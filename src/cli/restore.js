'use strict';

// npm run restore -- <backup file> [--force] [--to <path>]
// Decrypts a backup into the database location. Stop the app before restoring.
const path = require('node:path');
const { loadConfig } = require('../config');
const { restoreBackup, listBackups } = require('../backup');

const cfg = loadConfig();
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--to');
if (!file) {
  console.log('Usage: npm run restore -- <backup file> [--force] [--to <path>]\n\nBackups available:');
  for (const b of listBackups(cfg.backupDir)) console.log(`  ${path.join(cfg.backupDir, b.name)}  ${b.at.toISOString()}  ${Math.round(b.size / 1024)} KB`);
  process.exit(1);
}
const toIdx = args.indexOf('--to');
const target = toIdx >= 0 ? path.resolve(args[toIdx + 1]) : cfg.dbFile;
try {
  const r = restoreBackup(path.resolve(file), target, cfg.key, { force: args.includes('--force') });
  console.log(`Restored ${Math.round(r.bytes / 1024)} KB into ${target}. Start the app again.`);
} catch (err) {
  console.error(`Restore failed: ${err.message}`);
  process.exit(1);
}
