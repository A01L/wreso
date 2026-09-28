// Turns a composition (tracks + clips) into a single MP4 using one FFmpeg filter graph.
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');
const ffmpeg = require('./ffmpeg');
const storage = require('./storage');
const { loadTimeline, effectiveDuration, clipDuration, clipRect } = require('./timeline');

const f = (n) => Number(n.toFixed(4)).toString();

/** atempo accepts 0.5..2 per instance on older FFmpeg builds, so chain it. */
function atempoChain(speed) {
  const parts = [];
  let s = speed;
  while (s > 2) { parts.push('atempo=2'); s /= 2; }
  while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-6) parts.push(`atempo=${f(s)}`);
  return parts;
}

/**
 * Build the FFmpeg arguments for a composition. `sources` maps each clip id to
 * { file, kind: 'video'|'audio'|'image', width, height, hasAudio, hasVideo }.
 * Exported separately so it can be unit-tested without FFmpeg.
 */
function buildArgs({ composition, tracks, duration, sources, output }) {
  const W = composition.width;
  const H = composition.height;
  const fps = composition.fps;
  const D = duration;
  const bg = composition.background_color.replace('#', '0x');

  const inputs = [];
  const graph = [`color=c=${bg}:s=${W}x${H}:r=${f(fps)}:d=${f(D)},format=yuv420p[base]`];
  const audioLabels = [];
  let last = 'base';
  let n = 0;

  // Tracks are listed top-to-bottom in the UI; the top video track is drawn last (on top).
  const videoTracks = tracks.filter((t) => t.kind === 'video' && !t.hidden).sort((a, b) => b.position - a.position);
  const audioCapable = tracks.filter((t) => !t.muted);

  const inputIndex = new Map();
  const addInput = (clip, src) => {
    if (inputIndex.has(clip.id)) return inputIndex.get(clip.id);
    const idx = inputs.length;
    const dur = clip.source_out - clip.source_in;
    if (src.kind === 'image') {
      inputs.push(['-loop', '1', '-framerate', f(fps), '-t', f(dur), '-i', src.file]);
    } else {
      inputs.push(['-ss', f(clip.source_in), '-t', f(dur), '-i', src.file]);
    }
    inputIndex.set(clip.id, idx);
    return idx;
  };

  for (const track of videoTracks) {
    for (const clip of track.clips) {
      const src = sources.get(clip.id);
      if (!src || !src.hasVideo || clip.timeline_start >= D) continue;
      const idx = addInput(clip, src);
      const dur = clipDuration(clip);
      const start = clip.timeline_start;
      const rect = clipRect(clip, src.width, src.height, W, H);
      const chain = [`setpts=(PTS-STARTPTS)/${f(clip.speed)}`, `fps=${f(fps)}`, `trim=duration=${f(dur)}`];
      const cropW = 1 - clip.crop_left - clip.crop_right;
      const cropH = 1 - clip.crop_top - clip.crop_bottom;
      if (cropW < 1 || cropH < 1) {
        chain.push(`crop=w=iw*${f(cropW)}:h=ih*${f(cropH)}:x=iw*${f(clip.crop_left)}:y=ih*${f(clip.crop_top)}`);
      }
      chain.push(`scale=${rect.w}:${rect.h}`, 'setsar=1', 'format=yuva420p');
      if (clip.opacity < 1) chain.push(`colorchannelmixer=aa=${f(clip.opacity)}`);
      if (clip.fade_in > 0) chain.push(`fade=t=in:st=0:d=${f(Math.min(clip.fade_in, dur))}:alpha=1`);
      if (clip.fade_out > 0) {
        const fo = Math.min(clip.fade_out, dur);
        chain.push(`fade=t=out:st=${f(dur - fo)}:d=${f(fo)}:alpha=1`);
      }
      chain.push(`setpts=PTS+${f(start)}/TB`);
      const v = `v${n}`;
      const out = `o${n}`;
      n += 1;
      graph.push(`[${idx}:v]${chain.join(',')}[${v}]`);
      graph.push(
        `[${last}][${v}]overlay=x=${rect.x}:y=${rect.y}:eof_action=pass:`
        + `enable='between(t,${f(start)},${f(start + dur)})'[${out}]`,
      );
      last = out;
    }
  }
  graph.push(`[${last}]format=yuv420p[vout]`);

  for (const track of audioCapable) {
    for (const clip of track.clips) {
      const src = sources.get(clip.id);
      if (!src || !src.hasAudio || clip.muted || clip.timeline_start >= D) continue;
      const vol = clip.volume * track.volume;
      if (vol <= 0) continue;
      const idx = addInput(clip, src);
      const dur = clipDuration(clip);
      const chain = ['asetpts=PTS-STARTPTS', ...atempoChain(clip.speed), `atrim=duration=${f(dur)}`];
      if (Math.abs(vol - 1) > 1e-6) chain.push(`volume=${f(vol)}`);
      if (clip.fade_in > 0) chain.push(`afade=t=in:st=0:d=${f(Math.min(clip.fade_in, dur))}`);
      if (clip.fade_out > 0) {
        const fo = Math.min(clip.fade_out, dur);
        chain.push(`afade=t=out:st=${f(dur - fo)}:d=${f(fo)}`);
      }
      chain.push('aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo');
      const delay = Math.round(clip.timeline_start * 1000);
      if (delay > 0) chain.push(`adelay=${delay}:all=1`);
      const a = `a${audioLabels.length}`;
      graph.push(`[${idx}:a]${chain.join(',')}[${a}]`);
      audioLabels.push(a);
    }
  }

  if (audioLabels.length > 1) {
    graph.push(`${audioLabels.map((l) => `[${l}]`).join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0,apad,atrim=0:${f(D)}[aout]`);
  } else if (audioLabels.length === 1) {
    graph.push(`[${audioLabels[0]}]apad,atrim=0:${f(D)}[aout]`);
  } else {
    const idx = inputs.length;
    inputs.push(['-f', 'lavfi', '-t', f(D), '-i', 'anullsrc=r=48000:cl=stereo']);
    graph.push(`[${idx}:a]anull[aout]`);
  }

  return [
    '-y', '-v', 'error', '-nostats', '-progress', 'pipe:1',
    ...inputs.flat(),
    '-filter_complex', graph.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', f(fps),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-t', f(D), '-movflags', '+faststart',
    output,
  ];
}

/**
 * Render a composition to `output`. Nested compositions are rendered first into
 * temporary files (cached per job) and then used like regular media.
 */
async function renderComposition(compositionId, output, { onProgress, stack = [], cache = new Map(), temps = [] } = {}) {
  if (stack.includes(compositionId)) throw new Error('Composition cycle detected');
  const composition = await db.one('SELECT * FROM compositions WHERE id = ?', [compositionId]);
  if (!composition) throw new Error('Composition not found');
  const tracks = await loadTimeline(compositionId);
  const duration = await effectiveDuration(composition, tracks);
  if (!(duration > 0)) throw new Error(`Composition "${composition.name}" is empty`);

  const mediaIds = [...new Set(tracks.flatMap((t) => t.clips).filter((c) => c.media_id).map((c) => c.media_id))];
  const mediaRows = mediaIds.length
    ? await db.query(`SELECT * FROM media WHERE id IN (${mediaIds.map(() => '?').join(',')})`, mediaIds)
    : [];
  const mediaById = new Map(mediaRows.map((m) => [m.id, m]));

  const sources = new Map();
  for (const clip of tracks.flatMap((t) => t.clips)) {
    if (clip.source_type === 'media') {
      const m = mediaById.get(clip.media_id);
      if (!m) continue;
      sources.set(clip.id, {
        file: storage.mediaPath(m.filename),
        kind: m.kind,
        width: m.width,
        height: m.height,
        hasVideo: Boolean(m.has_video),
        hasAudio: Boolean(m.has_audio),
      });
    } else {
      const nestedId = clip.source_composition_id;
      if (!cache.has(nestedId)) {
        const tmp = path.join(config.dirs.tmp, `nested-${crypto.randomUUID()}.mp4`);
        temps.push(tmp);
        await renderComposition(nestedId, tmp, { stack: [...stack, compositionId], cache, temps });
        const nested = await db.one('SELECT width, height FROM compositions WHERE id = ?', [nestedId]);
        cache.set(nestedId, { file: tmp, kind: 'video', width: nested.width, height: nested.height, hasVideo: true, hasAudio: true });
      }
      sources.set(clip.id, cache.get(nestedId));
    }
  }

  const args = buildArgs({ composition, tracks, duration, sources, output });
  let buffer = '';
  try {
    await ffmpeg.run(config.ffmpegPath, args, {
      onStdout: (text) => {
        if (!onProgress) return;
        buffer += text;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
          if (m) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
        }
      },
    });
  } finally {
    if (stack.length === 0) await Promise.all(temps.map(storage.removeQuietly));
  }
  return { duration };
}

module.exports = { buildArgs, renderComposition, atempoChain };
