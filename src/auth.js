'use strict';

const crypto = require('node:crypto');
const { can, roleInfo } = require('./permissions');

const COOKIE = 'aba_session';
// Automatic logoff after inactivity (HIPAA §164.312(a)(2)(iii)).
const IDLE_MS = 30 * 60 * 1000;
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, now, now);
  return token;
}

function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setSessionCookie(req, res, token) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_MS / 1000}${secure ? '; Secure' : ''}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

// Attaches req.user when a valid, non-idle session cookie is present.
function sessionMiddleware(db) {
  return (req, res, next) => {
    const token = readCookie(req, COOKIE);
    if (!token) return next();
    const row = db.prepare(`
      SELECT s.token_hash, s.created_at, s.last_seen, u.id, u.email, u.name, u.role, u.active
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha256(token));
    const now = Date.now();
    if (!row || !row.active || now - row.last_seen > IDLE_MS || now - row.created_at > MAX_AGE_MS) {
      if (row) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
      clearSessionCookie(res);
      return next();
    }
    db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now, row.token_hash);
    req.token = token;
    req.user = { id: row.id, email: row.email, name: row.name, role: row.role, ...roleInfo(row.role) };
    next();
  };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireAuth(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Please sign in.'));
  next();
}

// Require at least one of the listed capabilities.
function requireCap(...caps) {
  return (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'Please sign in.'));
    if (!caps.some((c) => can(req.user, c))) return next(new HttpError(403, 'You do not have access to this.'));
    next();
  };
}

module.exports = {
  COOKIE,
  IDLE_MS,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  readCookie,
  setSessionCookie,
  clearSessionCookie,
  sessionMiddleware,
  requireAuth,
  requireCap,
  HttpError,
};
