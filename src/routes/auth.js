const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { str } = require('../validate');
const { HttpError, badRequest } = require('../errors');
const { requireAuth, issueToken, clearToken } = require('../middleware/auth');

const router = express.Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Слишком много попыток, попробуйте позже' },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/register', limiter, async (req, res) => {
  const email = str(req.body.email, 'email', { max: 255 }).toLowerCase();
  if (!EMAIL_RE.test(email)) throw badRequest('Некорректный email');
  const name = str(req.body.name, 'name', { min: 1, max: 120 });
  const password = str(req.body.password, 'password', { min: 8, max: 128 });

  const exists = await db.one('SELECT id FROM users WHERE email = ?', [email]);
  if (exists) throw new HttpError(409, 'Пользователь с таким email уже зарегистрирован');

  const hash = await bcrypt.hash(password, 10);
  const result = await db.query(
    'INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)',
    [email, name, hash],
  );
  const user = { id: result.insertId, email, name };
  issueToken(res, user);
  res.status(201).json({ user });
});

router.post('/login', limiter, async (req, res) => {
  const email = str(req.body.email, 'email').toLowerCase();
  const password = str(req.body.password, 'password', { max: 128 });
  const row = await db.one('SELECT * FROM users WHERE email = ?', [email]);
  if (!row || !(await bcrypt.compare(password, row.password_hash))) {
    throw new HttpError(401, 'Неверный email или пароль');
  }
  issueToken(res, row);
  res.json({ user: { id: row.id, email: row.email, name: row.name } });
});

router.post('/logout', (req, res) => {
  clearToken(res);
  res.json({ ok: true });
});

// Returns { user: null } for guests so the SPA can probe the session without a 401.
router.get('/me', async (req, res) => {
  try {
    await requireAuth(req, res, () => {});
  } catch (_) {
    return res.json({ user: null });
  }
  return res.json({ user: req.user });
});

module.exports = router;
