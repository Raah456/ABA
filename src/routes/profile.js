'use strict';

const express = require('express');
const { can } = require('../permissions');
const { requireAuth, requireCap, HttpError } = require('../auth');
const { tx } = require('../db');
const {
  audit, str, oneOf, id, requireClinicalView, requireClinicalWrite, canViewBasic, clinicalClientIds,
} = require('../access');

// Profile sections, in the order staff read them. `shared` sections are also shown to
// non-clinical staff who serve the client (drivers, front desk) because they affect safety.
const PROFILE_SECTIONS = [
  { key: 'alerts', label: 'Safety & medical alerts', help: 'Allergies, seizures, elopement risk, car seat, medications', shared: true },
  { key: 'about', label: 'About me', help: 'Interests, strengths, favorite topics and characters' },
  { key: 'communication', label: 'How I communicate', help: 'Vocal, signs, device, how I say yes/no/help' },
  { key: 'reinforcement', label: 'How to reinforce me', help: 'Schedule, how to deliver, signs of satiation' },
  { key: 'triggers', label: 'Things that upset me', help: 'Known triggers and what to avoid' },
  { key: 'calming', label: 'What helps when I am upset', help: 'Calming and de-escalation that works' },
  { key: 'sensory', label: 'Sensory needs', help: 'Seeks or avoids: noise, textures, movement' },
  { key: 'family', label: 'Family notes', help: 'Preferences, routines at home, who to talk to' },
];
const SECTION_KEYS = PROFILE_SECTIONS.map((s) => s.key);
const REINFORCER_CATEGORIES = ['edible', 'tangible', 'activity', 'social', 'sensory', 'other'];
const STRENGTHS = ['high', 'medium', 'low'];
const SUGGESTION_KINDS = ['reinforcer', 'strategy', 'trigger', 'other'];

// Where an approved idea lands on the profile.
const KIND_TO_SECTION = { strategy: 'calming', trigger: 'triggers', other: 'about' };

function sharedAlerts(db, clientId) {
  return db.prepare("SELECT body FROM client_profile WHERE client_id = ? AND section = 'alerts'").get(clientId)?.body || null;
}

module.exports = function profileRoutes(db) {
  const r = express.Router();

  function logChange(clientId, userId, summary) {
    db.prepare('INSERT INTO profile_changes (client_id, changed_by, summary) VALUES (?, ?, ?)').run(clientId, userId, summary);
  }

  function writeSection(clientId, section, body, userId) {
    if (body) {
      db.prepare(`INSERT INTO client_profile (client_id, section, body, updated_by, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT (client_id, section) DO UPDATE SET body = excluded.body, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .run(clientId, section, body, userId);
    } else {
      db.prepare('DELETE FROM client_profile WHERE client_id = ? AND section = ?').run(clientId, section);
    }
  }

  r.get('/clients/:id/profile', requireAuth, (req, res) => {
    const clientId = id(req.params.id);
    requireClinicalView(db, req.user, clientId);
    const rows = db.prepare(`SELECT p.*, u.name AS updated_by_name FROM client_profile p
      LEFT JOIN users u ON u.id = p.updated_by WHERE p.client_id = ?`).all(clientId);
    const byKey = new Map(rows.map((row) => [row.section, row]));
    const sections = PROFILE_SECTIONS.map((s) => {
      const row = byKey.get(s.key);
      return { ...s, body: row?.body || '', updated_at: row?.updated_at || null, updated_by_name: row?.updated_by_name || null };
    });
    const reinforcers = db.prepare(`SELECT r.*, u.name AS added_by_name, a.name AS suggested_by_name
      FROM reinforcers r LEFT JOIN users u ON u.id = r.added_by
      LEFT JOIN suggestions s ON s.id = r.suggestion_id LEFT JOIN users a ON a.id = s.author_id
      WHERE r.client_id = ? ORDER BY r.active DESC, CASE r.strength WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, r.name`).all(clientId);
    const suggestions = db.prepare(`SELECT s.*, a.name AS author_name, a.role AS author_role, v.name AS reviewer_name,
        (SELECT COUNT(*) FROM suggestion_votes x WHERE x.suggestion_id = s.id) AS votes,
        EXISTS (SELECT 1 FROM suggestion_votes x WHERE x.suggestion_id = s.id AND x.user_id = ?) AS voted
      FROM suggestions s JOIN users a ON a.id = s.author_id LEFT JOIN users v ON v.id = s.reviewer_id
      WHERE s.client_id = ? ORDER BY s.status = 'open' DESC, s.created_at DESC LIMIT 200`).all(req.user.id, clientId);
    const changes = db.prepare(`SELECT c.*, u.name AS changed_by_name FROM profile_changes c LEFT JOIN users u ON u.id = c.changed_by
      WHERE c.client_id = ? ORDER BY c.id DESC LIMIT 100`).all(clientId);
    audit(db, req, 'profile.view', { entity: 'client', entityId: clientId, clientId });
    res.json({
      sections, reinforcers, suggestions, changes,
      canEdit: can(req.user, 'profile.edit'),
      canSuggest: can(req.user, 'clinical.write'),
      categories: REINFORCER_CATEGORIES,
    });
  });

  r.put('/clients/:id/profile/:section', requireCap('profile.edit'), (req, res) => {
    const clientId = id(req.params.id);
    requireClinicalWrite(db, req.user, clientId);
    const section = oneOf(req.params.section, 'Section', SECTION_KEYS);
    const body = str(req.body?.body, 'Text', { max: 10000 });
    const label = PROFILE_SECTIONS.find((s) => s.key === section).label;
    tx(db, () => {
      writeSection(clientId, section, body, req.user.id);
      logChange(clientId, req.user.id, body ? `Updated "${label}"` : `Cleared "${label}"`);
    });
    audit(db, req, 'profile.update', { entity: 'client', entityId: clientId, clientId, detail: { section } });
    res.json({ ok: true });
  });

  // ---------- reinforcers ----------
  function parseReinforcer(b, partial) {
    const out = {};
    const has = (k) => !partial || b[k] !== undefined;
    if (has('name')) out.name = str(b.name, 'Reinforcer', { required: true, max: 120 });
    if (has('category')) out.category = oneOf(b.category, 'Type', REINFORCER_CATEGORIES);
    if (has('strength')) out.strength = b.strength == null && !partial ? 'medium' : oneOf(b.strength, 'Strength', STRENGTHS);
    if (has('notes')) out.notes = str(b.notes, 'Notes', { max: 1000 });
    if (b.active !== undefined) out.active = b.active ? 1 : 0;
    return out;
  }

  r.post('/clients/:id/reinforcers', requireCap('profile.edit'), (req, res) => {
    const clientId = id(req.params.id);
    requireClinicalWrite(db, req.user, clientId);
    const v = parseReinforcer(req.body || {}, false);
    const newId = tx(db, () => {
      const info = db.prepare('INSERT INTO reinforcers (client_id, name, category, strength, notes, added_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(clientId, v.name, v.category, v.strength, v.notes, req.user.id);
      logChange(clientId, req.user.id, `Added reinforcer "${v.name}" (${v.strength})`);
      return Number(info.lastInsertRowid);
    });
    audit(db, req, 'reinforcer.create', { entity: 'reinforcer', entityId: newId, clientId });
    res.status(201).json({ id: newId });
  });

  r.patch('/reinforcers/:id', requireCap('profile.edit'), (req, res) => {
    const before = db.prepare('SELECT * FROM reinforcers WHERE id = ?').get(id(req.params.id));
    if (!before) throw new HttpError(404, 'Reinforcer not found.');
    requireClinicalWrite(db, req.user, before.client_id);
    const v = parseReinforcer(req.body || {}, true);
    const keys = Object.keys(v);
    if (!keys.length) return res.json({ ok: true });
    const parts = [];
    if (v.strength && v.strength !== before.strength) parts.push(`strength ${before.strength} → ${v.strength}`);
    if (v.active === 0 && before.active) parts.push('no longer working');
    if (v.active === 1 && !before.active) parts.push('working again');
    if (v.name && v.name !== before.name) parts.push(`renamed from "${before.name}"`);
    if (v.notes !== undefined && v.notes !== before.notes) parts.push('notes updated');
    tx(db, () => {
      db.prepare(`UPDATE reinforcers SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
        .run(...keys.map((k) => v[k]), before.id);
      if (parts.length) logChange(before.client_id, req.user.id, `Reinforcer "${v.name || before.name}": ${parts.join(', ')}`);
    });
    audit(db, req, 'reinforcer.update', { entity: 'reinforcer', entityId: before.id, clientId: before.client_id });
    return res.json({ ok: true });
  });

  // ---------- team ideas ----------
  function getSuggestion(req) {
    const s = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id(req.params.id));
    if (!s) throw new HttpError(404, 'Idea not found.');
    requireClinicalView(db, req.user, s.client_id);
    return s;
  }

  r.post('/clients/:id/suggestions', requireCap('clinical.write'), (req, res) => {
    const clientId = id(req.params.id);
    requireClinicalWrite(db, req.user, clientId);
    const b = req.body || {};
    const kind = oneOf(b.kind, 'Type of idea', SUGGESTION_KINDS);
    const category = kind === 'reinforcer' ? oneOf(b.category || 'other', 'Reinforcer type', REINFORCER_CATEGORIES) : null;
    const info = db.prepare('INSERT INTO suggestions (client_id, author_id, kind, category, title, details) VALUES (?, ?, ?, ?, ?, ?)')
      .run(clientId, req.user.id, kind, category, str(b.title, 'What worked', { required: true, max: 150 }), str(b.details, 'Details', { max: 2000 }));
    const newId = Number(info.lastInsertRowid);
    audit(db, req, 'suggestion.create', { entity: 'suggestion', entityId: newId, clientId });
    res.status(201).json({ id: newId });
  });

  // "Worked for me too" (toggles).
  r.post('/suggestions/:id/vote', requireCap('clinical.write'), (req, res) => {
    const s = getSuggestion(req);
    if (s.author_id === req.user.id) throw new HttpError(400, 'You shared this one.');
    const had = db.prepare('SELECT 1 FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?').get(s.id, req.user.id);
    if (had) db.prepare('DELETE FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?').run(s.id, req.user.id);
    else db.prepare('INSERT INTO suggestion_votes (suggestion_id, user_id) VALUES (?, ?)').run(s.id, req.user.id);
    res.json({ voted: !had });
  });

  // Add an idea to the profile, or mark it as not used (with a reason everyone can see).
  r.post('/suggestions/:id/review', requireCap('profile.edit'), (req, res) => {
    const s = getSuggestion(req);
    requireClinicalWrite(db, req.user, s.client_id);
    if (s.status !== 'open') throw new HttpError(409, 'This idea was already reviewed.');
    const action = oneOf(req.body?.action, 'Action', ['add', 'not_used']);
    const note = str(req.body?.note, 'Reason', { required: action === 'not_used', max: 1000 });
    const author = db.prepare('SELECT name FROM users WHERE id = ?').get(s.author_id).name;
    tx(db, () => {
      if (action === 'add') {
        if (s.kind === 'reinforcer') {
          const strength = req.body?.strength ? oneOf(req.body.strength, 'Strength', STRENGTHS) : 'medium';
          db.prepare(`INSERT INTO reinforcers (client_id, name, category, strength, notes, suggestion_id, added_by)
                      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(s.client_id, s.title, s.category || 'other', strength, s.details, s.id, req.user.id);
          logChange(s.client_id, req.user.id, `Added reinforcer "${s.title}" from ${author}'s idea`);
        } else {
          const section = KIND_TO_SECTION[s.kind];
          const current = db.prepare('SELECT body FROM client_profile WHERE client_id = ? AND section = ?').get(s.client_id, section)?.body;
          const line = `• ${s.title}${s.details ? ` — ${s.details}` : ''} (from ${author})`;
          writeSection(s.client_id, section, current ? `${current}\n${line}` : line, req.user.id);
          const label = PROFILE_SECTIONS.find((x) => x.key === section).label;
          logChange(s.client_id, req.user.id, `Added ${author}'s idea "${s.title}" to "${label}"`);
        }
      }
      db.prepare(`UPDATE suggestions SET status = ?, reviewer_id = ?, review_note = ?, reviewed_at = datetime('now') WHERE id = ?`)
        .run(action === 'add' ? 'added' : 'not_used', req.user.id, note, s.id);
    });
    audit(db, req, `suggestion.${action}`, { entity: 'suggestion', entityId: s.id, clientId: s.client_id });
    res.json({ ok: true });
  });

  // Open ideas across the clients this person can see (for leads' and QSPs' dashboards).
  r.get('/suggestions', requireCap('profile.edit'), (req, res) => {
    const ids = clinicalClientIds(db, req.user);
    const where = ids === null ? '' : ids.length ? `AND s.client_id IN (${ids.map(Number).join(',')})` : 'AND 0 = 1';
    res.json(db.prepare(`SELECT s.id, s.client_id, s.kind, s.title, s.created_at, a.name AS author_name,
        c.first_name || ' ' || c.last_name AS client_name,
        (SELECT COUNT(*) FROM suggestion_votes x WHERE x.suggestion_id = s.id) AS votes
      FROM suggestions s JOIN users a ON a.id = s.author_id JOIN clients c ON c.id = s.client_id
      WHERE s.status = 'open' ${where} ORDER BY s.created_at LIMIT 100`).all());
  });

  // Safety alerts for anyone who serves the client (including admin staff).
  r.get('/clients/:id/alerts', requireAuth, (req, res) => {
    const clientId = id(req.params.id);
    if (!canViewBasic(db, req.user, clientId)) throw new HttpError(403, 'You do not have access to this client.');
    res.json({ alerts: sharedAlerts(db, clientId) });
  });

  return r;
};

module.exports.PROFILE_SECTIONS = PROFILE_SECTIONS;
module.exports.sharedAlerts = sharedAlerts;
