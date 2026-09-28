// Pure timeline helpers (no DOM). Keep clipRect in sync with src/services/timeline.js.
import { uuid } from '../ui.js';

export const MIN_CLIP = 0.05;
export const IMAGE_DEFAULT = 5;

export const clipDuration = (c) => (c.source_out - c.source_in) / c.speed;
export const clipEnd = (c) => c.timeline_start + clipDuration(c);

export function clipRect(clip, srcW, srcH, canvasW, canvasH) {
  const cw = srcW * (1 - clip.crop_left - clip.crop_right);
  const ch = srcH * (1 - clip.crop_top - clip.crop_bottom);
  const fit = Math.min(canvasW / cw, canvasH / ch) * clip.scale;
  const w = Math.max(2, Math.round((cw * fit) / 2) * 2);
  const h = Math.max(2, Math.round((ch * fit) / 2) * 2);
  const x = Math.round((canvasW - w) / 2 + clip.pos_x);
  const y = Math.round((canvasH - h) / 2 + clip.pos_y);
  return { x, y, w, h };
}

export function newClip(fields) {
  return {
    id: uuid(),
    source_type: 'media',
    media_id: null,
    source_composition_id: null,
    timeline_start: 0,
    source_in: 0,
    source_out: 1,
    speed: 1,
    volume: 1,
    muted: false,
    fade_in: 0,
    fade_out: 0,
    crop_left: 0,
    crop_top: 0,
    crop_right: 0,
    crop_bottom: 0,
    pos_x: 0,
    pos_y: 0,
    scale: 1,
    opacity: 1,
    ...fields,
  };
}

export function newTrack(kind, tracks) {
  const n = tracks.filter((t) => t.kind === kind).length + 1;
  return { id: uuid(), kind, name: `${kind === 'video' ? 'Видео' : 'Аудио'} ${n}`, muted: false, hidden: false, volume: 1, clips: [] };
}

export function sortClips(track) {
  track.clips.sort((a, b) => a.timeline_start - b.timeline_start);
}

/** Does [start, end) collide with any clip on the track (except `ignoreIds`)? */
export function overlaps(track, start, end, ignoreIds = new Set()) {
  return track.clips.some((c) => !ignoreIds.has(c.id) && start < clipEnd(c) - 1e-6 && end > c.timeline_start + 1e-6);
}

export function trackEnd(track) {
  return track.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
}

export function contentDuration(tracks) {
  return tracks.reduce((m, t) => Math.max(m, trackEnd(t)), 0);
}

/** Split `clip` at timeline time `t`; returns the new right-hand clip or null. */
export function splitClip(clip, t) {
  const start = clip.timeline_start;
  const end = clipEnd(clip);
  if (t <= start + MIN_CLIP || t >= end - MIN_CLIP) return null;
  const cut = clip.source_in + (t - start) * clip.speed;
  const right = { ...clip, id: uuid(), timeline_start: t, source_in: cut, fade_in: 0 };
  clip.source_out = cut;
  clip.fade_out = 0;
  return right;
}

/** Earliest free start >= t on a track for a clip of length `len`. */
export function freeSlot(track, t, len, ignoreIds) {
  let start = Math.max(0, t);
  const sorted = [...track.clips].filter((c) => !ignoreIds || !ignoreIds.has(c.id)).sort((a, b) => a.timeline_start - b.timeline_start);
  for (const c of sorted) {
    if (start + len <= c.timeline_start + 1e-6) break;
    if (start < clipEnd(c)) start = clipEnd(c);
  }
  return start;
}

/** Deep copy for undo snapshots and API payloads. */
export function cloneTracks(tracks) {
  return tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c })) }));
}

export function findClip(tracks, id) {
  for (const track of tracks) {
    const clip = track.clips.find((c) => c.id === id);
    if (clip) return { track, clip };
  }
  return null;
}
