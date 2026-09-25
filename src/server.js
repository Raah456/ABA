'use strict';

const { openDb } = require('./db');
const { createApp } = require('./app');
const { loadConfig } = require('./config');
const { hashPassword } = require('./auth');
const { startScheduler } = require('./backup');

let cfg;
try {
  cfg = loadConfig();
} catch (err) {
  console.error(`Cannot start: ${err.message}`);
  process.exit(1);
}

const db = openDb(cfg.dbFile);
const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (!count) {
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    if (process.env.ADMIN_PASSWORD.length < 12) {
      console.error('ADMIN_PASSWORD must be at least 12 characters.');
      process.exit(1);
    }
    db.prepare('INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?)')
      .run(process.env.ADMIN_EMAIL.toLowerCase(), process.env.ADMIN_NAME || 'Administrator', 'executive', hashPassword(process.env.ADMIN_PASSWORD));
    console.log(`Created executive account ${process.env.ADMIN_EMAIL}. Remove ADMIN_PASSWORD from your settings now.`);
  } else {
    console.log('No users yet. Set ADMIN_EMAIL and ADMIN_PASSWORD to create the first account, or run `npm run seed` for demo data.');
  }
}

const scheduler = startScheduler(db, cfg);
const server = createApp(db, cfg).listen(cfg.port, () => {
  console.log(`ABA Practice Platform running on port ${cfg.port}${cfg.production ? ' (production)' : ''}.`);
  if (cfg.backupIntervalHours > 0) console.log(`Encrypted backups every ${cfg.backupIntervalHours}h into ${cfg.backupDir}.`);
});

// Finish in-flight requests and close the database cleanly when the host stops the app.
function shutdown(signal) {
  console.log(`${signal} received, shutting down.`);
  scheduler?.stop();
  server.close(() => {
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
