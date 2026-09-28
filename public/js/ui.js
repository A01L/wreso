// Tiny DOM helpers shared by all pages.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function mount(root, ...children) {
  root.replaceChildren();
  append(root, children);
}

export function toast(message, type = 'info', ms = 3500) {
  const el = h('div', { class: `toast ${type}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

export function modal(title, content, { wide = false, onClose } = {}) {
  const box = h('div', { class: `modal${wide ? ' wide' : ''}` }, h('h2', {}, title), content);
  const bg = h('div', { class: 'modal-bg' }, box);
  const close = () => {
    bg.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(bg);
  const first = box.querySelector('input, select, textarea');
  if (first) setTimeout(() => first.focus(), 0);
  return { close, box };
}

/** Modal with a form; resolves with the FormData-derived object or null. */
export function formModal(title, fields, { submitLabel = 'Сохранить', extra } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const error = h('div', { class: 'error' });
    const form = h('form', {}, extra || null, fields, error,
      h('div', { class: 'modal-foot' },
        h('button', { type: 'button', onclick: () => m.close() }, 'Отмена'),
        h('button', { type: 'submit', class: 'primary' }, submitLabel)));
    const m = modal(title, form, { onClose: () => { if (!done) resolve(null); } });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      done = true;
      resolve(Object.fromEntries(new FormData(form)));
      m.close();
    });
  });
}

export function confirmDialog(message, { okLabel = 'Удалить', danger = true } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal('Подтверждение', h('div', {},
      h('p', {}, message),
      h('div', { class: 'modal-foot' },
        h('button', { onclick: () => m.close() }, 'Отмена'),
        h('button', { class: danger ? 'primary danger' : 'primary', onclick: () => { done = true; resolve(true); m.close(); } }, okLabel))),
    { onClose: () => { if (!done) resolve(false); } });
  });
}

export function field(label, input) {
  return h('label', {}, h('span', {}, label), input);
}

/** SMPTE-style timecode HH:MM:SS:FF. */
export function formatTime(sec, fps = 30) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const rate = Math.round(fps);
  const totalFrames = Math.floor(sec * fps + 1e-6);
  const fr = totalFrames % rate;
  const whole = Math.floor(totalFrames / rate);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(whole / 3600))}:${p(Math.floor(whole / 60) % 60)}:${p(whole % 60)}:${p(fr)}`;
}

export function formatDuration(sec) {
  if (!sec) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} КБ`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} МБ`;
  return `${(n / 1024 ** 3).toFixed(2)} ГБ`;
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // Fallback for non-secure (plain http) origins.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const KIND_LABEL = { video: 'Видео', audio: 'Аудио', image: 'Фото', comp: 'Композиция' };
