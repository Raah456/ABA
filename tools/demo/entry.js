import './globals.js';
import { openDb } from '../../src/db.js';
import { seed } from '../../src/seed.js';
import { sessionMiddleware } from '../../src/auth.js';
import core from '../../src/routes/core.js';
import clients from '../../src/routes/clients.js';
import clinical from '../../src/routes/clinical.js';
import admin from '../../src/routes/admin.js';
import comms from '../../src/routes/comms.js';
import profile from '../../src/routes/profile.js';
import security from '../../src/routes/security.js';

const STORE_KEY = 'aba-practice-demo-db-v3';
let db;
let routers;
let session;
let jar = null;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, bytesToB64(db.raw.export()));
    db.exec('PRAGMA foreign_keys = ON;');
  } catch { /* storage unavailable: changes last until the page closes */ }
}

const ready = (async () => {
  globalThis.__SQL = await globalThis.initSqlJs();
  let saved = null;
  try { saved = localStorage.getItem(STORE_KEY); } catch { /* ignore */ }
  if (saved) {
    try { globalThis.__DB_BYTES = b64ToBytes(saved); db = openDb(':memory:'); } catch { db = null; }
  }
  if (!db) { globalThis.__DB_BYTES = null; db = openDb(':memory:'); seed(db); }
  // Two-factor setup and backups need real cryptography and a server; the demo explains that.
  const cfg = { browserDemo: true, production: false, key: null, backupDir: null, backupIntervalHours: 0 };
  routers = [core, clients, clinical, admin, comms, profile, security].map((f) => f(db, cfg));
  session = sessionMiddleware(db);
})();

async function handle(req) {
  const res = {
    statusCode: 200, body: null, sent: false,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) {
      if (k.toLowerCase() !== 'set-cookie') return;
      const [pair] = String(v).split(';');
      const value = pair.slice(pair.indexOf('=') + 1);
      jar = /Max-Age=0/.test(v) || !value ? null : value;
    },
    json(d) { this.body = d; this.sent = true; },
  };
  let error = null;
  try {
    session(req, res, () => {});
    for (const r of routers) {
      const pending = r.handle(req, res, (err) => { if (err) error = err; });
      if (pending) await pending;
      if (error || res.sent) break;
    }
  } catch (e) { error = e; }
  if (error) {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    res.statusCode = status;
    res.body = { error: status >= 500 ? 'Something went wrong.' : error.message };
  } else if (!res.sent) {
    res.statusCode = 404;
    res.body = { error: 'Not found.' };
  }
  return res;
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.startsWith('/api')) return realFetch(input, init);
  await ready;
  const u = new URL(url, 'http://demo.local');
  const method = (init.method || 'GET').toUpperCase();
  const req = {
    method,
    path: u.pathname.slice(4) || '/',
    query: Object.fromEntries(u.searchParams),
    headers: { cookie: jar ? `aba_session=${jar}` : '' },
    body: init.body ? JSON.parse(init.body) : undefined,
    ip: 'demo',
    secure: false,
  };
  const res = await handle(req);
  if (method !== 'GET' && res.statusCode < 400) save();
  return new Response(JSON.stringify(res.body), { status: res.statusCode, headers: { 'content-type': 'application/json' } });
};

window.resetDemo = () => {
  try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
  location.hash = '';
  location.reload();
};

await ready.catch((e) => console.error(e));
await import('../../public/js/main.js');
