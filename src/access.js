'use strict';

const { can } = require('./permissions');
const { HttpError } = require('./auth');

function audit(db, req, action, { entity = null, entityId = null, clientId = null, detail = null } = {}) {
  db.prepare(`INSERT INTO audit_log (user_id, action, entity, entity_id, client_id, detail, ip)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(req.user?.id ?? null, action, entity, entityId, clientId,
      detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)), req.ip ?? null);
}

function isAssigned(db, userId, clientId) {
  return !!db.prepare('SELECT 1 FROM assignments WHERE user_id = ? AND client_id = ?').get(userId, clientId);
}

function canViewClinical(db, user, clientId) {
  if (can(user, 'clinical.view_all')) return true;
  if (can(user, 'clinical.view_assigned')) return isAssigned(db, user.id, clientId);
  return false;
}

// Basic demographics: whole roster for office/supervisory roles, assigned
// clients for technicians.
function canViewBasic(db, user, clientId) {
  if (can(user, 'clients.view_basic')) return true;
  if (can(user, 'clinical.view_assigned')) return isAssigned(db, user.id, clientId);
  return false;
}

function requireBasicView(db, user, clientId) {
  const client = assertClient(db, clientId);
  if (!canViewBasic(db, user, clientId)) throw new HttpError(403, 'You do not have access to this client.');
  return client;
}

// Clinicians may write to a client's record if they can see it.
function canWriteClinical(db, user, clientId) {
  return can(user, 'clinical.write') && canViewClinical(db, user, clientId);
}

function assertClient(db, clientId) {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) throw new HttpError(404, 'Client not found.');
  return client;
}

function requireClinicalView(db, user, clientId) {
  assertClient(db, clientId);
  if (!canViewClinical(db, user, clientId)) throw new HttpError(403, 'You are not on this client\'s team.');
}

function requireClinicalWrite(db, user, clientId) {
  assertClient(db, clientId);
  if (!canWriteClinical(db, user, clientId)) throw new HttpError(403, 'You cannot write to this client\'s record.');
}

// Clients this user may see clinical data for (null = all).
function clinicalClientIds(db, user) {
  if (can(user, 'clinical.view_all')) return null;
  if (can(user, 'clinical.view_assigned')) {
    return db.prepare('SELECT client_id FROM assignments WHERE user_id = ?').all(user.id).map((r) => r.client_id);
  }
  return [];
}

// ---- validation helpers ----
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

function str(v, name, { required = false, max = 5000 } = {}) {
  if (v == null || v === '') {
    if (required) throw new HttpError(400, `${name} is required.`);
    return null;
  }
  if (typeof v !== 'string' && typeof v !== 'number') throw new HttpError(400, `${name} must be text.`);
  const s = String(v).trim();
  if (required && !s) throw new HttpError(400, `${name} is required.`);
  if (s.length > max) throw new HttpError(400, `${name} is too long.`);
  return s || null;
}

function oneOf(v, name, allowed, { required = true, fallback } = {}) {
  if ((v == null || v === '') && !required) return fallback ?? null;
  if (!allowed.includes(v)) throw new HttpError(400, `${name} must be one of: ${allowed.join(', ')}.`);
  return v;
}

function date(v, name, opts = {}) {
  const s = str(v, name, opts);
  if (s && !DATE_RE.test(s)) throw new HttpError(400, `${name} must be YYYY-MM-DD.`);
  return s;
}

function time(v, name, opts = {}) {
  const s = str(v, name, opts);
  if (s && !TIME_RE.test(s)) throw new HttpError(400, `${name} must be HH:MM.`);
  return s;
}

function num(v, name, { required = false, min = -Infinity, max = Infinity, integer = false } = {}) {
  if (v == null || v === '') {
    if (required) throw new HttpError(400, `${name} is required.`);
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new HttpError(400, `${name} must be a valid number.`);
  }
  return n;
}

function id(v, name = 'id') {
  return num(v, name, { required: true, min: 1, integer: true });
}

// Billable 15-minute units using the 8-minute rule.
function unitsFor(start, end) {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const minutes = eh * 60 + em - (sh * 60 + sm);
  if (minutes <= 0) throw new HttpError(400, 'End time must be after start time.');
  return Math.floor(minutes / 15) + (minutes % 15 >= 8 ? 1 : 0);
}

function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

module.exports = {
  audit,
  isAssigned,
  canViewBasic,
  requireBasicView,
  canViewClinical,
  canWriteClinical,
  assertClient,
  requireClinicalView,
  requireClinicalWrite,
  clinicalClientIds,
  str,
  oneOf,
  date,
  time,
  num,
  id,
  unitsFor,
  today,
  addDays,
};
