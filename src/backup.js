'use strict';

// Encrypted database backups.
// - A consistent snapshot of the live database (SQLite VACUUM INTO), safe while the app runs.
// - Encrypted with APP_ENCRYPTION_KEY (AES-256-GCM) before it touches the disk.
// - Kept: every backup from the last BACKUP_KEEP_DAYS days, plus the newest backup of each
//   month for BACKUP_KEEP_MONTHS months. Older ones are deleted.
const fs = require('node:fs');
const path = require('node:path');
const { encrypt, decrypt } = require('./crypto-box');

const NAME_RE = /^aba-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db\.enc$/;
const SQLITE_HEADER = Buffer.from('SQLite format 3\0');

let lastError = null;
let lastRunAt = null;

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function listBackups(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.map((name) => {
    const m = name.match(NAME_RE);
    if (!m) return null;
    const at = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
    return { name, at, size: fs.statSync(path.join(dir, name)).size };
  }).filter(Boolean).sort((a, b) => b.at - a.at);
}

// Which backups to delete under the retention policy.
function toPrune(backups, { keepDays, keepMonths, now = new Date() }) {
  const dayCutoff = now.getTime() - keepDays * 86400000;
  const monthCutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - keepMonths + 1, 1)).getTime();
  const keep = new Set();
  const monthsSeen = new Set();
  for (const b of backups) { // newest first
    if (b.at.getTime() >= dayCutoff) keep.add(b.name);
    const month = `${b.at.getUTCFullYear()}-${b.at.getUTCMonth()}`;
    if (!monthsSeen.has(month) && b.at.getTime() >= monthCutoff) { monthsSeen.add(month); keep.add(b.name); }
  }
  if (backups.length) keep.add(backups[0].name); // never delete the newest
  return backups.filter((b) => !keep.has(b.name));
}

function createBackup(db, cfg, now = new Date()) {
  fs.mkdirSync(cfg.backupDir, { recursive: true, mode: 0o700 });
  const tmp = path.join(cfg.backupDir, `.snapshot-${process.pid}-${Date.now()}.db`);
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const box = encrypt(cfg.key, fs.readFileSync(tmp));
    const name = `aba-${stamp(now)}.db.enc`;
    const part = path.join(cfg.backupDir, `.${name}.part`);
    fs.writeFileSync(part, box, { mode: 0o600 });
    fs.renameSync(part, path.join(cfg.backupDir, name));
    const deleted = toPrune(listBackups(cfg.backupDir), { keepDays: cfg.backupKeepDays, keepMonths: cfg.backupKeepMonths, now });
    for (const b of deleted) fs.rmSync(path.join(cfg.backupDir, b.name), { force: true });
    lastError = null;
    lastRunAt = new Date();
    return { name, size: box.length, at: now, deleted: deleted.map((b) => b.name) };
  } catch (err) {
    lastError = { message: err.message, at: new Date() };
    lastRunAt = new Date();
    throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Decrypt a backup into `target`. Refuses to overwrite an existing database unless forced.
function restoreBackup(file, target, key, { force = false } = {}) {
  const plain = decrypt(key, fs.readFileSync(file));
  if (!plain.subarray(0, 16).equals(SQLITE_HEADER)) throw new Error('The decrypted file is not a database.');
  if (fs.existsSync(target) && !force) {
    throw new Error(`${target} already exists. Stop the app first, then run again with --force to replace it.`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  for (const f of [`${target}-wal`, `${target}-shm`]) fs.rmSync(f, { force: true });
  fs.writeFileSync(target, plain, { mode: 0o600 });
  return { bytes: plain.length };
}

function backupStatus(cfg) {
  const backups = listBackups(cfg.backupDir);
  const latest = backups[0] || null;
  const ageHours = latest ? (Date.now() - latest.at.getTime()) / 3600000 : null;
  return {
    enabled: cfg.backupIntervalHours > 0,
    intervalHours: cfg.backupIntervalHours,
    keepDays: cfg.backupKeepDays,
    keepMonths: cfg.backupKeepMonths,
    count: backups.length,
    totalBytes: backups.reduce((a, b) => a + b.size, 0),
    latest: latest && { name: latest.name, at: latest.at.toISOString(), size: latest.size },
    overdue: cfg.backupIntervalHours > 0 && (ageHours === null || ageHours > cfg.backupIntervalHours * 1.5),
    lastError: lastError && { message: lastError.message, at: lastError.at.toISOString() },
    lastRunAt: lastRunAt && lastRunAt.toISOString(),
  };
}

// Checks every 15 minutes and backs up when the newest backup is older than the interval.
function startScheduler(db, cfg, log = console) {
  if (!(cfg.backupIntervalHours > 0)) return null;
  const tick = () => {
    const latest = listBackups(cfg.backupDir)[0];
    if (latest && Date.now() - latest.at.getTime() < cfg.backupIntervalHours * 3600000) return;
    try {
      const b = createBackup(db, cfg);
      log.log(`Backup written: ${b.name}${b.deleted.length ? ` (removed ${b.deleted.length} old)` : ''}`);
    } catch (err) {
      log.error(`Backup FAILED: ${err.message}`);
    }
  };
  const first = setTimeout(tick, 60 * 1000);
  const timer = setInterval(tick, 15 * 60 * 1000);
  first.unref();
  timer.unref();
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}

module.exports = { createBackup, restoreBackup, listBackups, toPrune, backupStatus, startScheduler };
