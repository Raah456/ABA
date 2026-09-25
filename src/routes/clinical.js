'use strict';

const express = require('express');
const { can, rankOf } = require('../permissions');
const { requireAuth, requireCap, HttpError } = require('../auth');
const { tx } = require('../db');
const {
  audit, str, oneOf, date, time, num, id, unitsFor, requireClinicalView, requireClinicalWrite,
  clinicalClientIds, canViewClinical,
} = require('../access');
const { createEscalation, defaultUpTarget } = require('../escalations');

const MEASUREMENTS = ['percent', 'frequency', 'duration', 'rating'];
const PROGRAM_STATUSES = ['baseline', 'active', 'on_hold', 'mastered', 'discontinued'];
const FIELD_TYPES = ['text', 'textarea', 'number', 'select', 'checkbox', 'time', 'date'];
const SEVERITIES = ['info', 'concern', 'urgent'];
const TRIAL_RESULTS = ['correct', 'prompted', 'incorrect', 'no_response'];

// ---------- helpers ----------

function parseProgram(body, partial) {
  const out = {};
  const has = (k) => !partial || body[k] !== undefined;
  if (has('name')) out.name = str(body.name, 'Program name', { required: true, max: 150 });
  if (has('domain')) out.domain = str(body.domain, 'Domain', { max: 80 });
  if (has('goal')) out.goal = str(body.goal, 'Goal', { max: 2000 });
  if (has('instructions')) out.instructions = str(body.instructions, 'Instructions', { max: 5000 });
  if (has('measurement')) out.measurement = oneOf(body.measurement, 'Measurement', MEASUREMENTS);
  if (has('status')) out.status = body.status == null && !partial ? 'active' : oneOf(body.status, 'Status', PROGRAM_STATUSES);
  if (has('mastery_value')) out.mastery_value = num(body.mastery_value, 'Mastery value', { min: 0 });
  if (has('mastery_sessions')) out.mastery_sessions = num(body.mastery_sessions, 'Mastery sessions', { min: 1, max: 50, integer: true });
  if (has('mastery_direction')) {
    out.mastery_direction = body.mastery_direction == null && !partial
      ? 'at_least' : oneOf(body.mastery_direction, 'Mastery direction', ['at_least', 'at_most']);
  }
  return out;
}

// Trials the QSP writes: [{ id?, name, description }]. Every trial needs a description
// so anyone running it presents it the same way.
function parseTrials(list) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list) || list.length > 100) throw new HttpError(400, 'Trials must be a list.');
  const names = new Set();
  return list.map((t, i) => {
    const name = str(t?.name, `Trial ${i + 1} name`, { required: true, max: 120 });
    if (names.has(name.toLowerCase())) throw new HttpError(400, `There are two trials named "${name}".`);
    names.add(name.toLowerCase());
    return {
      id: t?.id ? id(t.id, 'Trial') : null,
      name,
      description: str(t?.description, `Description for "${name}"`, { required: true, max: 2000 }),
    };
  });
}

function loadTrials(db, programId, { all = false } = {}) {
  return db.prepare(`SELECT id, name, description, active, sort FROM program_trials WHERE program_id = ?
    ${all ? '' : 'AND active = 1'} ORDER BY active DESC, sort, id`).all(programId);
}

// Make the program's active trials match `trials`. Removed trials are retired, not
// deleted, so past data still shows what was run. Returns a change summary.
function syncTrials(db, programId, trials, userId) {
  const existing = loadTrials(db, programId, { all: true });
  const byId = new Map(existing.map((t) => [t.id, t]));
  const kept = new Set();
  const parts = [];
  trials.forEach((t, i) => {
    const old = t.id ? byId.get(t.id) : existing.find((e) => e.name.toLowerCase() === t.name.toLowerCase());
    if (t.id && !old) throw new HttpError(400, 'Unknown trial for this program.');
    if (old) {
      kept.add(old.id);
      if (!old.active) parts.push(`restored trial "${t.name}"`);
      else if (old.name !== t.name) parts.push(`renamed trial "${old.name}" → "${t.name}"`);
      if (old.active && old.description !== t.description) parts.push(`updated description of "${t.name}"`);
      db.prepare('UPDATE program_trials SET name = ?, description = ?, sort = ?, active = 1 WHERE id = ?').run(t.name, t.description, i, old.id);
    } else {
      db.prepare('INSERT INTO program_trials (program_id, name, description, sort, created_by) VALUES (?, ?, ?, ?, ?)')
        .run(programId, t.name, t.description, i, userId);
      parts.push(`added trial "${t.name}"`);
    }
  });
  for (const e of existing) {
    if (e.active && !kept.has(e.id)) {
      db.prepare('UPDATE program_trials SET active = 0 WHERE id = ?').run(e.id);
      parts.push(`retired trial "${e.name}"`);
    }
  }
  return parts;
}

// Mastery check: the last N session dates (averaged per date) all meet the criterion.
function masteryStatus(program, data) {
  if (program.mastery_value == null || !program.mastery_sessions) return { met: false, evaluated: false };
  const byDate = new Map();
  for (const d of data) {
    const list = byDate.get(d.session_date) || [];
    list.push(d.value);
    byDate.set(d.session_date, list);
  }
  const dates = [...byDate.keys()].sort();
  const lastN = dates.slice(-program.mastery_sessions);
  if (lastN.length < program.mastery_sessions) return { met: false, evaluated: true };
  const meets = (v) => (program.mastery_direction === 'at_most' ? v <= program.mastery_value : v >= program.mastery_value);
  const met = lastN.every((dt) => {
    const vals = byDate.get(dt);
    return meets(vals.reduce((a, b) => a + b, 0) / vals.length);
  });
  return { met, evaluated: true };
}

function programView(p) {
  const { targets, ...rest } = p;
  return rest;
}

function getProgram(db, programId) {
  const p = db.prepare('SELECT * FROM programs WHERE id = ?').get(programId);
  if (!p) throw new HttpError(404, 'Program not found.');
  return p;
}

function describeChanges(before, after) {
  const labels = {
    name: 'name', domain: 'domain', goal: 'goal', instructions: 'instructions', measurement: 'measurement',
    status: 'status', mastery_value: 'mastery value', mastery_sessions: 'mastery sessions',
    mastery_direction: 'mastery direction',
  };
  const parts = [];
  for (const k of Object.keys(after)) {
    if (String(before[k] ?? '') === String(after[k] ?? '')) continue;
    if (k === 'goal' || k === 'instructions') parts.push(`updated ${labels[k]}`);
    else parts.push(`${labels[k]}: ${before[k] ?? '—'} → ${after[k] ?? '—'}`);
  }
  return parts.join('; ');
}

function parseFields(fields) {
  if (!Array.isArray(fields) || !fields.length) throw new HttpError(400, 'A template needs at least one field.');
  if (fields.length > 60) throw new HttpError(400, 'Too many fields.');
  const keys = new Set();
  return fields.map((f, i) => {
    const label = str(f?.label, `Field ${i + 1} label`, { required: true, max: 200 });
    let key = str(f?.key, `Field ${i + 1} key`, { max: 40 })
      || label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
    if (!/^[a-z0-9_]{1,40}$/.test(key)) throw new HttpError(400, `Field "${label}" has an invalid key.`);
    if (keys.has(key)) key = `${key}_${i}`;
    keys.add(key);
    const type = oneOf(f?.type, `Field "${label}" type`, FIELD_TYPES);
    const out = { key, label, type, required: !!f?.required };
    if (f?.help) out.help = str(f.help, 'Help text', { max: 300 });
    if (type === 'select') {
      const opts = Array.isArray(f.options) ? f.options.map((o) => str(o, 'Option', { required: true, max: 120 })) : [];
      if (!opts.length) throw new HttpError(400, `Field "${label}" needs options.`);
      out.options = opts;
    }
    return out;
  });
}

// Clean note values against the template. With `strict`, required fields must be filled.
function cleanValues(fields, values, strict) {
  const v = values && typeof values === 'object' ? values : {};
  const out = {};
  for (const f of fields) {
    const raw = v[f.key];
    let val = null;
    if (f.type === 'checkbox') val = !!raw;
    else if (f.type === 'number') val = num(raw, f.label);
    else if (f.type === 'select') val = raw == null || raw === '' ? null : oneOf(raw, f.label, f.options);
    else if (f.type === 'time') val = time(raw, f.label);
    else if (f.type === 'date') val = date(raw, f.label);
    else val = str(raw, f.label, { max: f.type === 'textarea' ? 10000 : 500 });
    if (strict && f.required && (val == null || val === '' || val === false)) {
      throw new HttpError(400, `"${f.label}" is required before submitting.`);
    }
    out[f.key] = val;
  }
  return out;
}

function getNote(db, noteId) {
  const n = db.prepare('SELECT * FROM session_notes WHERE id = ?').get(noteId);
  if (!n) throw new HttpError(404, 'Note not found.');
  return n;
}

function noteView(n) {
  const { template_snapshot, values_json, ...rest } = n;
  return { ...rest, fields: JSON.parse(template_snapshot), values: JSON.parse(values_json) };
}

// Find the authorization covering an approved note.
function findAuthorization(db, note) {
  return db.prepare(`SELECT id FROM authorizations WHERE client_id = ? AND service_code = ?
                     AND start_date <= ? AND end_date >= ? ORDER BY end_date LIMIT 1`)
    .get(note.client_id, note.service_code, note.session_date, note.session_date)?.id ?? null;
}

module.exports = function clinicalRoutes(db) {
  const r = express.Router();

  // ================= programs =================
  r.get('/clients/:id/programs', requireAuth, (req, res) => {
    const clientId = id(req.params.id);
    requireClinicalView(db, req.user, clientId);
    const programs = db.prepare('SELECT * FROM programs WHERE client_id = ? ORDER BY status = \'active\' DESC, name').all(clientId);
    const dataStmt = db.prepare('SELECT session_date, value FROM program_data WHERE program_id = ? ORDER BY session_date, id');
    const out = programs.map((p) => {
      const data = dataStmt.all(p.id);
      return { ...programView(p), trials: loadTrials(db, p.id), recent: data.slice(-12), mastery: masteryStatus(p, data), data_points: data.length };
    });
    audit(db, req, 'program.list', { entity: 'client', entityId: clientId, clientId });
    res.json(out);
  });

  r.post('/clients/:id/programs', requireCap('programs.manage'), (req, res) => {
    const clientId = id(req.params.id);
    requireClinicalWrite(db, req.user, clientId);
    const p = parseProgram(req.body || {}, false);
    const trials = parseTrials(req.body?.trials) || [];
    const keys = Object.keys(p);
    const programId = tx(db, () => {
      const info = db.prepare(`INSERT INTO programs (client_id, created_by, ${keys.join(', ')})
                               VALUES (?, ?, ${keys.map(() => '?').join(', ')})`)
        .run(clientId, req.user.id, ...keys.map((k) => p[k]));
      const pid = Number(info.lastInsertRowid);
      syncTrials(db, pid, trials, req.user.id);
      db.prepare('INSERT INTO program_changes (program_id, changed_by, summary, reason) VALUES (?, ?, ?, ?)')
        .run(pid, req.user.id, 'Program created', str(req.body?.reason, 'Reason', { max: 1000 }));
      return pid;
    });
    audit(db, req, 'program.create', { entity: 'program', entityId: programId, clientId });
    res.status(201).json({ id: programId });
  });

  r.get('/programs/:id', requireAuth, (req, res) => {
    const p = getProgram(db, id(req.params.id));
    requireClinicalView(db, req.user, p.client_id);
    const data = db.prepare(`SELECT d.*, u.name AS recorded_by_name FROM program_data d
      LEFT JOIN users u ON u.id = d.recorded_by WHERE d.program_id = ? ORDER BY d.session_date, d.id`).all(p.id);
    const results = db.prepare(`SELECT r.program_data_id, r.result, r.seq, r.note, t.name AS trial_name
      FROM trial_results r JOIN program_trials t ON t.id = r.trial_id JOIN program_data d ON d.id = r.program_data_id
      WHERE d.program_id = ? ORDER BY r.program_data_id, r.seq`).all(p.id);
    const byData = new Map();
    for (const row of results) (byData.get(row.program_data_id) || byData.set(row.program_data_id, []).get(row.program_data_id)).push(row);
    for (const d of data) d.trials = byData.get(d.id) || [];
    const changes = db.prepare(`SELECT c.*, u.name AS changed_by_name FROM program_changes c
      LEFT JOIN users u ON u.id = c.changed_by WHERE c.program_id = ? ORDER BY c.id DESC`).all(p.id);
    audit(db, req, 'program.view', { entity: 'program', entityId: p.id, clientId: p.client_id });
    res.json({ program: programView(p), trials: loadTrials(db, p.id, { all: true }), data, changes, mastery: masteryStatus(p, data) });
  });

  r.patch('/programs/:id', requireCap('programs.manage'), (req, res) => {
    const before = getProgram(db, id(req.params.id));
    requireClinicalWrite(db, req.user, before.client_id);
    const p = parseProgram(req.body || {}, true);
    const trials = parseTrials(req.body?.trials);
    const keys = Object.keys(p);
    const summary = tx(db, () => {
      const parts = [describeChanges(before, p), ...(trials ? syncTrials(db, before.id, trials, req.user.id) : [])].filter(Boolean);
      if (!parts.length) return '';
      if (keys.length) {
        db.prepare(`UPDATE programs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
          .run(...keys.map((k) => p[k]), before.id);
      }
      db.prepare('INSERT INTO program_changes (program_id, changed_by, summary, reason) VALUES (?, ?, ?, ?)')
        .run(before.id, req.user.id, parts.join('; '), str(req.body?.reason, 'Reason', { max: 1000 }));
      return parts.join('; ');
    });
    if (!summary) return res.json({ ok: true, changed: false });
    audit(db, req, 'program.update', { entity: 'program', entityId: before.id, clientId: before.client_id, detail: summary });
    res.json({ ok: true, changed: true });
  });

  // One data point for a program. For % programs either trial-by-trial results
  // ({ trials: [{ trial_id, result, note }] }) or totals ({ correct, total, target }).
  function recordEntry(p, b, sessionDate, userId) {
    const note = str(b.note, 'Note', { max: 1000 });
    if (p.measurement === 'percent' && Array.isArray(b.trials)) {
      if (!b.trials.length) throw new HttpError(400, `Run at least one trial for "${p.name}".`);
      if (b.trials.length > 500) throw new HttpError(400, 'Too many trials in one session.');
      const trials = new Map(loadTrials(db, p.id).map((t) => [t.id, t]));
      const rows = b.trials.map((t) => {
        const trial = trials.get(Number(t?.trial_id));
        if (!trial) throw new HttpError(400, `Unknown or retired trial for "${p.name}".`);
        return { trial_id: trial.id, result: oneOf(t.result, 'Trial result', TRIAL_RESULTS), note: str(t.note, 'Trial note', { max: 500 }) };
      });
      const correct = rows.filter((t) => t.result === 'correct').length;
      const value = Math.round((correct / rows.length) * 1000) / 10;
      const dataId = Number(db.prepare(`INSERT INTO program_data (program_id, session_date, value, correct, total, note, recorded_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(p.id, sessionDate, value, correct, rows.length, note, userId).lastInsertRowid);
      const ins = db.prepare('INSERT INTO trial_results (program_data_id, trial_id, result, seq, note) VALUES (?, ?, ?, ?, ?)');
      rows.forEach((t, i) => ins.run(dataId, t.trial_id, t.result, i + 1, t.note));
      return { id: dataId, value };
    }
    let value;
    let correct = null;
    let total = null;
    let target = null;
    if (p.measurement === 'percent') {
      target = str(b.target, 'Trial', { max: 120 });
      if (target && !loadTrials(db, p.id).some((t) => t.name === target)) throw new HttpError(400, 'Unknown trial for this program.');
      correct = num(b.correct, 'Correct', { required: true, min: 0, integer: true });
      total = num(b.total, 'Total trials', { required: true, min: 1, integer: true });
      if (correct > total) throw new HttpError(400, 'Correct cannot exceed total trials.');
      value = Math.round((correct / total) * 1000) / 10;
    } else {
      value = num(b.value, `Value for "${p.name}"`, { required: true, min: 0 });
    }
    const info = db.prepare(`INSERT INTO program_data (program_id, session_date, target, value, correct, total, note, recorded_by)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(p.id, sessionDate, target, value, correct, total, note, userId);
    return { id: Number(info.lastInsertRowid), value };
  }

  r.post('/programs/:id/data', requireCap('clinical.write'), (req, res) => {
    const p = getProgram(db, id(req.params.id));
    requireClinicalWrite(db, req.user, p.client_id);
    const b = req.body || {};
    const sessionDate = date(b.session_date, 'Session date', { required: true });
    const out = tx(db, () => recordEntry(p, b, sessionDate, req.user.id));
    audit(db, req, 'program.data', { entity: 'program', entityId: p.id, clientId: p.client_id });
    res.status(201).json(out);
  });

  // Save a whole session's data for one client: { session_date, entries: [{ program_id, trials | value, note }] }.
  r.post('/clients/:id/session-data', requireCap('clinical.write'), (req, res) => {
    const clientId = id(req.params.id);
    requireClinicalWrite(db, req.user, clientId);
    const b = req.body || {};
    const sessionDate = date(b.session_date, 'Session date', { required: true });
    if (!Array.isArray(b.entries) || !b.entries.length) throw new HttpError(400, 'There is no data to save yet.');
    const saved = tx(db, () => b.entries.map((e) => {
      const p = getProgram(db, id(e?.program_id, 'Program'));
      if (p.client_id !== clientId) throw new HttpError(400, 'That program belongs to a different client.');
      return { program_id: p.id, ...recordEntry(p, e, sessionDate, req.user.id) };
    }));
    audit(db, req, 'program.session', { entity: 'client', entityId: clientId, clientId, detail: { programs: saved.length } });
    res.status(201).json({ saved });
  });

  // Correct a data entry: the person who recorded it, or a program manager.
  r.delete('/program-data/:id', requireCap('clinical.write'), (req, res) => {
    const row = db.prepare('SELECT d.*, p.client_id FROM program_data d JOIN programs p ON p.id = d.program_id WHERE d.id = ?')
      .get(id(req.params.id));
    if (!row) throw new HttpError(404, 'Data point not found.');
    requireClinicalWrite(db, req.user, row.client_id);
    if (row.recorded_by !== req.user.id && !can(req.user, 'programs.manage')) {
      throw new HttpError(403, 'Only the person who recorded this, or a QSP, can remove it.');
    }
    db.prepare('DELETE FROM program_data WHERE id = ?').run(row.id);
    audit(db, req, 'program.data.delete', { entity: 'program', entityId: row.program_id, clientId: row.client_id,
      detail: { session_date: row.session_date, value: row.value } });
    res.json({ ok: true });
  });

  // ================= note templates =================
  r.get('/templates', requireCap('clinical.write', 'templates.manage'), (req, res) => {
    const all = can(req.user, 'templates.manage') && req.query.all;
    const rows = db.prepare(`SELECT t.*, u.name AS created_by_name FROM note_templates t
      LEFT JOIN users u ON u.id = t.created_by ${all ? '' : 'WHERE t.active = 1'} ORDER BY t.name`).all();
    res.json(rows.map((t) => ({ ...t, fields: JSON.parse(t.fields) })));
  });

  r.post('/templates', requireCap('templates.manage'), (req, res) => {
    const name = str(req.body?.name, 'Template name', { required: true, max: 120 });
    const fields = parseFields(req.body?.fields);
    const code = str(req.body?.service_code, 'Service code', { max: 20 });
    const info = db.prepare('INSERT INTO note_templates (name, service_code, fields, created_by) VALUES (?, ?, ?, ?)')
      .run(name, code, JSON.stringify(fields), req.user.id);
    audit(db, req, 'template.create', { entity: 'template', entityId: Number(info.lastInsertRowid), detail: { name } });
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });

  // Edits apply to new notes; existing notes keep the snapshot they were written with.
  r.patch('/templates/:id', requireCap('templates.manage'), (req, res) => {
    const t = db.prepare('SELECT * FROM note_templates WHERE id = ?').get(id(req.params.id));
    if (!t) throw new HttpError(404, 'Template not found.');
    const b = req.body || {};
    const name = b.name !== undefined ? str(b.name, 'Template name', { required: true, max: 120 }) : t.name;
    const code = b.service_code !== undefined ? str(b.service_code, 'Service code', { max: 20 }) : t.service_code;
    const fields = b.fields !== undefined ? JSON.stringify(parseFields(b.fields)) : t.fields;
    const active = b.active !== undefined ? (b.active ? 1 : 0) : t.active;
    db.prepare(`UPDATE note_templates SET name = ?, service_code = ?, fields = ?, active = ?, updated_at = datetime('now')
                WHERE id = ?`).run(name, code, fields, active, t.id);
    audit(db, req, 'template.update', { entity: 'template', entityId: t.id, detail: { name, active } });
    res.json({ ok: true });
  });

  // ================= session notes =================
  r.get('/notes', requireAuth, (req, res) => {
    const u = req.user;
    const where = [];
    const args = [];
    if (req.query.mine) {
      where.push('n.author_id = ?'); args.push(u.id);
    } else {
      const ids = clinicalClientIds(db, u);
      if (ids === null) { /* all */ } else if (ids.length) where.push(`n.client_id IN (${ids.map(Number).join(',')})`);
      else if (!can(u, 'clinical.write')) throw new HttpError(403, 'You do not have access to session notes.');
      else where.push('0 = 1');
    }
    if (req.query.client_id) { where.push('n.client_id = ?'); args.push(id(req.query.client_id)); }
    if (req.query.status) { where.push('n.status = ?'); args.push(oneOf(req.query.status, 'Status', ['draft', 'submitted', 'returned', 'approved'])); }
    if (req.query.review) { where.push('n.author_id != ?'); args.push(u.id); }
    const rows = db.prepare(`
      SELECT n.id, n.client_id, n.author_id, n.service_code, n.session_date, n.start_time, n.end_time, n.units, n.status,
             n.review_comment, n.reviewed_at, n.billed_at, n.updated_at,
             c.first_name || ' ' || c.last_name AS client_name, a.name AS author_name, rv.name AS reviewer_name,
             t.name AS template_name
      FROM session_notes n JOIN clients c ON c.id = n.client_id JOIN users a ON a.id = n.author_id
      LEFT JOIN users rv ON rv.id = n.reviewer_id LEFT JOIN note_templates t ON t.id = n.template_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY n.session_date DESC, n.id DESC LIMIT 300`).all(...args);
    // A technician's "mine" list may include clients they have since been removed from; drop those.
    res.json(rows.filter((n) => n.author_id === u.id || canViewClinical(db, u, n.client_id)));
  });

  r.get('/notes/:id', requireAuth, (req, res) => {
    const n = getNote(db, id(req.params.id));
    if (n.author_id !== req.user.id) requireClinicalView(db, req.user, n.client_id);
    const extra = db.prepare(`SELECT c.first_name || ' ' || c.last_name AS client_name, a.name AS author_name,
        (SELECT name FROM users WHERE id = ?) AS reviewer_name
      FROM clients c, users a WHERE c.id = ? AND a.id = ?`).get(n.reviewer_id, n.client_id, n.author_id);
    audit(db, req, 'note.view', { entity: 'note', entityId: n.id, clientId: n.client_id });
    res.json({ ...noteView(n), ...extra });
  });

  function noteInput(b, fields, strict) {
    const sessionDate = date(b.session_date, 'Session date', { required: true });
    const start = time(b.start_time, 'Start time', { required: true });
    const end = time(b.end_time, 'End time', { required: true });
    const serviceCode = str(b.service_code, 'Service code', { required: true, max: 20 });
    return {
      session_date: sessionDate, start_time: start, end_time: end, service_code: serviceCode,
      units: unitsFor(start, end), values: cleanValues(fields, b.values, strict),
    };
  }

  r.post('/notes', requireCap('clinical.write'), (req, res) => {
    const b = req.body || {};
    const clientId = id(b.client_id, 'Client');
    requireClinicalWrite(db, req.user, clientId);
    const t = db.prepare('SELECT * FROM note_templates WHERE id = ? AND active = 1').get(id(b.template_id, 'Template'));
    if (!t) throw new HttpError(400, 'Choose an active note template.');
    const fields = JSON.parse(t.fields);
    const submit = !!b.submit;
    const n = noteInput({ ...b, service_code: b.service_code || t.service_code }, fields, submit);
    const info = db.prepare(`INSERT INTO session_notes (client_id, author_id, template_id, template_snapshot, values_json,
        service_code, session_date, start_time, end_time, units, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(clientId, req.user.id, t.id, t.fields, JSON.stringify(n.values), n.service_code, n.session_date,
        n.start_time, n.end_time, n.units, submit ? 'submitted' : 'draft');
    const noteId = Number(info.lastInsertRowid);
    audit(db, req, submit ? 'note.submit' : 'note.create', { entity: 'note', entityId: noteId, clientId });
    res.status(201).json({ id: noteId, units: n.units });
  });

  // Authors can edit their own drafts and returned notes.
  r.patch('/notes/:id', requireCap('clinical.write'), (req, res) => {
    const note = getNote(db, id(req.params.id));
    if (note.author_id !== req.user.id) throw new HttpError(403, 'Only the author can edit this note.');
    if (!['draft', 'returned'].includes(note.status)) throw new HttpError(409, 'Submitted and approved notes are locked.');
    requireClinicalWrite(db, req.user, note.client_id);
    const b = req.body || {};
    const submit = !!b.submit;
    const n = noteInput({ ...noteView(note), ...b }, JSON.parse(note.template_snapshot), submit);
    db.prepare(`UPDATE session_notes SET values_json = ?, service_code = ?, session_date = ?, start_time = ?, end_time = ?,
        units = ?, status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(n.values), n.service_code, n.session_date, n.start_time, n.end_time, n.units,
        submit ? 'submitted' : note.status, note.id);
    audit(db, req, submit ? 'note.submit' : 'note.update', { entity: 'note', entityId: note.id, clientId: note.client_id });
    res.json({ ok: true, units: n.units });
  });

  r.post('/notes/:id/review', requireCap('notes.approve'), (req, res) => {
    const note = getNote(db, id(req.params.id));
    requireClinicalView(db, req.user, note.client_id);
    if (note.author_id === req.user.id) throw new HttpError(403, 'You cannot approve your own note.');
    if (note.status !== 'submitted') throw new HttpError(409, 'Only submitted notes can be reviewed.');
    const action = oneOf(req.body?.action, 'Action', ['approve', 'return']);
    const comment = str(req.body?.comment, 'Comment', { required: action === 'return', max: 2000 });
    const authId = action === 'approve' ? findAuthorization(db, note) : null;
    db.prepare(`UPDATE session_notes SET status = ?, reviewer_id = ?, review_comment = ?, reviewed_at = datetime('now'),
                authorization_id = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(action === 'approve' ? 'approved' : 'returned', req.user.id, comment, authId, note.id);
    audit(db, req, `note.${action}`, { entity: 'note', entityId: note.id, clientId: note.client_id });
    let warning = null;
    if (action === 'approve' && !authId) {
      warning = `No authorization covers ${note.service_code} on ${note.session_date}. Billing will see this note as unauthorized.`;
    } else if (authId) {
      const a = db.prepare(`SELECT a.units_approved, COALESCE(SUM(n.units), 0) AS used FROM authorizations a
        LEFT JOIN session_notes n ON n.authorization_id = a.id AND n.status = 'approved' WHERE a.id = ?`).get(authId);
      if (a.used > a.units_approved) {
        warning = `This authorization is now ${a.used - a.units_approved} unit(s) over the ${a.units_approved} approved. Let billing know.`;
      }
    }
    res.json({ ok: true, authorization_id: authId, warning });
  });

  // ================= client log (observations) =================
  r.get('/clients/:id/observations', requireAuth, (req, res) => {
    const clientId = id(req.params.id);
    requireClinicalView(db, req.user, clientId);
    const rows = db.prepare(`
      SELECT o.*, u.name AS author_name, u.role AS author_role, e.status AS escalation_status
      FROM observations o JOIN users u ON u.id = o.author_id LEFT JOIN escalations e ON e.id = o.escalation_id
      WHERE o.client_id = ? ORDER BY o.at DESC LIMIT 500`).all(clientId);
    audit(db, req, 'observation.list', { entity: 'client', entityId: clientId, clientId });
    res.json(rows);
  });

  r.post('/clients/:id/observations', requireCap('clinical.write'), (req, res) => {
    const clientId = id(req.params.id);
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
    requireClinicalWrite(db, req.user, clientId);
    const b = req.body || {};
    const category = str(b.category, 'Category', { required: true, max: 60 });
    const severity = oneOf(b.severity || 'info', 'Severity', SEVERITIES);
    const body = str(b.body, 'Observation', { required: true, max: 5000 });
    const escalate = !!b.escalate || severity === 'urgent';

    const result = tx(db, () => {
      let escalationId = null;
      if (escalate) {
        // Client concerns go to at least the QSP level.
        const target = rankOf(req.user) < 3 ? { target_dept: 'clinical', target_rank: 3 } : defaultUpTarget(req.user);
        escalationId = createEscalation(db, req.user, {
          ...target, client_id: clientId, category, priority: severity === 'urgent' ? 'urgent' : 'high',
          subject: `${client.first_name} ${client.last_name.slice(0, 1)}.: ${category}`, body,
        });
      }
      const info = db.prepare(`INSERT INTO observations (client_id, author_id, category, severity, body, escalation_id)
                               VALUES (?, ?, ?, ?, ?, ?)`).run(clientId, req.user.id, category, severity, body, escalationId);
      return { id: Number(info.lastInsertRowid), escalation_id: escalationId };
    });
    audit(db, req, 'observation.create', { entity: 'observation', entityId: result.id, clientId,
      detail: result.escalation_id ? { escalation_id: result.escalation_id } : null });
    res.status(201).json(result);
  });

  return r;
};

module.exports.masteryStatus = masteryStatus;
module.exports.TRIAL_RESULTS = TRIAL_RESULTS;
module.exports.cleanValues = cleanValues;
