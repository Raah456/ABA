'use strict';

const path = require('node:path');
const { openDb } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'aba-practice.db');

const db = openDb(DB_FILE);
const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (!count) {
  console.log('No users yet. Run `npm run seed` for demo data, or set ADMIN_EMAIL / ADMIN_PASSWORD to create the first executive account.');
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const { hashPassword } = require('./auth');
    db.prepare('INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?)')
      .run(process.env.ADMIN_EMAIL.toLowerCase(), process.env.ADMIN_NAME || 'Administrator', 'executive', hashPassword(process.env.ADMIN_PASSWORD));
    console.log(`Created executive account ${process.env.ADMIN_EMAIL}.`);
  }
}

createApp(db).listen(PORT, () => {
  console.log(`ABA Practice Platform running at http://localhost:${PORT}`);
});
