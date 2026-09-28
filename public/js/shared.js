// Pieces shared by the project page and the editor.
import { api } from './api.js';
import { h, field, formModal, toast, formatBytes } from './ui.js';

const PRESETS = [
  ['1920×1080 (16:9)', 1920, 1080],
  ['1280×720', 1280, 720],
  ['1080×1920 (9:16, Reels/Shorts)', 1080, 1920],
  ['1080×1080 (1:1)', 1080, 1080],
  ['3840×2160 (4K)', 3840, 2160],
];

/** Opens the composition settings dialog; resolves with the payload for the API or null. */
export async function compositionDialog(comp = null) {
  const c = comp || { name: 'Композиция', width: 1920, height: 1080, fps: 30, background_color: '#000000', duration: null };
  const w = h('input', { name: 'width', type: 'number', min: 16, max: 7680, step: 2, required: true, value: c.width });
  const hh = h('input', { name: 'height', type: 'number', min: 16, max: 7680, step: 2, required: true, value: c.height });
  const presets = h('div', { class: 'presets' }, PRESETS.map(([label, pw, ph]) => h('button', {
    type: 'button', onclick: () => { w.value = pw; hh.value = ph; },
  }, label)));
  const data = await formModal(comp ? 'Настройки композиции' : 'Новая композиция', [
    field('Название', h('input', { name: 'name', required: true, maxLength: 200, value: c.name })),
    h('div', { class: 'muted small', style: { marginBottom: '6px' } }, 'Холст (размер кадра)'),
    presets,
    h('div', { class: 'two' }, field('Ширина, px', w), field('Высота, px', hh)),
    h('div', { class: 'three' },
      field('Кадров/сек', h('select', { name: 'fps' }, [24, 25, 30, 50, 60].map((f) => h('option', { value: f, selected: Number(c.fps) === f }, f)))),
      field('Фон', h('input', { name: 'background_color', type: 'color', value: c.background_color })),
      field('Длительность, с', h('input', { name: 'duration', type: 'number', min: 0.1, step: 0.1, placeholder: 'авто', value: c.duration ?? '' }))),
  ], { submitLabel: comp ? 'Сохранить' : 'Создать' });
  if (!data) return null;
  return {
    name: data.name,
    width: Number(data.width),
    height: Number(data.height),
    fps: Number(data.fps),
    background_color: data.background_color,
    duration: data.duration === '' ? null : Number(data.duration),
  };
}

export const ACCEPT = 'video/*,audio/*,image/*,.mkv,.mov,.flac,.opus';

/** Uploads files, rendering progress rows into `container`; returns created media. */
export async function uploadFiles(projectId, files, container) {
  files = [...files];
  if (!files.length) return [];
  const total = files.reduce((s, f) => s + f.size, 0);
  const bar = h('div', { style: { width: '0%' } });
  const label = h('div', { class: 'muted' }, `Загрузка ${files.length} файл(ов), ${formatBytes(total)}…`);
  const row = h('div', { class: 'upload-item' }, label, h('div', { class: 'progress' }, bar));
  container.append(row);
  try {
    const res = await api.upload(`/projects/${projectId}/media`, files, (p) => {
      bar.style.width = `${Math.round(p * 100)}%`;
      if (p >= 1) label.textContent = 'Обработка (анализ, превью)…';
    });
    for (const e of res.errors || []) toast(e, 'error', 6000);
    toast(`Загружено: ${res.media.length}`, 'ok');
    return res.media;
  } catch (err) {
    toast(err.message, 'error', 6000);
    return [];
  } finally {
    row.remove();
  }
}

/** Wire a drop zone element to upload handler. */
export function dropzone(el, onFiles) {
  let depth = 0;
  el.classList.add('dropzone');
  el.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    depth += 1; el.classList.add('drag');
  });
  el.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) el.classList.remove('drag'); });
  el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
  el.addEventListener('drop', (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    depth = 0; el.classList.remove('drag');
    onFiles(e.dataTransfer.files);
  });
}
