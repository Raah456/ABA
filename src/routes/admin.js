'use strict';

const express = require('express');
const { can } = require('../permissions');
const { requireCap, HttpError } = require('../auth');
const { tx } = require('../db');
const {
  audit, str, oneOf, date, time, num, id, today, assertClient, clinicalClientIds,
} = require('../access');
const { eligibilityDue, authorizationUsage, summarizeAuthorization } = require('./core');

const RIDE_STATUSES = ['scheduled', 'en_route', 'completed', 'no_show', 'cancelled'];

function parsePolicy(b, partial) {
  const out = {};
  const has = (k) => !partial || b[k] !== undefined;
  if (has('payer')) out.payer = str(b.payer, 'Payer', { required: true, max: 120 });
  if (has('member_id')) out.member_id = str(b.member_id, 'Member ID', { max: 60 });
  if (has('group_number')) out.group_number = str(b.group_number, 'Group number', { max: 60 });
  if (has('priority')) out.priority = b.priority == null && !partial ? 'primary' : oneOf(b.priority, 'Priority', ['primary', 'secondary', 'tertiary']);
  if (has('check_frequency_days')) {
    out.check_frequency_days = b.check_frequency_days == null && !partial
      ? 30 : num(b.check_frequency_days, 'Check frequency', { required: true, min: 1, max: 365, integer: true });
  }
  if (b.active !== undefined) out.active = b.active ? 1 : 0;
  return out;
}

function parseAuth(b, partial) {
  const out = {};
  const has = (k) => !partial || b[k] !== undefined;
  if (has('policy_id')) out.policy_id = b.policy_id ? id(b.policy_id, 'Policy') : null;
  if (has('auth_number')) out.auth_number = str(b.auth_number, 'Authorization number', { max: 60 });
  if (has('service_code')) out.service_code = str(b.service_code, 'Service code', { required: true, max: 20 });
  if (has('units_approved')) out.units_approved = num(b.units_approved, 'Units approved', { required: true, min: 0, integer: true });
  if (has('start_date')) out.start_date = date(b.start_date, 'Start date', { required: true });
  if (has('end_date')) out.end_date = date(b.end_date, 'End date', { required: true });
  if (has('notes')) out.notes = str(b.notes, 'Notes', { max: 2000 });
  return out;
}

function parseRide(b, partial) {
  const out = {};
  const has = (k) => !partial || b[k] !== undefined;
  if (has('ride_date')) out.ride_date = date(b.ride_date, 'Date', { required: true });
  if (has('client_id')) out.client_id = id(b.client_id, 'Client');
  if (has('direction')) out.direction = oneOf(b.direction, 'Direction', ['pickup', 'dropoff']);
  if (has('scheduled_time')) out.scheduled_time = time(b.scheduled_time, 'Time', { required: true });
  if (has('from_address')) out.from_address = str(b.from_address, 'From', { max: 300 });
  if (has('to_address')) out.to_address = str(b.to_address, 'To', { max: 300 });
  if (has('driver_id')) out.driver_id = b.driver_id ? id(b.driver_id, 'Driver') : null;
  if (has('status')) out.status = b.status == null && !partial ? 'scheduled' : oneOf(b.status, 'Status', RIDE_STATUSES);
  if (has('notes')) out.notes = str(b.notes, 'Notes', { max: 1000 });
  return out;
}

function update(db, table, rowId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), rowId);
}

function insert(db, table, fields) {
  const keys = Object.keys(fields);
  const info = db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...keys.map((k) => fields[k]));
  return Number(info.lastInsertRowid);
}

module.exports = function adminRoutes(db) {
  const r = express.Router();

  // ================= insurance =================
  // Full view for insurance roles; clinicians/coordinators get authorization
  // usage only (no member IDs or eligibility history).
  r.get('/clients/:id/insurance', requireCap('insurance.view', 'insurance.view_summary'), (req, res) => {
    const clientId = id(req.params.id);
    assertClient(db, clientId);
    const auths = authorizationUsage(db, clientId);
    if (!can(req.user, 'insurance.view')) {
      audit(db, req, 'insurance.summary', { entity: 'client', entityId: clientId, clientId });
      return res.json({ summaryOnly: true, authorizations: auths.map(summarizeAuthorization) });
    }
    const policies = eligibilityDue(db).filter((p) => p.client_id === clientId);
    const inactive = db.prepare('SELECT * FROM insurance_policies WHERE client_id = ? AND active = 0').all(clientId);
    const checks = db.prepare(`SELECT e.*, u.name AS checked_by_name, p.payer FROM eligibility_checks e
      JOIN insurance_policies p ON p.id = e.policy_id LEFT JOIN users u ON u.id = e.checked_by
      WHERE p.client_id = ? ORDER BY e.id DESC LIMIT 50`).all(clientId);
    audit(db, req, 'insurance.view', { entity: 'client', entityId: clientId, clientId });
    res.json({ summaryOnly: false, policies: [...policies, ...inactive.map((p) => ({ ...p, due: false }))], checks, authorizations: auths });
  });

  r.post('/clients/:id/policies', requireCap('insurance.edit'), (req, res) => {
    const clientId = id(req.params.id);
    assertClient(db, clientId);
    const policyId = insert(db, 'insurance_policies', { client_id: clientId, ...parsePolicy(req.body || {}, false) });
    audit(db, req, 'policy.create', { entity: 'policy', entityId: policyId, clientId });
    res.status(201).json({ id: policyId });
  });

  r.patch('/policies/:id', requireCap('insurance.edit'), (req, res) => {
    const p = db.prepare('SELECT * FROM insurance_policies WHERE id = ?').get(id(req.params.id));
    if (!p) throw new HttpError(404, 'Policy not found.');
    update(db, 'insurance_policies', p.id, parsePolicy(req.body || {}, true));
    audit(db, req, 'policy.update', { entity: 'policy', entityId: p.id, clientId: p.client_id });
    res.json({ ok: true });
  });

  // The morning eligibility checklist.
  r.get('/eligibility', requireCap('insurance.view'), (req, res) => {
    audit(db, req, 'eligibility.list');
    res.json(eligibilityDue(db));
  });

  r.post('/policies/:id/checks', requireCap('insurance.edit'), (req, res) => {
    const p = db.prepare('SELECT * FROM insurance_policies WHERE id = ?').get(id(req.params.id));
    if (!p) throw new HttpError(404, 'Policy not found.');
    const result = oneOf(req.body?.result, 'Result', ['active', 'inactive', 'issue']);
    const notes = str(req.body?.notes, 'Notes', { required: result !== 'active', max: 2000 });
    const checkId = insert(db, 'eligibility_checks', { policy_id: p.id, result, notes, checked_by: req.user.id });
    audit(db, req, 'eligibility.check', { entity: 'policy', entityId: p.id, clientId: p.client_id, detail: { result } });
    res.status(201).json({ id: checkId });
  });

  // ================= authorizations =================
  r.get('/authorizations', requireCap('insurance.view', 'insurance.view_summary'), (req, res) => {
    let rows = authorizationUsage(db);
    if (req.query.alerts) rows = rows.filter((a) => a.alert);
    if (!can(req.user, 'insurance.view')) rows = rows.map(summarizeAuthorization);
    res.json(rows);
  });

  r.post('/clients/:id/authorizations', requireCap('insurance.edit'), (req, res) => {
    const clientId = id(req.params.id);
    assertClient(db, clientId);
    const a = parseAuth(req.body || {}, false);
    if (a.end_date < a.start_date) throw new HttpError(400, 'End date must be after start date.');
    const authId = tx(db, () => {
      const newId = insert(db, 'authorizations', { client_id: clientId, ...a });
      // Attach approved notes in this window that were waiting for an authorization.
      db.prepare(`UPDATE session_notes SET authorization_id = ? WHERE client_id = ? AND service_code = ? AND status = 'approved'
                  AND authorization_id IS NULL AND session_date BETWEEN ? AND ?`)
        .run(newId, clientId, a.service_code, a.start_date, a.end_date);
      return newId;
    });
    audit(db, req, 'authorization.create', { entity: 'authorization', entityId: authId, clientId });
    res.status(201).json({ id: authId });
  });

  r.patch('/authorizations/:id', requireCap('insurance.edit'), (req, res) => {
    const a = db.prepare('SELECT * FROM authorizations WHERE id = ?').get(id(req.params.id));
    if (!a) throw new HttpError(404, 'Authorization not found.');
    const changes = parseAuth(req.body || {}, true);
    const merged = { ...a, ...changes };
    if (merged.end_date < merged.start_date) throw new HttpError(400, 'End date must be after start date.');
    update(db, 'authorizations', a.id, changes);
    audit(db, req, 'authorization.update', { entity: 'authorization', entityId: a.id, clientId: a.client_id, detail: changes });
    res.json({ ok: true });
  });

  // ================= transportation =================
  r.get('/rides', requireCap('transport.manage', 'transport.view_own', 'transport.view_assigned'), (req, res) => {
    const u = req.user;
    const from = date(req.query.date || req.query.from || today(), 'Date');
    const to = date(req.query.to || from, 'To');
    const where = ['r.ride_date BETWEEN ? AND ?'];
    const args = [from, to];
    if (req.query.client_id) { where.push('r.client_id = ?'); args.push(id(req.query.client_id)); }
    if (!can(u, 'transport.manage')) {
      if (can(u, 'transport.view_own')) { where.push('r.driver_id = ?'); args.push(u.id); }
      else {
        const ids = clinicalClientIds(db, u);
        if (ids !== null) where.push(ids.length ? `r.client_id IN (${ids.map(Number).join(',')})` : '0 = 1');
      }
    }
    const rows = db.prepare(`
      SELECT r.*, c.first_name || ' ' || c.last_name AS client_name, c.guardian_name, c.guardian_phone,
             d.name AS driver_name
      FROM rides r JOIN clients c ON c.id = r.client_id LEFT JOIN users d ON d.id = r.driver_id
      WHERE ${where.join(' AND ')} ORDER BY r.ride_date, r.scheduled_time`).all(...args);
    res.json(rows);
  });

  r.post('/rides', requireCap('transport.manage'), (req, res) => {
    const ride = parseRide(req.body || {}, false);
    assertClient(db, ride.client_id);
    const rideId = insert(db, 'rides', { ...ride, updated_by: req.user.id });
    audit(db, req, 'ride.create', { entity: 'ride', entityId: rideId, clientId: ride.client_id });
    res.status(201).json({ id: rideId });
  });

  // Coordinators edit everything; drivers update status/notes on their own rides.
  r.patch('/rides/:id', requireCap('transport.manage', 'transport.view_own'), (req, res) => {
    const ride = db.prepare('SELECT * FROM rides WHERE id = ?').get(id(req.params.id));
    if (!ride) throw new HttpError(404, 'Ride not found.');
    let changes;
    if (can(req.user, 'transport.manage')) {
      changes = parseRide(req.body || {}, true);
    } else {
      if (ride.driver_id !== req.user.id) throw new HttpError(403, 'This ride is not assigned to you.');
      changes = parseRide({ status: req.body?.status, notes: req.body?.notes }, true);
    }
    update(db, 'rides', ride.id, { ...changes, updated_by: req.user.id });
    db.prepare('UPDATE rides SET updated_at = datetime(\'now\') WHERE id = ?').run(ride.id);
    audit(db, req, 'ride.update', { entity: 'ride', entityId: ride.id, clientId: ride.client_id, detail: changes });
    res.json({ ok: true });
  });

  r.delete('/rides/:id', requireCap('transport.manage'), (req, res) => {
    const ride = db.prepare('SELECT * FROM rides WHERE id = ?').get(id(req.params.id));
    if (!ride) throw new HttpError(404, 'Ride not found.');
    db.prepare('DELETE FROM rides WHERE id = ?').run(ride.id);
    audit(db, req, 'ride.delete', { entity: 'ride', entityId: ride.id, clientId: ride.client_id });
    res.json({ ok: true });
  });

  // Copy a day's schedule (e.g. last Monday -> this Monday). Skips cancelled rides.
  r.post('/rides/copy', requireCap('transport.manage'), (req, res) => {
    const from = date(req.body?.from_date, 'From date', { required: true });
    const to = date(req.body?.to_date, 'To date', { required: true });
    if (from === to) throw new HttpError(400, 'Pick two different dates.');
    const existing = db.prepare('SELECT COUNT(*) AS n FROM rides WHERE ride_date = ?').get(to).n;
    if (existing && !req.body?.append) throw new HttpError(409, `${to} already has ${existing} ride(s). Copy anyway to add to them.`);
    const count = tx(db, () => {
      const rows = db.prepare('SELECT * FROM rides WHERE ride_date = ? AND status != \'cancelled\'').all(from);
      for (const r0 of rows) {
        insert(db, 'rides', {
          ride_date: to, client_id: r0.client_id, direction: r0.direction, scheduled_time: r0.scheduled_time,
          from_address: r0.from_address, to_address: r0.to_address, driver_id: r0.driver_id, status: 'scheduled',
          notes: r0.notes, updated_by: req.user.id,
        });
      }
      return rows.length;
    });
    audit(db, req, 'ride.copy', { detail: { from, to, count } });
    res.json({ copied: count });
  });

  // ================= billing queue =================
  // Approved notes: who / when / code / units only. Note content never leaves the clinical side.
  r.get('/billing', requireCap('billing.view'), (req, res) => {
    const billed = req.query.status === 'billed';
    const rows = db.prepare(`
      SELECT n.id, n.client_id, n.session_date, n.start_time, n.end_time, n.service_code, n.units, n.reviewed_at,
             n.billed_at, n.authorization_id, a.auth_number,
             c.first_name || ' ' || c.last_name AS client_name, c.dob, u.name AS provider_name, u.role AS provider_role,
             (SELECT p.payer FROM insurance_policies p WHERE p.client_id = n.client_id AND p.active = 1
               ORDER BY p.priority = 'primary' DESC LIMIT 1) AS payer
      FROM session_notes n JOIN clients c ON c.id = n.client_id JOIN users u ON u.id = n.author_id
      LEFT JOIN authorizations a ON a.id = n.authorization_id
      WHERE n.status = 'approved' AND n.billed_at IS ${billed ? 'NOT NULL' : 'NULL'}
      ORDER BY n.session_date, c.last_name LIMIT 1000`).all();
    audit(db, req, 'billing.list', { detail: { billed } });
    res.json(rows);
  });

  r.post('/billing/mark', requireCap('billing.mark'), (req, res) => {
    const ids = Array.isArray(req.body?.note_ids) ? req.body.note_ids.map((v) => id(v, 'note')) : [];
    if (!ids.length) throw new HttpError(400, 'Select at least one note.');
    const n = tx(db, () => {
      const stmt = db.prepare(`UPDATE session_notes SET billed_at = datetime('now'), billed_by = ?
                               WHERE id = ? AND status = 'approved' AND billed_at IS NULL`);
      return ids.reduce((acc, noteId) => acc + Number(stmt.run(req.user.id, noteId).changes), 0);
    });
    audit(db, req, 'billing.mark', { detail: { note_ids: ids, marked: n } });
    res.json({ marked: n });
  });

  return r;
};
