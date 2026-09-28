import { api } from './api.js';
import { h } from './ui.js';
import { authPage } from './pages/auth.js';
import { projectsPage } from './pages/projects.js';
import { projectPage } from './pages/project.js';
import { editorPage } from './pages/editor.js';

export const session = { user: null };
const root = document.getElementById('app');
let cleanup = null;

const routes = [
  { re: /^\/login$/, page: (ctx) => authPage(ctx, 'login'), guest: true },
  { re: /^\/register$/, page: (ctx) => authPage(ctx, 'register'), guest: true },
  { re: /^\/projects$/, page: projectsPage },
  { re: /^\/projects\/(\d+)$/, page: (ctx, id) => projectPage(ctx, Number(id)) },
  { re: /^\/compositions\/(\d+)$/, page: (ctx, id) => editorPage(ctx, Number(id)) },
];

export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  render();
}

export async function logout() {
  await api.post('/auth/logout').catch(() => {});
  session.user = null;
  navigate('/login');
}

export function topbar(...center) {
  return h('header', { class: 'topbar' },
    h('a', { class: 'logo', href: '/projects', 'data-link': '' }, 'Wreso'),
    h('div', { class: 'crumbs' }, center),
    h('div', { class: 'spacer' }),
    session.user && h('span', { class: 'muted small' }, session.user.name),
    session.user && h('button', { class: 'ghost', onclick: logout }, 'Выйти'));
}

async function render() {
  if (cleanup) { try { cleanup(); } catch (_) { /* ignore */ } cleanup = null; }
  let path = location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/') path = session.user ? '/projects' : '/login';

  const route = routes.find((r) => r.re.test(path));
  if (!route) { navigate(session.user ? '/projects' : '/login', { replace: true }); return; }
  if (!route.guest && !session.user) { navigate('/login', { replace: true }); return; }
  if (route.guest && session.user) { navigate('/projects', { replace: true }); return; }

  const params = path.match(route.re).slice(1);
  root.replaceChildren();
  const ctx = { root, onCleanup: (fn) => { cleanup = fn; } };
  try {
    await route.page(ctx, ...params);
  } catch (err) {
    root.replaceChildren(topbar(), h('div', { class: 'page' },
      h('div', { class: 'empty' }, h('h2', {}, 'Не удалось открыть страницу'), h('p', {}, err.message),
        h('a', { href: '/projects', 'data-link': '' }, '← К проектам'))));
  }
}

// Intercept internal links.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});
window.addEventListener('popstate', render);
window.addEventListener('unauthorized', () => {
  if (session.user) { session.user = null; navigate('/login', { replace: true }); }
});

(async function boot() {
  try {
    session.user = (await api.get('/auth/me')).user;
  } catch (_) {
    session.user = null;
  }
  render();
}());
