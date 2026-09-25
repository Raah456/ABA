'use strict';

// npm run backup: write one encrypted backup now (uses the same settings as the app).
const { loadConfig } = require('../config');
const { openDb } = require('../db');
const { createBackup } = require('../backup');

const cfg = loadConfig();
const b = createBackup(openDb(cfg.dbFile), cfg);
console.log(`Wrote ${cfg.backupDir}/${b.name} (${Math.round(b.size / 1024)} KB).${b.deleted.length ? ` Removed ${b.deleted.length} old backup(s).` : ''}`);
