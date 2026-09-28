import { api } from '../api.js';
import { h, mount, modal, toast, formatTime, formatDuration, confirmDialog, KIND_LABEL } from '../ui.js';
import { navigate, topbar } from '../app.js';
import { compositionDialog, uploadFiles, dropzone, ACCEPT } from '../shared.js';
import {
  clipDuration, clipEnd, contentDuration, newClip, newTrack, sortClips, splitClip, freeSlot,
  cloneTracks, findClip, overlaps, IMAGE_DEFAULT, MIN_CLIP,
} from '../editor/model.js';
import { Preview } from '../editor/preview.js';
import { Timeline } from '../editor/timeline.js';
import { Inspector } from '../editor/inspector.js';

export async function editorPage({ root, onCleanup }, compositionId) {
  const data = await api.get(`/compositions/${compositionId}`);

  const ed = {
    comp: data.composition,
    project: data.project,
    tracks: data.tracks.map((t) => ({ ...t, clips: t.clips.map(stripClip) })),
    media: new Map(data.media.map((m) => [m.id, m])),
    comps: new Map(),
    nestedRenders: new Map(),
    selection: new Set(),
    undo: [],
    redo: [],
  };
  setCompositions(data.compositions);

  function stripClip(c) {
    const { track_id, composition_id, ...rest } = c; // eslint-disable-line no-unused-vars
    return rest;
  }

  function setCompositions(list) {
    ed.comps = new Map(list.map((c) => [c.id, c]));
    ed.nestedRenders = new Map(list.filter((c) => c.preview_url).map((c) => [c.id, c.preview_url]));
  }

  // ---------------------------------------------------------------- layout
  const saveState = h('span', { class: 'muted small' }, 'Сохранено');
  const undoBtn = h('button', { class: 'icon ghost', title: 'Отменить (Ctrl+Z)', onclick: () => undo() }, '↶');
  const redoBtn = h('button', { class: 'icon ghost', title: 'Повторить (Ctrl+Shift+Z)', onclick: () => redo() }, '↷');
  const compTitle = h('b', {}, ed.comp.name);
  const header = topbar(
    h('a', { href: '/projects', 'data-link': '' }, 'Проекты'), '/',
    h('a', { href: `/projects/${ed.project.id}`, 'data-link': '' }, ed.project.name), '/',
    compTitle,
  );
  header.querySelector('.spacer').after(saveState, undoBtn, redoBtn,
    h('button', { onclick: () => ed.openSettings() }, '⚙ Холст'),
    h('button', { class: 'primary', onclick: () => ed.openExport() }, '⬇ Экспорт'));

  const canvas = h('canvas');
  const playBtn = h('button', { class: 'icon', title: 'Воспроизвести (Пробел)', onclick: () => preview.toggle() }, '▶');
  const timecode = h('span', { class: 'timecode' });
  const volumeHint = h('span', { class: 'muted small' });
  const stage = h('div', { class: 'stage' },
    h('div', { class: 'viewport' }, canvas),
    h('div', { class: 'transport' },
      h('button', { class: 'icon ghost', title: 'В начало (Home)', onclick: () => ed.seek(0) }, '⏮'),
      h('button', { class: 'icon ghost', title: 'Кадр назад (←)', onclick: () => step(-1) }, '◀'),
      playBtn,
      h('button', { class: 'icon ghost', title: 'Кадр вперёд (→)', onclick: () => step(1) }, '▶▏'),
      h('button', { class: 'icon ghost', title: 'В конец (End)', onclick: () => ed.seek(ed.duration()) }, '⏭'),
      h('div', { class: 'spacer' }), timecode, h('div', { class: 'spacer' }), volumeHint));

  const binBody = h('div', { class: 'side-body' });
  const tabMedia = h('button', { class: 'on', onclick: () => showTab('media') }, 'Медиа');
  const tabComps = h('button', { onclick: () => showTab('comps') }, 'Композиции');
  const left = h('aside', { class: 'side' }, h('div', { class: 'tabs' }, tabMedia, tabComps), binBody);
  const inspectorEl = h('div', { class: 'inspector' });
  const right = h('aside', { class: 'side right' }, inspectorEl);
  const timelineEl = h('section', { class: 'timeline' });
  const splitter = h('div', { class: 'splitter', title: 'Потяните, чтобы изменить высоту таймлайна' });
  const layout = h('div', { class: 'editor' }, header, h('div', { class: 'editor-main' }, left, stage, right), splitter, timelineEl);
  mount(root, layout);

  const savedH = Number(localStorage.getItem('wreso.timelineH'));
  if (savedH > 150) layout.style.setProperty('--timeline-h', `${savedH}px`);
  splitter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const move = (ev) => {
      const hgt = Math.max(160, Math.min(window.innerHeight - 250, window.innerHeight - ev.clientY));
      layout.style.setProperty('--timeline-h', `${hgt}px`);
      try { localStorage.setItem('wreso.timelineH', String(hgt)); } catch (_) { /* ignore */ }
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  // ---------------------------------------------------------------- core API used by views
  ed.duration = () => ed.comp.duration || contentDuration(ed.tracks);
  ed.time = () => preview.time;
  ed.isPlaying = () => preview.playing;
  ed.toast = (msg, type = 'info') => toast(msg, type);
  ed.seek = (t) => { preview.seek(t); timeline.updatePlayhead(); };
  ed.snapshot = () => JSON.stringify(ed.tracks);
  ed.selectedClips = () => [...ed.selection].map((id) => findClip(ed.tracks, id)).filter(Boolean);

  ed.select = (id, additive = false) => {
    if (!id) ed.selection.clear();
    else if (additive) { if (ed.selection.has(id)) ed.selection.delete(id); else ed.selection.add(id); }
    else { ed.selection.clear(); ed.selection.add(id); }
    preview.selectedId = ed.selection.size === 1 ? [...ed.selection][0] : null;
    preview.invalidate();
    for (const el of timelineEl.querySelectorAll('.clip')) el.classList.toggle('selected', ed.selection.has(el.dataset.clipId));
    inspector.render();
  };

  ed.restore = (snap) => {
    ed.tracks = JSON.parse(snap);
    for (const id of [...ed.selection]) if (!findClip(ed.tracks, id)) ed.selection.delete(id);
    refresh();
  };

  ed.commit = (fn) => {
    const before = ed.snapshot();
    fn();
    ed.commitFrom(before);
  };

  ed.commitFrom = (before) => {
    normalize();
    if (ed.snapshot() === before) { refresh(); return; }
    ed.undo.push(before);
    if (ed.undo.length > 200) ed.undo.shift();
    ed.redo = [];
    refresh();
    scheduleSave();
  };

  ed.onLiveChange = (clip) => {
    preview.invalidate();
    const el = timelineEl.querySelector(`[data-clip-id="${clip.id}"]`);
    if (el) timeline.placeClip(el, clip);
    if (inspector.refreshReadouts) inspector.refreshReadouts();
  };

  function refresh() {
    for (const t of ed.tracks) sortClips(t);
    timeline.render();
    inspector.render();
    preview.selectedId = ed.selection.size === 1 ? [...ed.selection][0] : null;
    preview.invalidate();
    undoBtn.disabled = !ed.undo.length;
    redoBtn.disabled = !ed.redo.length;
    updateTimecode();
  }

  function undo() {
    if (!ed.undo.length) return;
    ed.redo.push(ed.snapshot());
    ed.restore(ed.undo.pop());
    scheduleSave();
    undoBtn.disabled = !ed.undo.length; redoBtn.disabled = !ed.redo.length;
  }

  function redo() {
    if (!ed.redo.length) return;
    ed.undo.push(ed.snapshot());
    ed.restore(ed.redo.pop());
    scheduleSave();
    undoBtn.disabled = !ed.undo.length; redoBtn.disabled = !ed.redo.length;
  }

  /** Keep every clip inside its source bounds before saving. */
  function normalize() {
    for (const t of ed.tracks) {
      for (const c of t.clips) {
        const max = timeline.sourceMax(c);
        c.speed = Math.max(0.1, Math.min(10, c.speed || 1));
        c.timeline_start = Math.max(0, c.timeline_start);
        c.source_in = Math.max(0, Math.min(c.source_in, max - MIN_CLIP));
        c.source_out = Math.max(c.source_in + MIN_CLIP, Math.min(c.source_out, max));
      }
    }
  }

  // ---------------------------------------------------------------- saving
  let saveTimer = null;
  let saving = false;
  let dirty = false;

  function scheduleSave() {
    dirty = true;
    saveState.textContent = 'Изменения…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 700);
  }

  async function save() {
    if (saving) { saveTimer = setTimeout(save, 300); return; }
    if (!dirty) return;
    saving = true;
    dirty = false;
    saveState.textContent = 'Сохранение…';
    try {
      const payload = ed.tracks.map((t) => ({
        id: t.id, kind: t.kind, name: t.name, muted: t.muted, hidden: t.hidden, volume: t.volume, clips: t.clips,
      }));
      await api.put(`/compositions/${ed.comp.id}/timeline`, { tracks: payload });
      if (!dirty) saveState.textContent = 'Сохранено';
    } catch (err) {
      dirty = true;
      saveState.textContent = '⚠ Не сохранено';
      toast(`Ошибка сохранения: ${err.message}`, 'error', 6000);
    } finally {
      saving = false;
    }
  }

  const beforeUnload = (e) => { if (dirty || saving) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);

  // ---------------------------------------------------------------- editing operations
  function trackFor(kind) {
    let track = ed.tracks.find((t) => t.kind === kind);
    if (!track) {
      track = newTrack(kind, ed.tracks);
      if (kind === 'video') ed.tracks.unshift(track); else ed.tracks.push(track);
    }
    return track;
  }

  ed.addSource = (payload, { track, time, append = false } = {}) => {
    let clip;
    let kind;
    if (payload.type === 'media') {
      const m = ed.media.get(payload.id);
      if (!m) return;
      kind = track ? track.kind : (m.kind === 'audio' ? 'audio' : 'video');
      if (kind === 'audio' && !m.has_audio) { toast('У этого файла нет звука'); return; }
      if (kind === 'video' && m.kind === 'audio') { toast('Аудио размещается на аудиодорожке'); return; }
      const len = m.kind === 'image' ? IMAGE_DEFAULT : m.duration;
      clip = newClip({ source_type: 'media', media_id: m.id, source_in: 0, source_out: len });
    } else {
      const c = ed.comps.get(payload.id);
      if (!c) return;
      if (c.id === ed.comp.id) { toast('Нельзя вложить композицию саму в себя', 'error'); return; }
      if (!(c.effective_duration > 0)) { toast('Эта композиция пустая — добавьте в неё клипы', 'error'); return; }
      kind = track ? track.kind : 'video';
      clip = newClip({ source_type: 'composition', source_composition_id: c.id, source_in: 0, source_out: c.effective_duration });
    }
    const wasEmpty = contentDuration(ed.tracks) === 0;
    ed.commit(() => {
      const target = track || trackFor(kind);
      const len = clipDuration(clip);
      const at = append ? contentDuration([target]) : (time ?? preview.time);
      clip.timeline_start = freeSlot(target, at, len);
      target.clips.push(clip);
      ed.selection.clear();
      ed.selection.add(clip.id);
    });
    if (wasEmpty) timeline.zoomToFit();
  };

  ed.split = () => {
    const t = preview.time;
    let targets = ed.selectedClips().filter(({ clip }) => t > clip.timeline_start && t < clipEnd(clip));
    if (!targets.length) {
      targets = ed.tracks.flatMap((track) => track.clips
        .filter((clip) => t > clip.timeline_start && t < clipEnd(clip)).map((clip) => ({ track, clip })));
    }
    if (!targets.length) { toast('Поставьте курсор на клип, чтобы разрезать его'); return; }
    ed.commit(() => {
      for (const { track, clip } of targets) {
        const right = splitClip(clip, t);
        if (right) track.clips.push(right);
      }
    });
  };

  ed.remove = (ripple) => {
    const sel = ed.selectedClips();
    if (!sel.length) return;
    ed.commit(() => {
      for (const { track, clip } of sel) {
        track.clips = track.clips.filter((c) => c.id !== clip.id);
        if (ripple) {
          const d = clipDuration(clip);
          for (const c of track.clips) if (c.timeline_start >= clipEnd(clip) - 1e-6) c.timeline_start = Math.max(0, c.timeline_start - d);
        }
      }
      ed.selection.clear();
    });
  };

  ed.duplicate = () => {
    const sel = ed.selectedClips();
    if (!sel.length) return;
    ed.commit(() => {
      ed.selection.clear();
      for (const { track, clip } of sel) {
        const copy = { ...clip, id: newClip().id };
        copy.timeline_start = freeSlot(track, clipEnd(clip), clipDuration(clip));
        track.clips.push(copy);
        ed.selection.add(copy.id);
      }
    });
  };

  ed.setSpeed = (clip, speed) => {
    if (!Number.isFinite(speed) || speed < 0.1 || speed > 10) { toast('Скорость от 0.1× до 10×', 'error'); return; }
    const found = findClip(ed.tracks, clip.id);
    if (!found) return;
    const newEnd = clip.timeline_start + (clip.source_out - clip.source_in) / speed;
    if (overlaps(found.track, clip.timeline_start, newEnd, new Set([clip.id]))) {
      toast('Клип станет длиннее и наложится на соседний — освободите место справа', 'error');
      inspector.render();
      return;
    }
    ed.commit(() => { clip.speed = speed; });
  };

  ed.detachAudio = () => {
    const sel = ed.selectedClips().filter(({ track }) => track.kind === 'video');
    if (!sel.length) return;
    ed.commit(() => {
      for (const { clip } of sel) {
        const copy = {
          ...clip, id: newClip().id, crop_left: 0, crop_top: 0, crop_right: 0, crop_bottom: 0,
          pos_x: 0, pos_y: 0, scale: 1, opacity: 1, muted: false,
        };
        let target = ed.tracks.find((t) => t.kind === 'audio' && !overlaps(t, copy.timeline_start, clipEnd(copy)));
        if (!target) { target = newTrack('audio', ed.tracks); ed.tracks.push(target); }
        target.clips.push(copy);
        clip.muted = true;
      }
    });
    toast('Звук перенесён на аудиодорожку', 'ok');
  };

  ed.fitClip = (clip, mode) => {
    ed.commit(() => {
      clip.pos_x = 0; clip.pos_y = 0; clip.scale = 1;
      if (mode === 'reset') {
        clip.crop_left = 0; clip.crop_top = 0; clip.crop_right = 0; clip.crop_bottom = 0; clip.opacity = 1;
        return;
      }
      // "Cover": scale so the clip fills the whole canvas.
      const src = preview.sourceOf(clip, { kind: 'video' });
      if (!src || !src.w) return;
      const cw = src.w * (1 - clip.crop_left - clip.crop_right);
      const ch = src.h * (1 - clip.crop_top - clip.crop_bottom);
      const { width: W, height: H } = ed.comp;
      clip.scale = Math.max(W / cw, H / ch) / Math.min(W / cw, H / ch);
    });
  };

  ed.closeGaps = (track) => ed.commit(() => {
    sortClips(track);
    let cursor = 0;
    for (const c of track.clips) { c.timeline_start = cursor; cursor = clipEnd(c); }
  });

  ed.moveTrack = (index, dir) => {
    const j = index + dir;
    if (j < 0 || j >= ed.tracks.length) return;
    ed.commit(() => { [ed.tracks[index], ed.tracks[j]] = [ed.tracks[j], ed.tracks[index]]; });
  };

  ed.addTrack = (kind) => ed.commit(() => {
    const t = newTrack(kind, ed.tracks);
    if (kind === 'video') ed.tracks.unshift(t); else ed.tracks.push(t);
  });

  ed.removeTrack = async (track) => {
    if (track.clips.length && !(await confirmDialog(`Удалить дорожку «${track.name}» вместе с ${track.clips.length} клип(ами)?`))) return;
    ed.commit(() => {
      ed.tracks = ed.tracks.filter((t) => t !== track);
      for (const c of track.clips) ed.selection.delete(c.id);
    });
  };

  ed.openSettings = async () => {
    const payload = await compositionDialog(ed.comp);
    if (!payload) return;
    try {
      const { composition } = await api.patch(`/compositions/${ed.comp.id}`, payload);
      ed.comp = composition;
      compTitle.textContent = composition.name;
      preview.resize();
      refresh();
      toast('Настройки холста сохранены', 'ok');
    } catch (err) { toast(err.message, 'error'); }
  };

  ed.openExport = () => openExport();

  // ---------------------------------------------------------------- views
  const preview = new Preview(canvas, ed);
  const timeline = new Timeline(timelineEl, ed);
  const inspector = new Inspector(inspectorEl, ed);
  ed.timeline = timeline;

  timeline.renderTools([
    h('button', { title: 'Разрезать по курсору (S)', onclick: () => ed.split() }, '✂ Разрезать'),
    h('button', { class: 'danger', title: 'Удалить выбранное (Del)', onclick: () => ed.remove(false) }, '🗑'),
    h('button', { title: 'Отделить звук от видео', onclick: () => ed.detachAudio() }, '🎵 Отделить звук'),
    h('span', { class: 'muted small', style: { margin: '0 4px' } }, '|'),
    h('button', { onclick: () => ed.addTrack('video') }, '+ Видеодорожка'),
    h('button', { onclick: () => ed.addTrack('audio') }, '+ Аудиодорожка'),
  ]);

  function updateTimecode() {
    timecode.textContent = `${formatTime(preview.time, ed.comp.fps)} / ${formatTime(ed.duration(), ed.comp.fps)}`;
  }
  preview.onTime = () => { updateTimecode(); timeline.updatePlayhead(); };
  preview.onStateChange = (playing) => {
    playBtn.textContent = playing ? '❚❚' : '▶';
    volumeHint.textContent = '';
  };

  function step(frames) {
    preview.pause();
    ed.seek(preview.time + frames / ed.comp.fps);
  }

  // Click / drag clips directly on the canvas.
  canvas.addEventListener('pointerdown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const k = canvas.width / rect.width;
    const x = (e.clientX - rect.left) * k;
    const y = (e.clientY - rect.top) * k;
    const id = preview.hitTest(x, y);
    if (!id) { ed.select(null); return; }
    if (!ed.selection.has(id) || ed.selection.size > 1) ed.select(id);
    const found = findClip(ed.tracks, id);
    if (!found) return;
    const { clip } = found;
    e.preventDefault();
    const before = ed.snapshot();
    const ox = clip.pos_x;
    const oy = clip.pos_y;
    let moved = false;
    const move = (ev) => {
      const dx = (ev.clientX - e.clientX) * k;
      const dy = (ev.clientY - e.clientY) * k;
      if (!moved && Math.hypot(dx, dy) < 3 * k) return;
      moved = true;
      clip.pos_x = Math.round(ox + dx);
      clip.pos_y = Math.round(oy + dy);
      // Snap to canvas center.
      if (Math.abs(clip.pos_x) < 12 * k) clip.pos_x = 0;
      if (Math.abs(clip.pos_y) < 12 * k) clip.pos_y = 0;
      preview.invalidate();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) ed.commitFrom(before);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons) return;
    const rect = canvas.getBoundingClientRect();
    const k = canvas.width / rect.width;
    canvas.classList.toggle('draggable', Boolean(preview.hitTest((e.clientX - rect.left) * k, (e.clientY - rect.top) * k)));
  });

  // ---------------------------------------------------------------- bin (media + compositions)
  let currentTab = 'media';
  const uploads = h('div', { class: 'uploads' });
  const fileInput = h('input', { type: 'file', multiple: true, accept: ACCEPT, class: 'hidden' });
  const doUpload = async (files) => {
    const created = await uploadFiles(ed.project.id, files, uploads);
    for (const m of created) ed.media.set(m.id, m);
    if (created.length) drawBin();
  };
  fileInput.addEventListener('change', () => { doUpload(fileInput.files); fileInput.value = ''; });
  dropzone(left, doUpload);

  function showTab(tab) {
    currentTab = tab;
    tabMedia.classList.toggle('on', tab === 'media');
    tabComps.classList.toggle('on', tab === 'comps');
    drawBin();
  }

  function dragData(e, payload, kinds) {
    e.dataTransfer.setData('application/json', JSON.stringify(payload));
    for (const k of kinds) e.dataTransfer.setData(`application/x-wreso-${k}`, '1');
    e.dataTransfer.effectAllowed = 'copy';
  }

  function drawBin() {
    if (currentTab === 'media') {
      const items = [...ed.media.values()];
      mount(binBody,
        h('div', { class: 'row', style: { marginBottom: '10px' } },
          h('button', { class: 'primary', style: { flex: 1 }, onclick: () => fileInput.click() }, '⬆ Загрузить медиа'), fileInput),
        uploads,
        items.length ? h('div', { class: 'bin-list' }, items.map((m) => {
          const kinds = m.kind === 'audio' ? ['audio'] : m.kind === 'image' ? ['video'] : (m.has_audio ? ['video', 'audio'] : ['video']);
          const thumb = h('div', {
            class: `thumb${m.thumbnail_url ? '' : ' wave'}`,
            style: { backgroundImage: m.thumbnail_url ? `url(${m.thumbnail_url})` : m.waveform_url ? `url(${m.waveform_url})` : 'none' },
          },
          !m.thumbnail_url && !m.waveform_url ? '♪' : null,
          h('span', { class: `badge ${m.kind}` }, KIND_LABEL[m.kind]),
          m.duration ? h('span', { class: 'badge dur' }, formatDuration(m.duration)) : null,
          h('button', {
            class: 'add primary', title: 'Добавить на таймлайн в позицию курсора',
            onclick: (e) => { e.stopPropagation(); ed.addSource({ type: 'media', id: m.id }); },
          }, '+'));
          return h('div', {
            class: 'bin-item', draggable: true, title: `${m.name}\nПеретащите на дорожку или дважды щёлкните`,
            ondragstart: (e) => dragData(e, { type: 'media', id: m.id }, kinds),
            ondblclick: () => ed.addSource({ type: 'media', id: m.id }),
          }, thumb, h('div', { class: 'name' }, m.name));
        })) : h('div', { class: 'empty small' }, 'Перетащите сюда видео, аудио или изображения'));
    } else {
      const items = [...ed.comps.values()];
      mount(binBody,
        h('button', {
          class: 'primary', style: { width: '100%', marginBottom: '10px' },
          onclick: async () => {
            const payload = await compositionDialog();
            if (!payload) return;
            try {
              const { composition } = await api.post(`/projects/${ed.project.id}/compositions`, payload);
              ed.comps.set(composition.id, { ...composition, effective_duration: 0, preview_url: null });
              drawBin();
              toast('Композиция создана — откройте её, чтобы смонтировать', 'ok');
            } catch (err) { toast(err.message, 'error'); }
          },
        }, '+ Новая композиция'),
        h('p', { class: 'muted small' }, 'Перетащите композицию на дорожку, чтобы вложить её, или нажмите «⇥», чтобы присоединить в конец.'),
        items.map((c) => {
          const self = c.id === ed.comp.id;
          return h('div', {
            class: 'comp-item', draggable: !self,
            ondragstart: (e) => dragData(e, { type: 'composition', id: c.id }, ['video', 'audio']),
          },
          h('span', { class: 'badge comp' }, '▣'),
          h('div', { class: 'meta' },
            h('div', {}, c.name, self ? ' (текущая)' : ''),
            h('div', { class: 'muted small' }, `${c.width}×${c.height} · ${formatDuration(c.effective_duration)}${c.preview_url ? '' : ' · нет рендера'}`)),
          !self && h('button', { class: 'icon', title: 'Вставить в позицию курсора', onclick: () => ed.addSource({ type: 'composition', id: c.id }) }, '+'),
          !self && h('button', { class: 'icon', title: 'Присоединить в конец', onclick: () => ed.addSource({ type: 'composition', id: c.id }, { append: true }) }, '⇥'),
          !self && h('button', { class: 'icon ghost', title: 'Открыть', onclick: () => navigate(`/compositions/${c.id}`) }, '↗'));
        }));
    }
  }

  // ---------------------------------------------------------------- export
  function openExport() {
    const list = h('div');
    const startBtn = h('button', { class: 'primary' }, '▶ Начать рендер');
    let timer = null;
    const m = modal('Экспорт в MP4', h('div', {},
      h('p', { class: 'muted' }, `Композиция «${ed.comp.name}» — ${ed.comp.width}×${ed.comp.height}, ${ed.comp.fps} fps, H.264 + AAC, длительность ${formatTime(ed.duration(), ed.comp.fps)}.`),
      h('div', { class: 'row', style: { marginBottom: '16px' } }, startBtn),
      list), { wide: true, onClose: () => clearTimeout(timer) });

    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      try {
        if (dirty || saving) { clearTimeout(saveTimer); await save(); }
        await api.post(`/compositions/${ed.comp.id}/renders`);
        await load();
      } catch (err) { toast(err.message, 'error'); } finally { startBtn.disabled = false; }
    });

    async function load() {
      clearTimeout(timer);
      if (!m.box.isConnected) return;
      const { renders } = await api.get(`/compositions/${ed.comp.id}/renders`);
      mount(list, renders.length ? renders.map((r) => h('div', { class: 'card', style: { marginBottom: '10px' } },
        h('div', { class: 'body' },
          h('div', { class: 'row' },
            h('b', {}, `Рендер #${r.id}`),
            h('span', { class: 'muted small' }, new Date(r.created_at).toLocaleString('ru-RU')),
            h('div', { class: 'spacer' }),
            h('span', { class: `badge ${r.status === 'done' ? 'audio' : r.status === 'failed' ? '' : 'video'}` },
              { queued: 'В очереди', processing: 'Рендеринг', done: 'Готово', failed: 'Ошибка' }[r.status])),
          (r.status === 'processing' || r.status === 'queued') && h('div', { class: 'progress', style: { marginTop: '8px' } },
            h('div', { style: { width: `${Math.round(r.progress * 100)}%` } })),
          r.status === 'failed' && h('pre', { class: 'small', style: { whiteSpace: 'pre-wrap', color: '#fca5a5' } }, r.error),
          r.status === 'done' && h('video', { src: r.url, controls: true, preload: 'metadata', style: { width: '100%', maxHeight: '320px', background: '#000', marginTop: '8px' } }),
          h('div', { class: 'row', style: { marginTop: '6px' } },
            r.status === 'done' && h('a', { class: 'btn primary', href: r.download_url, download: '' }, '⬇ Скачать MP4'),
            h('div', { class: 'spacer' }),
            r.status !== 'processing' && h('button', {
              class: 'ghost danger',
              onclick: async () => { await api.del(`/renders/${r.id}`).catch((err) => toast(err.message, 'error')); load(); },
            }, 'Удалить'))))) : h('div', { class: 'empty' }, 'Рендеров ещё не было'));
      if (renders.some((r) => r.status === 'queued' || r.status === 'processing')) timer = setTimeout(load, 1500);
    }
    load();
  }

  // ---------------------------------------------------------------- keyboard
  const onKey = (e) => {
    if (e.target.closest('input, textarea, select') || document.querySelector('.modal-bg')) return;
    const mod = e.ctrlKey || e.metaKey;
    const code = e.code;
    if (code === 'Space') { e.preventDefault(); preview.toggle(); }
    else if (mod && code === 'KeyZ' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (mod && (code === 'KeyY' || (code === 'KeyZ' && e.shiftKey))) { e.preventDefault(); redo(); }
    else if (mod && code === 'KeyD') { e.preventDefault(); ed.duplicate(); }
    else if (mod && code === 'KeyA') {
      e.preventDefault();
      ed.selection = new Set(ed.tracks.flatMap((t) => t.clips.map((c) => c.id)));
      refresh();
    }
    else if (!mod && code === 'KeyS') { e.preventDefault(); ed.split(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); ed.remove(e.shiftKey); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); if (e.shiftKey) { preview.pause(); ed.seek(preview.time - 1); } else step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); if (e.shiftKey) { preview.pause(); ed.seek(preview.time + 1); } else step(1); }
    else if (e.key === 'Home') { e.preventDefault(); ed.seek(0); }
    else if (e.key === 'End') { e.preventDefault(); ed.seek(ed.duration()); }
    else if (e.key === 'Escape') ed.select(null);
    else if (e.key === '+' || e.key === '=') timeline.setZoom(timeline.zoom * 1.25);
    else if (e.key === '-') timeline.setZoom(timeline.zoom / 1.25);
  };
  document.addEventListener('keydown', onKey);

  onCleanup(() => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('beforeunload', beforeUnload);
    clearTimeout(saveTimer);
    if (dirty) save();
    preview.destroy();
  });

  drawBin();
  refresh();
  requestAnimationFrame(() => timeline.zoomToFit());
}
