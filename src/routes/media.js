const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const mime = require('mime-types');
const config = require('../config');
const db = require('../db');
const ffmpeg = require('../services/ffmpeg');
const storage = require('../services/storage');
const { str } = require('../validate');
const { getProject, getMedia } = require('../access');
const { HttpError, badRequest, notFound } = require('../errors');

const router = express.Router();

const VIDEO_EXT = ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.mpeg', '.mpg', '.3gp'];
const AUDIO_EXT = ['.mp3', '.wav', '.aac', '.m4a', '.ogg', '.oga', '.flac', '.opus'];
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'];
const ALLOWED = new Set([...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.dirs.tmp),
    filename: (req, file, cb) => {
      cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase());
    },
  }),
  limits: { fileSize: config.maxUploadBytes, files: 20 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED.has(ext)) return cb(badRequest(`Unsupported file type: ${ext || file.originalname}`));
    cb(null, true);
  },
});

function serializeMedia(m) {
  return {
    id: m.id,
    project_id: m.project_id,
    name: m.original_name,
    mime: m.mime,
    kind: m.kind,
    size_bytes: Number(m.size_bytes),
    duration: m.duration,
    width: m.width,
    height: m.height,
    fps: m.fps,
    has_video: Boolean(m.has_video),
    has_audio: Boolean(m.has_audio),
    url: `/api/media/${m.id}/file`,
    // Preview player source: a browser-friendly proxy when the original can't be played natively.
    preview_url: m.proxy ? `/api/media/${m.id}/file?proxy=1` : `/api/media/${m.id}/file`,
    thumbnail_url: m.thumbnail ? `/api/media/${m.id}/thumbnail` : null,
    waveform_url: m.waveform ? `/api/media/${m.id}/waveform` : null,
    created_at: m.created_at,
  };
}

async function ingest(project, file) {
  const ext = path.extname(file.filename);
  const base = path.basename(file.filename, ext);
  let info;
  try {
    info = await ffmpeg.probe(file.path);
  } catch (err) {
    throw badRequest(`${file.originalname}: not a readable media file`);
  }

  let kind;
  if (IMAGE_EXT.includes(ext) && ext !== '.gif') kind = 'image';
  else if (info.hasVideo && (ext === '.gif' || info.duration)) kind = 'video';
  else if (info.hasAudio) kind = 'audio';
  else if (info.hasVideo) kind = 'image';
  else throw badRequest(`${file.originalname}: no audio or video streams found`);
  if (kind !== 'image' && !(info.duration > 0)) throw badRequest(`${file.originalname}: unknown duration`);

  const finalPath = storage.mediaPath(file.filename);
  await fs.promises.rename(file.path, finalPath);

  let thumbnail = null;
  let waveform = null;
  if (kind !== 'audio') {
    try {
      thumbnail = `${base}.jpg`;
      const at = kind === 'video' ? Math.min(1, info.duration * 0.1) : 0;
      await ffmpeg.thumbnail(finalPath, storage.thumbPath(thumbnail), { at, isImage: kind === 'image' });
    } catch (_) { thumbnail = null; }
  }
  if (info.hasAudio) {
    try {
      waveform = `${base}.wave.png`;
      await ffmpeg.waveform(finalPath, storage.thumbPath(waveform));
    } catch (_) { waveform = null; }
  }

  const result = await db.query(
    `INSERT INTO media (project_id, original_name, filename, mime, kind, size_bytes, duration,
       width, height, fps, has_video, has_audio, thumbnail, waveform)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      project.id, file.originalname.slice(0, 255), file.filename, mime.lookup(ext) || file.mimetype || 'application/octet-stream',
      kind, file.size, kind === 'image' ? null : info.duration, info.width, info.height, info.fps,
      info.hasVideo ? 1 : 0, info.hasAudio ? 1 : 0, thumbnail, waveform,
    ],
  );
  if (kind === 'video' && !ffmpeg.isBrowserFriendly(info, ext)) {
    const proxyName = `${base}.proxy.mp4`;
    ffmpeg.proxy(finalPath, storage.mediaPath(proxyName))
      .then(() => db.query('UPDATE media SET proxy = ? WHERE id = ?', [proxyName, result.insertId]))
      .catch((err) => console.error(`Proxy for media ${result.insertId} failed:`, err.message));
  }
  return db.one('SELECT * FROM media WHERE id = ?', [result.insertId]);
}

router.post('/projects/:projectId/media', async (req, res) => {
  const project = await getProject(req.user.id, req.params.projectId);
  await new Promise((resolve, reject) => {
    upload.array('files')(req, res, (err) => {
      if (!err) return resolve();
      if (err.code === 'LIMIT_FILE_SIZE') return reject(new HttpError(413, 'File is too large'));
      return reject(err.status ? err : badRequest(err.message));
    });
  });
  const files = req.files || [];
  if (!files.length) throw badRequest('No files uploaded');

  const created = [];
  const errors = [];
  for (const file of files) {
    try {
      created.push(serializeMedia(await ingest(project, file)));
    } catch (err) {
      errors.push(err.message);
      await storage.removeQuietly(file.path);
    }
  }
  await db.query('UPDATE projects SET updated_at = NOW() WHERE id = ?', [project.id]);
  if (!created.length) throw badRequest(errors.join('; '));
  res.status(201).json({ media: created, errors });
});

router.get('/projects/:projectId/media', async (req, res) => {
  const project = await getProject(req.user.id, req.params.projectId);
  const rows = await db.query('SELECT * FROM media WHERE project_id = ? ORDER BY id DESC', [project.id]);
  res.json({ media: rows.map(serializeMedia) });
});

router.get('/media/:id', async (req, res) => {
  res.json({ media: serializeMedia(await getMedia(req.user.id, req.params.id)) });
});

router.patch('/media/:id', async (req, res) => {
  const media = await getMedia(req.user.id, req.params.id);
  const name = str(req.body.name, 'name', { min: 1, max: 255 });
  await db.query('UPDATE media SET original_name = ? WHERE id = ?', [name, media.id]);
  res.json({ media: serializeMedia(await getMedia(req.user.id, media.id)) });
});

router.delete('/media/:id', async (req, res) => {
  const media = await getMedia(req.user.id, req.params.id);
  await db.query('DELETE FROM media WHERE id = ?', [media.id]);
  await storage.removeMediaFiles(media);
  res.json({ ok: true });
});

const sendOpts = { maxAge: '1h', headers: { 'Cache-Control': 'private, max-age=3600' } };

router.get('/media/:id/file', async (req, res) => {
  const media = await getMedia(req.user.id, req.params.id);
  if (req.query.proxy && media.proxy) return res.type('video/mp4').sendFile(storage.mediaPath(media.proxy), sendOpts);
  return res.type(media.mime).sendFile(storage.mediaPath(media.filename), sendOpts);
});

router.get('/media/:id/thumbnail', async (req, res) => {
  const media = await getMedia(req.user.id, req.params.id);
  if (!media.thumbnail) throw notFound();
  res.sendFile(storage.thumbPath(media.thumbnail), sendOpts);
});

router.get('/media/:id/waveform', async (req, res) => {
  const media = await getMedia(req.user.id, req.params.id);
  if (!media.waveform) throw notFound();
  res.sendFile(storage.thumbPath(media.waveform), sendOpts);
});

module.exports = router;
module.exports.serializeMedia = serializeMedia;
