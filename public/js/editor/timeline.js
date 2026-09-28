// Timeline view: track headers, ruler, clips with move / trim / drop interactions.
import { h, mount } from '../ui.js';
import { clipDuration, clipEnd, overlaps, MIN_CLIP } from './model.js';

const SNAP_PX = 8;

export class Timeline {
  constructor(container, editor) {
    this.editor = editor;
    this.zoom = 60; // px per second
    this.snap = true;
    this.heads = h('div', { class: 'tl-heads-inner' });
    this.content = h('div', { class: 'tl-content' });
    this.scroll = h('div', { class: 'tl-scroll' }, this.content);
    this.ruler = h('div', { class: 'ruler' });
    this.lanes = h('div');
    this.playhead = h('div', { class: 'playhead' });
    this.endMarker = h('div', { class: 'end-marker' });
    this.snapline = h('div', { class: 'snapline hidden' });
    this.content.append(this.ruler, this.lanes, this.endMarker, this.playhead, this.snapline);
    this.tools = h('div', { class: 'tl-tools' });
    container.append(this.tools, h('div', { class: 'tl-heads' }, this.heads), this.scroll);

    this.scroll.addEventListener('scroll', () => {
      this.heads.style.transform = `translateY(${-this.scroll.scrollTop}px)`;
      this.drawRuler();
    });
    this.scroll.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = this.scroll.getBoundingClientRect();
      const t = this.xToTime(e.clientX - rect.left + this.scroll.scrollLeft);
      this.setZoom(this.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), t, e.clientX - rect.left);
    }, { passive: false });
    this.ruler.addEventListener('pointerdown', (e) => this.startScrub(e));
    this.lanes.addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('lane')) {
        this.editor.select(null);
        this.startScrub(e);
      }
    });
    new ResizeObserver(() => this.layout()).observe(this.scroll);
  }

  xToTime(x) { return Math.max(0, x / this.zoom); }

  setZoom(z, anchorTime, anchorX) {
    this.zoom = Math.max(4, Math.min(600, z));
    if (this.zoomInput) this.zoomInput.value = Math.log(this.zoom);
    this.render();
    if (anchorTime !== undefined) this.scroll.scrollLeft = anchorTime * this.zoom - anchorX;
  }

  zoomToFit() {
    const d = Math.max(10, this.editor.duration());
    this.setZoom((this.scroll.clientWidth - 40) / d);
    this.scroll.scrollLeft = 0;
  }

  layout() {
    const total = Math.max(this.editor.duration() + 30, this.scroll.clientWidth / this.zoom);
    this.content.style.width = `${total * this.zoom}px`;
    const d = this.editor.duration();
    this.endMarker.style.left = `${d * this.zoom}px`;
    this.endMarker.style.width = `${Math.max(0, (total - d) * this.zoom)}px`;
    this.drawRuler();
    this.updatePlayhead();
  }

  drawRuler() {
    const { fps } = this.editor.comp;
    const steps = [1 / fps, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const major = steps.find((s) => s * this.zoom >= 80) || 600;
    const minor = major / (major >= 1 ? 5 : 4);
    const from = Math.floor(this.scroll.scrollLeft / this.zoom / major) * major;
    const to = (this.scroll.scrollLeft + this.scroll.clientWidth) / this.zoom;
    const ticks = [];
    for (let t = from; t <= to + major; t += minor) {
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ticks.push(h('div', { class: `tick${isMajor ? '' : ' minor'}`, style: { left: `${t * this.zoom}px` } },
        isMajor ? rulerLabel(t, major) : null));
    }
    mount(this.ruler, ticks);
  }

  updatePlayhead() {
    const x = this.editor.time() * this.zoom;
    this.playhead.style.left = `${x}px`;
    // Keep playhead visible while playing.
    if (this.editor.isPlaying()) {
      const { scrollLeft, clientWidth } = this.scroll;
      if (x > scrollLeft + clientWidth - 40 || x < scrollLeft) this.scroll.scrollLeft = x - 40;
    }
  }

  startScrub(e) {
    e.preventDefault();
    const rect = this.scroll.getBoundingClientRect();
    const seek = (ev) => this.editor.seek(this.xToTime(ev.clientX - rect.left + this.scroll.scrollLeft));
    seek(e);
    const move = (ev) => seek(ev);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  renderTools(buttons) {
    this.zoomInput = h('input', {
      type: 'range', min: Math.log(4), max: Math.log(600), step: 0.01, value: Math.log(this.zoom), title: 'Масштаб (Ctrl + колесо)',
      oninput: (e) => {
        const center = this.xToTime(this.scroll.scrollLeft + this.scroll.clientWidth / 2);
        this.setZoom(Math.exp(Number(e.target.value)), center, this.scroll.clientWidth / 2);
      },
    });
    const snapBtn = h('button', {
      class: `icon${this.snap ? ' active' : ''}`, title: 'Прилипание к краям клипов и курсору',
      onclick: () => { this.snap = !this.snap; snapBtn.classList.toggle('active', this.snap); },
    }, '🧲');
    mount(this.tools, buttons, h('div', { class: 'spacer' }), snapBtn,
      h('button', { class: 'icon', title: 'Вместить всё', onclick: () => this.zoomToFit() }, '⤢'),
      h('span', { class: 'muted small' }, 'Масштаб'), this.zoomInput);
  }

  render() {
    const { editor } = this;
    const tracks = editor.tracks;
    mount(this.heads, h('div', { class: 'tl-head-spacer' }), tracks.map((track, i) => this.renderHead(track, i)));
    mount(this.lanes, tracks.map((track) => {
      const lane = h('div', { class: `lane${track.hidden || track.muted ? ' dim' : ''}`, dataset: { trackId: track.id } },
        track.clips.map((clip) => this.renderClip(track, clip)));
      this.wireDrop(lane, track);
      return lane;
    }));
    this.layout();
  }

  renderHead(track, index) {
    const { editor } = this;
    const name = h('input', {
      class: 'tname', value: track.name, maxLength: 100,
      onchange: (e) => editor.commit(() => { track.name = e.target.value.trim() || track.name; }),
      onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); e.stopPropagation(); },
    });
    const btn = (label, title, on, fn) => h('button', { class: `ghost${on ? ' active' : ''}`, title, onclick: fn }, label);
    return h('div', { class: `track-head ${track.kind}` }, name,
      h('div', { class: 'tbtns' },
        btn(track.muted ? '🔇' : '🔊', 'Выключить звук дорожки', track.muted, () => editor.commit(() => { track.muted = !track.muted; })),
        track.kind === 'video' && btn(track.hidden ? '🚫' : '👁', 'Скрыть видео дорожки', track.hidden, () => editor.commit(() => { track.hidden = !track.hidden; })),
        btn('↑', 'Выше', false, () => editor.moveTrack(index, -1)),
        btn('↓', 'Ниже', false, () => editor.moveTrack(index, 1)),
        btn('⇤', 'Соединить: убрать промежутки между клипами', false, () => editor.closeGaps(track)),
        btn('✕', 'Удалить дорожку', false, () => editor.removeTrack(track))));
  }

  clipLabel(clip) {
    const { media, comps } = this.editor;
    if (clip.source_type === 'composition') {
      const c = comps.get(clip.source_composition_id);
      return { name: `▣ ${c ? c.name : 'Композиция'}`, kind: 'comp' };
    }
    const m = media.get(clip.media_id);
    return { name: m ? m.name : '—', kind: m ? m.kind : 'video', media: m };
  }

  renderClip(track, clip) {
    const { editor } = this;
    const { name, kind, media } = this.clipLabel(clip);
    const cls = track.kind === 'audio' ? 'audio' : kind === 'image' ? 'image' : kind === 'comp' ? 'comp' : 'video';
    const el = h('div', {
      class: `clip ${cls}${editor.selection.has(clip.id) ? ' selected' : ''}${clip.muted ? ' muted-clip' : ''}`,
      dataset: { clipId: clip.id },
      title: name,
    },
    h('div', { class: 'label' }, name),
    clip.speed !== 1 ? h('div', { class: 'speed' }, `${clip.speed}×`) : null,
    h('div', { class: 'fade in' }), h('div', { class: 'fade out' }),
    h('div', { class: 'handle l' }), h('div', { class: 'handle r' }));
    if (media && track.kind === 'audio' && media.waveform_url) el.style.backgroundImage = `url(${media.waveform_url})`;
    else if (media && track.kind === 'video' && media.thumbnail_url) el.style.backgroundImage = `url(${media.thumbnail_url})`;
    this.placeClip(el, clip, media);
    el.addEventListener('pointerdown', (e) => this.onClipPointerDown(e, track, clip, el));
    el.addEventListener('dblclick', () => editor.seek(clip.timeline_start));
    return el;
  }

  placeClip(el, clip, media = this.clipLabel(clip).media) {
    const dur = clipDuration(clip);
    el.style.left = `${clip.timeline_start * this.zoom}px`;
    el.style.width = `${Math.max(2, dur * this.zoom)}px`;
    el.querySelector('.fade.in').style.width = `${Math.min(dur, clip.fade_in) * this.zoom}px`;
    el.querySelector('.fade.out').style.width = `${Math.min(dur, clip.fade_out) * this.zoom}px`;
    if (media && el.classList.contains('audio') && media.duration) {
      // Stretch the full-file waveform so that the visible part matches source_in..source_out.
      const full = (media.duration / clip.speed) * this.zoom;
      el.style.backgroundSize = `${full}px 100%`;
      el.style.backgroundPositionX = `${(-clip.source_in / clip.speed) * this.zoom}px`;
    }
  }

  /** Upper bound of a clip's source_out. */
  sourceMax(clip) {
    if (clip.source_type === 'composition') {
      const c = this.editor.comps.get(clip.source_composition_id);
      return c ? Math.max(c.effective_duration, MIN_CLIP) : clip.source_out;
    }
    const m = this.editor.media.get(clip.media_id);
    if (!m || m.kind === 'image') return 3600;
    return m.duration;
  }

  snapTimes(ignoreIds) {
    const times = [0, this.editor.time()];
    for (const t of this.editor.tracks) {
      for (const c of t.clips) if (!ignoreIds.has(c.id)) times.push(c.timeline_start, clipEnd(c));
    }
    return times;
  }

  snapValue(value, candidates) {
    if (!this.snap) return { value, snapped: null };
    let best = null;
    for (const c of candidates) {
      const d = Math.abs(c - value) * this.zoom;
      if (d < SNAP_PX && (!best || d < best.d)) best = { d, c };
    }
    return best ? { value: best.c, snapped: best.c } : { value, snapped: null };
  }

  showSnap(t) {
    if (t === null) this.snapline.classList.add('hidden');
    else { this.snapline.classList.remove('hidden'); this.snapline.style.left = `${t * this.zoom}px`; }
  }

  onClipPointerDown(e, track, clip, el) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const { editor } = this;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (additive || !editor.selection.has(clip.id)) editor.select(clip.id, additive);
    el = this.lanes.querySelector(`[data-clip-id="${clip.id}"]`) || el;

    const mode = e.target.classList.contains('handle') ? (e.target.classList.contains('l') ? 'trim-l' : 'trim-r') : 'move';
    const startX = e.clientX;
    const orig = { ...clip };
    const before = editor.snapshot();
    const ignore = new Set([clip.id]);
    const snaps = this.snapTimes(ignore);
    const neighbours = track.clips.filter((c) => c.id !== clip.id);
    const prevEnd = Math.max(0, ...neighbours.filter((c) => clipEnd(c) <= orig.timeline_start + 1e-6).map(clipEnd));
    const nextStart = Math.min(Infinity, ...neighbours.filter((c) => c.timeline_start >= clipEnd(orig) - 1e-6).map((c) => c.timeline_start));
    const isImage = clip.source_type === 'media' && editor.media.get(clip.media_id)?.kind === 'image';
    let currentTrack = track;
    let moved = false;

    const onMove = (ev) => {
      const dt = (ev.clientX - startX) / this.zoom;
      if (!moved && Math.abs(ev.clientX - startX) < 3) return;
      moved = true;
      el.classList.add('dragging');
      if (mode === 'move') {
        const dur = clipDuration(orig);
        let start = Math.max(0, orig.timeline_start + dt);
        const a = this.snapValue(start, snaps);
        const b = this.snapValue(start + dur, snaps);
        if (a.snapped !== null) { start = a.value; this.showSnap(a.snapped); }
        else if (b.snapped !== null) { start = b.value - dur; this.showSnap(b.snapped); }
        else this.showSnap(null);
        clip.timeline_start = Math.max(0, start);
        // Vertical move to another track of the same kind.
        const lane = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.lane');
        const target = lane && editor.tracks.find((t) => t.id === lane.dataset.trackId);
        if (target && target !== currentTrack && target.kind === currentTrack.kind) {
          currentTrack.clips = currentTrack.clips.filter((c) => c.id !== clip.id);
          target.clips.push(clip);
          lane.append(el);
          currentTrack = target;
        }
        el.classList.toggle('invalid', overlaps(currentTrack, clip.timeline_start, clipEnd(clip), ignore));
      } else if (mode === 'trim-l') {
        let start = orig.timeline_start + dt;
        const s = this.snapValue(start, snaps);
        start = s.value;
        this.showSnap(s.snapped);
        const minStart = Math.max(prevEnd, isImage ? 0 : orig.timeline_start - orig.source_in / orig.speed);
        const maxStart = clipEnd(orig) - MIN_CLIP;
        start = Math.max(minStart, Math.min(maxStart, start));
        if (isImage) {
          clip.timeline_start = start;
          clip.source_out = orig.source_out - (start - orig.timeline_start);
        } else {
          clip.timeline_start = start;
          clip.source_in = Math.max(0, orig.source_in + (start - orig.timeline_start) * orig.speed);
        }
      } else {
        let end = clipEnd(orig) + dt;
        const s = this.snapValue(end, snaps);
        end = s.value;
        this.showSnap(s.snapped);
        const maxEnd = Math.min(nextStart, orig.timeline_start + (this.sourceMax(orig) - orig.source_in) / orig.speed);
        end = Math.max(orig.timeline_start + MIN_CLIP, Math.min(maxEnd, end));
        clip.source_out = orig.source_in + (end - orig.timeline_start) * orig.speed;
      }
      this.placeClip(el, clip);
      editor.onLiveChange(clip);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      this.showSnap(null);
      el.classList.remove('dragging');
      if (!moved) return;
      if (mode === 'move' && overlaps(currentTrack, clip.timeline_start, clipEnd(clip), ignore)) {
        editor.restore(before);
        editor.toast('Клипы на одной дорожке не могут перекрываться');
        return;
      }
      editor.commitFrom(before);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  wireDrop(lane, track) {
    const { editor } = this;
    const accepts = (e) => e.dataTransfer.types.includes(`application/x-wreso-${track.kind}`);
    lane.addEventListener('dragover', (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      lane.classList.add('drop');
    });
    lane.addEventListener('dragleave', () => lane.classList.remove('drop'));
    lane.addEventListener('drop', (e) => {
      lane.classList.remove('drop');
      if (!accepts(e)) return;
      e.preventDefault();
      const payload = JSON.parse(e.dataTransfer.getData('application/json'));
      const rect = lane.getBoundingClientRect();
      const t = this.xToTime(e.clientX - rect.left);
      editor.addSource(payload, { track, time: t });
    });
  }
}


function rulerLabel(t, step) {
  const m = Math.floor(t / 60 + 1e-9);
  const sec = t - m * 60;
  const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  const s = sec.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0');
  return `${m}:${s}`;
}
