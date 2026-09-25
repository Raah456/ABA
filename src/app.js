'use strict';

const path = require('node:path');
const express = require('express');
const { sessionMiddleware, HttpError } = require('./auth');

function createApp(db) {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'");
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

  app.use('/api', require('./routes/core')(db));
  app.use('/api', require('./routes/clients')(db));
  app.use('/api', require('./routes/clinical')(db));
  app.use('/api', require('./routes/admin')(db));
  app.use('/api', require('./routes/comms')(db));
  app.use('/api', require('./routes/profile')(db));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong.' : err.message });
  });

  return app;
}

module.exports = { createApp };
