'use strict';

// Two-factor sign-in: authenticator-app codes plus one-time recovery codes.
const crypto = require('node:crypto');
const totp = require('./totp');
const { encryptText, decryptText } = require('./crypto-box');
const { sha256 } = require('./auth');
const { getSetting } = require('./db');

const CHALLENGE_MS = 5 * 60 * 1000;
const CHALLENGE_ATTEMPTS = 5;
const RECOVERY_COUNT = 10;
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes (0/o, 1/l/i)

const isRequired = (db) => getSetting(db, 'require_2fa', '1') === '1';

function createChallenge(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM login_challenges WHERE user_id = ? OR created_at < ?').run(userId, Date.now() - CHALLENGE_MS);
  db.prepare('INSERT INTO login_challenges (token_hash, user_id, created_at) VALUES (?, ?, ?)').run(sha256(token), userId, Date.now());
  return token;
}

// Returns the live challenge row, or null if it's unknown, expired or used up.
function findChallenge(db, token) {
  const row = db.prepare('SELECT * FROM login_challenges WHERE token_hash = ?').get(sha256(String(token || '')));
  if (!row) return null;
  if (Date.now() - row.created_at > CHALLENGE_MS || row.attempts >= CHALLENGE_ATTEMPTS) {
    db.prepare('DELETE FROM login_challenges WHERE token_hash = ?').run(row.token_hash);
    return null;
  }
  return row;
}

function randomRecoveryCode() {
  const bytes = crypto.randomBytes(8);
  const chars = [...bytes].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

const normalizeRecovery = (code) => String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function newRecoveryCodes(db, userId) {
  const codes = Array.from({ length: RECOVERY_COUNT }, randomRecoveryCode);
  db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
  const ins = db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)');
  for (const c of codes) ins.run(userId, sha256(normalizeRecovery(c)));
  return codes;
}

const recoveryRemaining = (db, userId) =>
  db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId).n;

// Check an authenticator code, or a recovery code, for a user with two-factor on.
// Returns 'app' or 'recovery' on success (and records use), otherwise null.
function checkSecondFactor(db, key, user, code) {
  if (user.totp_enabled && user.totp_secret) {
    const step = totp.verify(decryptText(key, user.totp_secret), code, { lastStep: user.totp_last_step });
    if (step !== null) {
      db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, user.id);
      return 'app';
    }
  }
  const norm = normalizeRecovery(code);
  if (norm.length === 8) {
    const row = db.prepare('SELECT id FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL').get(user.id, sha256(norm));
    if (row) {
      db.prepare("UPDATE recovery_codes SET used_at = datetime('now') WHERE id = ?").run(row.id);
      return 'recovery';
    }
  }
  return null;
}

function startSetup(db, key, user) {
  const secret = totp.generateSecret();
  db.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').run(encryptText(key, secret), user.id);
  return { secret, uri: totp.otpauthUri(secret, user.email) };
}

// Confirms the first code from the app, turns two-factor on, returns recovery codes.
function finishSetup(db, key, user, code) {
  const row = db.prepare('SELECT totp_pending FROM users WHERE id = ?').get(user.id);
  if (!row?.totp_pending) return null;
  const step = totp.verify(decryptText(key, row.totp_pending), code);
  if (step === null) return null;
  db.prepare('UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled = 1, totp_last_step = ? WHERE id = ?')
    .run(step, user.id);
  return newRecoveryCodes(db, user.id);
}

function turnOff(db, userId) {
  db.prepare('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled = 0, totp_last_step = 0 WHERE id = ?').run(userId);
  db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
}

module.exports = {
  isRequired, createChallenge, findChallenge, checkSecondFactor, startSetup, finishSetup, turnOff,
  newRecoveryCodes, recoveryRemaining, CHALLENGE_ATTEMPTS,
};
