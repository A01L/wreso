const express = require('express');
const db = require('../db');
const { str } = require('../validate');
const { getProject } = require('../access');
const storage = require('../services/storage');
const { serializeMedia } = require('./media');
const { createComposition } = require('./compositions');

const router = express.Router();

router.get('/', async (req, res) => {
  const projects = await db.query(
    `SELECT p.*,
       (SELECT COUNT(*) FROM compositions c WHERE c.project_id = p.id) AS composition_count,
       (SELECT COUNT(*) FROM media m WHERE m.project_id = p.id) AS media_count,
       (SELECT m.id FROM media m WHERE m.project_id = p.id AND m.thumbnail IS NOT NULL ORDER BY m.id LIMIT 1) AS cover_media_id
     FROM projects p WHERE p.user_id = ? ORDER BY p.updated_at DESC, p.id DESC`,
    [req.user.id],
  );
  res.json({ projects });
});

router.post('/', async (req, res) => {
  const name = str(req.body.name, 'name', { min: 1, max: 200 });
  const description = str(req.body.description, 'description', { max: 2000, optional: true }) || null;
  const result = await db.query(
    'INSERT INTO projects (user_id, name, description) VALUES (?, ?, ?)',
    [req.user.id, name, description],
  );
  await createComposition(result.insertId, {
    name: 'Main', width: 1920, height: 1080, fps: 30, background_color: '#000000', duration: null,
  });
  const project = await getProject(req.user.id, result.insertId);
  res.status(201).json({ project });
});

router.get('/:id', async (req, res) => {
  const project = await getProject(req.user.id, req.params.id);
  const compositions = await db.query(
    `SELECT c.*, (SELECT COUNT(*) FROM clips cl WHERE cl.composition_id = c.id) AS clip_count,
       (SELECT MAX(cl.timeline_start + (cl.source_out - cl.source_in) / cl.speed)
          FROM clips cl WHERE cl.composition_id = c.id) AS content_duration
     FROM compositions c WHERE c.project_id = ? ORDER BY c.id`,
    [project.id],
  );
  const media = await db.query('SELECT * FROM media WHERE project_id = ? ORDER BY id DESC', [project.id]);
  res.json({ project, compositions, media: media.map(serializeMedia) });
});

router.patch('/:id', async (req, res) => {
  const project = await getProject(req.user.id, req.params.id);
  const name = str(req.body.name, 'name', { min: 1, max: 200, optional: true }) ?? project.name;
  const description = req.body.description === undefined
    ? project.description
    : str(req.body.description, 'description', { max: 2000, optional: true }) || null;
  await db.query('UPDATE projects SET name = ?, description = ? WHERE id = ?', [name, description, project.id]);
  res.json({ project: await getProject(req.user.id, project.id) });
});

router.delete('/:id', async (req, res) => {
  const project = await getProject(req.user.id, req.params.id);
  const media = await db.query('SELECT * FROM media WHERE project_id = ?', [project.id]);
  const renders = await db.query(
    `SELECT r.output_file FROM renders r JOIN compositions c ON c.id = r.composition_id
     WHERE c.project_id = ? AND r.output_file IS NOT NULL`,
    [project.id],
  );
  await db.query('DELETE FROM projects WHERE id = ?', [project.id]);
  await Promise.all(media.map(storage.removeMediaFiles));
  await Promise.all(renders.map((r) => storage.removeQuietly(storage.renderPath(r.output_file))));
  res.json({ ok: true });
});

module.exports = router;
