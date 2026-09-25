'use strict';

const express = require('express');
const { can } = require('../permissions');
const { requireAuth, requireCap, HttpError } = require('../auth');
const { tx } = require('../db');
const {
  audit, str, oneOf, date, id, requireBasicView, canViewClinical, canWriteClinical, assertClient,
} = require('../access');

const CLIENT_FIELDS = ['first_name', 'last_name', 'dob', 'guardian_name', 'guardian_phone', 'address', 'status'];

function parseClient(body, partial) {
  const out = {};
  if (!partial || body.first_name !== undefined) out.first_name = str(body.first_name, 'First name', { required: true, max: 80 });
  if (!partial || body.last_name !== undefined) out.last_name = str(body.last_name, 'Last name', { required: true, max: 80 });
  if (!partial || body.dob !== undefined) out.dob = date(body.dob, 'Date of birth');
  if (!partial || body.guardian_name !== undefined) out.guardian_name = str(body.guardian_name, 'Guardian name', { max: 120 });
  if (!partial || body.guardian_phone !== undefined) out.guardian_phone = str(body.guardian_phone, 'Guardian phone', { max: 40 });
  if (!partial || body.address !== undefined) out.address = str(body.address, 'Address', { max: 300 });
  if (!partial || body.status !== undefined) {
    out.status = body.status == null && !partial ? 'active' : oneOf(body.status, 'Status', ['active', 'waitlist', 'discharged']);
  }
  return out;
}

module.exports = function clientRoutes(db) {
  const r = express.Router();

  r.get('/clients', requireAuth, (req, res) => {
    const u = req.user;
    let rows;
    if (can(u, 'clients.view_basic')) {
      rows = db.prepare('SELECT * FROM clients ORDER BY status, last_name, first_name').all();
    } else if (can(u, 'clinical.view_assigned')) {
      rows = db.prepare(`SELECT c.* FROM clients c JOIN assignments a ON a.client_id = c.id
                         WHERE a.user_id = ? ORDER BY c.status, c.last_name`).all(u.id);
    } else {
      throw new HttpError(403, 'You do not have access to the client list.');
    }
    audit(db, req, 'client.list');
    res.json(rows);
  });

  r.get('/clients/:id', requireAuth, (req, res) => {
    const clientId = id(req.params.id);
    const client = requireBasicView(db, req.user, clientId);
    const team = db.prepare(`SELECT u.id, u.name, u.role FROM assignments a JOIN users u ON u.id = a.user_id
                             WHERE a.client_id = ? ORDER BY u.name`).all(clientId);
    const u = req.user;
    // Tell the UI which sections this viewer may open.
    const sections = {
      clinical: canViewClinical(db, u, clientId),
      clinicalWrite: canWriteClinical(db, u, clientId),
      manageprograms: can(u, 'programs.manage') && canViewClinical(db, u, clientId),
      insurance: can(u, 'insurance.view'),
      insuranceSummary: can(u, 'insurance.view') || can(u, 'insurance.view_summary'),
      insuranceEdit: can(u, 'insurance.edit'),
      transport: can(u, 'transport.manage') || can(u, 'transport.view_assigned'),
      editBasic: can(u, 'clients.edit_basic'),
      manageTeam: can(u, 'assignments.manage'),
    };
    audit(db, req, 'client.view', { entity: 'client', entityId: clientId, clientId });
    res.json({ client, team, sections });
  });

  r.post('/clients', requireCap('clients.edit_basic'), (req, res) => {
    const c = parseClient(req.body || {}, false);
    const info = db.prepare(`INSERT INTO clients (${CLIENT_FIELDS.join(', ')}) VALUES (${CLIENT_FIELDS.map(() => '?').join(', ')})`)
      .run(...CLIENT_FIELDS.map((f) => c[f] ?? null));
    const clientId = Number(info.lastInsertRowid);
    audit(db, req, 'client.create', { entity: 'client', entityId: clientId, clientId });
    res.status(201).json({ id: clientId });
  });

  r.patch('/clients/:id', requireCap('clients.edit_basic'), (req, res) => {
    const clientId = id(req.params.id);
    assertClient(db, clientId);
    const c = parseClient(req.body || {}, true);
    const keys = Object.keys(c);
    if (keys.length) {
      db.prepare(`UPDATE clients SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => c[k]), clientId);
    }
    audit(db, req, 'client.update', { entity: 'client', entityId: clientId, clientId, detail: c });
    res.json({ ok: true });
  });

  // Replace the client's team.
  r.put('/clients/:id/team', requireCap('assignments.manage'), (req, res) => {
    const clientId = id(req.params.id);
    assertClient(db, clientId);
    const ids = Array.isArray(req.body?.user_ids) ? req.body.user_ids.map((v) => id(v, 'user')) : null;
    if (!ids) throw new HttpError(400, 'user_ids must be a list.');
    const exists = db.prepare('SELECT 1 FROM users WHERE id = ?');
    for (const uid of ids) if (!exists.get(uid)) throw new HttpError(400, `Unknown user ${uid}.`);
    tx(db, () => {
      db.prepare('DELETE FROM assignments WHERE client_id = ?').run(clientId);
      const ins = db.prepare('INSERT INTO assignments (client_id, user_id) VALUES (?, ?)');
      for (const uid of new Set(ids)) ins.run(clientId, uid);
    });
    audit(db, req, 'client.team', { entity: 'client', entityId: clientId, clientId, detail: { user_ids: ids } });
    res.json({ ok: true });
  });

  return r;
};
