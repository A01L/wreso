// Ownership checks: every resource is reachable only through a project owned by the user.
const db = require('./db');
const { notFound } = require('./errors');

function toId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw notFound();
  return id;
}

async function getProject(userId, id) {
  const project = await db.one('SELECT * FROM projects WHERE id = ? AND user_id = ?', [toId(id), userId]);
  if (!project) throw notFound('Project not found');
  return project;
}

async function getComposition(userId, id) {
  const comp = await db.one(
    `SELECT c.* FROM compositions c JOIN projects p ON p.id = c.project_id
     WHERE c.id = ? AND p.user_id = ?`,
    [toId(id), userId],
  );
  if (!comp) throw notFound('Composition not found');
  return comp;
}

async function getMedia(userId, id) {
  const media = await db.one(
    `SELECT m.* FROM media m JOIN projects p ON p.id = m.project_id
     WHERE m.id = ? AND p.user_id = ?`,
    [toId(id), userId],
  );
  if (!media) throw notFound('Media not found');
  return media;
}

async function getRender(userId, id) {
  const render = await db.one(
    `SELECT r.*, c.project_id, c.name AS composition_name FROM renders r
     JOIN compositions c ON c.id = r.composition_id
     JOIN projects p ON p.id = c.project_id
     WHERE r.id = ? AND p.user_id = ?`,
    [toId(id), userId],
  );
  if (!render) throw notFound('Render not found');
  return render;
}

module.exports = { toId, getProject, getComposition, getMedia, getRender };
