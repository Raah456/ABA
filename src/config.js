'use strict';

// All runtime settings come from environment variables (see .env.example).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const dataDir = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'));
  const cfg = {
    production,
    port: Number(env.PORT) || 3000,
    dataDir,
    dbFile: path.resolve(env.DB_FILE || path.join(dataDir, 'aba-practice.db')),
    backupDir: path.resolve(env.BACKUP_DIR || path.join(dataDir, 'backups')),
    backupIntervalHours: Number(env.BACKUP_INTERVAL_HOURS ?? 24),
    backupKeepDays: Number(env.BACKUP_KEEP_DAYS ?? 30),
    backupKeepMonths: Number(env.BACKUP_KEEP_MONTHS ?? 12),
    // Number of reverse proxies in front of the app (Caddy in the provided setup = 1).
    trustProxy: env.TRUST_PROXY !== undefined ? Number(env.TRUST_PROXY) : (production ? 1 : 0),
    demo: env.DEMO_MODE === '1',
    key: null,
  };
  cfg.key = loadKey(env, cfg);
  return cfg;
}

// 32-byte key that encrypts backups and two-factor secrets. In production it must be
// provided; locally one is generated into the data folder so development just works.
function loadKey(env, cfg) {
  if (env.APP_ENCRYPTION_KEY) {
    const key = Buffer.from(env.APP_ENCRYPTION_KEY, 'base64');
    if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded. Generate one with: npm run keygen');
    return key;
  }
  if (cfg.production) {
    throw new Error('APP_ENCRYPTION_KEY is required in production. Generate one with: npm run keygen');
  }
  const file = path.join(cfg.dataDir, 'dev-encryption.key');
  if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key.toString('base64'), { mode: 0o600 });
  return key;
}

module.exports = { loadConfig };
