import { api } from '../api.js';
import { h, mount, field } from '../ui.js';
import { navigate, session } from '../app.js';

export function authPage({ root }, mode) {
  const isLogin = mode === 'login';
  const error = h('div', { class: 'error' });
  const submit = h('button', { type: 'submit', class: 'primary' }, isLogin ? 'Войти' : 'Создать аккаунт');
  const form = h('form', { class: 'auth-card' },
    h('div', { class: 'logo' }, 'Wreso'),
    h('h1', {}, isLogin ? 'Вход' : 'Регистрация'),
    h('p', { class: 'muted' }, isLogin ? 'Онлайн-видеоредактор: проекты, композиции, монтаж.' : 'Бесплатный аккаунт за минуту.'),
    !isLogin && field('Имя', h('input', { name: 'name', required: true, maxLength: 120, autocomplete: 'name' })),
    field('Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
    field('Пароль', h('input', {
      name: 'password', type: 'password', required: true, minLength: isLogin ? 1 : 8,
      autocomplete: isLogin ? 'current-password' : 'new-password',
      placeholder: isLogin ? '' : 'Минимум 8 символов',
    })),
    error,
    submit,
    h('p', { class: 'muted small', style: { textAlign: 'center', marginTop: '16px' } },
      isLogin ? 'Нет аккаунта? ' : 'Уже есть аккаунт? ',
      h('a', { href: isLogin ? '/register' : '/login', 'data-link': '' }, isLogin ? 'Зарегистрироваться' : 'Войти')));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(form));
      const { user } = await api.post(isLogin ? '/auth/login' : '/auth/register', body);
      session.user = user;
      navigate('/projects');
    } catch (err) {
      error.textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  });

  mount(root, h('div', { class: 'auth-wrap' }, form));
}
