// Things that depend on the device someone is using: icons for the phone/tablet tab bar,
// unsaved-data drafts kept on the device, keeping the screen awake, and session keep-alive.
import { h, api } from './lib.js';

// ---------- icons (24x24, stroke) ----------
const ICONS = {
  home: [['path', { d: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z' }]],
  clients: [['circle', { cx: 9, cy: 8, r: 3.5 }], ['path', { d: 'M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6' }],
    ['circle', { cx: 17.5, cy: 9, r: 2.5 }], ['path', { d: 'M17 14.2c2.6.3 4.5 2.4 4.5 5.8' }]],
  notes: [['rect', { x: 5, y: 3, width: 14, height: 18, rx: 2 }], ['path', { d: 'M9 8h6M9 12h6M9 16h3' }]],
  reports: [['path', { d: 'M5 21V4h11l-2 4 2 4H5' }]],
  rides: [['path', { d: 'M3 13 5 7h14l2 6v4H3z' }], ['circle', { cx: 7, cy: 17, r: 2 }], ['circle', { cx: 17, cy: 17, r: 2 }]],
  insurance: [['path', { d: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z' }], ['path', { d: 'M9 12l2 2 4-4' }]],
  billing: [['path', { d: 'M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6' }]],
  announcements: [['path', { d: 'M3 10v4h4l7 4V6l-7 4z' }], ['path', { d: 'M17 9a4 4 0 0 1 0 6' }]],
  more: [['path', { d: 'M4 6h16M4 12h16M4 18h16' }]],
};

export function icon(name) {
  return h('svg', { viewBox: '0 0 24 24', width: 24, height: 24, fill: 'none', stroke: 'currentColor', 'stroke-width': 2,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
  (ICONS[name] || []).map(([tag, attrs]) => h(tag, attrs)));
}

// ---------- unsaved data kept on this device ----------
// Drafts are keyed by user so a shared center iPad never shows one person's data to another.
const DRAFT_PREFIX = 'aba-draft:';
export const draftKey = (userId, clientId) => `${DRAFT_PREFIX}${userId}:${clientId}`;

export function readDraft(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
export function writeDraft(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
export function clearDraft(key) {
  try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
}
export function userDraftKeys(userId) {
  try { return Object.keys(localStorage).filter((k) => k.startsWith(`${DRAFT_PREFIX}${userId}:`)); } catch { return []; }
}

// ---------- keep the screen on during a session ----------
export const canKeepScreenOn = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
let wakeLock = null;
let wantAwake = false;

export async function keepScreenOn(on) {
  wantAwake = on;
  try {
    if (on && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { wakeLock = null; }
  return !!wakeLock;
}
// The browser drops the lock when the tab is hidden; take it back when the person returns.
document.addEventListener('visibilitychange', () => {
  if (wantAwake && document.visibilityState === 'visible') keepScreenOn(true);
});

// ---------- session keep-alive while actively working ----------
// Tapping trial results is real activity, but it doesn't reach the server until "Save".
// Tell the server now and then so a 2-hour session doesn't hit the 30-minute idle sign-out.
let lastPing = Date.now();
export function stillWorking() {
  if (Date.now() - lastPing < 4 * 60 * 1000) return;
  lastPing = Date.now();
  api('/me').catch(() => {});
}
