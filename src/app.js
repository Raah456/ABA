'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { sessionMiddleware, HttpError } = require('./auth');

// While two-factor setup is owed, a session can only reach these.
const SETUP_ALLOWED = ['/me', '/me/2fa', '/me/2fa/setup', '/me/2fa/enable', '/logout'];

// Settings for tests and local runs when no config is passed.
function localConfig() {
  return { production: false, trustProxy: 'loopback', key: crypto.randomBytes(32), browserDemo: false,
    backupDir: null, backupIntervalHours: 0, backupKeepDays: 30, backupKeepMonths: 12 };
}

function createApp(db, cfg = localConfig()) {
  const app = express();
  app.set('trust proxy', cfg.trustProxy);
  app.disable('x-powered-by');
  app.locals.production = cfg.production;

  // For the hosting provider's health checks. No data, no sign-in.
  app.get('/healthz', (req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  if (cfg.production) {
    // Everything over HTTPS. The reverse proxy (Caddy) terminates TLS and sets X-Forwarded-Proto.
    app.use((req, res, next) => {
      if (req.secure) return next();
      if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(301, `https://${req.hostname}${req.originalUrl}`);
      return res.status(403).json({ error: 'Use HTTPS.' });
    });
  }

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (cfg.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  app.use('/api', express.json({ limit: '1mb' }));
  // Health-record responses must never be cached by the browser or a proxy.
  app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  // State-changing API calls must be JSON; with SameSite=Strict cookies this blocks CSRF.
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) && !req.is('application/json')) {
      return next(new HttpError(415, 'Requests must be JSON.'));
    }
    next();
  });
  app.use('/api', sessionMiddleware(db));
  app.use('/api', (req, res, next) => {
    if (req.user?.needs2faSetup && !SETUP_ALLOWED.includes(req.path)) {
      return next(new HttpError(403, 'Set up two-factor sign-in to continue.', '2fa_setup_required'));
    }
    next();
  });

  for (const name of ['core', 'clients', 'clinical', 'admin', 'comms', 'profile', 'security']) {
    app.use('/api', require(`./routes/${name}`)(db, cfg));
  }

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 && !err.expose ? 'Something went wrong.' : err.message, code: err.code });
  });

  return app;
}

module.exports = { createApp, localConfig };
