import { api } from '../api.js';
import { h, mount, field, formModal, confirmDialog, toast } from '../ui.js';
import { navigate, topbar } from '../app.js';

function projectFields(p = {}) {
  return [
    field('Название', h('input', { name: 'name', required: true, maxLength: 200, value: p.name || '' })),
    field('Описание', h('textarea', { name: 'description', rows: 3, maxLength: 2000 }, p.description || '')),
  ];
}

export async function createProject() {
  const data = await formModal('Новый проект', projectFields(), { submitLabel: 'Создать' });
  if (!data) return;
  try {
    const { project } = await api.post('/projects', data);
    navigate(`/projects/${project.id}`);
  } catch (err) { toast(err.message, 'error'); }
}

export async function projectsPage({ root }) {
  const list = h('div');
  mount(root, topbar(h('b', {}, 'Мои проекты')), h('main', { class: 'page' },
    h('div', { class: 'page-head' },
      h('h1', {}, 'Проекты'), h('div', { class: 'spacer' }),
      h('button', { class: 'primary', onclick: createProject }, '+ Новый проект')),
    list));

  async function load() {
    const { projects } = await api.get('/projects');
    if (!projects.length) {
      mount(list, h('div', { class: 'empty' },
        h('h2', {}, 'Пока нет проектов'),
        h('p', {}, 'Создайте проект, загрузите видео, аудио или фото и начните монтаж.'),
        h('button', { class: 'primary', onclick: createProject }, '+ Создать первый проект')));
      return;
    }
    mount(list, h('div', { class: 'grid' }, projects.map((p) => {
      const open = () => navigate(`/projects/${p.id}`);
      return h('div', { class: 'card' },
        h('div', {
          class: 'cover', onclick: open,
          style: p.cover_media_id ? { backgroundImage: `url(/api/media/${p.cover_media_id}/thumbnail)` } : {},
        }, p.cover_media_id ? null : '🎬'),
        h('div', { class: 'body' },
          h('div', { class: 'title', onclick: open, title: p.name }, p.name),
          h('div', { class: 'muted small' }, `Композиций: ${p.composition_count} · Медиа: ${p.media_count}`),
          h('div', { class: 'muted small' }, `Изменён ${new Date(p.updated_at).toLocaleString('ru-RU')}`)),
        h('div', { class: 'actions' },
          h('button', { class: 'ghost', onclick: open }, 'Открыть'),
          h('div', { class: 'spacer' }),
          h('button', {
            class: 'ghost icon', title: 'Переименовать',
            onclick: async () => {
              const data = await formModal('Проект', projectFields(p));
              if (!data) return;
              try { await api.patch(`/projects/${p.id}`, data); load(); } catch (err) { toast(err.message, 'error'); }
            },
          }, '✎'),
          h('button', {
            class: 'ghost icon danger', title: 'Удалить',
            onclick: async () => {
              if (!(await confirmDialog(`Удалить проект «${p.name}» со всеми медиа и композициями?`))) return;
              try { await api.del(`/projects/${p.id}`); load(); toast('Проект удалён', 'ok'); } catch (err) { toast(err.message, 'error'); }
            },
          }, '🗑')));
    })));
  }
  await load();
}
