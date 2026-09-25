'use strict';

const express = require('express');
const QRCode = require('qrcode');
const { requireAuth, requireCap, verifyPassword, HttpError } = require('../auth');
const { tx, setSetting } = require('../db');
const { audit } = require('../access');
const twofactor = require('../twofactor');
const { createBackup, backupStatus } = require('../backup');

module.exports = function securityRoutes(db, cfg) {
  const r = express.Router();
  const notInDemo = () => {
    if (cfg.browserDemo) throw new HttpError(400, 'This is not available in the demo. It works in the real app.');
  };
  const me = (req) => db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  // ---------- my two-factor sign-in ----------
  r.get('/me/2fa', requireAuth, (req, res) => {
    const u = me(req);
    res.json({ enabled: !!u.totp_enabled, required: twofactor.isRequired(db), recoveryRemaining: twofactor.recoveryRemaining(db, u.id) });
  });

  r.post('/me/2fa/setup', requireAuth, async (req, res) => {
    notInDemo();
    const u = me(req);
    if (u.totp_enabled) throw new HttpError(409, 'Two-factor sign-in is already on.');
    const { secret, uri } = twofactor.startSetup(db, cfg.key, u);
    const qr = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.json({ secret: secret.replace(/(.{4})/g, '$1 ').trim(), qrSvg: qr });
  });

  r.post('/me/2fa/enable', requireAuth, (req, res) => {
    notInDemo();
    const u = me(req);
    const codes = tx(db, () => {
      const c = twofactor.finishSetup(db, cfg.key, u, req.body?.code);
      if (!c) return null;
      db.prepare('UPDATE sessions SET needs_2fa_setup = 0 WHERE user_id = ?').run(u.id);
      return c;
    });
    if (!codes) throw new HttpError(400, "That code didn't match. Check the time on your phone is set automatically, and enter the newest code.");
    audit(db, req, 'user.2fa_enabled', { entity: 'user', entityId: u.id });
    res.json({ recoveryCodes: codes });
  });

  r.post('/me/2fa/recovery-codes', requireAuth, (req, res) => {
    const u = me(req);
    if (!u.totp_enabled) throw new HttpError(400, 'Turn on two-factor sign-in first.');
    if (twofactor.checkSecondFactor(db, cfg.key, u, req.body?.code) !== 'app') {
      throw new HttpError(400, "That code didn't match. Use the current code from your authenticator app.");
    }
    const codes = twofactor.newRecoveryCodes(db, u.id);
    audit(db, req, 'user.2fa_recovery_codes', { entity: 'user', entityId: u.id });
    res.json({ recoveryCodes: codes });
  });

  r.post('/me/2fa/disable', requireAuth, (req, res) => {
    const u = me(req);
    if (twofactor.isRequired(db)) throw new HttpError(403, 'Your practice requires two-factor sign-in, so it cannot be turned off.');
    if (!verifyPassword(String(req.body?.password ?? ''), u.password_hash)) throw new HttpError(400, 'Password is incorrect.');
    if (!twofactor.checkSecondFactor(db, cfg.key, u, req.body?.code)) throw new HttpError(400, "That code didn't match.");
    twofactor.turnOff(db, u.id);
    audit(db, req, 'user.2fa_disabled', { entity: 'user', entityId: u.id });
    res.json({ ok: true });
  });

  // ---------- practice security (owner) ----------
  r.get('/security', requireCap('security.manage'), (req, res) => {
    const users = db.prepare('SELECT id, name, role, active, totp_enabled FROM users ORDER BY name').all();
    res.json({
      require2fa: twofactor.isRequired(db),
      users,
      backups: cfg.browserDemo ? null : backupStatus(cfg),
      production: cfg.production,
    });
  });

  r.put('/security/require-2fa', requireCap('security.manage'), (req, res) => {
    const required = !!req.body?.required;
    setSetting(db, 'require_2fa', required ? '1' : '0');
    if (required) {
      // Anyone signed in without two-factor must set it up before continuing.
      db.prepare(`UPDATE sessions SET needs_2fa_setup = 1 WHERE user_id IN (SELECT id FROM users WHERE totp_enabled = 0)`).run();
    } else {
      db.prepare('UPDATE sessions SET needs_2fa_setup = 0').run();
    }
    audit(db, req, 'security.require_2fa', { detail: { required } });
    res.json({ ok: true });
  });

  r.post('/security/backup-now', requireCap('security.manage'), (req, res) => {
    notInDemo();
    let b;
    try {
      b = createBackup(db, cfg);
    } catch (err) {
      throw new HttpError(500, `Backup failed: ${err.message}`);
    }
    audit(db, req, 'security.backup', { detail: { file: b.name } });
    res.json({ name: b.name, size: b.size, deleted: b.deleted.length });
  });

  return r;
};
