// Real-time composition preview: HTML media elements drawn onto a <canvas>.
import { clipDuration, clipRect } from './model.js';

const DRIFT = 0.25; // seconds of allowed A/V drift while playing

export class Preview {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} store  { comp, tracks, media: Map, comps: Map, nestedRenders: Map, duration() }
   */
  constructor(canvas, store) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.store = store;
    this.time = 0;
    this.playing = false;
    this.elements = new Map(); // clip id -> { el, key }
    this.images = new Map(); // media id -> HTMLImageElement
    this.onTime = null;
    this.onStateChange = null;
    this.dirty = true;
    this.lastEmitted = -1;
    this.raf = requestAnimationFrame(this.tick);
    this.resize();
  }

  resize() {
    const { width, height } = this.store.comp;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.dirty = true;
  }

  invalidate() { this.dirty = true; }

  seek(t) {
    this.time = Math.max(0, Math.min(t, this.store.duration()));
    if (this.playing) { this.t0 = this.time; this.wall0 = performance.now(); }
    this.dirty = true;
  }

  play() {
    if (this.playing) return;
    const dur = this.store.duration();
    if (dur <= 0) return;
    if (this.time >= dur - 0.01) this.time = 0;
    this.playing = true;
    this.t0 = this.time;
    this.wall0 = performance.now();
    if (this.onStateChange) this.onStateChange(true);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    for (const { el } of this.elements.values()) if (el.pause) el.pause();
    this.dirty = true;
    if (this.onStateChange) this.onStateChange(false);
  }

  toggle() { if (this.playing) this.pause(); else this.play(); }

  destroy() {
    cancelAnimationFrame(this.raf);
    for (const { el } of this.elements.values()) this.disposeEl(el);
    this.elements.clear();
  }

  disposeEl(el) {
    if (el instanceof HTMLMediaElement) {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
  }

  /** Source description for a clip: { url, type: 'video'|'audio'|'image'|'placeholder', w, h, hasAudio }. */
  sourceOf(clip, track) {
    const { media, comps, nestedRenders } = this.store;
    if (clip.source_type === 'media') {
      const m = media.get(clip.media_id);
      if (!m) return null;
      if (m.kind === 'image') return { url: m.url, type: 'image', w: m.width, h: m.height, hasAudio: false, key: `img:${m.id}` };
      const url = m.preview_url || m.url;
      if (track.kind === 'audio' || m.kind === 'audio') return { url, type: 'audio', hasAudio: m.has_audio, key: `a:${url}` };
      return { url, type: 'video', w: m.width, h: m.height, hasAudio: m.has_audio, key: `v:${url}` };
    }
    const c = comps.get(clip.source_composition_id);
    if (!c) return null;
    const url = nestedRenders.get(c.id);
    if (!url) return { type: 'placeholder', w: c.width, h: c.height, name: c.name, hasAudio: false, key: `p:${c.id}` };
    return { url, type: track.kind === 'audio' ? 'audio' : 'video', w: c.width, h: c.height, hasAudio: true, key: `r:${c.id}:${url}` };
  }

  elementFor(clip, src) {
    if (src.type === 'placeholder') return null;
    if (src.type === 'image') {
      let img = this.images.get(src.url);
      if (!img) {
        img = new Image();
        img.onload = () => this.invalidate();
        img.src = src.url;
        this.images.set(src.url, img);
      }
      return img;
    }
    let entry = this.elements.get(clip.id);
    if (entry && entry.key !== src.key) { this.disposeEl(entry.el); entry = null; }
    if (!entry) {
      const el = document.createElement(src.type === 'audio' ? 'audio' : 'video');
      el.preload = 'auto';
      el.playsInline = true;
      el.src = src.url;
      el.addEventListener('seeked', () => this.invalidate());
      el.addEventListener('loadeddata', () => this.invalidate());
      entry = { el, key: src.key };
      this.elements.set(clip.id, entry);
    }
    return entry.el;
  }

  /** Remove elements whose clips are gone. */
  gc(liveIds) {
    for (const [id, { el }] of this.elements) {
      if (!liveIds.has(id)) { this.disposeEl(el); this.elements.delete(id); }
    }
  }

  tick = (now) => {
    this.raf = requestAnimationFrame(this.tick);
    const dur = this.store.duration();
    if (this.playing) {
      this.time = this.t0 + (now - this.wall0) / 1000;
      if (this.time >= dur) { this.time = dur; this.pause(); }
    }
    this.syncAndDraw();
    if (this.onTime && this.time !== this.lastEmitted) {
      this.lastEmitted = this.time;
      this.onTime(this.time);
    }
  };

  syncAndDraw() {
    const { comp, tracks } = this.store;
    const t = this.time;
    const live = new Set();
    const visuals = [];
    const fps = comp.fps || 30;

    tracks.forEach((track, trackIndex) => {
      for (const clip of track.clips) {
        live.add(clip.id);
        const start = clip.timeline_start;
        const dur = clipDuration(clip);
        const active = t >= start && t < start + dur;
        // Create media elements lazily: only for clips that are playing or about to.
        const soon = t >= start - 2 && t < start + dur;
        if (!active && !soon) {
          const entry = this.elements.get(clip.id);
          if (entry && !entry.el.paused) entry.el.pause();
          continue;
        }
        const src = this.sourceOf(clip, track);
        if (!src) continue;
        const el = this.elementFor(clip, src);
        const isMedia = el instanceof HTMLMediaElement;
        if (!active) {
          // Pre-roll: park the element on its first frame so playback starts instantly.
          if (isMedia && !el.seeking && Math.abs(el.currentTime - clip.source_in) > 0.1) el.currentTime = clip.source_in;
          continue;
        }
        const local = t - start;
        const fade = fadeGain(clip, local, dur);
        if (isMedia) {
          const srcT = clip.source_in + local * clip.speed;
          const audible = src.hasAudio && !track.muted && !clip.muted;
          el.muted = !audible;
          el.volume = Math.max(0, Math.min(1, clip.volume * track.volume * fade));
          if (this.playing) {
            if (el.playbackRate !== clip.speed) el.playbackRate = clip.speed;
            if (Math.abs(el.currentTime - srcT) > DRIFT * Math.max(1, clip.speed)) el.currentTime = srcT;
            if (el.paused) el.play().catch(() => {});
          } else {
            if (!el.paused) el.pause();
            if (!el.seeking && Math.abs(el.currentTime - srcT) > 0.5 / fps) el.currentTime = srcT;
          }
        }
        if (track.kind === 'video' && !track.hidden && src.type !== 'audio') {
          visuals.push({ trackIndex, clip, el, src, alpha: clip.opacity * fade });
        }
      }
    });
    this.gc(live);

    if (!this.playing && !this.dirty) return;
    this.dirty = false;
    const ctx = this.ctx;
    const W = comp.width;
    const H = comp.height;
    ctx.globalAlpha = 1;
    ctx.fillStyle = comp.background_color;
    ctx.fillRect(0, 0, W, H);
    // Top track (index 0) is drawn last.
    visuals.sort((a, b) => b.trackIndex - a.trackIndex);
    this.lastVisuals = [];
    for (const v of visuals) {
      const { clip, el, src } = v;
      const rect = clipRect(clip, src.w || 16, src.h || 9, W, H);
      this.lastVisuals.push({ clip, rect });
      ctx.globalAlpha = Math.max(0, Math.min(1, v.alpha));
      if (src.type === 'placeholder') {
        ctx.fillStyle = '#3b2a12';
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        ctx.fillStyle = '#f59e0b';
        ctx.font = `${Math.round(Math.max(14, rect.h / 14))}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(`▣ ${src.name}`, rect.x + rect.w / 2, rect.y + rect.h / 2);
        ctx.font = `${Math.round(Math.max(11, rect.h / 24))}px system-ui, sans-serif`;
        ctx.fillText('Отрендерите композицию для превью', rect.x + rect.w / 2, rect.y + rect.h / 2 + rect.h / 12);
        continue;
      }
      const vw = el.videoWidth || el.naturalWidth;
      const vh = el.videoHeight || el.naturalHeight;
      if (!vw || !vh || (el instanceof HTMLMediaElement && el.readyState < 2)) continue;
      const sx = clip.crop_left * vw;
      const sy = clip.crop_top * vh;
      const sw = vw * (1 - clip.crop_left - clip.crop_right);
      const sh = vh * (1 - clip.crop_top - clip.crop_bottom);
      try { ctx.drawImage(el, sx, sy, sw, sh, rect.x, rect.y, rect.w, rect.h); } catch (_) { /* not ready */ }
    }
    ctx.globalAlpha = 1;
    if (this.selectedId) {
      const sel = this.lastVisuals.find((v) => v.clip.id === this.selectedId);
      if (sel) {
        ctx.strokeStyle = '#818cf8';
        ctx.lineWidth = Math.max(2, W / 480);
        ctx.setLineDash([W / 96, W / 192]);
        ctx.strokeRect(sel.rect.x, sel.rect.y, sel.rect.w, sel.rect.h);
        ctx.setLineDash([]);
      }
    }
  }

  /** Topmost visible clip at canvas coordinates. */
  hitTest(x, y) {
    const list = this.lastVisuals || [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const { clip, rect } = list[i];
      if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) return clip.id;
    }
    return null;
  }
}

function fadeGain(clip, local, dur) {
  let g = 1;
  if (clip.fade_in > 0) g = Math.min(g, local / clip.fade_in);
  if (clip.fade_out > 0) g = Math.min(g, (dur - local) / clip.fade_out);
  return Math.max(0, Math.min(1, g));
}
