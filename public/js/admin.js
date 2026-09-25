import {
  h, mount, api, can, attempt, rerender, modal, field, input, textarea, select, formValues, fmtDate, fmtDateTime, fmtTime,
  todayIso, shiftDate, badge, empty, table, usageBar, listOptions, loadUsers, toast, downloadCsv, confirmDialog,
} from './lib.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const RIDE_STATUSES = [['scheduled', 'Scheduled'], ['en_route', 'En route'], ['completed', 'Completed'], ['no_show', 'No-show'], ['cancelled', 'Cancelled']];

// ================= insurance =================
export async function insuranceView(el, _, query) {
  if (!can('insurance.view')) return authorizationsOnly(el);
  const tab = query.tab === 'auths' ? 'auths' : 'eligibility';
  const tabs = h('div', { class: 'tabs' },
    h('a', { href: '#/insurance', class: tab === 'eligibility' ? 'active' : '' }, 'Eligibility checks'),
    h('a', { href: '#/insurance?tab=auths', class: tab === 'auths' ? 'active' : '' }, 'Authorizations'));
  const head = h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Insurance & authorizations'),
    h('div', { class: 'muted' }, 'Replaces the morning paper checklist: log each check here and everyone sees the result.')));

  if (tab === 'eligibility') {
    const policies = await api('/eligibility');
    const due = policies.filter((p) => p.due);
    const rest = policies.filter((p) => !p.due);
    const edit = can('insurance.edit');
    const cols = [
      { label: 'Client', render: (p) => h('a', { href: `#/clients/${p.client_id}/insurance` }, p.client_name) },
      { label: 'Payer', render: (p) => [p.payer, h('div', { class: 'muted small' }, `${p.member_id || 'no member ID'} · ${p.priority}`)] },
      { label: 'Last check', render: (p) => (p.last_checked_at ? [badge(p.last_result), h('div', { class: 'muted small' }, `${fmtDateTime(p.last_checked_at)} · ${p.last_checked_by}`)] : h('span', { class: 'muted' }, 'Never checked')) },
      { label: 'Next due', render: (p) => fmtDate(p.next_check) },
      { label: '', render: (p) => edit && h('button', { class: `btn small ${p.due ? 'primary' : ''}`, onclick: () => openCheckForm(p) }, 'Log check') },
    ];
    mount(el, head, tabs,
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, `Due today (${due.length})`),
        h('span', { class: 'muted small' }, 'Due when never checked, past the check interval, or the last result was not "active".')),
      table(cols, due, { emptyText: 'All caught up. 🎉' })),
      h('div', { class: 'card' }, h('h2', {}, 'Up to date'), table(cols, rest, { emptyText: 'None.' })));
    return;
  }

  const auths = await api('/authorizations');
  const alerts = auths.filter((a) => a.alert);
  mount(el, head, tabs,
    alerts.length > 0 && h('div', { class: 'banner warn' }, `${alerts.length} authorization(s) need attention: expiring within 30 days or 80%+ used.`),
    h('div', { class: 'card flush' }, authTable(auths, true)));
}

function authTable(auths, full) {
  return table([
    { label: 'Client', render: (a) => h('a', { href: `#/clients/${a.client_id}/insurance` }, a.client_name) },
    full && { label: 'Payer / Auth #', render: (a) => [a.payer || '—', h('div', { class: 'muted small' }, a.auth_number || '')] },
    { label: 'Service', key: 'service_code' },
    { label: 'Dates', render: (a) => `${fmtDate(a.start_date)} – ${fmtDate(a.end_date)}` },
    { label: 'Usage', render: (a) => [h('div', { class: 'small' }, `${a.units_used}/${a.units_approved} units${a.units_pending ? ` · ${a.units_pending} pending` : ''}`), usageBar(a.pct_used)] },
    { label: '', render: (a) => (a.expired ? badge('discontinued', 'Expired') : a.alert ? badge('high', a.alert_reasons.join(', ')) : a.current ? badge('active', 'OK') : badge('scheduled', 'Upcoming')) },
  ].filter(Boolean), auths, { emptyText: 'No authorizations on file.' });
}

async function authorizationsOnly(el) {
  const auths = await api('/authorizations');
  mount(el,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Authorizations'), h('div', { class: 'muted' }, 'Units remaining per client, to plan hours. Contact billing for policy details.'))),
    h('div', { class: 'card flush' }, authTable(auths, false)));
}

export function openCheckForm(p) {
  modal(`Eligibility check — ${p.client_name || p.payer}`, h('div', {},
    h('p', { class: 'muted small' }, `${p.payer}${p.member_id ? ` · Member ID ${p.member_id}` : ''}`),
    field('Result', h('div', { class: 'seg' }, [['active', 'Active'], ['inactive', 'Inactive'], ['issue', 'Issue']].map(([v, l]) => h('label', {}, h('input', { type: 'radio', name: 'result', value: v, checked: v === 'active' }), l))), { required: true }),
    field('Notes', textarea('notes', { rows: 3, placeholder: 'Required if inactive or an issue: what you found and who you told' }))),
  {
    submitLabel: 'Log check',
    onSubmit: async (form) => {
      await api(`/policies/${p.id}/checks`, { method: 'POST', body: formValues(form) });
      toast('Check logged');
      rerender();
      return true;
    },
  });
}

export function openPolicyForm(p) {
  const payers = listOptions('payers').map((x) => [x.value, x.label]);
  if (p.payer && !payers.some(([v]) => v === p.payer)) payers.push([p.payer, p.payer]);
  modal(p.id ? 'Edit policy' : 'Add insurance policy', h('div', {},
    h('div', { class: 'form-grid' },
      field('Payer', select('payer', payers, { value: p.payer, required: true, blank: 'Choose…' }), { required: true }),
      field('Priority', select('priority', ['primary', 'secondary', 'tertiary'], { value: p.priority || 'primary' })),
      field('Member ID', input('member_id', { value: p.member_id })),
      field('Group #', input('group_number', { value: p.group_number })),
      field('Check every (days)', input('check_frequency_days', { type: 'number', min: 1, value: p.check_frequency_days ?? 30 }))),
    p.id && h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: !!p.active }), 'Active')),
  {
    onSubmit: async (form) => {
      const v = formValues(form);
      if (p.id) await api(`/policies/${p.id}`, { method: 'PATCH', body: v });
      else await api(`/clients/${p.client_id}/policies`, { method: 'POST', body: v });
      toast('Saved');
      rerender();
      return true;
    },
  });
}

export function openAuthForm(a, policies = []) {
  const codes = listOptions('service_codes').map((c) => [c.value, c.label]);
  modal(a.id ? 'Edit authorization' : 'Add authorization', h('div', {},
    h('div', { class: 'form-grid' },
      field('Policy', select('policy_id', policies.map((p) => [p.id, `${p.payer} (${p.priority})`]), { value: a.policy_id, blank: '—' })),
      field('Auth #', input('auth_number', { value: a.auth_number })),
      field('Service code', select('service_code', codes, { value: a.service_code, required: true, blank: 'Choose…' }), { required: true }),
      field('Units approved', input('units_approved', { type: 'number', min: 0, value: a.units_approved, required: true }), { required: true, help: '1 unit = 15 min' }),
      field('Start', input('start_date', { type: 'date', value: a.start_date, required: true }), { required: true }),
      field('End', input('end_date', { type: 'date', value: a.end_date, required: true }), { required: true })),
    field('Notes', textarea('notes', { value: a.notes, rows: 2 }))),
  {
    onSubmit: async (form) => {
      const v = formValues(form);
      if (a.id) await api(`/authorizations/${a.id}`, { method: 'PATCH', body: v });
      else await api(`/clients/${a.client_id}/authorizations`, { method: 'POST', body: v });
      toast('Saved');
      rerender();
      return true;
    },
  });
}

// ================= transportation =================
export function rideStatusSelect(r) {
  const s = select('status', RIDE_STATUSES, { value: r.status, class: 'inline-select' });
  s.addEventListener('click', (e) => e.stopPropagation());
  s.addEventListener('change', async () => {
    if (await attempt(() => api(`/rides/${r.id}`, { method: 'PATCH', body: { status: s.value } }), 'Updated')) rerender();
  });
  return s;
}

export async function openRideForm(r) {
  const [clients, users] = await Promise.all([api('/clients'), loadUsers()]);
  const drivers = users.filter((u) => u.role === 'driver' && u.active !== 0);
  modal(r.id ? 'Edit ride' : 'Add ride', h('div', {},
    h('div', { class: 'form-grid' },
      field('Date', input('ride_date', { type: 'date', value: r.ride_date || todayIso(), required: true }), { required: true }),
      field('Time', input('scheduled_time', { type: 'time', value: r.scheduled_time, required: true }), { required: true }),
      field('Client', select('client_id', clients.filter((c) => c.status === 'active' || c.id === r.client_id).map((c) => [c.id, `${c.last_name}, ${c.first_name}`]), { value: r.client_id, required: true, blank: 'Choose…' }), { required: true }),
      field('Direction', select('direction', [['pickup', 'Pick up'], ['dropoff', 'Drop off']], { value: r.direction || 'pickup' })),
      field('Driver', select('driver_id', drivers.map((d) => [d.id, d.name]), { value: r.driver_id, blank: 'Unassigned' })),
      field('Status', select('status', RIDE_STATUSES, { value: r.status || 'scheduled' }))),
    field('From', input('from_address', { value: r.from_address })),
    field('To', input('to_address', { value: r.to_address ?? 'Center' })),
    field('Notes', input('notes', { value: r.notes, placeholder: 'Car seat, gate code, call on arrival…' })),
    r.id && h('button', {
      type: 'button', class: 'btn danger small',
      onclick: async () => {
        if (!await confirmDialog('Delete this ride? This cannot be undone.', { confirmLabel: 'Delete ride' })) return;
        if (await attempt(() => api(`/rides/${r.id}`, { method: 'DELETE' }), 'Ride deleted')) { document.querySelector('.modal-backdrop')?.remove(); rerender(); }
      },
    }, 'Delete ride')),
  {
    onSubmit: async (form) => {
      const v = formValues(form);
      if (r.id) await api(`/rides/${r.id}`, { method: 'PATCH', body: v });
      else await api('/rides', { method: 'POST', body: v });
      toast('Saved');
      rerender();
      return true;
    },
  });
}

export async function transportView(el, _, query) {
  const day = query.date || todayIso();
  const rides = await api(`/rides?date=${day}`);
  const manage = can('transport.manage');
  const driverView = can('transport.view_own');
  const go = (d) => { location.hash = `#/transport?date=${d}`; };
  const datePick = h('input', { type: 'date', value: day, 'aria-label': 'Date', onchange: (e) => go(e.target.value) });
  const nav = h('div', { class: 'row nowrap' },
    h('button', { class: 'btn small', onclick: () => go(shiftDate(day, -1)) }, '←'), datePick,
    h('button', { class: 'btn small', onclick: () => go(shiftDate(day, 1)) }, '→'),
    day !== todayIso() && h('button', { class: 'btn small', onclick: () => go(todayIso()) }, 'Today'));

  const rideCard = (r) => h('div', { class: `ride ${r.status}` },
    h('div', { class: 'row' }, h('span', { class: 'time' }, fmtTime(r.scheduled_time)), h('span', {}, r.direction === 'pickup' ? 'Pick up' : 'Drop off'),
      h('span', { class: 'spacer' }), manage || driverView ? rideStatusSelect(r) : badge(r.status)),
    h('div', {}, h('strong', {}, r.client_name)),
    h('div', { class: 'small muted' }, `${r.from_address || '?'} → ${r.to_address || '?'}`),
    (driverView || manage) && r.guardian_phone && h('div', { class: 'small' }, `${r.guardian_name || 'Guardian'}: `, h('a', { href: `tel:${r.guardian_phone}` }, r.guardian_phone)),
    r.notes && h('div', { class: 'small' }, `📝 ${r.notes}`),
    manage && h('div', { class: 'row end' }, h('button', { class: 'btn small', onclick: () => openRideForm(r) }, 'Edit')));

  let body;
  if (manage) {
    const groups = new Map([['', { name: 'Unassigned', rides: [] }]]);
    const users = await loadUsers();
    for (const d of users.filter((u) => u.role === 'driver' && u.active !== 0)) groups.set(String(d.id), { name: d.name, rides: [] });
    for (const r of rides) {
      const k = r.driver_id ? String(r.driver_id) : '';
      if (!groups.has(k)) groups.set(k, { name: r.driver_name, rides: [] });
      groups.get(k).rides.push(r);
    }
    body = h('div', { class: 'board' }, [...groups.entries()].filter(([k, g]) => k !== '' || g.rides.length).map(([, g]) => h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, g.name), h('span', { class: 'muted small' }, plural(g.rides.filter((r) => r.status !== 'cancelled').length, 'ride'))),
      g.rides.length ? g.rides.map(rideCard) : empty('No rides.'))));
  } else {
    body = h('div', { class: 'card' }, rides.length ? rides.map(rideCard) : empty('No rides for this day.'));
  }

  const copy = manage && h('button', {
    class: 'btn',
    onclick: () => modal('Copy a day\'s schedule', h('div', {},
      h('p', { class: 'muted small' }, `Copies every non-cancelled ride from the chosen day onto ${fmtDate(day)} as "scheduled".`),
      field('Copy from', input('from_date', { type: 'date', value: shiftDate(day, -7), required: true }))), {
      submitLabel: 'Copy',
      onSubmit: async (form) => {
        const from = form.from_date.value;
        let r;
        try {
          r = await api('/rides/copy', { method: 'POST', body: { from_date: from, to_date: day } });
        } catch (e) {
          if (!/already has/.test(e.message) || !await confirmDialog(e.message, { confirmLabel: 'Copy anyway', danger: false })) throw e;
          r = await api('/rides/copy', { method: 'POST', body: { from_date: from, to_date: day, append: true } });
        }
        toast(`Copied ${r.copied} ride(s)`);
        rerender();
        return true;
      },
    }),
  }, 'Copy from another day');

  mount(el,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, driverView ? 'My rides' : 'Transportation'), h('div', { class: 'muted' }, fmtDate(day))),
      h('div', { class: 'row' }, nav, copy, manage && h('button', { class: 'btn primary', onclick: () => openRideForm({ ride_date: day }) }, '+ Add ride'))),
    body);
}

// ================= billing =================
export async function billingView(el, _, query) {
  const billed = query.tab === 'billed';
  const rows = await api(`/billing${billed ? '?status=billed' : ''}`);
  const mark = can('billing.mark') && !billed;
  const selected = new Set();
  const noAuth = rows.filter((r) => !r.authorization_id).length;
  const markBtn = h('button', {
    class: 'btn primary', disabled: true,
    onclick: async () => {
      const r = await attempt(() => api('/billing/mark', { method: 'POST', body: { note_ids: [...selected] } }));
      if (r) { toast(`Marked ${r.marked} as billed`); rerender(); }
    },
  }, 'Mark selected as billed');
  const sync = () => { markBtn.disabled = !selected.size; markBtn.textContent = `Mark ${selected.size || ''} selected as billed`; };
  const csvCols = [
    { key: 'session_date', label: 'Date of service' }, { key: 'client_name', label: 'Client' }, { key: 'dob', label: 'DOB' },
    { key: 'payer', label: 'Payer' }, { key: 'auth_number', label: 'Auth #' }, { key: 'service_code', label: 'Code' },
    { key: 'units', label: 'Units' }, { key: 'provider_name', label: 'Provider' }, { key: 'start_time', label: 'Start' }, { key: 'end_time', label: 'End' },
  ];
  mount(el,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Billing queue'), h('div', { class: 'muted' }, 'Approved session notes. Billing sees service details only, never note content.')),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => downloadCsv(`billing-${billed ? 'billed' : 'unbilled'}-${todayIso()}.csv`, rows, csvCols) }, 'Export CSV'),
        mark && markBtn)),
    h('div', { class: 'tabs' },
      h('a', { href: '#/billing', class: billed ? '' : 'active' }, 'Ready to bill'),
      h('a', { href: '#/billing?tab=billed', class: billed ? 'active' : '' }, 'Billed')),
    noAuth > 0 && !billed && h('div', { class: 'banner warn' }, `${noAuth} note(s) have no matching authorization. Check with the insurance team before billing.`),
    h('div', { class: 'card flush' }, table([
      mark && { label: h('input', { type: 'checkbox', 'aria-label': 'Select all', onchange: (e) => {
        el.querySelectorAll('input[data-note]').forEach((cb) => { cb.checked = e.target.checked; cb.dispatchEvent(new Event('change')); });
      } }), render: (r) => h('input', { type: 'checkbox', 'data-note': r.id, 'aria-label': 'Select', onchange: (e) => { if (e.target.checked) selected.add(r.id); else selected.delete(r.id); sync(); } }) },
      { label: 'Date', render: (r) => fmtDate(r.session_date) },
      { label: 'Client', render: (r) => [r.client_name, h('div', { class: 'muted small' }, r.payer || 'No payer on file')] },
      { label: 'Code', key: 'service_code' },
      { label: 'Units', key: 'units' },
      { label: 'Provider', key: 'provider_name' },
      { label: 'Auth', render: (r) => (r.authorization_id ? r.auth_number || 'On file' : badge('high', 'None')) },
      billed && { label: 'Billed', render: (r) => fmtDate(r.billed_at) },
    ].filter(Boolean), rows, { emptyText: billed ? 'Nothing billed yet.' : 'Nothing waiting to be billed.' })));
}
