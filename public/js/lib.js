// Shared helpers: DOM building, API calls, modals, formatting, charts.

export const state = { me: null, lists: null, users: null, onAuthLost: null };

// ---------- DOM ----------
// h('div', { class: 'x', onclick: fn }, 'text', child, [children])
export function h(tag, props, ...children) {
  const svg = ['svg', 'line', 'polyline', 'circle', 'text', 'g', 'path', 'rect', 'title'].includes(tag);
  const el = svg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.setAttribute('class', v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'value' && !svg) el.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled' || k === 'required') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function mount(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

// ---------- API ----------
export class ApiError extends Error {}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && path !== '/login') {
    state.me = null;
    state.onAuthLost?.();
    throw new ApiError('Your session ended. Please sign in again.');
  }
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`);
  return data;
}

// Re-render the current page after a change.
export function rerender() {
  window.dispatchEvent(new Event('app:rerender'));
}

export const can = (cap) => !!state.me?.capabilities.includes(cap);
export const roleLabel = (role) => state.me?.roles[role]?.label || role;
export const deptOfRole = (role) => state.me?.roles[role]?.dept;

export async function loadLists(force = false) {
  if (!state.lists || force) state.lists = await api('/lists');
  return state.lists;
}

export function listOptions(key, { includeInactive = false } = {}) {
  return (state.lists?.lists[key] || []).filter((x) => includeInactive || x.active);
}

export async function loadUsers(force = false) {
  if (!state.users || force) state.users = await api('/users');
  return state.users;
}

// ---------- feedback ----------
export function toast(message, kind = '') {
  let box = document.querySelector('.toasts');
  if (!box) { box = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: `toast ${kind}` }, message);
  box.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3000);
}

// Run an async action with error toast; returns undefined on failure.
export async function attempt(fn, success) {
  try {
    const r = await fn();
    if (success) toast(success);
    return r ?? true;
  } catch (e) {
    toast(e.message, 'error');
    return undefined;
  }
}

// ---------- modal ----------
// content: node(s). onSubmit(form) -> truthy closes. Returns close().
export function modal(title, content, { onSubmit, onClose, submitLabel = 'Save', wide = false, danger = false } = {}) {
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const error = h('div', { class: 'banner bad hidden' });
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (!onSubmit) return close();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      error.classList.add('hidden');
      try {
        if (await onSubmit(form)) close();
      } catch (err) {
        error.textContent = err.message;
        error.classList.remove('hidden');
      } finally {
        btn.disabled = false;
      }
    },
  },
  h('h2', {}, title), error, content,
  h('div', { class: 'row end' },
    h('button', { type: 'button', class: 'btn', onclick: close }, onSubmit ? 'Cancel' : 'Close'),
    onSubmit && h('button', { type: 'submit', class: `btn ${danger ? 'danger' : 'primary'}` }, submitLabel)));
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } },
    h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, form));
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey);
  form.querySelector('input:not([type=hidden]), select, textarea')?.focus();
  return close;
}

// In-page "are you sure?" step. Resolves true only if the person confirms.
export function confirmDialog(message, { confirmLabel = 'Confirm', danger = true } = {}) {
  return new Promise((resolve) => {
    let confirmed = false;
    modal('Are you sure?', h('p', {}, message), {
      submitLabel: confirmLabel,
      danger,
      onSubmit: () => { confirmed = true; return true; },
      onClose: () => resolve(confirmed),
    });
  });
}

// ---------- forms ----------
export function field(label, input, { required = false, help } = {}) {
  return h('label', { class: 'field' },
    h('span', {}, label, required && h('span', { class: 'req' }, ' *'), help && h('span', { class: 'help' }, ` — ${help}`)),
    input);
}

export function input(name, { type = 'text', value = '', required = false, placeholder, min, max, step } = {}) {
  return h('input', { name, type, value: value ?? '', required, placeholder, min, max, step });
}

export function textarea(name, { value = '', required = false, rows, placeholder } = {}) {
  return h('textarea', { name, required, rows, placeholder, value: value ?? '' });
}

// options: [[value, label]] or [value]
export function select(name, options, { value = '', required = false, blank, class: cls } = {}) {
  return h('select', { name, required, class: cls },
    blank !== undefined && h('option', { value: '' }, blank),
    options.map((o) => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return h('option', { value: v, selected: String(v) === String(value ?? '') }, l);
    }));
}

export function checkbox(name, label, checked = false) {
  return h('label', { class: 'check' }, h('input', { type: 'checkbox', name, checked }), label);
}

export function formValues(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') {
      if (el.dataset.multi) { (out[el.name] ||= []); if (el.checked) out[el.name].push(el.value); } else out[el.name] = el.checked;
    } else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; } else out[el.name] = el.value;
  }
  return out;
}

// ---------- formatting ----------
export function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s.length === 10 ? `${s}T00:00:00` : `${s.replace(' ', 'T')}Z`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtDateTime(s) {
  if (!s) return '—';
  const d = new Date(`${s.replace(' ', 'T')}Z`);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function fmtTime(t) {
  if (!t) return '';
  const [hh, mm] = t.split(':').map(Number);
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
}

export function ago(s) {
  const d = new Date(`${s.replace(' ', 'T')}Z`);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  if (mins < 10080) return `${Math.round(mins / 1440)}d ago`;
  return fmtDate(s);
}

export function todayIso() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export function shiftDate(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function age(dob) {
  if (!dob) return '';
  const d = new Date(`${dob}T00:00:00`);
  const n = new Date();
  let a = n.getFullYear() - d.getFullYear();
  if (n < new Date(n.getFullYear(), d.getMonth(), d.getDate())) a -= 1;
  return `${a} yrs`;
}

const STATUS_KIND = {
  draft: '', submitted: 'info', returned: 'warn', approved: 'ok',
  open: 'bad', acknowledged: 'warn', resolved: 'ok',
  active: 'ok', baseline: 'info', on_hold: 'warn', mastered: 'ok', discontinued: '',
  scheduled: 'info', en_route: 'warn', completed: 'ok', no_show: 'bad', cancelled: '',
  info: 'info', concern: 'warn', urgent: 'bad', low: '', normal: 'info', high: 'warn',
  inactive: 'bad', issue: 'warn', waitlist: 'warn', discharged: '',
};

export function badge(status, label) {
  return h('span', { class: `badge ${STATUS_KIND[status] ?? ''}` }, label || String(status).replace(/_/g, ' '));
}

export function empty(text) {
  return h('div', { class: 'empty' }, text);
}

export function table(columns, rows, { onRow, emptyText = 'Nothing here yet.' } = {}) {
  if (!rows.length) return empty(emptyText);
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, columns.map((c) => h('th', {}, c.label)))),
    h('tbody', {}, rows.map((r) => h('tr', { class: onRow ? 'clickable' : null, onclick: onRow ? () => onRow(r) : null },
      columns.map((c) => h('td', { 'data-label': typeof c.label === 'string' ? c.label : '' },
        h('div', { class: 'cell' }, c.render ? c.render(r) : r[c.key] ?? '—'))))))));
}

export function usageBar(pct) {
  const bar = h('div', { class: `bar ${pct >= 95 ? 'bad' : pct >= 80 ? 'warn' : ''}`, title: `${pct}% used` }, h('div'));
  bar.firstChild.style.width = `${Math.min(pct, 100)}%`;
  return bar;
}

// ---------- charts ----------
// points: [{date, value}], criterion: number|null, phases: [date]
export function lineChart(points, { criterion = null, max = null, width = 640, height = 220, spark = false, unit = '' } = {}) {
  const pad = spark ? { l: 2, r: 2, t: 4, b: 4 } : { l: 40, r: 24, t: 12, b: 26 };
  const W = width;
  const H = height;
  const byDate = new Map();
  for (const p of points) (byDate.get(p.date) || byDate.set(p.date, []).get(p.date)).push(p.value);
  const series = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([date, vals]) => ({ date, value: vals.reduce((a, b) => a + b, 0) / vals.length }));
  const svg = h('svg', { class: `chart ${spark ? 'spark' : ''}`, viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': spark ? 'Trend' : `Chart of ${series.length} sessions` });
  if (!series.length) {
    if (!spark) svg.append(h('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'axis-label' }, 'No data yet'));
    return svg;
  }
  const top = max ?? Math.max(1, criterion ?? 0, ...series.map((s) => s.value)) * (max ? 1 : 1.1);
  const x = (i) => pad.l + (series.length === 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (series.length - 1));
  const y = (v) => pad.t + (1 - v / top) * (H - pad.t - pad.b);
  if (!spark) {
    for (let k = 0; k <= 4; k++) {
      const v = (top * k) / 4;
      svg.append(h('line', { class: 'grid-line', x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }));
      svg.append(h('text', { class: 'axis-label', x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, `${Math.round(v)}${unit}`));
    }
    const step = Math.ceil(series.length / 8);
    series.forEach((s, i) => {
      if (i % step === 0 || i === series.length - 1) {
        const anchor = series.length > 1 && i === series.length - 1 ? 'end' : 'middle';
        svg.append(h('text', { class: 'axis-label', x: x(i), y: H - 8, 'text-anchor': anchor }, s.date.slice(5)));
      }
    });
  }
  if (criterion != null) svg.append(h('line', { class: 'criterion', x1: pad.l, x2: W - pad.r, y1: y(criterion), y2: y(criterion) }));
  svg.append(h('polyline', { class: 'series', points: series.map((s, i) => `${x(i)},${y(s.value)}`).join(' ') }));
  if (!spark) {
    series.forEach((s, i) => svg.append(h('circle', { class: 'dot', cx: x(i), cy: y(s.value), r: 3.5 },
      h('title', {}, `${s.date}: ${Math.round(s.value * 10) / 10}${unit}`))));
  }
  return svg;
}

export function downloadCsv(filename, rows, columns) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    // Neutralize spreadsheet formula injection.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const text = [columns.map((c) => esc(c.label)).join(','), ...rows.map((r) => columns.map((c) => esc(r[c.key])).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
