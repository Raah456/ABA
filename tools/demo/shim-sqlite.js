// node:sqlite's DatabaseSync API on top of sql.js, enough for this app.
const clean = (args) => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? (a ? 1 : 0) : a));
class Statement {
  constructor(raw, sql) { this.raw = raw; this.sql = sql; }
  _each(args, fn) {
    const s = this.raw.prepare(this.sql);
    try { s.bind(clean(args)); return fn(s); } finally { s.free(); }
  }
  get(...args) { return this._each(args, (s) => (s.step() ? s.getAsObject() : undefined)); }
  all(...args) { return this._each(args, (s) => { const out = []; while (s.step()) out.push(s.getAsObject()); return out; }); }
  run(...args) {
    this._each(args, (s) => s.step());
    const changes = this.raw.getRowsModified();
    const lastInsertRowid = this.raw.exec('SELECT last_insert_rowid()')[0].values[0][0];
    return { changes, lastInsertRowid };
  }
}
class DatabaseSync {
  constructor() { this.raw = new globalThis.__SQL.Database(globalThis.__DB_BYTES || undefined); }
  exec(sql) { this.raw.exec(sql); }
  prepare(sql) { return new Statement(this.raw, sql); }
}
module.exports = { DatabaseSync };
