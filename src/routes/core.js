'use strict';

const express = require('express');
const {
  ROLES, DEPARTMENTS, can, capabilitiesFor, canSeeEscalation, isInAudience, announceableDepts,
} = require('../permissions');
const {
  hashPassword, verifyPassword, createSession, destroySession, setSessionCookie, clearSessionCookie,
  requireAuth, requireCap, HttpError, IDLE_MS,
} = require('../auth');
const { audit, str, oneOf, id, today, addDays, clinicalClientIds } = require('../access');

// Which permission manages each configurable list.
const LIST_DOMAINS = {
  observation_categories: ['lists.manage.clinical'],
  program_domains: ['lists.manage.clinical'],
  service_codes: ['lists.manage.clinical', 'lists.manage.admin'],
  escalation_categories: ['lists.manage.clinical', 'lists.manage.admin'],
  payers: ['lists.manage.admin'],
};

const MIN_PASSWORD = 10;

module.exports = function coreRoutes(db) {
  const r = express.Router();

  // ---------------- auth ----------------
  const failures = new Map(); // email -> [timestamps]
  r.post('/login', (req, res) => {
    const email = str(req.body?.email, 'Email', { required: true, max: 200 }).toLowerCase();
    const password = String(req.body?.password ?? '');
    const now = Date.now();
    const recent = (failures.get(email) || []).filter((t) => now - t < 15 * 60 * 1000);
    if (recent.length >= 5) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
      failures.set(email, [...recent, now]);
      req.user = null;
      audit(db, req, 'login.failed', { detail: { email } });
      throw new HttpError(401, 'Email or password is incorrect.');
    }
    failures.delete(email);
    const token = createSession(db, user.id);
    setSessionCookie(req, res, token);
    req.user = user;
    audit(db, req, 'login');
    res.json({ ok: true });
  });

  // Demo mode only: lets the sign-in page offer the seeded demo accounts.
  r.get('/demo-accounts', (req, res) => {
    if (process.env.DEMO_MODE !== '1') throw new HttpError(404, 'Not found.');
    const rows = db.prepare("SELECT email, role FROM users WHERE active = 1 AND email LIKE '%@demo.test' ORDER BY id").all();
    res.json({ password: 'demo-password', accounts: rows.map((u) => ({ email: u.email, label: ROLES[u.role]?.label || u.role })) });
  });

  r.post('/logout', (req, res) => {
    if (req.user) audit(db, req, 'logout');
    destroySession(db, req.token);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  r.get('/me', requireAuth, (req, res) => {
    res.json({
      user: req.user,
      capabilities: capabilitiesFor(req.user.role),
      announceDepts: announceableDepts(req.user),
      roles: ROLES,
      departments: DEPARTMENTS,
      idleTimeoutMs: IDLE_MS,
    });
  });

  r.post('/me/password', requireAuth, (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(String(req.body?.current ?? ''), user.password_hash)) {
      throw new HttpError(400, 'Current password is incorrect.');
    }
    const next = String(req.body?.next ?? '');
    if (next.length < MIN_PASSWORD) throw new HttpError(400, `New password must be at least ${MIN_PASSWORD} characters.`);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), user.id);
    audit(db, req, 'password.change', { entity: 'user', entityId: user.id });
    res.json({ ok: true });
  });

  // ---------------- users ----------------
  r.get('/users', requireAuth, (req, res) => {
    const manage = can(req.user, 'users.manage');
    const rows = db.prepare(`SELECT id, name, role, ${manage ? 'email, active,' : ''} created_at
                             FROM users ${manage ? '' : 'WHERE active = 1'} ORDER BY name`).all();
    res.json(rows);
  });

  function guardRole(req, role) {
    // Only an executive can create or modify executive accounts.
    if (role === 'executive' && req.user.role !== 'executive') {
      throw new HttpError(403, 'Only an executive can grant the executive role.');
    }
  }

  r.post('/users', requireCap('users.manage'), (req, res) => {
    const name = str(req.body?.name, 'Name', { required: true, max: 120 });
    const email = str(req.body?.email, 'Email', { required: true, max: 200 }).toLowerCase();
    const role = oneOf(req.body?.role, 'Role', Object.keys(ROLES));
    const password = String(req.body?.password ?? '');
    guardRole(req, role);
    if (password.length < MIN_PASSWORD) throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters.`);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'That email is already in use.');
    const info = db.prepare('INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?)')
      .run(email, name, role, hashPassword(password));
    audit(db, req, 'user.create', { entity: 'user', entityId: Number(info.lastInsertRowid), detail: { email, role } });
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });

  r.patch('/users/:id', requireCap('users.manage'), (req, res) => {
    const userId = id(req.params.id);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!target) throw new HttpError(404, 'User not found.');
    guardRole(req, target.role);
    const b = req.body || {};
    const changes = {};
    if (b.name !== undefined) changes.name = str(b.name, 'Name', { required: true, max: 120 });
    if (b.role !== undefined) { changes.role = oneOf(b.role, 'Role', Object.keys(ROLES)); guardRole(req, changes.role); }
    if (b.active !== undefined) {
      if (userId === req.user.id) throw new HttpError(400, 'You cannot deactivate your own account.');
      changes.active = b.active ? 1 : 0;
    }
    if (b.password) {
      if (String(b.password).length < MIN_PASSWORD) throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters.`);
      changes.password_hash = hashPassword(String(b.password));
    }
    const keys = Object.keys(changes);
    if (!keys.length) return res.json({ ok: true });
    db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => changes[k]), userId);
    if (changes.active === 0 || changes.role || changes.password_hash) {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }
    audit(db, req, 'user.update', { entity: 'user', entityId: userId,
      detail: { ...changes, password_hash: changes.password_hash ? '(reset)' : undefined } });
    res.json({ ok: true });
  });

  // ---------------- configurable lists ----------------
  r.get('/lists', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT * FROM lists ORDER BY list_key, sort, label').all();
    const out = {};
    for (const key of Object.keys(LIST_DOMAINS)) out[key] = [];
    for (const row of rows) (out[row.list_key] ||= []).push(row);
    const editable = Object.keys(LIST_DOMAINS).filter((k) => LIST_DOMAINS[k].some((c) => can(req.user, c)));
    res.json({ lists: out, editable });
  });

  function requireListEdit(req, key) {
    const caps = LIST_DOMAINS[key];
    if (!caps) throw new HttpError(400, 'Unknown list.');
    if (!caps.some((c) => can(req.user, c))) throw new HttpError(403, 'You cannot edit this list.');
  }

  r.post('/lists', requireAuth, (req, res) => {
    const key = str(req.body?.list_key, 'List', { required: true });
    requireListEdit(req, key);
    const value = str(req.body?.value, 'Value', { required: true, max: 60 });
    const label = str(req.body?.label, 'Label', { max: 200 }) || value;
    const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM lists WHERE list_key = ?').get(key).n;
    try {
      db.prepare('INSERT INTO lists (list_key, value, label, sort) VALUES (?, ?, ?, ?)').run(key, value, label, sort);
    } catch {
      throw new HttpError(409, 'That value already exists in this list.');
    }
    audit(db, req, 'list.add', { entity: 'list', detail: { key, value, label } });
    res.status(201).json({ ok: true });
  });

  r.patch('/lists/:id', requireAuth, (req, res) => {
    const row = db.prepare('SELECT * FROM lists WHERE id = ?').get(id(req.params.id));
    if (!row) throw new HttpError(404, 'Not found.');
    requireListEdit(req, row.list_key);
    const label = req.body?.label !== undefined ? str(req.body.label, 'Label', { required: true, max: 200 }) : row.label;
    const active = req.body?.active !== undefined ? (req.body.active ? 1 : 0) : row.active;
    db.prepare('UPDATE lists SET label = ?, active = ? WHERE id = ?').run(label, active, row.id);
    audit(db, req, 'list.update', { entity: 'list', entityId: row.id, detail: { label, active } });
    res.json({ ok: true });
  });

  // ---------------- audit log ----------------
  r.get('/audit', requireCap('audit.view'), (req, res) => {
    const where = [];
    const args = [];
    if (req.query.user_id) { where.push('a.user_id = ?'); args.push(id(req.query.user_id)); }
    if (req.query.client_id) { where.push('a.client_id = ?'); args.push(id(req.query.client_id)); }
    if (req.query.action) { where.push('a.action LIKE ?'); args.push(`${String(req.query.action)}%`); }
    const rows = db.prepare(`
      SELECT a.*, u.name AS user_name, c.first_name || ' ' || c.last_name AS client_name
      FROM audit_log a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN clients c ON c.id = a.client_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.id DESC LIMIT 300`).all(...args);
    res.json(rows);
  });

  // ---------------- dashboard ----------------
  r.get('/dashboard', requireAuth, (req, res) => {
    const u = req.user;
    const out = {};

    // Announcements waiting for my acknowledgement
    const anns = db.prepare(`
      SELECT a.id, a.title, a.audience, a.created_at, a.requires_ack, u.name AS author_name,
             EXISTS (SELECT 1 FROM announcement_acks k WHERE k.announcement_id = a.id AND k.user_id = ?) AS acked
      FROM announcements a JOIN users u ON u.id = a.author_id ORDER BY a.created_at DESC LIMIT 200`).all(u.id);
    out.unacked = anns.filter((a) => a.requires_ack && !a.acked && isInAudience(u, JSON.parse(a.audience)))
      .map(({ audience, ...a }) => a);

    // Escalations addressed to my level that are still open
    const escs = db.prepare(`
      SELECT e.*, u.name AS created_by_name FROM escalations e JOIN users u ON u.id = e.created_by
      WHERE e.status != 'resolved' ORDER BY e.created_at DESC`).all();
    out.escalationsInbox = escs.filter((e) => e.created_by !== u.id && canSeeEscalation(u, e)).slice(0, 20);
    out.escalationsMine = escs.filter((e) => e.created_by === u.id).slice(0, 20);

    const ids = clinicalClientIds(db, u);
    const inClients = (col) => (ids === null ? '1=1' : ids.length ? `${col} IN (${ids.map(Number).join(',')})` : '0=1');

    if (can(u, 'clinical.view_all') || can(u, 'clinical.view_assigned')) {
      out.myClients = db.prepare(`SELECT id, first_name, last_name FROM clients
        WHERE status = 'active' AND ${inClients('id')} ORDER BY last_name LIMIT 50`).all();
      out.recentConcerns = db.prepare(`
        SELECT o.id, o.client_id, o.category, o.severity, o.body, o.at, u.name AS author_name,
               c.first_name || ' ' || c.last_name AS client_name
        FROM observations o JOIN users u ON u.id = o.author_id JOIN clients c ON c.id = o.client_id
        WHERE o.severity IN ('concern', 'urgent') AND o.at >= datetime('now', '-7 days') AND ${inClients('o.client_id')}
        ORDER BY o.at DESC LIMIT 20`).all();
    }
    if (can(u, 'clinical.write')) {
      out.myNotes = db.prepare(`SELECT status, COUNT(*) AS n FROM session_notes
        WHERE author_id = ? AND status IN ('draft', 'returned', 'submitted') GROUP BY status`).all(u.id);
    }
    if (can(u, 'notes.approve')) {
      out.notesToReview = db.prepare(`SELECT COUNT(*) AS n FROM session_notes
        WHERE status = 'submitted' AND author_id != ? AND ${inClients('client_id')}`).get(u.id).n;
    }
    if (can(u, 'insurance.view')) {
      out.eligibilityDue = eligibilityDue(db).filter((p) => p.due).length;
    }
    if (can(u, 'insurance.view') || can(u, 'insurance.view_summary')) {
      out.authAlerts = authorizationUsage(db).filter((a) => a.alert).slice(0, 20)
        .map((a) => (can(u, 'insurance.view') ? a : summarizeAuthorization(a)));
    }
    if (can(u, 'billing.view')) {
      out.unbilled = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(units), 0) AS units FROM session_notes
        WHERE status = 'approved' AND billed_at IS NULL`).get();
    }
    if (can(u, 'transport.manage')) {
      out.ridesToday = db.prepare(`SELECT status, COUNT(*) AS n FROM rides WHERE ride_date = ? GROUP BY status`).all(today());
    } else if (can(u, 'transport.view_own')) {
      out.myRidesToday = db.prepare(`
        SELECT r.*, c.first_name || ' ' || c.last_name AS client_name FROM rides r JOIN clients c ON c.id = r.client_id
        WHERE r.driver_id = ? AND r.ride_date = ? ORDER BY r.scheduled_time`).all(u.id, today());
    }
    res.json(out);
  });

  return r;
};

// Shared with admin routes: each active policy with its last check and whether
// it is due today.
function eligibilityDue(db) {
  const rows = db.prepare(`
    SELECT p.*, c.first_name || ' ' || c.last_name AS client_name,
      (SELECT checked_at FROM eligibility_checks e WHERE e.policy_id = p.id ORDER BY e.id DESC LIMIT 1) AS last_checked_at,
      (SELECT result FROM eligibility_checks e WHERE e.policy_id = p.id ORDER BY e.id DESC LIMIT 1) AS last_result,
      (SELECT u.name FROM eligibility_checks e JOIN users u ON u.id = e.checked_by
        WHERE e.policy_id = p.id ORDER BY e.id DESC LIMIT 1) AS last_checked_by
    FROM insurance_policies p JOIN clients c ON c.id = p.client_id
    WHERE p.active = 1 AND c.status = 'active' ORDER BY c.last_name`).all();
  const t = today();
  return rows.map((p) => {
    // Never checked, or the last check found a problem: due now.
    const next = p.last_result === 'active' ? addDays(p.last_checked_at.slice(0, 10), p.check_frequency_days) : t;
    return { ...p, next_check: next, due: next <= t };
  });
}

// Every authorization with units used (approved notes) and whether it needs attention.
function authorizationUsage(db, clientId = null) {
  const rows = db.prepare(`
    SELECT a.*, c.first_name || ' ' || c.last_name AS client_name, p.payer,
      COALESCE((SELECT SUM(n.units) FROM session_notes n WHERE n.authorization_id = a.id AND n.status = 'approved'), 0) AS units_used,
      COALESCE((SELECT SUM(n.units) FROM session_notes n WHERE n.client_id = a.client_id AND n.service_code = a.service_code
        AND n.status = 'submitted' AND n.session_date BETWEEN a.start_date AND a.end_date), 0) AS units_pending
    FROM authorizations a JOIN clients c ON c.id = a.client_id LEFT JOIN insurance_policies p ON p.id = a.policy_id
    ${clientId ? 'WHERE a.client_id = ?' : ''}
    ORDER BY a.end_date`).all(...(clientId ? [clientId] : []));
  const t = today();
  const soon = addDays(t, 30);
  return rows.map((a) => {
    const pct = a.units_approved ? Math.round((a.units_used / a.units_approved) * 100) : 0;
    const expired = a.end_date < t;
    const expiringSoon = !expired && a.end_date <= soon;
    const current = a.start_date <= t && !expired;
    const reasons = [];
    if (expiringSoon) reasons.push(`expires ${a.end_date}`);
    if (a.units_used > a.units_approved) reasons.push(`over by ${a.units_used - a.units_approved} units`);
    else if (current && pct >= 80) reasons.push(`${pct}% of units used`);
    return { ...a, pct_used: pct, units_remaining: a.units_approved - a.units_used, expired, current,
      alert: reasons.length > 0, alert_reasons: reasons };
  });
}

// What clinicians and coordinators may see about an authorization: units and dates, no payer details.
function summarizeAuthorization(a) {
  const keys = ['id', 'client_id', 'client_name', 'service_code', 'start_date', 'end_date', 'units_approved', 'units_used',
    'units_pending', 'units_remaining', 'pct_used', 'current', 'expired', 'alert', 'alert_reasons'];
  return Object.fromEntries(keys.map((k) => [k, a[k]]));
}

module.exports.eligibilityDue = eligibilityDue;
module.exports.summarizeAuthorization = summarizeAuthorization;
module.exports.authorizationUsage = authorizationUsage;
module.exports.LIST_DOMAINS = LIST_DOMAINS;
