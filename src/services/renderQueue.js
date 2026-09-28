// Simple in-process render queue backed by the `renders` table.
const db = require('../db');
const config = require('../config');
const storage = require('./storage');
const { renderComposition } = require('./renderer');

const queue = [];
let active = 0;

function enqueue(renderId) {
  queue.push(renderId);
  setImmediate(pump);
}

function pump() {
  while (active < config.renderConcurrency && queue.length) {
    const id = queue.shift();
    active += 1;
    runRender(id)
      .catch((err) => console.error(`Render ${id} crashed:`, err))
      .finally(() => { active -= 1; setImmediate(pump); });
  }
}

async function runRender(renderId) {
  const render = await db.one('SELECT * FROM renders WHERE id = ?', [renderId]);
  if (!render || render.status !== 'queued') return;
  const outputFile = `render-${render.id}-${Date.now()}.mp4`;
  await db.query("UPDATE renders SET status = 'processing', progress = 0 WHERE id = ?", [render.id]);

  let lastWrite = 0;
  try {
    await renderComposition(render.composition_id, storage.renderPath(outputFile), {
      onProgress: (p) => {
        const now = Date.now();
        if (now - lastWrite < 1000) return;
        lastWrite = now;
        db.query('UPDATE renders SET progress = ? WHERE id = ?', [p, render.id]).catch(() => {});
      },
    });
    const updated = await db.query(
      "UPDATE renders SET status = 'done', progress = 1, output_file = ?, finished_at = NOW() WHERE id = ?",
      [outputFile, render.id],
    );
    // The render (or its project) was deleted while we were working.
    if (!updated.affectedRows) await storage.removeQuietly(storage.renderPath(outputFile));
  } catch (err) {
    await storage.removeQuietly(storage.renderPath(outputFile));
    await db.query(
      "UPDATE renders SET status = 'failed', error = ?, finished_at = NOW() WHERE id = ?",
      [String(err.message).slice(0, 4000), render.id],
    );
  }
}

/** Re-queue renders interrupted by a restart. */
async function resume() {
  await db.query("UPDATE renders SET status = 'queued', progress = 0 WHERE status = 'processing'");
  const rows = await db.query("SELECT id FROM renders WHERE status = 'queued' ORDER BY id");
  rows.forEach((r) => enqueue(r.id));
}

module.exports = { enqueue, resume };
