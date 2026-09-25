'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDb, getSetting } = require('../src/db');
const { createApp, localConfig } = require('../src/app');
const { seed, DEMO_PASSWORD } = require('../src/seed');
const totp = require('../src/totp');
const { encrypt, decrypt } = require('../src/crypto-box');
const { createBackup, restoreBackup, listBackups, toPrune } = require('../src/backup');
const { loadConfig } = require('../src/config');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aba-sec-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('authenticator codes (RFC 6238)', () => {
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  test('match the published test vectors', () => {
    for (const [t, code] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037']]) {
      assert.equal(totp.codeAt(secret, Math.floor(t / 30), 8), code);
    }
  });
  test('accept one step of clock drift and refuse replays', () => {
    const now = 1_700_000_000_000;
    const step = totp.currentStep(now);
    assert.equal(totp.verify(secret, totp.codeAt(secret, step - 1), { now }), step - 1);
    assert.equal(totp.verify(secret, totp.codeAt(secret, step - 2), { now }), null);
    assert.equal(totp.verify(secret, totp.codeAt(secret, step), { now, lastStep: step }), null, 'same code twice');
    assert.equal(totp.verify(secret, 'abc123', { now }), null);
  });
});

describe('encryption', () => {
  test('round-trips and detects the wrong key or tampering', () => {
    const key = crypto.randomBytes(32);
    const box = encrypt(key, Buffer.from('hello'));
    assert.equal(decrypt(key, box).toString(), 'hello');
    assert.throws(() => decrypt(crypto.randomBytes(32), box), /wrong encryption key/);
    box[box.length - 1] ^= 1;
    assert.throws(() => decrypt(key, box), /damaged/);
  });

  test('production refuses to start without a proper key', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production', DATA_DIR: tmp }), /APP_ENCRYPTION_KEY is required/);
    assert.throws(() => loadConfig({ NODE_ENV: 'production', DATA_DIR: tmp, APP_ENCRYPTION_KEY: 'c2hvcnQ=' }), /32 bytes/);
    const cfg = loadConfig({ NODE_ENV: 'production', DATA_DIR: tmp, APP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64') });
    assert.equal(cfg.production, true);
    assert.equal(cfg.trustProxy, 1);
  });
});

// ---------- API helpers ----------
let db;
let cfg;
let server;
let base;
before(async () => {
  db = openDb(':memory:');
  seed(db);
  cfg = { ...localConfig(), backupDir: path.join(tmp, 'backups'), backupIntervalHours: 24 };
  server = createApp(db, cfg).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function call(cookie, method, p, body, headers = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    redirect: 'manual',
    headers: { cookie: cookie || '', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, data: await res.json().catch(() => null), cookie: setCookie ? setCookie.split(';')[0] : null, headers: res.headers };
}
const password = (who) => call(null, 'POST', '/api/login', { email: `${who}@demo.test`, password: DEMO_PASSWORD });
async function signIn(who) {
  const r = await password(who);
  assert.equal(r.status, 200, `password step for ${who}`);
  return r.cookie;
}
// The code an authenticator app shows now. Codes can't be reused, so tests that sign the
// same person in several times within 30 seconds first simulate the previous code expiring.
function appCode(secret, userEmail) {
  const step = totp.currentStep();
  db.prepare('UPDATE users SET totp_last_step = ? WHERE email = ?').run(step - 1, userEmail);
  return totp.codeAt(secret.replace(/\s/g, ''), step);
}

describe('two-factor sign-in', () => {
  let secret;
  let recovery;

  test('a person turns it on by scanning a QR code and confirming a code', async () => {
    const c = await signIn('exec');
    const setup = await call(c, 'POST', '/api/me/2fa/setup', {});
    assert.equal(setup.status, 200);
    assert.match(setup.data.qrSvg, /^<svg/);
    secret = setup.data.secret;
    const stored = db.prepare("SELECT totp_pending FROM users WHERE email = 'exec@demo.test'").get().totp_pending;
    assert.ok(!stored.includes(secret.replace(/\s/g, '')), 'secret is stored encrypted');
    assert.equal((await call(c, 'POST', '/api/me/2fa/enable', { code: '000000' })).status, 400);
    const on = await call(c, 'POST', '/api/me/2fa/enable', { code: totp.codeAt(secret.replace(/\s/g, ''), totp.currentStep()) });
    assert.equal(on.status, 200);
    assert.equal(on.data.recoveryCodes.length, 10);
    recovery = on.data.recoveryCodes;
  });

  test('sign-in then asks for the code; wrong codes are limited', async () => {
    const step1 = await password('exec');
    assert.equal(step1.data.twoFactor, true);
    assert.equal(step1.cookie, null, 'no session before the second step');
    const bad = await call(null, 'POST', '/api/login/2fa', { challenge: step1.data.challenge, code: '123456' });
    assert.equal(bad.status, 401);
    assert.match(bad.data.error, /4 tries left/);
    const good = await call(null, 'POST', '/api/login/2fa', { challenge: step1.data.challenge, code: appCode(secret, 'exec@demo.test') });
    assert.equal(good.status, 200);
    assert.equal((await call(good.cookie, 'GET', '/api/clients')).status, 200);
    assert.equal((await call(null, 'POST', '/api/login/2fa', { challenge: step1.data.challenge, code: appCode(secret, 'exec@demo.test') })).status, 401,
      'a challenge works once');

    const step2 = await password('exec');
    for (let i = 0; i < 5; i++) await call(null, 'POST', '/api/login/2fa', { challenge: step2.data.challenge, code: '000000' });
    const locked = await call(null, 'POST', '/api/login/2fa', { challenge: step2.data.challenge, code: appCode(secret, 'exec@demo.test') });
    assert.equal(locked.data.code, 'challenge_expired');
  });

  test('a recovery code works exactly once', async () => {
    const s1 = await password('exec');
    const r1 = await call(null, 'POST', '/api/login/2fa', { challenge: s1.data.challenge, code: recovery[0].toUpperCase() });
    assert.equal(r1.status, 200);
    assert.equal(r1.data.usedRecoveryCode, true);
    assert.equal(r1.data.recoveryRemaining, 9);
    const s2 = await password('exec');
    assert.equal((await call(null, 'POST', '/api/login/2fa', { challenge: s2.data.challenge, code: recovery[0] })).status, 401);
  });

  test('the owner can require it; people without it must set it up first', async () => {
    const tech = await signIn('tech');
    const exec = await (async () => {
      const s = await password('exec');
      return (await call(null, 'POST', '/api/login/2fa', { challenge: s.data.challenge, code: appCode(secret, 'exec@demo.test') })).cookie;
    })();
    assert.equal((await call(tech, 'PUT', '/api/security/require-2fa', { required: true })).status, 403);
    assert.equal((await call(exec, 'PUT', '/api/security/require-2fa', { required: true })).status, 200);
    assert.equal(getSetting(db, 'require_2fa'), '1');

    const blocked = await call(tech, 'GET', '/api/clients');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.code, '2fa_setup_required');
    const me = await call(tech, 'GET', '/api/me');
    assert.equal(me.data.user.needs2faSetup, true);
    const fresh = await password('tech');
    assert.equal(fresh.data.needs2faSetup, true);
    const setup = await call(fresh.cookie, 'POST', '/api/me/2fa/setup', {});
    const s = setup.data.secret.replace(/\s/g, '');
    assert.equal((await call(fresh.cookie, 'POST', '/api/me/2fa/enable', { code: totp.codeAt(s, totp.currentStep()) })).status, 200);
    assert.equal((await call(fresh.cookie, 'GET', '/api/clients')).status, 200, 'unlocked once set up');
    assert.equal((await call(fresh.cookie, 'POST', '/api/me/2fa/disable', { password: DEMO_PASSWORD, code: '000000' })).status, 403,
      'cannot turn off while required');
  });

  test('an office manager can reset a lost phone; it signs the person out', async () => {
    const office = await password('office');
    const officeCookie = office.cookie; // office has no 2FA yet: session limited to setup
    assert.equal((await call(officeCookie, 'GET', '/api/users')).status, 403);
    const s = (await call(officeCookie, 'POST', '/api/me/2fa/setup', {})).data.secret.replace(/\s/g, '');
    await call(officeCookie, 'POST', '/api/me/2fa/enable', { code: totp.codeAt(s, totp.currentStep()) });
    const techId = db.prepare("SELECT id FROM users WHERE email = 'tech@demo.test'").get().id;
    assert.equal((await call(officeCookie, 'GET', '/api/users')).data.find((u) => u.id === techId).totp_enabled, 1);
    assert.equal((await call(officeCookie, 'PATCH', `/api/users/${techId}`, { reset_2fa: true })).status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id = ?').get(techId).n, 0);
    const again = await password('tech');
    assert.equal(again.data.twoFactor, undefined);
    assert.equal(again.data.needs2faSetup, true, 'required again at next sign-in');
    const execId = db.prepare("SELECT id FROM users WHERE email = 'exec@demo.test'").get().id;
    assert.equal((await call(officeCookie, 'PATCH', `/api/users/${execId}`, { reset_2fa: true })).status, 403, 'cannot reset the owner');
    assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'user.2fa_reset'").get());
  });
});

describe('backups', () => {
  test('are encrypted snapshots that restore to an identical database', () => {
    const b = createBackup(db, cfg);
    const raw = fs.readFileSync(path.join(cfg.backupDir, b.name));
    assert.ok(!raw.includes(Buffer.from('SQLite format 3')), 'not readable without the key');
    assert.ok(!raw.includes(Buffer.from('Thompson')), 'client names are not visible');
    const target = path.join(tmp, 'restored.db');
    restoreBackup(path.join(cfg.backupDir, b.name), target, cfg.key);
    const restored = openDb(target);
    assert.equal(restored.prepare('SELECT COUNT(*) n FROM clients').get().n, db.prepare('SELECT COUNT(*) n FROM clients').get().n);
    assert.equal(restored.prepare('SELECT COUNT(*) n FROM program_data').get().n, db.prepare('SELECT COUNT(*) n FROM program_data').get().n);
    restored.close();
    assert.throws(() => restoreBackup(path.join(cfg.backupDir, b.name), target, cfg.key), /already exists/);
    assert.throws(() => restoreBackup(path.join(cfg.backupDir, b.name), path.join(tmp, 'x.db'), crypto.randomBytes(32)), /wrong encryption key/);
  });

  test('keep 30 days of daily backups plus one per month for a year', () => {
    const now = new Date(Date.UTC(2026, 8, 25, 12));
    const backups = [];
    for (let d = 0; d < 400; d++) {
      const at = new Date(now.getTime() - d * 86400000);
      backups.push({ name: `b${d}`, at });
    }
    const deleted = new Set(toPrune(backups, { keepDays: 30, keepMonths: 12, now }).map((b) => b.name));
    const kept = backups.filter((b) => !deleted.has(b.name));
    assert.ok(kept.filter((b) => now - b.at <= 30 * 86400000).length >= 30);
    const old = kept.filter((b) => now - b.at > 31 * 86400000);
    assert.ok(old.length >= 10 && old.length <= 12, `one per month for older ones (got ${old.length})`);
    assert.ok(!kept.some((b) => now - b.at > 370 * 86400000), 'nothing older than a year');
  });

  test('only the owner can see backup status or back up now', async () => {
    const tech = await signIn('lead');
    assert.equal((await call(tech, 'POST', '/api/security/backup-now', {})).status, 403);
    assert.ok(listBackups(cfg.backupDir).length >= 1);
  });
});

describe('HTTPS in production', () => {
  let prod;
  let prodBase;
  before(async () => {
    const pdb = openDb(':memory:');
    seed(pdb);
    prod = createApp(pdb, { ...localConfig(), production: true, trustProxy: 1 }).listen(0);
    await new Promise((r) => prod.once('listening', r));
    prodBase = `http://127.0.0.1:${prod.address().port}`;
  });
  after(() => prod.close());

  test('plain HTTP is redirected; HTTPS gets HSTS and secure cookies', async () => {
    const http = await fetch(`${prodBase}/clients`, { redirect: 'manual', headers: { 'x-forwarded-proto': 'http', 'x-forwarded-host': 'aba.example.org' } });
    assert.equal(http.status, 301);
    assert.equal(http.headers.get('location'), 'https://aba.example.org/clients');
    const login = await fetch(`${prodBase}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ email: 'tech@demo.test', password: DEMO_PASSWORD }) });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('strict-transport-security'), /max-age=31536000/);
    assert.match(login.headers.get('set-cookie'), /; Secure/);
    const health = await fetch(`${prodBase}/healthz`, { headers: { 'x-forwarded-proto': 'http' } });
    assert.equal(health.status, 200, 'health checks work without HTTPS');
  });
});
