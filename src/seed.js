'use strict';

// Demo data. Every person and client here is fictional.
const fs = require('node:fs');
const path = require('node:path');
const { openDb, tx } = require('./db');
const { hashPassword } = require('./auth');
const { today, addDays, unitsFor } = require('./access');

const DEMO_PASSWORD = 'demo-password';

const USERS = [
  ['exec@demo.test', 'Jordan Ellis', 'executive'],
  ['director@demo.test', 'Priya Raman', 'clinical_director'],
  ['qsp@demo.test', 'Marcus Webb', 'qsp'],
  ['lead@demo.test', 'Dana Ortiz', 'senior_tech'],
  ['tech@demo.test', 'Sam Nguyen', 'technician'],
  ['tech2@demo.test', 'Alex Kim', 'technician'],
  ['office@demo.test', 'Renee Carter', 'office_manager'],
  ['billing@demo.test', 'Tom Alvarez', 'billing'],
  ['coord@demo.test', 'Keisha Brown', 'coordinator'],
  ['frontdesk@demo.test', 'Lena Park', 'admin_staff'],
  ['driver@demo.test', 'Chris Young', 'driver'],
  ['driver2@demo.test', 'Pat Morgan', 'driver'],
];

const LISTS = {
  observation_categories: ['Behavior', 'Health / medical', 'Family / home', 'Safety', 'Progress', 'School', 'Schedule / attendance'],
  program_domains: ['Communication', 'Social', 'Daily living', 'Academic', 'Behavior reduction', 'Play / leisure'],
  service_codes: [
    ['97153', '97153 – Direct treatment by technician'],
    ['97155', '97155 – Protocol modification by QSP'],
    ['97156', '97156 – Family / caregiver training'],
    ['97151', '97151 – Assessment'],
  ],
  escalation_categories: ['Client concern', 'Safety incident', 'Conflicting instructions', 'Scheduling', 'Staffing',
    'Insurance / authorization', 'Transportation', 'Policy question', 'Other'],
  payers: ['Medical Assistance', 'Blue Plus', 'HealthPartners', 'UCare', 'Medica'],
};

function seed(db) {
  return tx(db, () => {
    const pw = hashPassword(DEMO_PASSWORD);
    const u = {};
    for (const [email, name, role] of USERS) {
      u[email.split('@')[0]] = Number(db.prepare('INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?)')
        .run(email, name, role, pw).lastInsertRowid);
    }

    for (const [key, values] of Object.entries(LISTS)) {
      values.forEach((v, i) => {
        const [value, label] = Array.isArray(v) ? v : [v, v];
        db.prepare('INSERT INTO lists (list_key, value, label, sort) VALUES (?, ?, ?, ?)').run(key, value, label, i);
      });
    }

    const clientRows = [
      ['Ava', 'Thompson', '2018-04-12', 'Maria Thompson', '555-0101', '14 Birch Ln, Springfield'],
      ['Liam', 'Johnson', '2016-09-30', 'Kevin Johnson', '555-0102', '220 Oak St, Springfield'],
      ['Noah', 'Garcia', '2019-01-22', 'Rosa Garcia', '555-0103', '9 Maple Ct, Riverton'],
      ['Emma', 'Williams', '2017-06-05', 'Angela Williams', '555-0104', '301 Pine Ave, Riverton'],
    ];
    const c = clientRows.map((row) => Number(db.prepare(`INSERT INTO clients (first_name, last_name, dob, guardian_name, guardian_phone, address)
      VALUES (?, ?, ?, ?, ?, ?)`).run(...row).lastInsertRowid));
    const assign = db.prepare('INSERT INTO assignments (client_id, user_id) VALUES (?, ?)');
    [[c[0], u.tech], [c[0], u.lead], [c[0], u.qsp], [c[1], u.tech], [c[1], u.qsp], [c[2], u.tech2], [c[2], u.lead],
      [c[2], u.qsp], [c[3], u.tech2], [c[3], u.qsp]].forEach(([cid, uid]) => assign.run(cid, uid));

    // Note templates
    const directFields = [
      { key: 'location', label: 'Location', type: 'select', options: ['Center', 'Home', 'School', 'Community'], required: true },
      { key: 'present', label: 'People present', type: 'text' },
      { key: 'programs_run', label: 'Programs run / targets addressed', type: 'textarea', required: true },
      { key: 'behavior', label: 'Challenging behavior (antecedent, behavior, consequence)', type: 'textarea' },
      { key: 'mood', label: 'Client mood / engagement', type: 'select', options: ['Great', 'Good', 'Fair', 'Poor'], required: true },
      { key: 'reinforcers', label: 'Reinforcers used', type: 'text' },
      { key: 'caregiver', label: 'Caregiver communication', type: 'textarea' },
      { key: 'incident', label: 'Incident occurred (complete incident report)', type: 'checkbox' },
      { key: 'plan', label: 'Plan for next session', type: 'textarea', required: true },
    ];
    const tDirect = Number(db.prepare('INSERT INTO note_templates (name, service_code, fields, created_by) VALUES (?, ?, ?, ?)')
      .run('Direct session (97153)', '97153', JSON.stringify(directFields), u.qsp).lastInsertRowid);
    db.prepare('INSERT INTO note_templates (name, service_code, fields, created_by) VALUES (?, ?, ?, ?)').run(
      'Supervision / protocol modification (97155)', '97155', JSON.stringify([
        { key: 'observed', label: 'Staff observed', type: 'text', required: true },
        { key: 'fidelity', label: 'Treatment fidelity (%)', type: 'number' },
        { key: 'changes', label: 'Protocol changes made', type: 'textarea', required: true },
        { key: 'feedback', label: 'Feedback given to staff', type: 'textarea' },
      ]), u.qsp);

    // Programs with data
    const t = today();
    const addProgram = (clientId, name, domain, measurement, targets, mastery, direction, series) => {
      const pid = Number(db.prepare(`INSERT INTO programs (client_id, name, domain, goal, measurement, targets, mastery_value,
          mastery_sessions, mastery_direction, instructions, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(clientId, name, domain, `${name} across settings and people.`, measurement, JSON.stringify(targets),
          mastery, 3, direction, 'Run 10 trials per session. Use least-to-most prompting.', u.qsp).lastInsertRowid);
      db.prepare('INSERT INTO program_changes (program_id, changed_by, summary) VALUES (?, ?, ?)').run(pid, u.qsp, 'Program created');
      series.forEach((v, i) => {
        const d = addDays(t, i - series.length);
        if (measurement === 'percent') {
          db.prepare(`INSERT INTO program_data (program_id, session_date, target, value, correct, total, recorded_by)
                      VALUES (?, ?, ?, ?, ?, 10, ?)`).run(pid, d, targets[0] || null, v * 10, v, u.tech);
        } else {
          db.prepare('INSERT INTO program_data (program_id, session_date, value, recorded_by) VALUES (?, ?, ?, ?)').run(pid, d, v, u.tech);
        }
      });
      return pid;
    };
    const mand = addProgram(c[0], 'Manding for preferred items', 'Communication', 'percent', ['Juice', 'iPad', 'Bubbles'], 80, 'at_least', [3, 4, 4, 6, 7, 8, 8, 9]);
    addProgram(c[0], 'Elopement', 'Behavior reduction', 'frequency', [], 1, 'at_most', [6, 5, 5, 4, 3, 3, 2, 2]);
    addProgram(c[1], 'Handwashing task analysis', 'Daily living', 'percent', [], 90, 'at_least', [4, 5, 5, 6, 6, 7]);
    addProgram(c[2], 'Greeting peers', 'Social', 'percent', ['Hi', 'Wave'], 80, 'at_least', [2, 3, 3, 4]);
    db.prepare('INSERT INTO program_changes (program_id, changed_by, summary, reason) VALUES (?, ?, ?, ?)')
      .run(mand, u.qsp, 'Added target "Bubbles"', 'Mom reports he is asking for bubbles at home; use as new target.');

    // Session notes in each state
    const addNote = (clientId, author, daysAgo, start, end, status, extra = {}) => {
      const values = { location: 'Center', present: 'Client, RBT', programs_run: 'Manding, handwashing TA',
        behavior: '', mood: 'Good', reinforcers: 'iPad, tickles', caregiver: 'Brief update at pickup.', incident: false,
        plan: 'Continue current targets.' };
      return Number(db.prepare(`INSERT INTO session_notes (client_id, author_id, template_id, template_snapshot, values_json, service_code,
          session_date, start_time, end_time, units, status, reviewer_id, review_comment, reviewed_at)
          VALUES (?, ?, ?, ?, ?, '97153', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(clientId, author, tDirect, JSON.stringify(directFields), JSON.stringify(values), addDays(t, -daysAgo), start, end,
          unitsFor(start, end), status, extra.reviewer ?? null, extra.comment ?? null, extra.reviewer ? `${addDays(t, -daysAgo + 1)} 09:00:00` : null)
        .lastInsertRowid);
    };
    addNote(c[0], u.tech, 1, '09:00', '12:00', 'submitted');
    addNote(c[1], u.tech, 1, '13:00', '15:00', 'returned', { reviewer: u.qsp, comment: 'Please describe the ABC data for the tantrum at 2pm.' });
    addNote(c[0], u.tech, 3, '09:00', '12:00', 'approved', { reviewer: u.qsp });
    addNote(c[2], u.tech2, 2, '08:30', '11:30', 'approved', { reviewer: u.qsp });
    addNote(c[3], u.tech2, 2, '12:00', '14:00', 'approved', { reviewer: u.qsp });

    // Insurance
    const pol = (clientId, payer, member, freq) => Number(db.prepare(`INSERT INTO insurance_policies (client_id, payer, member_id, check_frequency_days)
      VALUES (?, ?, ?, ?)`).run(clientId, payer, member, freq).lastInsertRowid);
    const p0 = pol(c[0], 'Medical Assistance', 'MA00012345', 30);
    const p1 = pol(c[1], 'Blue Plus', 'BP-778812', 30);
    const p2 = pol(c[2], 'UCare', 'UC-440091', 30);
    pol(c[3], 'HealthPartners', 'HP-120045', 30);
    db.prepare(`INSERT INTO eligibility_checks (policy_id, result, notes, checked_by, checked_at) VALUES (?, 'active', NULL, ?, ?)`)
      .run(p0, u.frontdesk, `${addDays(t, -5)} 08:15:00`);
    db.prepare(`INSERT INTO eligibility_checks (policy_id, result, notes, checked_by, checked_at) VALUES (?, 'active', NULL, ?, ?)`)
      .run(p1, u.frontdesk, `${addDays(t, -40)} 08:20:00`);
    db.prepare(`INSERT INTO eligibility_checks (policy_id, result, notes, checked_by, checked_at) VALUES (?, 'issue', ?, ?, ?)`)
      .run(p2, 'Portal shows coverage termed end of last month. Called family.', u.frontdesk, `${addDays(t, -1)} 08:30:00`);

    const auth = (clientId, policyId, code, units, start, end, num) => db.prepare(`INSERT INTO authorizations
      (client_id, policy_id, auth_number, service_code, units_approved, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(clientId, policyId, num, code, units, start, end);
    auth(c[0], p0, '97153', 60, addDays(t, -150), addDays(t, 20), 'A-2291');
    auth(c[1], p1, '97153', 400, addDays(t, -30), addDays(t, 150), 'B-5510');
    auth(c[2], p2, '97153', 14, addDays(t, -60), addDays(t, 120), 'U-3007');
    // Link approved notes to their authorizations
    db.exec(`UPDATE session_notes SET authorization_id = (SELECT a.id FROM authorizations a WHERE a.client_id = session_notes.client_id
             AND a.service_code = session_notes.service_code AND session_notes.session_date BETWEEN a.start_date AND a.end_date)
             WHERE status = 'approved'`);
    // Pretend earlier usage on Ava's auth so it shows the 80% warning
    db.prepare(`INSERT INTO session_notes (client_id, author_id, template_id, template_snapshot, values_json, service_code, session_date,
        start_time, end_time, units, status, reviewer_id, reviewed_at, authorization_id, billed_at, billed_by)
        VALUES (?, ?, ?, ?, '{}', '97153', ?, '09:00', '20:00', 44, 'approved', ?, ?, 1, ?, ?)`)
      .run(c[0], u.tech, tDirect, JSON.stringify(directFields), addDays(t, -40), u.qsp, `${addDays(t, -39)} 09:00:00`,
        `${addDays(t, -35)} 10:00:00`, u.billing);

    // Rides
    const ride = (clientId, dir, time, from, to, driver) => db.prepare(`INSERT INTO rides (ride_date, client_id, direction, scheduled_time,
      from_address, to_address, driver_id, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(t, clientId, dir, time, from, to, driver, u.coord);
    ride(c[0], 'pickup', '08:15', clientRows[0][5], 'Center', u.driver);
    ride(c[1], 'pickup', '08:40', clientRows[1][5], 'Center', u.driver);
    ride(c[2], 'pickup', '08:00', clientRows[2][5], 'Center', u.driver2);
    ride(c[0], 'dropoff', '12:15', 'Center', clientRows[0][5], u.driver);
    ride(c[2], 'dropoff', '11:45', 'Center', clientRows[2][5], null);

    // Communication
    db.prepare(`INSERT INTO announcements (author_id, title, body, audience, requires_ack, pinned) VALUES (?, ?, ?, ?, 1, 1)`)
      .run(u.director, 'New prompting procedure for all communication programs',
        'Starting Monday, all communication programs use a 3-second time delay before prompting. Your QSP will review this with you in supervision. This replaces the instructions from the team meeting on the 3rd.',
        JSON.stringify({ depts: ['clinical'], roles: [] }));
    db.prepare(`INSERT INTO announcements (author_id, title, body, audience, requires_ack) VALUES (?, ?, ?, ?, 1)`)
      .run(u.office, 'Eligibility checks by 9:30am',
        'All eligibility checks for the day need to be logged here by 9:30am so the schedule can be confirmed. No more paper checklist.',
        JSON.stringify({ depts: ['admin'], roles: ['admin_staff', 'billing'] }));

    const esc = Number(db.prepare(`INSERT INTO escalations (created_by, target_dept, target_rank, client_id, category, priority, subject, body)
      VALUES (?, 'clinical', 3, ?, 'Conflicting instructions', 'high', ?, ?)`)
      .run(u.tech, c[1], 'Two different instructions for Liam\'s transitions',
        'Lead told me to use a visual timer for transitions, but the program sheet says first/then board only. Which one should I be doing?')
      .lastInsertRowid);
    db.prepare(`INSERT INTO escalation_events (escalation_id, user_id, kind, body) VALUES (?, ?, 'comment', ?)`)
      .run(esc, u.lead, 'I mentioned the timer because it worked at home per mom. Happy to go with whatever Marcus decides.');
    db.prepare(`INSERT INTO escalations (created_by, target_dept, target_rank, category, priority, subject, body)
      VALUES (?, 'admin', 3, 'Transportation', 'normal', ?, ?)`)
      .run(u.driver, 'Van 2 check engine light', 'Came on this morning after the 8:00 pickup. Still drivable but needs to be looked at.');

    const obs = db.prepare('INSERT INTO observations (client_id, author_id, category, severity, body, at) VALUES (?, ?, ?, ?, ?, ?)');
    obs.run(c[0], u.tech, 'Health / medical', 'concern', 'Ava was rubbing her left ear most of the session and was more irritable than usual. Told mom at pickup.', `${addDays(t, -1)} 11:50:00`);
    obs.run(c[0], u.lead, 'Progress', 'info', 'Independently requested "bubbles" twice today without a model!', `${addDays(t, -2)} 10:05:00`);
    obs.run(c[2], u.tech2, 'Family / home', 'info', 'Dad mentioned they are moving next month; new address TBD.', `${addDays(t, -3)} 11:30:00`);

    return u;
  });
}

module.exports = { seed, DEMO_PASSWORD, USERS };

if (require.main === module) {
  const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'aba-practice.db');
  if (fs.existsSync(file)) {
    if (!process.argv.includes('--reset')) {
      console.error(`${file} already exists. Run \`npm run seed -- --reset\` to wipe it and load demo data.`);
      process.exit(1);
    }
    for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  }
  seed(openDb(file));
  console.log(`Demo data loaded into ${file}. Sign in with any of these (password: ${DEMO_PASSWORD}):`);
  for (const [email, name, role] of USERS) console.log(`  ${email.padEnd(22)} ${name.padEnd(14)} ${role}`);
}
