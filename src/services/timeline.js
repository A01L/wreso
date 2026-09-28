// Loading timelines and the geometry shared by the renderer and the browser preview.
const db = require('../db');

function clipDuration(clip) {
  return (clip.source_out - clip.source_in) / clip.speed;
}

function clipEnd(clip) {
  return clip.timeline_start + clipDuration(clip);
}

function normalizeClip(row) {
  return {
    ...row,
    muted: Boolean(row.muted),
  };
}

async function loadTimeline(compositionId, conn = null) {
  const q = conn ? (sql, p) => conn.execute(sql, p).then(([r]) => r) : db.query;
  const tracks = await q('SELECT * FROM tracks WHERE composition_id = ? ORDER BY position, id', [compositionId]);
  const clips = await q('SELECT * FROM clips WHERE composition_id = ? ORDER BY timeline_start, id', [compositionId]);
  const byTrack = new Map(tracks.map((t) => [t.id, []]));
  for (const clip of clips) {
    const list = byTrack.get(clip.track_id);
    if (list) list.push(normalizeClip(clip));
  }
  return tracks.map((t) => ({
    ...t,
    muted: Boolean(t.muted),
    hidden: Boolean(t.hidden),
    clips: byTrack.get(t.id),
  }));
}

function contentDuration(tracks) {
  let end = 0;
  for (const t of tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c));
  return end;
}

async function effectiveDuration(composition, tracks) {
  if (composition.duration) return composition.duration;
  return contentDuration(tracks || (await loadTimeline(composition.id)));
}

/**
 * Where a clip lands on the canvas: fit the (cropped) source inside the canvas
 * ("contain"), multiply by clip.scale, then offset from the center by pos_x/pos_y.
 * public/js/geometry.js mirrors this for the live preview.
 */
function clipRect(clip, srcW, srcH, canvasW, canvasH) {
  const cw = srcW * (1 - clip.crop_left - clip.crop_right);
  const ch = srcH * (1 - clip.crop_top - clip.crop_bottom);
  const fit = Math.min(canvasW / cw, canvasH / ch) * clip.scale;
  const w = Math.max(2, Math.round((cw * fit) / 2) * 2);
  const h = Math.max(2, Math.round((ch * fit) / 2) * 2);
  const x = Math.round((canvasW - w) / 2 + clip.pos_x);
  const y = Math.round((canvasH - h) / 2 + clip.pos_y);
  return { x, y, w, h };
}

module.exports = { clipDuration, clipEnd, loadTimeline, contentDuration, effectiveDuration, clipRect };
