'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { seed, DEMO_PASSWORD } = require('../src/seed');
const { unitsFor, today } = require('../src/access');
const { masteryStatus } = require('../src/routes/clinical');

let server;
let base;
let db;
const cookies = {};

// Fictional seeded clients: 1 Ava (tech, lead, qsp), 2 Liam (tech, qsp), 3 Noah (tech2, lead, qsp), 4 Emma (tech2, qsp)
before(async () => {
  db = openDb(':memory:');
  seed(db);
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => server.close());

async function login(who) {
  if (cookies[who]) return cookies[who];
  const res = await fetch(`${base}/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${who}@demo.test`, password: DEMO_PASSWORD }),
  });
  assert.equal(res.status, 200, `login ${who}`);
  cookies[who] = res.headers.get('set-cookie').split(';')[0];
  return cookies[who];
}

async function call(who, method, path, body) {
  const headers = { cookie: who ? await login(who) : '' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

const get = (who, path) => call(who, 'GET', path);
const post = (who, path, body = {}) => call(who, 'POST', path, body);
const patch = (who, path, body = {}) => call(who, 'PATCH', path, body);

describe('helpers', () => {
  test('billable units follow the 8-minute rule', () => {
    assert.equal(unitsFor('09:00', '09:07'), 0);
    assert.equal(unitsFor('09:00', '09:08'), 1);
    assert.equal(unitsFor('09:00', '09:22'), 1);
    assert.equal(unitsFor('09:00', '09:23'), 2);
    assert.equal(unitsFor('09:00', '12:00'), 12);
    assert.throws(() => unitsFor('10:00', '09:00'));
  });

  test('mastery requires the last N session dates to meet the criterion', () => {
    const p = { mastery_value: 80, mastery_sessions: 3, mastery_direction: 'at_least' };
    const d = (date, value) => ({ session_date: date, value });
    assert.equal(masteryStatus(p, [d('2026-01-01', 90), d('2026-01-02', 85)]).met, false);
    assert.equal(masteryStatus(p, [d('2026-01-01', 50), d('2026-01-02', 80), d('2026-01-03', 90), d('2026-01-04', 85)]).met, true);
    assert.equal(masteryStatus(p, [d('2026-01-02', 80), d('2026-01-03', 70), d('2026-01-04', 95)]).met, false);
    const reduce = { mastery_value: 1, mastery_sessions: 2, mastery_direction: 'at_most' };
    assert.equal(masteryStatus(reduce, [d('2026-01-01', 4), d('2026-01-02', 1), d('2026-01-03', 0)]).met, true);
  });
});

describe('authentication', () => {
  test('rejects bad passwords and unauthenticated requests', async () => {
    const res = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'tech@demo.test', password: 'wrong' }) });
    assert.equal(res.status, 401);
    assert.equal((await get(null, '/me')).status, 401);
    assert.equal((await get(null, '/clients')).status, 401);
  });

  test('state-changing requests must be JSON (CSRF guard)', async () => {
    const res = await fetch(`${base}/clients/1/observations`, { method: 'POST',
      headers: { cookie: await login('tech'), 'content-type': 'application/x-www-form-urlencoded' }, body: 'category=x&body=y' });
    assert.equal(res.status, 415);
  });

  test('idle sessions expire', async () => {
    const cookie = await login('tech2');
    db.prepare('UPDATE sessions SET last_seen = ?').run(Date.now() - 31 * 60 * 1000);
    const res = await fetch(`${base}/me`, { headers: { cookie } });
    assert.equal(res.status, 401);
    for (const k of Object.keys(cookies)) delete cookies[k];
  });

  test('office manager cannot grant the executive role', async () => {
    const r = await post('office', '/users', { name: 'X', email: 'x@demo.test', role: 'executive', password: 'long-enough-pw' });
    assert.equal(r.status, 403);
  });
});

describe('privacy between clinical and admin', () => {
  test('admin roles cannot read clinical records', async () => {
    for (const who of ['billing', 'frontdesk', 'coord', 'office']) {
      assert.equal((await get(who, '/clients/1/programs')).status, 403, `${who} programs`);
      assert.equal((await get(who, '/clients/1/observations')).status, 403, `${who} observations`);
      assert.equal((await get(who, '/notes/1')).status, 403, `${who} note`);
      assert.equal((await get(who, '/notes')).status, 403, `${who} notes list`);
    }
  });

  test('billing queue carries service details but never note content', async () => {
    const r = await get('billing', '/billing');
    assert.equal(r.status, 200);
    assert.ok(r.data.length > 0);
    for (const row of r.data) {
      assert.equal(row.values_json, undefined);
      assert.equal(row.values, undefined);
      assert.equal(row.template_snapshot, undefined);
    }
  });

  test('clinical staff cannot see insurance member IDs; QSP sees unit summary only', async () => {
    assert.equal((await get('tech', '/clients/1/insurance')).status, 403);
    const r = await get('qsp', '/clients/1/insurance');
    assert.equal(r.status, 200);
    assert.equal(r.data.summaryOnly, true);
    assert.equal(r.data.policies, undefined);
    assert.equal(JSON.stringify(r.data).includes('MA00012345'), false);
    for (const who of ['qsp', 'coord']) {
      const dash = await get(who, '/dashboard');
      assert.ok(dash.data.authAlerts.length > 0);
      assert.ok(dash.data.authAlerts.every((a) => a.auth_number === undefined && a.payer === undefined), `${who} dashboard`);
      const list = await get(who, '/authorizations');
      assert.ok(list.data.every((a) => a.auth_number === undefined && a.payer === undefined), `${who} list`);
    }
    const full = await get('frontdesk', '/clients/1/insurance');
    assert.equal(full.data.policies[0].member_id, 'MA00012345');
  });

  test('technicians only see clients they are assigned to', async () => {
    const list = await get('tech', '/clients');
    assert.deepEqual(list.data.map((c) => c.id).sort(), [1, 2]);
    assert.equal((await get('tech', '/clients/3')).status, 403);
    assert.equal((await get('tech', '/clients/3/programs')).status, 403);
    assert.equal((await post('tech', '/clients/3/observations', { category: 'Behavior', body: 'x' })).status, 403);
    assert.equal((await get('tech', '/clients/1/programs')).status, 200);
  });

  test('drivers only see and update their own rides', async () => {
    const mine = await get('driver', `/rides?date=${today()}`);
    assert.ok(mine.data.length > 0);
    assert.ok(mine.data.every((r) => r.driver_name === 'Chris Young'));
    assert.equal((await get('driver', '/clients')).status, 403);
    const other = db.prepare('SELECT id FROM rides WHERE driver_id != (SELECT id FROM users WHERE email = ?)').get('driver@demo.test');
    assert.equal((await patch('driver', `/rides/${other.id}`, { status: 'completed' })).status, 403);
    const r = mine.data[0];
    assert.equal((await patch('driver', `/rides/${r.id}`, { status: 'en_route', driver_id: null, scheduled_time: '01:00' })).status, 200);
    const after = db.prepare('SELECT * FROM rides WHERE id = ?').get(r.id);
    assert.equal(after.status, 'en_route');
    assert.equal(after.scheduled_time, r.scheduled_time, 'drivers cannot reschedule');
    assert.ok(after.driver_id, 'drivers cannot unassign themselves');
  });
});

describe('session notes', () => {
  let noteId;
  test('required template fields are enforced on submit, not on draft', async () => {
    const base0 = { client_id: 1, template_id: 1, session_date: today(), start_time: '09:00', end_time: '10:30' };
    const draft = await post('tech', '/notes', { ...base0, values: {} });
    assert.equal(draft.status, 201);
    assert.equal(draft.data.units, 6);
    const bad = await patch('tech', `/notes/${draft.data.id}`, { submit: true, values: {} });
    assert.equal(bad.status, 400);
    noteId = draft.data.id;
    const ok = await patch('tech', `/notes/${noteId}`, { submit: true,
      values: { location: 'Center', programs_run: 'Manding', mood: 'Good', plan: 'Continue' } });
    assert.equal(ok.status, 200);
  });

  test('submitted notes are locked and cannot be self-approved', async () => {
    assert.equal((await patch('tech', `/notes/${noteId}`, { values: {} })).status, 409);
    assert.equal((await post('tech', `/notes/${noteId}/review`, { action: 'approve' })).status, 403);
  });

  test('returning a note requires feedback; approval counts units against the authorization', async () => {
    assert.equal((await post('qsp', `/notes/${noteId}/review`, { action: 'return' })).status, 400);
    const before = (await get('billing', '/authorizations')).data.find((a) => a.client_id === 1);
    const r = await post('qsp', `/notes/${noteId}/review`, { action: 'approve' });
    assert.equal(r.status, 200);
    assert.ok(r.data.authorization_id);
    // Seed data has Ava at 56 of 60 units, so 6 more puts her over.
    assert.match(r.data.warning, /2 unit\(s\) over/);
    const afterAuth = (await get('billing', '/authorizations')).data.find((a) => a.client_id === 1);
    assert.equal(afterAuth.units_used, before.units_used + 6);
    const queue = await get('billing', '/billing');
    assert.ok(queue.data.some((n) => n.id === noteId));
    const marked = await post('billing', '/billing/mark', { note_ids: [noteId] });
    assert.equal(marked.data.marked, 1);
  });

  test('template edits do not change notes already written', async () => {
    const t = (await get('qsp', '/templates')).data.find((x) => x.id === 1);
    await patch('qsp', '/templates/1', { fields: [{ label: 'Only field', type: 'text' }] });
    const note = await get('qsp', `/notes/${noteId}`);
    assert.equal(note.data.fields.length, t.fields.length);
  });
});

describe('communication', () => {
  test('urgent observations escalate to the QSP level, not to peers', async () => {
    const r = await post('tech', '/clients/1/observations', { category: 'Safety', severity: 'urgent', body: 'Climbed the fence at recess.' });
    assert.equal(r.status, 201);
    const escId = r.data.escalation_id;
    assert.ok(escId);
    const esc = db.prepare('SELECT * FROM escalations WHERE id = ?').get(escId);
    assert.equal(esc.target_dept, 'clinical');
    assert.equal(esc.target_rank, 3);
    assert.equal((await get('qsp', `/escalations/${escId}`)).status, 200);
    assert.equal((await get('director', `/escalations/${escId}`)).status, 200);
    assert.equal((await get('exec', `/escalations/${escId}`)).status, 200);
    assert.equal((await get('lead', `/escalations/${escId}`)).status, 404);
    assert.equal((await get('tech2', `/escalations/${escId}`)).status, 404);
    assert.equal((await get('billing', `/escalations/${escId}`)).status, 404);
  });

  test('reports go up within a department and can be raised further', async () => {
    const bad = await post('qsp', '/escalations', { target_dept: 'clinical', target_rank: 2, category: 'Other', subject: 's', body: 'b' });
    assert.equal(bad.status, 400);
    const r = await post('tech', '/escalations', { target_dept: 'clinical', target_rank: 2, category: 'Other', subject: 'Supplies', body: 'Out of tokens' });
    assert.equal(r.status, 201);
    assert.equal((await get('lead', `/escalations/${r.data.id}`)).status, 200);
    assert.equal((await post('tech', `/escalations/${r.data.id}/status`, { status: 'acknowledged' })).status, 403);
    assert.equal((await post('lead', `/escalations/${r.data.id}/status`, { status: 'acknowledged' })).status, 200);
    const raised = await post('lead', `/escalations/${r.data.id}/raise`, { target_dept: 'clinical', target_rank: 4, reason: 'Needs budget' });
    assert.equal(raised.status, 200);
    assert.equal((await get('lead', `/escalations/${r.data.id}`)).status, 404, 'lead loses sight once raised above them');
    assert.equal((await get('tech', `/escalations/${r.data.id}`)).status, 200, 'the reporter keeps sight');
    assert.equal((await get('director', `/escalations/${r.data.id}`)).status, 200);
    // Cross-department: a driver reports to the office manager
    const x = await post('driver', '/escalations', { target_dept: 'admin', target_rank: 3, category: 'Transportation', subject: 'Van', body: 'Flat tire' });
    assert.equal((await get('office', `/escalations/${x.data.id}`)).status, 200);
    assert.equal((await get('coord', `/escalations/${x.data.id}`)).status, 404);
  });

  test('announcements reach only their audience and track who has read them', async () => {
    const r = await post('office', '/announcements', { title: 'Paperwork due', body: 'Friday', depts: ['admin'], roles: ['admin_staff', 'billing'] });
    assert.equal(r.status, 201);
    const seen = async (who) => (await get(who, '/announcements')).data.some((a) => a.id === r.data.id);
    assert.equal(await seen('frontdesk'), true);
    assert.equal(await seen('billing'), true);
    assert.equal(await seen('driver'), false);
    assert.equal(await seen('tech'), false);
    assert.equal(await seen('exec'), true);
    await post('frontdesk', `/announcements/${r.data.id}/ack`);
    const acks = await get('office', `/announcements/${r.data.id}/acks`);
    assert.equal(acks.data.length, 2);
    assert.equal(acks.data.filter((a) => a.acked_at).length, 1);
    assert.equal((await get('billing', `/announcements/${r.data.id}/acks`)).status, 403);
    // Technicians cannot post; senior techs cannot post to admin
    assert.equal((await post('tech', '/announcements', { title: 't', body: 'b' })).status, 403);
    assert.equal((await post('lead', '/announcements', { title: 't', body: 'b', depts: ['admin'] })).status, 403);
  });
});

describe('programs', () => {
  test('changes are logged with who and why; technicians cannot edit programs', async () => {
    assert.equal((await patch('tech', '/programs/1', { mastery_value: 90 })).status, 403);
    const r = await patch('qsp', '/programs/1', { mastery_value: 90, reason: 'Raise the bar' });
    assert.equal(r.data.changed, true);
    const p = await get('tech', '/programs/1');
    assert.match(p.data.changes[0].summary, /mastery value: 80 → 90/);
    assert.equal(p.data.changes[0].reason, 'Raise the bar');
  });

  test('percent data is computed from trials', async () => {
    const r = await post('tech', '/programs/1/data', { session_date: today(), target: 'Juice', correct: 7, total: 8 });
    assert.equal(r.status, 201);
    assert.equal(r.data.value, 87.5);
    assert.equal((await post('tech', '/programs/1/data', { session_date: today(), correct: 9, total: 8 })).status, 400);
    assert.equal((await post('tech', '/programs/1/data', { session_date: today(), target: 'Cookies', correct: 1, total: 2 })).status, 400);
  });
});

describe('trials', () => {
  test('every trial needs a description, and changes to trials are logged', async () => {
    const bad = await patch('qsp', '/programs/1', { trials: [{ name: 'Juice' }] });
    assert.equal(bad.status, 400);
    const { data } = await get('qsp', '/programs/1');
    const trials = data.trials.filter((t) => t.active).map((t) => ({ id: t.id, name: t.name, description: t.description }));
    trials.push({ name: 'Ball', description: 'Hold the ball up. Wait 3 seconds for "ball".' });
    const r = await patch('qsp', '/programs/1', { trials: trials.filter((t) => t.name !== 'iPad'), reason: 'iPad is satiated' });
    assert.equal(r.data.changed, true);
    const after = await get('tech', '/programs/1');
    assert.match(after.data.changes[0].summary, /added trial "Ball"/);
    assert.match(after.data.changes[0].summary, /retired trial "iPad"/);
    assert.equal(after.data.trials.find((t) => t.name === 'iPad').active, 0, 'retired trials are kept for history');
    assert.equal((await patch('tech', '/programs/1', { trials: [] })).status, 403);
  });

  test('a technician saves a whole session trial by trial', async () => {
    const programs = (await get('tech', '/clients/1/programs')).data;
    const mand = programs.find((p) => p.name.startsWith('Manding'));
    const elope = programs.find((p) => p.name === 'Elopement');
    const [a, b] = mand.trials;
    const r = await post('tech', '/clients/1/session-data', { session_date: today(), entries: [
      { program_id: mand.id, trials: [
        { trial_id: a.id, result: 'correct' }, { trial_id: a.id, result: 'prompted', note: 'needed a gesture' },
        { trial_id: b.id, result: 'correct' }, { trial_id: b.id, result: 'incorrect' },
      ] },
      { program_id: elope.id, value: 1 },
    ] });
    assert.equal(r.status, 201);
    assert.equal(r.data.saved[0].value, 50);
    const detail = await get('tech', `/programs/${mand.id}`);
    const last = detail.data.data.find((d) => d.id === r.data.saved[0].id);
    assert.deepEqual(last.trials.map((t) => t.result), ['correct', 'prompted', 'correct', 'incorrect']);
    assert.equal(last.trials[1].note, 'needed a gesture');
    // Retired trials and other clients' programs are rejected
    const retired = detail.data.trials.find((t) => !t.active);
    assert.equal((await post('tech', '/clients/1/session-data', { session_date: today(), entries: [
      { program_id: mand.id, trials: [{ trial_id: retired.id, result: 'correct' }] }] })).status, 400);
    const noah = (await get('qsp', '/clients/3/programs')).data[0];
    assert.equal((await post('tech', '/clients/1/session-data', { session_date: today(), entries: [{ program_id: noah.id, value: 1 }] })).status, 400);
  });
});

describe('client profile', () => {
  test('the whole team reads the profile; admin staff do not', async () => {
    for (const who of ['tech', 'lead', 'qsp']) assert.equal((await get(who, '/clients/1/profile')).status, 200, who);
    for (const who of ['billing', 'frontdesk', 'driver']) assert.equal((await get(who, '/clients/1/profile')).status, 403, who);
    assert.equal((await get('tech2', '/clients/1/profile')).status, 403, 'not on the team');
  });

  test('safety alerts reach drivers and the front desk', async () => {
    const rides = (await get('driver', `/rides?date=${today()}`)).data;
    assert.ok(rides.find((r) => r.client_id === 1).alerts.includes('Peanut allergy'));
    const c = await get('frontdesk', '/clients/1');
    assert.match(c.data.alerts, /EpiPen/);
    const p = await get('frontdesk', '/clients/1/programs');
    assert.equal(p.status, 403, 'but nothing else clinical');
  });

  test('technicians share ideas; leads add them to the profile with credit', async () => {
    assert.equal((await call('tech', 'PUT', '/clients/1/profile/about', { body: 'x' })).status, 403);
    const s = await post('tech', '/clients/1/suggestions', { kind: 'reinforcer', category: 'tangible', title: 'Squishy frog', details: 'Worked during table time' });
    assert.equal(s.status, 201);
    assert.equal((await post('tech', `/suggestions/${s.data.id}/vote`)).status, 400, 'no voting for your own idea');
    assert.equal((await post('lead', `/suggestions/${s.data.id}/vote`)).data.voted, true);
    assert.equal((await post('tech', `/suggestions/${s.data.id}/review`, { action: 'add' })).status, 403);
    assert.equal((await post('lead', `/suggestions/${s.data.id}/review`, { action: 'add', strength: 'high' })).status, 200);
    const prof = (await get('tech', '/clients/1/profile')).data;
    const frog = prof.reinforcers.find((r) => r.name === 'Squishy frog');
    assert.equal(frog.strength, 'high');
    assert.equal(frog.suggested_by_name, 'Sam Nguyen');
    assert.match(prof.changes[0].summary, /Sam Nguyen's idea/);

    const tip = await post('tech', '/clients/1/suggestions', { kind: 'strategy', title: 'Sing the clean-up song' });
    await post('qsp', `/suggestions/${tip.data.id}/review`, { action: 'add' });
    const calming = (await get('tech', '/clients/1/profile')).data.sections.find((x) => x.key === 'calming');
    assert.match(calming.body, /Sing the clean-up song \(from Sam Nguyen\)/);

    const no = await post('tech', '/clients/1/suggestions', { kind: 'other', title: 'Skip snack' });
    assert.equal((await post('qsp', `/suggestions/${no.data.id}/review`, { action: 'not_used' })).status, 400, 'needs a reason');
    assert.equal((await post('qsp', `/suggestions/${no.data.id}/review`, { action: 'not_used', note: 'Snack is in the BIP' })).status, 200);
  });

  test('leads edit sections and mark reinforcers that stopped working', async () => {
    assert.equal((await call('lead', 'PUT', '/clients/1/profile/sensory', { body: 'Likes the swing' })).status, 200);
    const r = (await get('lead', '/clients/1/profile')).data.reinforcers.find((x) => x.name === 'Fruit snacks');
    assert.equal((await patch('lead', `/reinforcers/${r.id}`, { active: false })).status, 200);
    const after = (await get('tech', '/clients/1/profile')).data;
    assert.equal(after.reinforcers.find((x) => x.id === r.id).active, 0);
    assert.match(after.changes[0].summary, /no longer working/);
    assert.equal(after.sections.find((x) => x.key === 'sensory').updated_by_name, 'Dana Ortiz');
  });
});

describe('audit trail', () => {
  test('client record views are logged and only leadership can read the log', async () => {
    await get('qsp', '/clients/2');
    const row = db.prepare("SELECT * FROM audit_log WHERE action = 'client.view' AND client_id = 2 ORDER BY id DESC").get();
    assert.ok(row);
    assert.equal((await get('office', '/audit')).status, 403);
    assert.equal((await get('exec', '/audit')).status, 200);
  });
});
