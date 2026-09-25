'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  dob TEXT,
  guardian_name TEXT,
  guardian_phone TEXT,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Which staff are on which client's team. Technicians only see clinical data
-- for clients they are assigned to.
CREATE TABLE IF NOT EXISTS assignments (
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (client_id, user_id)
);

-- Configurable dropdown lists (observation categories, service codes, ...).
CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY,
  list_key TEXT NOT NULL,
  value TEXT NOT NULL,
  label TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (list_key, value)
);

-- ---------- Clinical ----------
CREATE TABLE IF NOT EXISTS programs (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  domain TEXT,
  goal TEXT,
  measurement TEXT NOT NULL,           -- percent | frequency | duration | rating
  targets TEXT NOT NULL DEFAULT '[]',  -- JSON array of target names
  mastery_value REAL,                  -- e.g. 80 (%)
  mastery_direction TEXT NOT NULL DEFAULT 'at_least', -- at_least | at_most (behavior reduction)
  mastery_sessions INTEGER,            -- e.g. 3 consecutive sessions
  instructions TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- baseline | active | on_hold | mastered | discontinued
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every change to a program, so the whole team sees what changed, when and why.
CREATE TABLE IF NOT EXISTS program_changes (
  id INTEGER PRIMARY KEY,
  program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  changed_by INTEGER REFERENCES users(id),
  summary TEXT NOT NULL,
  reason TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS program_data (
  id INTEGER PRIMARY KEY,
  program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  session_date TEXT NOT NULL,
  target TEXT,
  value REAL NOT NULL,
  correct INTEGER,
  total INTEGER,
  note TEXT,
  recorded_by INTEGER REFERENCES users(id),
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS note_templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  service_code TEXT,
  fields TEXT NOT NULL,                -- JSON [{key,label,type,options,required}]
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS session_notes (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  template_id INTEGER REFERENCES note_templates(id),
  template_snapshot TEXT NOT NULL,     -- fields as they were when the note was written
  values_json TEXT NOT NULL DEFAULT '{}',
  service_code TEXT NOT NULL,
  session_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft', -- draft | submitted | returned | approved
  reviewer_id INTEGER REFERENCES users(id),
  review_comment TEXT,
  reviewed_at TEXT,
  authorization_id INTEGER REFERENCES authorizations(id),
  billed_at TEXT,
  billed_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The single place for "things we noticed" about a client.
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  category TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info', -- info | concern | urgent
  body TEXT NOT NULL,
  escalation_id INTEGER REFERENCES escalations(id),
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Trials a QSP writes for a program. Retired trials stay for history.
CREATE TABLE IF NOT EXISTS program_trials (
  id INTEGER PRIMARY KEY,
  program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Each trial a technician ran, in order, within one session's data point.
CREATE TABLE IF NOT EXISTS trial_results (
  id INTEGER PRIMARY KEY,
  program_data_id INTEGER NOT NULL REFERENCES program_data(id) ON DELETE CASCADE,
  trial_id INTEGER NOT NULL REFERENCES program_trials(id),
  result TEXT NOT NULL,                -- correct | prompted | incorrect | no_response
  seq INTEGER NOT NULL,
  note TEXT
);

-- Client profile: one row per section (see PROFILE_SECTIONS).
CREATE TABLE IF NOT EXISTS client_profile (
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  section TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (client_id, section)
);

CREATE TABLE IF NOT EXISTS profile_changes (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  changed_by INTEGER REFERENCES users(id),
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reinforcers (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,              -- edible | tangible | activity | social | sensory | other
  strength TEXT NOT NULL DEFAULT 'medium', -- high | medium | low
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  suggestion_id INTEGER REFERENCES suggestions(id),
  added_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- "This worked for me": ideas any team member shares about a client.
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,                  -- reinforcer | strategy | trigger | other
  category TEXT,                       -- reinforcer category when kind = reinforcer
  title TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | added | not_used
  reviewer_id INTEGER REFERENCES users(id),
  review_note TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS suggestion_votes (
  suggestion_id INTEGER NOT NULL REFERENCES suggestions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (suggestion_id, user_id)
);

-- ---------- Admin ----------
CREATE TABLE IF NOT EXISTS insurance_policies (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  payer TEXT NOT NULL,
  member_id TEXT,
  group_number TEXT,
  priority TEXT NOT NULL DEFAULT 'primary',
  check_frequency_days INTEGER NOT NULL DEFAULT 30,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS eligibility_checks (
  id INTEGER PRIMARY KEY,
  policy_id INTEGER NOT NULL REFERENCES insurance_policies(id) ON DELETE CASCADE,
  result TEXT NOT NULL,                -- active | inactive | issue
  notes TEXT,
  checked_by INTEGER REFERENCES users(id),
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS authorizations (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  policy_id INTEGER REFERENCES insurance_policies(id),
  auth_number TEXT,
  service_code TEXT NOT NULL,
  units_approved INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS rides (
  id INTEGER PRIMARY KEY,
  ride_date TEXT NOT NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,             -- pickup | dropoff
  scheduled_time TEXT NOT NULL,
  from_address TEXT,
  to_address TEXT,
  driver_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | en_route | completed | no_show | cancelled
  notes TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Communication ----------
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  audience TEXT NOT NULL,              -- JSON {depts:[], roles:[]}
  requires_ack INTEGER NOT NULL DEFAULT 1,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS announcement_acks (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (announcement_id, user_id)
);

CREATE TABLE IF NOT EXISTS escalations (
  id INTEGER PRIMARY KEY,
  created_by INTEGER NOT NULL REFERENCES users(id),
  target_dept TEXT NOT NULL,
  target_rank INTEGER NOT NULL,
  client_id INTEGER REFERENCES clients(id),
  category TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal', -- low | normal | high | urgent
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',     -- open | acknowledged | resolved
  owner_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Comments and status changes on an escalation, in order.
CREATE TABLE IF NOT EXISTS escalation_events (
  id INTEGER PRIMARY KEY,
  escalation_id INTEGER NOT NULL REFERENCES escalations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,                  -- comment | status | raised
  body TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Security ----------
-- One-time recovery codes for two-factor sign-in (stored hashed).
CREATE TABLE IF NOT EXISTS recovery_codes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT
);

-- Password accepted, waiting for the authenticator code. Short-lived.
CREATE TABLE IF NOT EXISTS login_challenges (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

-- Practice-wide settings (e.g. require_2fa).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------- Oversight ----------
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  client_id INTEGER,
  detail TEXT,
  ip TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notes_client ON session_notes(client_id, session_date);
CREATE INDEX IF NOT EXISTS idx_notes_status ON session_notes(status);
CREATE INDEX IF NOT EXISTS idx_obs_client ON observations(client_id, at);
CREATE INDEX IF NOT EXISTS idx_data_program ON program_data(program_id, session_date);
CREATE INDEX IF NOT EXISTS idx_trials_program ON program_trials(program_id);
CREATE INDEX IF NOT EXISTS idx_results_data ON trial_results(program_data_id);
CREATE INDEX IF NOT EXISTS idx_suggestions_client ON suggestions(client_id, status);
CREATE INDEX IF NOT EXISTS idx_rides_date ON rides(ride_date);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
`;

// Changes to tables that already exist. Each runs once, in order, tracked by
// PRAGMA user_version, so existing databases upgrade in place on startup.
const MIGRATIONS = [
  // 1: two-factor sign-in
  `ALTER TABLE users ADD COLUMN totp_secret TEXT;
   ALTER TABLE users ADD COLUMN totp_pending TEXT;
   ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE sessions ADD COLUMN needs_2fa_setup INTEGER NOT NULL DEFAULT 0;
   INSERT OR IGNORE INTO settings (key, value) VALUES ('require_2fa', '1');`,
];

function migrate(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = version; i < MIGRATIONS.length; i++) {
    tx(db, () => {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
}

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

function getSetting(db, key, fallback = null) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// Run fn inside a transaction; rolls back if it throws.
function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, tx, getSetting, setSetting, MIGRATIONS };
