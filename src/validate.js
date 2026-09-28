const { badRequest } = require('./errors');

// Human-readable (Russian) field names for error messages shown in the UI.
const LABELS = {
  email: 'Email', password: 'Пароль', name: 'Название', description: 'Описание',
  width: 'Ширина', height: 'Высота', fps: 'Кадров/сек', duration: 'Длительность', background_color: 'Фон',
};
const label = (field) => `«${LABELS[field] || field}»`;

function str(value, field, { min = 0, max = 255, optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw badRequest(`Поле ${label(field)} обязательно`);
  }
  if (typeof value !== 'string') throw badRequest(`Поле ${label(field)} должно быть строкой`);
  const v = value.trim();
  if (v.length < min) throw badRequest(`Поле ${label(field)}: минимум ${min} символов`);
  if (v.length > max) throw badRequest(`Поле ${label(field)}: максимум ${max} символов`);
  return v;
}

function num(value, field, { min = -Infinity, max = Infinity, def, integer = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (def !== undefined) return def;
    throw badRequest(`Поле ${label(field)} обязательно`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest(`Поле ${label(field)} должно быть числом`);
  if (integer && !Number.isInteger(n)) throw badRequest(`Поле ${label(field)} должно быть целым числом`);
  if (n < min || n > max) throw badRequest(`Поле ${label(field)} должно быть от ${min} до ${max}`);
  return n;
}

function bool(value, def = false) {
  if (value === undefined || value === null) return def;
  return value === true || value === 1 || value === '1' || value === 'true';
}

function color(value, field, def = '#000000') {
  if (value === undefined || value === null) return def;
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw badRequest(`Поле ${label(field)}: цвет в формате #112233`);
  }
  return value.toLowerCase();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(value, field) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw badRequest(`${field} must be a UUID`);
  return value.toLowerCase();
}

module.exports = { str, num, bool, color, uuid };
