// Demo-only stand-ins for node:crypto. Nothing here is secure; the demo has no real accounts.
function randomHex(n) {
  const a = new Uint8Array(n);
  globalThis.crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}
function fakeHash(str, bytes = 32) {
  let out = '';
  let h = 2166136261;
  for (let r = 0; out.length < bytes * 2; r++) {
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    h ^= r; h = Math.imul(h, 16777619) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, bytes * 2);
}
class Buf { constructor(hex) { this.hex = hex; this.length = hex.length / 2; } toString() { return this.hex; } }
globalThis.Buffer = globalThis.Buffer || { from: (hex) => new Buf(String(hex)) };
module.exports = {
  randomBytes: (n) => new Buf(randomHex(n)),
  createHash: () => { let d = ''; return { update(s) { d += s; return this; }, digest() { return fakeHash(d); } }; },
  scryptSync: (pw, salt, len) => new Buf(fakeHash(`${pw}:${salt}`, len)),
  timingSafeEqual: (a, b) => a.hex === b.hex,
};
