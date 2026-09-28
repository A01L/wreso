import { api } from '../api.js';
import { h, mount, modal, confirmDialog, formModal, field, toast, formatDuration, formatBytes, KIND_LABEL } from '../ui.js';
import { navigate, topbar } from '../app.js';
import { compositionDialog, uploadFiles, dropzone, ACCEPT } from '../shared.js';

export async function projectPage({ root }, projectId) {
  let data = await api.get(`/projects/${projectId}`);
  const compsEl = h('div');
  const mediaEl = h('div');
  const uploads = h('div', { class: 'uploads' });
  const fileInput = h('input', { type: 'file', multiple: true, accept: ACCEPT, class: 'hidden' });
  const title = h('b', {}, data.project.name);

  const upload = async (files) => {
    const created = await uploadFiles(projectId, files, uploads);
    if (created.length) reload();
  };
  fileInput.addEventListener('change', () => { upload(fileInput.files); fileInput.value = ''; });

  const main = h('main', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', {},
        h('h1', {}, data.project.name),
        data.project.description && h('p', { class: 'muted', style: { margin: '6px 0 0' } }, data.project.description)),
      h('div', { class: 'spacer' }),
      h('button', { onclick: editProject }, '✎ Переименовать')),
    h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', {}, 'Композиции'), h('div', { class: 'spacer' }),
        h('button', { class: 'primary', onclick: newComposition }, '+ Композиция')),
      compsEl),
    h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', {}, 'Медиафайлы'), h('div', { class: 'spacer' }),
        h('span', { class: 'muted small' }, 'Перетащите файлы сюда или'),
        h('button', { class: 'primary', onclick: () => fileInput.click() }, '⬆ Загрузить'), fileInput),
      uploads, mediaEl));
  dropzone(main, upload);
  mount(root, topbar(h('a', { href: '/projects', 'data-link': '' }, 'Проекты'), '/', title), main);

  async function reload() {
    data = await api.get(`/projects/${projectId}`);
    draw();
  }

  async function editProject() {
    const res = await formModal('Проект', [
      field('Название', h('input', { name: 'name', required: true, value: data.project.name })),
      field('Описание', h('textarea', { name: 'description', rows: 3 }, data.project.description || '')),
    ]);
    if (!res) return;
    try {
      await api.patch(`/projects/${projectId}`, res);
      main.querySelector('h1').textContent = res.name;
      title.textContent = res.name;
      reload();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function newComposition() {
    const payload = await compositionDialog();
    if (!payload) return;
    try {
      const { composition } = await api.post(`/projects/${projectId}/compositions`, payload);
      navigate(`/compositions/${composition.id}`);
    } catch (err) { toast(err.message, 'error'); }
  }

  function draw() {
    const { compositions, media } = data;
    mount(compsEl, compositions.length ? h('div', { class: 'grid' }, compositions.map((c) => {
      const open = () => navigate(`/compositions/${c.id}`);
      const dur = c.duration || c.content_duration || 0;
      return h('div', { class: 'card' },
        h('div', { class: 'cover', onclick: open },
          h('div', {
            style: {
              aspectRatio: `${c.width}/${c.height}`, maxHeight: '80%', maxWidth: '80%', height: c.height >= c.width ? '80%' : 'auto',
              width: c.width > c.height ? '80%' : 'auto', background: c.background_color, border: '1px solid #333',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', color: '#888',
            },
          }, `${c.width}×${c.height}`)),
        h('div', { class: 'body' },
          h('div', { class: 'title', onclick: open }, c.name),
          h('div', { class: 'muted small' }, `${formatDuration(dur)} · ${c.fps} fps · клипов: ${c.clip_count}`)),
        h('div', { class: 'actions' },
          h('button', { class: 'ghost', onclick: open }, 'Монтаж'),
          h('div', { class: 'spacer' }),
          h('button', {
            class: 'ghost icon', title: 'Дублировать',
            onclick: async () => { try { await api.post(`/compositions/${c.id}/duplicate`); reload(); } catch (err) { toast(err.message, 'error'); } },
          }, '⧉'),
          h('button', {
            class: 'ghost icon', title: 'Настройки',
            onclick: async () => {
              const payload = await compositionDialog(c);
              if (!payload) return;
              try { await api.patch(`/compositions/${c.id}`, payload); reload(); } catch (err) { toast(err.message, 'error'); }
            },
          }, '⚙'),
          h('button', {
            class: 'ghost icon danger', title: 'Удалить',
            onclick: async () => {
              if (!(await confirmDialog(`Удалить композицию «${c.name}»? Клипы, которые её используют, тоже будут удалены.`))) return;
              try { await api.del(`/compositions/${c.id}`); reload(); } catch (err) { toast(err.message, 'error'); }
            },
          }, '🗑')));
    })) : h('div', { class: 'empty' }, 'Композиций пока нет'));

    mount(mediaEl, media.length ? h('div', { class: 'grid' }, media.map((m) => h('div', { class: 'card' },
      h('div', {
        class: 'cover', onclick: () => previewMedia(m),
        style: m.thumbnail_url ? { backgroundImage: `url(${m.thumbnail_url})` }
          : m.waveform_url ? { backgroundImage: `url(${m.waveform_url})`, backgroundSize: '100% 60%', backgroundColor: '#0b1f1d' } : {},
      }, h('span', { class: `badge ${m.kind} ` }, KIND_LABEL[m.kind])),
      h('div', { class: 'body' },
        h('div', { class: 'title', title: m.name, onclick: () => previewMedia(m) }, m.name),
        h('div', { class: 'muted small' }, [
          m.duration ? formatDuration(m.duration) : null,
          m.width ? `${m.width}×${m.height}` : null,
          formatBytes(m.size_bytes),
        ].filter(Boolean).join(' · '))),
      h('div', { class: 'actions' },
        h('div', { class: 'spacer' }),
        h('button', {
          class: 'ghost icon', title: 'Переименовать',
          onclick: async () => {
            const res = await formModal('Переименовать', [field('Название', h('input', { name: 'name', required: true, value: m.name }))]);
            if (!res) return;
            try { await api.patch(`/media/${m.id}`, res); reload(); } catch (err) { toast(err.message, 'error'); }
          },
        }, '✎'),
        h('button', {
          class: 'ghost icon danger', title: 'Удалить',
          onclick: async () => {
            if (!(await confirmDialog(`Удалить «${m.name}»? Он будет убран из всех композиций.`))) return;
            try { await api.del(`/media/${m.id}`); reload(); } catch (err) { toast(err.message, 'error'); }
          },
        }, '🗑'))))) : h('div', { class: 'empty' },
      h('p', {}, 'Загрузите видео, аудио или изображения — MP4, MOV, WebM, MKV, MP3, WAV, AAC, FLAC, JPG, PNG, WebP…'),
      h('button', { class: 'primary', onclick: () => fileInput.click() }, '⬆ Выбрать файлы')));
  }

  function previewMedia(m) {
    let el;
    if (m.kind === 'video') el = h('video', { src: m.preview_url || m.url, controls: true, autoplay: true, style: { width: '100%', maxHeight: '60vh', background: '#000' } });
    else if (m.kind === 'audio') el = h('audio', { src: m.url, controls: true, autoplay: true, style: { width: '100%' } });
    else el = h('img', { src: m.url, style: { maxWidth: '100%', maxHeight: '60vh', display: 'block', margin: '0 auto' } });
    modal(m.name, el, { wide: true, onClose: () => el.pause && el.pause() });
  }

  draw();
}
