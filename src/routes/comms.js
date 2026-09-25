'use strict';

const express = require('express');
const {
  ROLES, deptOf, rankOf, canSeeEscalation, isInAudience, announceableDepts,
} = require('../permissions');
const { requireAuth, requireCap, HttpError } = require('../auth');
const { tx } = require('../db');
const { audit, str, oneOf, id, canViewBasic } = require('../access');
const { createEscalation, checkTarget, PRIORITIES } = require('../escalations');

module.exports = function commsRoutes(db) {
  const r = express.Router();

  // ================= announcements (top-down, one source of truth) =================
  function canSeeAckReport(user, a) {
    return a.author_id === user.id || deptOf(user) === 'leadership' || rankOf(user) >= 3;
  }

  function audienceUsers(audience) {
    return db.prepare('SELECT id, name, role FROM users WHERE active = 1 ORDER BY name').all()
      .filter((u) => deptOf(u) !== 'leadership' && isInAudience(u, audience));
  }

  r.get('/announcements', requireAuth, (req, res) => {
    const rows = db.prepare(`
      SELECT a.*, u.name AS author_name, u.role AS author_role,
        (SELECT at FROM announcement_acks k WHERE k.announcement_id = a.id AND k.user_id = ?) AS acked_at,
        (SELECT COUNT(*) FROM announcement_acks k WHERE k.announcement_id = a.id) AS ack_count
      FROM announcements a JOIN users u ON u.id = a.author_id
      ORDER BY a.pinned DESC, a.created_at DESC LIMIT 200`).all(req.user.id);
    const out = [];
    for (const a of rows) {
      const audience = JSON.parse(a.audience);
      if (a.author_id !== req.user.id && !isInAudience(req.user, audience)) continue;
      const item = { ...a, audience };
      if (canSeeAckReport(req.user, a)) item.audience_size = audienceUsers(audience).length;
      else delete item.ack_count;
      out.push(item);
    }
    res.json(out);
  });

  r.post('/announcements', requireCap('announcements.create'), (req, res) => {
    const b = req.body || {};
    const title = str(b.title, 'Title', { required: true, max: 200 });
    const body = str(b.body, 'Message', { required: true, max: 10000 });
    const allowed = announceableDepts(req.user);
    const depts = Array.isArray(b.depts) && b.depts.length ? b.depts : allowed;
    for (const d of depts) if (!allowed.includes(d)) throw new HttpError(403, `You cannot post to the ${d} department.`);
    const roles = Array.isArray(b.roles) ? b.roles : [];
    for (const role of roles) {
      if (!ROLES[role]) throw new HttpError(400, `Unknown role ${role}.`);
      if (!depts.includes(ROLES[role].dept)) throw new HttpError(400, `${ROLES[role].label} is not in the selected department(s).`);
    }
    const pinned = b.pinned && rankOf(req.user) >= 3 ? 1 : 0;
    const info = db.prepare(`INSERT INTO announcements (author_id, title, body, audience, requires_ack, pinned)
                             VALUES (?, ?, ?, ?, ?, ?)`)
      .run(req.user.id, title, body, JSON.stringify({ depts, roles }), b.requires_ack === false ? 0 : 1, pinned);
    audit(db, req, 'announcement.create', { entity: 'announcement', entityId: Number(info.lastInsertRowid) });
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });

  function getAnnouncement(req) {
    const a = db.prepare('SELECT * FROM announcements WHERE id = ?').get(id(req.params.id));
    if (!a) throw new HttpError(404, 'Announcement not found.');
    a.audience = JSON.parse(a.audience);
    if (a.author_id !== req.user.id && !isInAudience(req.user, a.audience)) throw new HttpError(404, 'Announcement not found.');
    return a;
  }

  r.post('/announcements/:id/ack', requireAuth, (req, res) => {
    const a = getAnnouncement(req);
    db.prepare('INSERT OR IGNORE INTO announcement_acks (announcement_id, user_id) VALUES (?, ?)').run(a.id, req.user.id);
    res.json({ ok: true });
  });

  // Who has / hasn't read it.
  r.get('/announcements/:id/acks', requireAuth, (req, res) => {
    const a = getAnnouncement(req);
    if (!canSeeAckReport(req.user, a)) throw new HttpError(403, 'You cannot see read receipts for this.');
    const acks = new Map(db.prepare('SELECT user_id, at FROM announcement_acks WHERE announcement_id = ?').all(a.id)
      .map((k) => [k.user_id, k.at]));
    res.json(audienceUsers(a.audience).map((u) => ({ ...u, acked_at: acks.get(u.id) || null })));
  });

  r.patch('/announcements/:id', requireAuth, (req, res) => {
    const a = getAnnouncement(req);
    if (a.author_id !== req.user.id && deptOf(req.user) !== 'leadership') throw new HttpError(403, 'Only the author can change this.');
    const pinned = req.body?.pinned !== undefined ? (req.body.pinned ? 1 : 0) : a.pinned;
    db.prepare('UPDATE announcements SET pinned = ? WHERE id = ?').run(pinned, a.id);
    res.json({ ok: true });
  });

  // ================= escalations (bottom-up, tracked to resolution) =================
  const ESC_SELECT = `
    SELECT e.*, u.name AS created_by_name, u.role AS created_by_role, o.name AS owner_name,
           c.first_name || ' ' || c.last_name AS client_name
    FROM escalations e JOIN users u ON u.id = e.created_by LEFT JOIN users o ON o.id = e.owner_id
    LEFT JOIN clients c ON c.id = e.client_id`;

  function getEscalation(req) {
    const e = db.prepare(`${ESC_SELECT} WHERE e.id = ?`).get(id(req.params.id));
    if (!e || !canSeeEscalation(req.user, e)) throw new HttpError(404, 'Report not found.');
    return e;
  }

  function addEvent(escId, userId, kind, body) {
    db.prepare('INSERT INTO escalation_events (escalation_id, user_id, kind, body) VALUES (?, ?, ?, ?)').run(escId, userId, kind, body);
    db.prepare('UPDATE escalations SET updated_at = datetime(\'now\') WHERE id = ?').run(escId);
  }

  r.get('/escalations', requireAuth, (req, res) => {
    const box = oneOf(req.query.box || 'inbox', 'Box', ['inbox', 'sent', 'all']);
    const status = req.query.status ? oneOf(req.query.status, 'Status', ['open', 'acknowledged', 'resolved', 'active']) : null;
    let rows = db.prepare(`${ESC_SELECT} ORDER BY e.updated_at DESC LIMIT 1000`).all()
      .filter((e) => canSeeEscalation(req.user, e));
    if (box === 'inbox') rows = rows.filter((e) => e.created_by !== req.user.id);
    if (box === 'sent') rows = rows.filter((e) => e.created_by === req.user.id);
    if (status === 'active') rows = rows.filter((e) => e.status !== 'resolved');
    else if (status) rows = rows.filter((e) => e.status === status);
    res.json(rows);
  });

  r.get('/escalations/:id', requireAuth, (req, res) => {
    const e = getEscalation(req);
    const events = db.prepare(`SELECT v.*, u.name AS user_name, u.role AS user_role FROM escalation_events v
      JOIN users u ON u.id = v.user_id WHERE v.escalation_id = ? ORDER BY v.id`).all(e.id);
    audit(db, req, 'escalation.view', { entity: 'escalation', entityId: e.id, clientId: e.client_id });
    res.json({ ...e, events });
  });

  r.post('/escalations', requireAuth, (req, res) => {
    const b = req.body || {};
    const clientId = b.client_id ? id(b.client_id, 'Client') : null;
    if (clientId && !canViewBasic(db, req.user, clientId)) throw new HttpError(403, 'You do not have access to that client.');
    const escId = createEscalation(db, req.user, {
      target_dept: b.target_dept,
      target_rank: Number(b.target_rank),
      client_id: clientId,
      category: str(b.category, 'Category', { required: true, max: 60 }),
      priority: b.priority || 'normal',
      subject: str(b.subject, 'Subject', { required: true, max: 200 }),
      body: str(b.body, 'Details', { required: true, max: 10000 }),
    });
    audit(db, req, 'escalation.create', { entity: 'escalation', entityId: escId, clientId });
    res.status(201).json({ id: escId });
  });

  r.post('/escalations/:id/comment', requireAuth, (req, res) => {
    const e = getEscalation(req);
    const body = str(req.body?.body, 'Comment', { required: true, max: 5000 });
    addEvent(e.id, req.user.id, 'comment', body);
    audit(db, req, 'escalation.comment', { entity: 'escalation', entityId: e.id, clientId: e.client_id });
    res.status(201).json({ ok: true });
  });

  // Acknowledge / take ownership / resolve. The reporter can only resolve (withdraw) their own.
  r.post('/escalations/:id/status', requireAuth, (req, res) => {
    const e = getEscalation(req);
    const status = oneOf(req.body?.status, 'Status', ['open', 'acknowledged', 'resolved']);
    const isRecipient = e.created_by !== req.user.id || deptOf(req.user) === 'leadership';
    if (!isRecipient && status !== 'resolved') throw new HttpError(403, 'Someone at the receiving level must acknowledge this.');
    const note = str(req.body?.note, 'Note', { required: status === 'resolved' && isRecipient, max: 5000 });
    tx(db, () => {
      db.prepare('UPDATE escalations SET status = ?, owner_id = COALESCE(owner_id, ?) WHERE id = ?')
        .run(status, isRecipient ? req.user.id : null, e.id);
      addEvent(e.id, req.user.id, 'status', `${status}${note ? `: ${note}` : ''}`);
    });
    audit(db, req, 'escalation.status', { entity: 'escalation', entityId: e.id, clientId: e.client_id, detail: { status } });
    res.json({ ok: true });
  });

  // Send it further up (or across to another department).
  r.post('/escalations/:id/raise', requireAuth, (req, res) => {
    const e = getEscalation(req);
    const dept = req.body?.target_dept;
    const rank = checkTarget(req.user, dept, Number(req.body?.target_rank));
    if (dept === e.target_dept && rank <= e.target_rank) throw new HttpError(400, 'Choose a higher level than it is at now.');
    const reason = str(req.body?.reason, 'Reason', { required: true, max: 2000 });
    const priority = req.body?.priority ? oneOf(req.body.priority, 'Priority', PRIORITIES) : e.priority;
    const label = dept === 'leadership' ? 'Leadership'
      : Object.values(ROLES).filter((x) => x.dept === dept && x.rank === rank).map((x) => x.label).join(' / ');
    tx(db, () => {
      db.prepare('UPDATE escalations SET target_dept = ?, target_rank = ?, priority = ?, status = \'open\', owner_id = NULL WHERE id = ?')
        .run(dept, rank, priority, e.id);
      addEvent(e.id, req.user.id, 'raised', `Raised to ${label}: ${reason}`);
    });
    audit(db, req, 'escalation.raise', { entity: 'escalation', entityId: e.id, clientId: e.client_id, detail: { dept, rank } });
    res.json({ ok: true });
  });

  // Levels a user can send a report to, for the UI picker.
  r.get('/escalation-targets', requireAuth, (req, res) => {
    const out = [];
    const seen = new Set();
    for (const role of Object.values(ROLES)) {
      const key = `${role.dept}:${role.rank}`;
      if (seen.has(key)) continue;
      try { checkTarget(req.user, role.dept, role.rank); } catch { continue; }
      seen.add(key);
      const labels = Object.values(ROLES).filter((x) => x.dept === role.dept && x.rank === role.rank).map((x) => x.label);
      out.push({ target_dept: role.dept, target_rank: role.rank, label: `${labels.join(' / ')}${role.dept === 'leadership' ? '' : ' and above'}` });
    }
    out.sort((a, b) => (a.target_dept === deptOf(req.user) ? 0 : 1) - (b.target_dept === deptOf(req.user) ? 0 : 1) || a.target_rank - b.target_rank);
    res.json(out);
  });

  return r;
};
