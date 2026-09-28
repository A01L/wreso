const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');
const { HttpError } = require('../errors');

const COOKIE = 'wreso_token';
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

function issueToken(res, user) {
  const token = jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: '7d' });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: MAX_AGE_MS,
  });
}

function clearToken(res) {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure });
}

async function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = req.cookies[COOKIE] || (header.startsWith('Bearer ') ? header.slice(7) : null);
  if (!token) throw new HttpError(401, 'Authentication required');
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch (_) {
    throw new HttpError(401, 'Invalid or expired session');
  }
  const user = await db.one('SELECT id, email, name, created_at FROM users WHERE id = ?', [payload.sub]);
  if (!user) throw new HttpError(401, 'User not found');
  req.user = user;
  next();
}

module.exports = { requireAuth, issueToken, clearToken };
