const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { str, num, bool, color, uuid } = require('../validate');
const { serializeMedia } = require('./media');
const { getProject, getComposition, getRender } = require('../access');
const { badRequest, notFound } = require('../errors');
const { loadTimeline, contentDuration } = require('../services/timeline');
const renderQueue = require('../services/renderQueue');
const storage = require('../services/storage');

const router = express.Router();

const MAX_DIM = 7680;

function compositionFields(body, current = {}) {
  const even = (v, field, def) => {
    const n = num(v, field, { min: 16, max: MAX_DIM, integer: true, def: current[field] ?? def });
    if (n % 2) throw badRequest(`Размер холста должен быть чётным числом (${field})`);
    return n;
  };
  return {
    name: str(body.name, 'name', { min: 1, max: 200, optional: current.name !== undefined }) ?? current.name,
    width: even(body.width, 'width', 1920),
    height: even(body.height, 'height', 1080),
    fps: num(body.fps, 'fps', { min: 1, max: 120, def: current.fps ?? 30 }),
    background_color: color(body.background_color, 'background_color', current.background_color || '#000000'),
    duration: body.duration === undefined
      ? (current.duration ?? null)
      : (body.duration === null || body.duration === '' ? null : num(body.duration, 'duration', { min: 0.1, max: 86400 })),
  };
}

async function createComposition(projectId, fields, conn = db.pool) {
  const [result] = await conn.execute(
    `INSERT INTO compositions (project_id, name, width, height, fps, background_color, duration)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [projectId, fields.name, fields.width, fields.height, fields.fps, fields.background_color, fields.duration],
  );
  const id = result.insertId;
  await conn.execute(
    `INSERT INTO tracks (id, composition_id, kind, name, position) VALUES (?, ?, 'video', 'Video 1', 0), (?, ?, 'audio', 'Audio 1', 1)`,
    [crypto.randomUUID(), id, crypto.randomUUID(), id],
  );
  return id;
}

async function projectCompositions(projectId) {
  const comps = await db.query('SELECT * FROM compositions WHERE project_id = ? ORDER BY id', [projectId]);
  const ends = await db.query(
    `SELECT composition_id, MAX(timeline_start + (source_out - source_in) / speed) AS content_end
     FROM clips WHERE composition_id IN (SELECT id FROM compositions WHERE project_id = ?) GROUP BY composition_id`,
    [projectId],
  );
  const renders = await db.query(
    `SELECT composition_id, MAX(id) AS render_id FROM renders
     WHERE status = 'done' AND composition_id IN (SELECT id FROM compositions WHERE project_id = ?)
     GROUP BY composition_id`,
    [projectId],
  );
  const endById = new Map(ends.map((e) => [e.composition_id, Number(e.content_end)]));
  const renderById = new Map(renders.map((r) => [r.composition_id, r.render_id]));
  return comps.map((c) => ({
    ...c,
    effective_duration: c.duration || endById.get(c.id) || 0,
    // Latest finished render, used by the editor to preview nested compositions.
    preview_url: renderById.has(c.id) ? `/api/renders/${renderById.get(c.id)}/file` : null,
  }));
}

// ---- compositions ---------------------------------------------------------

router.post('/projects/:projectId/compositions', async (req, res) => {
  const project = await getProject(req.user.id, req.params.projectId);
  const fields = compositionFields(req.body);
  const id = await createComposition(project.id, fields);
  await db.query('UPDATE projects SET updated_at = NOW() WHERE id = ?', [project.id]);
  res.status(201).json({ composition: await getComposition(req.user.id, id) });
});

router.get('/compositions/:id', async (req, res) => {
  const composition = await getComposition(req.user.id, req.params.id);
  const [project, tracks, compositions, media] = await Promise.all([
    getProject(req.user.id, composition.project_id),
    loadTimeline(composition.id),
    projectCompositions(composition.project_id),
    db.query('SELECT * FROM media WHERE project_id = ? ORDER BY id DESC', [composition.project_id]),
  ]);
  res.json({ composition, project, tracks, compositions, media: media.map(serializeMedia) });
});

router.patch('/compositions/:id', async (req, res) => {
  const current = await getComposition(req.user.id, req.params.id);
  const fields = compositionFields(req.body, current);
  await db.query(
    `UPDATE compositions SET name = ?, width = ?, height = ?, fps = ?, background_color = ?, duration = ? WHERE id = ?`,
    [fields.name, fields.width, fields.height, fields.fps, fields.background_color, fields.duration, current.id],
  );
  res.json({ composition: await getComposition(req.user.id, current.id) });
});

router.post('/compositions/:id/duplicate', async (req, res) => {
  const source = await getComposition(req.user.id, req.params.id);
  const tracks = await loadTimeline(source.id);
  const id = await db.transaction(async (conn) => {
    const [result] = await conn.execute(
      `INSERT INTO compositions (project_id, name, width, height, fps, background_color, duration)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [source.project_id, `${source.name} (copy)`.slice(0, 200), source.width, source.height, source.fps,
        source.background_color, source.duration],
    );
    const newTracks = tracks.map((t) => ({
      ...t,
      id: crypto.randomUUID(),
      clips: t.clips.map((c) => ({ ...c, id: crypto.randomUUID() })),
    }));
    await writeTimeline(conn, result.insertId, newTracks);
    return result.insertId;
  });
  res.status(201).json({ composition: await getComposition(req.user.id, id) });
});

router.delete('/compositions/:id', async (req, res) => {
  const composition = await getComposition(req.user.id, req.params.id);
  const renders = await db.query('SELECT output_file FROM renders WHERE composition_id = ? AND output_file IS NOT NULL', [composition.id]);
  await db.query('DELETE FROM compositions WHERE id = ?', [composition.id]);
  await Promise.all(renders.map((r) => storage.removeQuietly(storage.renderPath(r.output_file))));
  res.json({ ok: true });
});

// ---- timeline -------------------------------------------------------------

const CLIP_COLUMNS = [
  'id', 'track_id', 'composition_id', 'source_type', 'media_id', 'source_composition_id',
  'timeline_start', 'source_in', 'source_out', 'speed', 'volume', 'muted', 'fade_in', 'fade_out',
  'crop_left', 'crop_top', 'crop_right', 'crop_bottom', 'pos_x', 'pos_y', 'scale', 'opacity',
];

async function writeTimeline(conn, compositionId, tracks) {
  await conn.execute('DELETE FROM clips WHERE composition_id = ?', [compositionId]);
  await conn.execute('DELETE FROM tracks WHERE composition_id = ?', [compositionId]);
  for (const t of tracks) {
    await conn.execute(
      'INSERT INTO tracks (id, composition_id, kind, name, position, muted, hidden, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [t.id, compositionId, t.kind, t.name, t.position, t.muted ? 1 : 0, t.hidden ? 1 : 0, t.volume],
    );
  }
  const clips = tracks.flatMap((t) => t.clips.map((c) => ({ ...c, track_id: t.id, composition_id: compositionId })));
  if (clips.length) {
    const placeholders = `(${CLIP_COLUMNS.map(() => '?').join(',')})`;
    const values = clips.flatMap((c) => CLIP_COLUMNS.map((col) => (col === 'muted' ? (c.muted ? 1 : 0) : c[col] ?? null)));
    await conn.query(`INSERT INTO clips (${CLIP_COLUMNS.join(',')}) VALUES ${clips.map(() => placeholders).join(',')}`, values);
  }
}

function validateClip(raw, track, ctx) {
  const where = `clip ${raw && raw.id}`;
  if (!raw || typeof raw !== 'object') throw badRequest('Invalid clip');
  const clip = {
    id: uuid(raw.id, 'clip.id'),
    source_type: raw.source_type === 'composition' ? 'composition' : 'media',
    media_id: null,
    source_composition_id: null,
    timeline_start: num(raw.timeline_start, `${where}: timeline_start`, { min: 0, max: 86400 }),
    source_in: num(raw.source_in, `${where}: source_in`, { min: 0, max: 86400, def: 0 }),
    source_out: num(raw.source_out, `${where}: source_out`, { min: 0.01, max: 86400 }),
    speed: num(raw.speed, `${where}: speed`, { min: 0.1, max: 10, def: 1 }),
    volume: num(raw.volume, `${where}: volume`, { min: 0, max: 4, def: 1 }),
    muted: bool(raw.muted),
    fade_in: num(raw.fade_in, `${where}: fade_in`, { min: 0, max: 600, def: 0 }),
    fade_out: num(raw.fade_out, `${where}: fade_out`, { min: 0, max: 600, def: 0 }),
    crop_left: num(raw.crop_left, `${where}: crop_left`, { min: 0, max: 0.45, def: 0 }),
    crop_top: num(raw.crop_top, `${where}: crop_top`, { min: 0, max: 0.45, def: 0 }),
    crop_right: num(raw.crop_right, `${where}: crop_right`, { min: 0, max: 0.45, def: 0 }),
    crop_bottom: num(raw.crop_bottom, `${where}: crop_bottom`, { min: 0, max: 0.45, def: 0 }),
    pos_x: num(raw.pos_x, `${where}: pos_x`, { min: -20000, max: 20000, def: 0 }),
    pos_y: num(raw.pos_y, `${where}: pos_y`, { min: -20000, max: 20000, def: 0 }),
    scale: num(raw.scale, `${where}: scale`, { min: 0.05, max: 10, def: 1 }),
    opacity: num(raw.opacity, `${where}: opacity`, { min: 0, max: 1, def: 1 }),
  };
  if (clip.source_out <= clip.source_in) throw badRequest(`${where}: source_out must be after source_in`);

  if (clip.source_type === 'media') {
    const media = ctx.media.get(Number(raw.media_id));
    if (!media) throw badRequest(`${where}: media not found in this project`);
    clip.media_id = media.id;
    if (media.kind === 'image') {
      clip.speed = 1;
      if (track.kind === 'audio') throw badRequest(`${where}: images cannot be placed on audio tracks`);
    } else {
      if (clip.source_out > media.duration + 0.05) throw badRequest(`${where}: source_out exceeds media duration`);
      if (track.kind === 'video' && !media.has_video) throw badRequest(`${where}: audio files go on audio tracks`);
      if (track.kind === 'audio' && !media.has_audio) throw badRequest(`${where}: media has no audio`);
    }
  } else {
    const compId = Number(raw.source_composition_id);
    if (!ctx.compositions.has(compId)) throw badRequest(`${where}: composition not found in this project`);
    if (compId === ctx.compositionId) throw badRequest('Композиция не может содержать саму себя');
    clip.source_composition_id = compId;
  }
  return clip;
}

/** Would adding edges composition -> sources create a loop through the nesting graph? */
async function assertNoCycle(projectId, compositionId, sources) {
  const edges = await db.query(
    `SELECT DISTINCT cl.composition_id AS parent, cl.source_composition_id AS child FROM clips cl
     JOIN compositions c ON c.id = cl.composition_id
     WHERE c.project_id = ? AND cl.source_composition_id IS NOT NULL AND cl.composition_id <> ?`,
    [projectId, compositionId],
  );
  const graph = new Map();
  for (const e of edges) {
    if (!graph.has(e.parent)) graph.set(e.parent, []);
    graph.get(e.parent).push(e.child);
  }
  const seen = new Set();
  const stack = [...sources];
  while (stack.length) {
    const id = stack.pop();
    if (id === compositionId) throw badRequest('Такое вложение композиций создаст цикл');
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(graph.get(id) || []));
  }
}

router.put('/compositions/:id/timeline', async (req, res) => {
  const composition = await getComposition(req.user.id, req.params.id);
  const rawTracks = req.body.tracks;
  if (!Array.isArray(rawTracks)) throw badRequest('tracks must be an array');
  if (rawTracks.length > 50) throw badRequest('Too many tracks');

  const [mediaRows, compRows] = await Promise.all([
    db.query('SELECT id, kind, duration, has_audio, has_video FROM media WHERE project_id = ?', [composition.project_id]),
    db.query('SELECT id FROM compositions WHERE project_id = ?', [composition.project_id]),
  ]);
  const ctx = {
    compositionId: composition.id,
    media: new Map(mediaRows.map((m) => [m.id, m])),
    compositions: new Set(compRows.map((c) => c.id)),
  };

  const ids = new Set();
  let clipCount = 0;
  const tracks = rawTracks.map((raw, index) => {
    const track = {
      id: uuid(raw.id, 'track.id'),
      kind: raw.kind === 'audio' ? 'audio' : 'video',
      name: str(raw.name, 'track.name', { min: 1, max: 100 }),
      position: index,
      muted: bool(raw.muted),
      hidden: bool(raw.hidden),
      volume: num(raw.volume, 'track.volume', { min: 0, max: 4, def: 1 }),
    };
    if (!Array.isArray(raw.clips)) throw badRequest('track.clips must be an array');
    track.clips = raw.clips.map((c) => validateClip(c, track, ctx));
    for (const id of [track.id, ...track.clips.map((c) => c.id)]) {
      if (ids.has(id)) throw badRequest(`Duplicate id ${id}`);
      ids.add(id);
    }
    clipCount += track.clips.length;
    return track;
  });
  if (clipCount > 2000) throw badRequest('Too many clips');

  const nested = [...new Set(tracks.flatMap((t) => t.clips).map((c) => c.source_composition_id).filter(Boolean))];
  await assertNoCycle(composition.project_id, composition.id, nested);

  // Track/clip ids are client-generated UUIDs; make sure none belong to another composition.
  if (ids.size) {
    const list = [...ids];
    const foreign = await db.query(
      `SELECT id FROM tracks WHERE id IN (${list.map(() => '?').join(',')}) AND composition_id <> ?
       UNION SELECT id FROM clips WHERE id IN (${list.map(() => '?').join(',')}) AND composition_id <> ?`,
      [...list, composition.id, ...list, composition.id],
    );
    if (foreign.length) throw badRequest('Some ids are already used by another composition');
  }

  await db.transaction(async (conn) => {
    await writeTimeline(conn, composition.id, tracks);
    await conn.execute('UPDATE compositions SET updated_at = NOW() WHERE id = ?', [composition.id]);
    await conn.execute('UPDATE projects SET updated_at = NOW() WHERE id = ?', [composition.project_id]);
  });
  const saved = await loadTimeline(composition.id);
  res.json({ tracks: saved, content_duration: contentDuration(saved) });
});

// ---- renders --------------------------------------------------------------

function serializeRender(r) {
  return {
    id: r.id,
    composition_id: r.composition_id,
    status: r.status,
    progress: r.progress,
    error: r.error,
    created_at: r.created_at,
    finished_at: r.finished_at,
    url: r.status === 'done' ? `/api/renders/${r.id}/file` : null,
    download_url: r.status === 'done' ? `/api/renders/${r.id}/file?download=1` : null,
  };
}

router.post('/compositions/:id/renders', async (req, res) => {
  const composition = await getComposition(req.user.id, req.params.id);
  const tracks = await loadTimeline(composition.id);
  const hasClips = tracks.some((t) => t.clips.length);
  if (!hasClips && !composition.duration) throw badRequest('Композиция пуста — сначала добавьте клипы');
  const result = await db.query('INSERT INTO renders (composition_id) VALUES (?)', [composition.id]);
  renderQueue.enqueue(result.insertId);
  const render = await db.one('SELECT * FROM renders WHERE id = ?', [result.insertId]);
  res.status(202).json({ render: serializeRender(render) });
});

router.get('/compositions/:id/renders', async (req, res) => {
  const composition = await getComposition(req.user.id, req.params.id);
  const rows = await db.query('SELECT * FROM renders WHERE composition_id = ? ORDER BY id DESC LIMIT 50', [composition.id]);
  res.json({ renders: rows.map(serializeRender) });
});

router.get('/renders/:id', async (req, res) => {
  res.json({ render: serializeRender(await getRender(req.user.id, req.params.id)) });
});

router.get('/renders/:id/file', async (req, res) => {
  const render = await getRender(req.user.id, req.params.id);
  if (render.status !== 'done' || !render.output_file) throw notFound('Render is not ready');
  const file = storage.renderPath(render.output_file);
  if (req.query.download) {
    const safe = render.composition_name.replace(/[^\p{L}\p{N}_ -]+/gu, '').trim() || 'render';
    res.download(file, `${safe}-${render.id}.mp4`);
  } else {
    res.type('video/mp4').sendFile(file);
  }
});

router.delete('/renders/:id', async (req, res) => {
  const render = await getRender(req.user.id, req.params.id);
  if (render.status === 'processing') throw badRequest('Рендер ещё выполняется');
  await db.query('DELETE FROM renders WHERE id = ?', [render.id]);
  if (render.output_file) await storage.removeQuietly(storage.renderPath(render.output_file));
  res.json({ ok: true });
});

module.exports = router;
module.exports.createComposition = createComposition;
