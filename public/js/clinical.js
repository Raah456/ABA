import {
  state, h, mount, api, can, roleLabel, deptOfRole, attempt, rerender, modal, field, input, textarea, select, checkbox,
  formValues, fmtDate, fmtDateTime, fmtTime, age, todayIso, shiftDate, badge, empty, table, usageBar, lineChart,
  listOptions, loadUsers, toast,
} from './lib.js';
import { openRideForm, rideStatusSelect, openPolicyForm, openCheckForm, openAuthForm } from './admin.js';
import { openReportForm } from './comms.js';

const MEASUREMENT_LABELS = { percent: '% correct', frequency: 'Frequency (count)', duration: 'Duration (minutes)', rating: 'Rating / prompt level' };
const STATUS_LABELS = { baseline: 'Baseline', active: 'Active', on_hold: 'On hold', mastered: 'Mastered', discontinued: 'Discontinued' };

// ================= clients =================
export async function clientsView(el) {
  const clients = await api('/clients');
  const search = h('input', { type: 'search', placeholder: 'Search clients…', 'aria-label': 'Search clients' });
  const body = h('div');
  const draw = () => {
    const q = search.value.toLowerCase();
    const rows = clients.filter((c) => `${c.first_name} ${c.last_name} ${c.guardian_name || ''}`.toLowerCase().includes(q));
    mount(body, table([
      { label: 'Client', render: (c) => h('strong', {}, `${c.last_name}, ${c.first_name}`) },
      { label: 'Age', render: (c) => age(c.dob) },
      { label: 'Guardian', render: (c) => [c.guardian_name || '—', c.guardian_phone ? h('div', { class: 'muted small' }, c.guardian_phone) : null] },
      { label: 'Status', render: (c) => badge(c.status) },
    ], rows, { onRow: (c) => { location.hash = `#/clients/${c.id}`; }, emptyText: clients.length ? 'No matches.' : 'No clients yet.' }));
  };
  search.addEventListener('input', draw);
  draw();
  mount(el,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Clients'), h('div', { class: 'muted' }, can('clients.view_basic') ? `${clients.length} total` : 'Clients you are assigned to')),
      can('clients.edit_basic') && h('button', { class: 'btn primary', onclick: () => openClientForm() }, '+ Add client')),
    h('div', { class: 'card' }, search),
    h('div', { class: 'card flush' }, body));
}

function openClientForm(c = {}) {
  modal(c.id ? 'Edit client' : 'Add client', h('div', {},
    h('div', { class: 'form-grid' },
      field('First name', input('first_name', { value: c.first_name, required: true }), { required: true }),
      field('Last name', input('last_name', { value: c.last_name, required: true }), { required: true }),
      field('Date of birth', input('dob', { type: 'date', value: c.dob })),
      field('Status', select('status', [['active', 'Active'], ['waitlist', 'Waitlist'], ['discharged', 'Discharged']], { value: c.status || 'active' }))),
    h('div', { class: 'form-grid' },
      field('Guardian', input('guardian_name', { value: c.guardian_name })),
      field('Guardian phone', input('guardian_phone', { value: c.guardian_phone }))),
    field('Home address', input('address', { value: c.address }))),
  {
    onSubmit: async (form) => {
      const v = formValues(form);
      if (c.id) await api(`/clients/${c.id}`, { method: 'PATCH', body: v });
      else { const r = await api('/clients', { method: 'POST', body: v }); location.hash = `#/clients/${r.id}`; }
      toast('Saved');
      rerender();
      return true;
    },
  });
}

export async function clientView(el, [clientId, tab = 'overview']) {
  const { client, team, sections } = await api(`/clients/${clientId}`);
  const tabs = [
    ['overview', 'Overview', true],
    ['log', 'Client log', sections.clinical],
    ['programs', 'Programs', sections.clinical],
    ['notes', 'Session notes', sections.clinical],
    ['insurance', sections.insurance ? 'Insurance' : 'Authorizations', sections.insuranceSummary],
    ['transport', 'Transportation', sections.transport],
  ].filter((t) => t[2]);
  if (!tabs.some((t) => t[0] === tab)) tab = 'overview';
  const body = h('div');
  mount(el,
    h('div', { class: 'page-head' },
      h('div', {},
        h('div', { class: 'small' }, h('a', { href: '#/clients' }, '← Clients')),
        h('h1', {}, `${client.first_name} ${client.last_name}`),
        h('div', { class: 'row muted small' }, client.dob && h('span', {}, `${age(client.dob)} · DOB ${fmtDate(client.dob)}`), badge(client.status))),
      h('div', { class: 'row' },
        sections.clinicalWrite && h('a', { class: 'btn', href: `#/clients/${clientId}/log` }, 'Log observation'),
        h('button', { class: 'btn', onclick: () => openReportForm({ client_id: client.id }) }, 'Report up'))),
    h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([k, label]) => h('a', { href: `#/clients/${clientId}/${k}`, class: k === tab ? 'active' : '' }, label))),
    body);
  const views = { overview: overviewTab, log: logTab, programs: programsTab, notes: clientNotesTab, insurance: insuranceTab, transport: transportTab };
  await views[tab](body, client, team, sections);
}

function overviewTab(el, client, team, sections) {
  mount(el, h('div', { class: 'grid' },
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Details'), sections.editBasic && h('button', { class: 'btn small', onclick: () => openClientForm(client) }, 'Edit')),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Guardian'), h('dd', {}, client.guardian_name || '—'),
        h('dt', {}, 'Phone'), h('dd', {}, client.guardian_phone || '—'),
        h('dt', {}, 'Address'), h('dd', {}, client.address || '—'),
        h('dt', {}, 'Status'), h('dd', {}, badge(client.status)))),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Care team'), sections.manageTeam && h('button', { class: 'btn small', onclick: () => openTeamForm(client, team) }, 'Edit team')),
      team.length ? team.map((u) => h('div', { class: 'list-item row' }, h('span', {}, u.name), h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, roleLabel(u.role))))
        : empty('No one assigned yet.'))));
}

async function openTeamForm(client, team) {
  const users = (await loadUsers(true)).filter((u) => u.active !== 0 && deptOfRole(u.role) === 'clinical');
  const onTeam = new Set(team.map((u) => u.id));
  modal(`Care team for ${client.first_name}`, h('div', {},
    h('p', { class: 'muted small' }, 'Technicians only see clinical records for clients they are on the team for.'),
    users.map((u) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'user_ids', value: u.id, 'data-multi': '1', checked: onTeam.has(u.id) }), `${u.name} — ${roleLabel(u.role)}`))),
  {
    onSubmit: async (form) => {
      await api(`/clients/${client.id}/team`, { method: 'PUT', body: { user_ids: formValues(form).user_ids || [] } });
      toast('Team updated');
      rerender();
      return true;
    },
  });
}

// ---------- client log ----------
async function logTab(el, client, team, sections) {
  const rows = await api(`/clients/${client.id}/observations`);
  const cats = listOptions('observation_categories');
  const filter = select('filter', [['', 'All categories'], ...cats.map((c) => [c.value, c.label])], { class: 'inline-select' });
  const list = h('ul', { class: 'timeline' });
  const draw = () => mount(list, rows.filter((o) => !filter.value || o.category === filter.value).map((o) => h('li', { class: o.severity },
    h('div', { class: 'row' }, badge(o.severity), h('strong', {}, o.category),
      o.escalation_id && h('a', { href: `#/reports/${o.escalation_id}`, class: 'small' }, `Escalated · ${o.escalation_status}`)),
    h('div', { class: 'pre' }, o.body),
    h('div', { class: 'meta muted small' }, `${o.author_name} (${roleLabel(o.author_role)}) · ${fmtDateTime(o.at)}`))));
  filter.addEventListener('change', draw);
  draw();

  let form = null;
  if (sections.clinicalWrite) {
    form = h('form', {
      class: 'card',
      onsubmit: async (e) => {
        e.preventDefault();
        const v = formValues(form);
        const r = await attempt(() => api(`/clients/${client.id}/observations`, { method: 'POST', body: v }));
        if (r) {
          toast(r.escalation_id ? 'Logged and sent to your QSP' : 'Logged');
          rerender();
        }
      },
    },
    h('h2', {}, 'Log an observation'),
    h('p', { class: 'muted small' }, 'Anything you notice about this client goes here so the whole team sees the same thing.'),
    h('div', { class: 'form-grid' },
      field('Category', select('category', cats.map((c) => [c.value, c.label]), { required: true }), { required: true }),
      field('Severity', h('div', { class: 'seg' }, ['info', 'concern', 'urgent'].map((s) => h('label', {}, h('input', { type: 'radio', name: 'severity', value: s, checked: s === 'info' }), s[0].toUpperCase() + s.slice(1)))))),
    field('What did you notice?', textarea('body', { required: true, rows: 3 }), { required: true }),
    checkbox('escalate', 'Also send this up to the QSP as a report (urgent always does)'),
    h('button', { class: 'btn primary', type: 'submit' }, 'Add to log'));
  }
  mount(el, form, h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, `Log (${rows.length})`), filter), rows.length ? list : empty('Nothing logged yet.')));
}

// ---------- programs ----------
async function programsTab(el, client, team, sections) {
  const programs = await api(`/clients/${client.id}/programs`);
  mount(el,
    h('div', { class: 'row', }, h('span', { class: 'spacer' }),
      sections.manageprograms && h('button', { class: 'btn primary', onclick: () => openProgramForm({ client_id: client.id }) }, '+ Add program')),
    h('div', { class: 'grid' }, programs.length ? programs.map((p) => {
      const unit = p.measurement === 'percent' ? '%' : '';
      const last = p.recent[p.recent.length - 1];
      return h('a', { class: 'card', href: `#/programs/${p.id}` },
        h('div', { class: 'row' }, h('strong', {}, p.name), h('span', { class: 'spacer' }), badge(p.status, STATUS_LABELS[p.status])),
        h('div', { class: 'muted small' }, [p.domain, MEASUREMENT_LABELS[p.measurement]].filter(Boolean).join(' · ')),
        lineChart(p.recent.map((d) => ({ date: d.session_date, value: d.value })), { spark: true, width: 300, height: 50, criterion: p.mastery_value, max: p.measurement === 'percent' ? 100 : null }),
        h('div', { class: 'row small' },
          last ? h('span', {}, `Last: ${Math.round(last.value * 10) / 10}${unit} on ${fmtDate(last.session_date)}`) : h('span', { class: 'muted' }, 'No data yet'),
          h('span', { class: 'spacer' }),
          p.mastery.met && p.status === 'active' && badge('mastered', 'Criteria met')));
    }) : [empty('No programs yet.')]));
}

function openProgramForm(p) {
  const editing = !!p.id;
  const domains = listOptions('program_domains').map((d) => [d.value, d.label]);
  modal(editing ? 'Edit program' : 'Add program', h('div', {},
    field('Program name', input('name', { value: p.name, required: true }), { required: true }),
    h('div', { class: 'form-grid' },
      field('Domain', select('domain', domains, { value: p.domain, blank: '—' })),
      field('Measurement', select('measurement', Object.entries(MEASUREMENT_LABELS), { value: p.measurement || 'percent', required: true }), { required: true }),
      editing && field('Status', select('status', Object.entries(STATUS_LABELS), { value: p.status }))),
    field('Goal', textarea('goal', { value: p.goal, rows: 2 })),
    field('Targets', textarea('targets', { value: (p.targets || []).join('\n'), rows: 3 }), { help: 'one per line' }),
    h('div', { class: 'form-grid' },
      field('Mastery criterion', input('mastery_value', { type: 'number', value: p.mastery_value, step: 'any', min: 0 }), { help: 'e.g. 80' }),
      field('Across sessions', input('mastery_sessions', { type: 'number', value: p.mastery_sessions ?? 3, min: 1 })),
      field('Direction', select('mastery_direction', [['at_least', 'At or above (skill)'], ['at_most', 'At or below (reduce behavior)']], { value: p.mastery_direction }))),
    field('Instructions for staff', textarea('instructions', { value: p.instructions, rows: 4 })),
    field(editing ? 'Why the change?' : 'Notes', textarea('reason', { rows: 2 }), { help: 'shown to the whole team in the change history' })),
  {
    wide: true,
    onSubmit: async (form) => {
      const v = formValues(form);
      v.targets = v.targets.split('\n').map((s) => s.trim()).filter(Boolean);
      if (editing) {
        const r = await api(`/programs/${p.id}`, { method: 'PATCH', body: v });
        toast(r.changed ? 'Program updated — change logged for the team' : 'No changes');
      } else {
        const r = await api(`/clients/${p.client_id}/programs`, { method: 'POST', body: v });
        location.hash = `#/programs/${r.id}`;
      }
      rerender();
      return true;
    },
  });
}

export async function programView(el, [programId]) {
  const { program: p, data, changes, mastery } = await api(`/programs/${programId}`);
  const { client, sections } = await api(`/clients/${p.client_id}`);
  const unit = p.measurement === 'percent' ? '%' : '';
  const mine = state.me.user.id;

  const entry = sections.clinicalWrite && h('form', {
    class: 'card',
    onsubmit: async (e) => {
      e.preventDefault();
      if (await attempt(() => api(`/programs/${p.id}/data`, { method: 'POST', body: formValues(entry) }), 'Data saved')) rerender();
    },
  },
  h('h2', {}, 'Record data'),
  h('div', { class: 'form-grid' },
    field('Session date', input('session_date', { type: 'date', value: todayIso(), required: true }), { required: true }),
    p.targets.length > 0 && field('Target', select('target', p.targets, { blank: '—' })),
    ...(p.measurement === 'percent'
      ? [field('Correct', input('correct', { type: 'number', min: 0, required: true }), { required: true }),
        field('Total trials', input('total', { type: 'number', min: 1, value: 10, required: true }), { required: true })]
      : [field(MEASUREMENT_LABELS[p.measurement], input('value', { type: 'number', min: 0, step: 'any', required: true }), { required: true })])),
  field('Note', input('note')),
  h('button', { class: 'btn primary', type: 'submit' }, 'Save'));

  const recent = [...data].reverse();
  mount(el,
    h('div', { class: 'page-head' },
      h('div', {},
        h('div', { class: 'small' }, h('a', { href: `#/clients/${client.id}/programs` }, `← ${client.first_name} ${client.last_name}`)),
        h('h1', {}, p.name),
        h('div', { class: 'row muted small' }, badge(p.status, STATUS_LABELS[p.status]), h('span', {}, [p.domain, MEASUREMENT_LABELS[p.measurement]].filter(Boolean).join(' · ')))),
      sections.manageprograms && h('button', { class: 'btn', onclick: () => openProgramForm(p) }, 'Edit program')),
    mastery.met && p.status === 'active' && h('div', { class: 'banner info' },
      `Mastery criterion met (${p.mastery_direction === 'at_most' ? '≤' : '≥'} ${p.mastery_value}${unit} for ${p.mastery_sessions} sessions). QSP: review and update the status.`),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Progress'), p.mastery_value != null && h('span', { class: 'muted small' }, `Dashed line = mastery criterion (${p.mastery_value}${unit})`)),
      lineChart(data.map((d) => ({ date: d.session_date, value: d.value })), { criterion: p.mastery_value, max: p.measurement === 'percent' ? 100 : null, unit })),
    h('div', { class: 'grid' },
      h('div', {}, entry,
        h('div', { class: 'card' }, h('h2', {}, 'Program details'),
          h('dl', { class: 'kv' },
            h('dt', {}, 'Goal'), h('dd', { class: 'pre' }, p.goal || '—'),
            h('dt', {}, 'Targets'), h('dd', {}, p.targets.length ? h('div', { class: 'chips' }, p.targets.map((t) => h('span', { class: 'chip' }, t))) : '—'),
            h('dt', {}, 'Mastery'), h('dd', {}, p.mastery_value != null ? `${p.mastery_direction === 'at_most' ? '≤' : '≥'} ${p.mastery_value}${unit} across ${p.mastery_sessions} sessions` : '—'),
            h('dt', {}, 'Instructions'), h('dd', { class: 'pre' }, p.instructions || '—')))),
      h('div', {},
        h('div', { class: 'card' }, h('h2', {}, 'Change history'),
          h('p', { class: 'muted small' }, 'Every change to this program, who made it and why — so everyone works from the same version.'),
          h('ul', { class: 'timeline' }, changes.map((c) => h('li', { class: 'status' },
            h('div', {}, c.summary), c.reason && h('div', { class: 'small pre' }, `“${c.reason}”`),
            h('div', { class: 'muted small' }, `${c.changed_by_name} · ${fmtDateTime(c.at)}`))))),
        h('div', { class: 'card flush' }, table([
          { label: 'Date', render: (d) => fmtDate(d.session_date) },
          { label: 'Target', render: (d) => d.target || '—' },
          { label: 'Value', render: (d) => (d.total != null ? `${d.correct}/${d.total} (${d.value}%)` : `${d.value}`) },
          { label: 'By', render: (d) => [d.recorded_by_name, d.note && h('div', { class: 'muted small' }, d.note)] },
          { label: '', render: (d) => sections.clinicalWrite && (d.recorded_by === mine || can('programs.manage')) && h('button', {
            class: 'btn small danger',
            onclick: async (e) => { e.stopPropagation(); if (confirm('Remove this data point?') && await attempt(() => api(`/program-data/${d.id}`, { method: 'DELETE' }), 'Removed')) rerender(); },
          }, 'Remove') },
        ], recent.slice(0, 50), { emptyText: 'No data recorded yet.' })))));
}

// ---------- client notes / insurance / transport tabs ----------
async function clientNotesTab(el, client, team, sections) {
  const notes = await api(`/notes?client_id=${client.id}`);
  mount(el,
    h('div', { class: 'row' }, h('span', { class: 'spacer' }), sections.clinicalWrite && h('a', { class: 'btn primary', href: `#/notes/new?client=${client.id}` }, '+ Session note')),
    h('div', { class: 'card flush' }, notesTable(notes)));
}

function notesTable(notes, { showClient = true } = {}) {
  return table([
    { label: 'Date', render: (n) => fmtDate(n.session_date) },
    showClient && { label: 'Client', key: 'client_name' },
    { label: 'Staff', key: 'author_name' },
    { label: 'Service', render: (n) => [n.service_code, h('div', { class: 'muted small' }, `${fmtTime(n.start_time)}–${fmtTime(n.end_time)}`)] },
    { label: 'Units', key: 'units' },
    { label: 'Status', render: (n) => [badge(n.status), n.status === 'returned' && n.review_comment && h('div', { class: 'muted small' }, n.review_comment)] },
  ].filter(Boolean), notes, { onRow: (n) => { location.hash = `#/notes/${n.id}`; }, emptyText: 'No session notes.' });
}

async function insuranceTab(el, client, team, sections) {
  const d = await api(`/clients/${client.id}/insurance`);
  const authCols = [
    { label: 'Service', key: 'service_code' },
    { label: 'Dates', render: (a) => `${fmtDate(a.start_date)} – ${fmtDate(a.end_date)}` },
    { label: 'Used', render: (a) => [h('div', { class: 'small' }, `${a.units_used} of ${a.units_approved} units${a.units_pending ? ` (+${a.units_pending} pending)` : ''}`), usageBar(a.pct_used)] },
    { label: 'Remaining', render: (a) => `${a.units_remaining} units (${Math.round(a.units_remaining / 4)} hrs)` },
    { label: '', render: (a) => (a.expired ? badge('discontinued', 'Expired') : a.alert ? badge('high', a.alert_reasons.join(', ')) : a.current ? badge('active', 'Current') : badge('scheduled', 'Upcoming')) },
  ];
  if (d.summaryOnly) {
    mount(el, h('div', { class: 'card flush' }, h('div', { class: 'card-head' }), table(authCols, d.authorizations, { emptyText: 'No authorizations on file.' })));
    return;
  }
  const edit = sections.insuranceEdit;
  mount(el,
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Insurance policies'), edit && h('button', { class: 'btn small', onclick: () => openPolicyForm({ client_id: client.id }) }, '+ Add policy')),
      table([
        { label: 'Payer', render: (p) => [h('strong', {}, p.payer), h('div', { class: 'muted small' }, p.priority)] },
        { label: 'Member ID', render: (p) => p.member_id || '—' },
        { label: 'Last check', render: (p) => (p.last_checked_at ? [badge(p.last_result), h('div', { class: 'muted small' }, `${fmtDate(p.last_checked_at)} · ${p.last_checked_by}`)] : h('span', { class: 'muted' }, 'Never')) },
        { label: 'Next due', render: (p) => (p.active ? [fmtDate(p.next_check), p.due && h('div', {}, badge('high', 'Due'))] : badge('discontinued', 'Inactive')) },
        { label: '', render: (p) => edit && h('div', { class: 'row' },
          p.active ? h('button', { class: 'btn small primary', onclick: () => openCheckForm(p) }, 'Log check') : null,
          h('button', { class: 'btn small', onclick: () => openPolicyForm(p) }, 'Edit')) },
      ], d.policies, { emptyText: 'No insurance on file.' })),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Authorizations'), edit && h('button', { class: 'btn small', onclick: () => openAuthForm({ client_id: client.id }, d.policies) }, '+ Add authorization')),
      table([{ label: 'Auth #', render: (a) => a.auth_number || '—' }, ...authCols,
        { label: '', render: (a) => edit && h('button', { class: 'btn small', onclick: () => openAuthForm(a, d.policies) }, 'Edit') }], d.authorizations, { emptyText: 'No authorizations on file.' })),
    h('div', { class: 'card' }, h('h2', {}, 'Eligibility check history'),
      table([
        { label: 'Checked', render: (c) => fmtDateTime(c.checked_at) },
        { label: 'Payer', key: 'payer' },
        { label: 'Result', render: (c) => badge(c.result) },
        { label: 'Notes', render: (c) => c.notes || '—' },
        { label: 'By', key: 'checked_by_name' },
      ], d.checks, { emptyText: 'No checks logged yet.' })));
}

async function transportTab(el, client) {
  const from = todayIso();
  const rides = await api(`/rides?from=${from}&to=${shiftDate(from, 14)}&client_id=${client.id}`);
  const manage = can('transport.manage');
  mount(el,
    h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Next 14 days'), h('span', { class: 'spacer' }),
      manage && h('button', { class: 'btn primary', onclick: () => openRideForm({ client_id: client.id, ride_date: from, from_address: client.address }) }, '+ Add ride')),
    h('div', { class: 'card flush' }, table([
      { label: 'Date', render: (r) => fmtDate(r.ride_date) },
      { label: 'Time', render: (r) => fmtTime(r.scheduled_time) },
      { label: 'Ride', render: (r) => [r.direction === 'pickup' ? 'Pick up' : 'Drop off', h('div', { class: 'muted small' }, `${r.from_address || '?'} → ${r.to_address || '?'}`)] },
      { label: 'Driver', render: (r) => r.driver_name || h('span', { class: 'badge warn' }, 'Unassigned') },
      { label: 'Status', render: (r) => (manage ? rideStatusSelect(r) : badge(r.status)) },
    ], rides, { onRow: manage ? (r) => openRideForm(r) : null, emptyText: 'No rides scheduled.' })));
}

// ================= session notes =================
export async function notesView(el, _, query) {
  const tabs = [['mine', 'My notes', can('clinical.write')], ['review', 'Review queue', can('notes.approve')], ['all', 'All notes', can('clinical.view_all')]].filter((t) => t[2]);
  const tab = tabs.some((t) => t[0] === query.tab) ? query.tab : tabs[0][0];
  const qs = { mine: '?mine=1', review: '?status=submitted&review=1', all: '' }[tab];
  const notes = await api(`/notes${qs}`);
  mount(el,
    h('div', { class: 'page-head' }, h('h1', {}, 'Session notes'), can('clinical.write') && h('a', { class: 'btn primary', href: '#/notes/new' }, '+ Session note')),
    h('div', { class: 'tabs' }, tabs.map(([k, l]) => h('a', { href: `#/notes?tab=${k}`, class: k === tab ? 'active' : '' }, l))),
    tab === 'review' && h('p', { class: 'muted' }, 'Submitted notes from your team, oldest first. Approving sends the date, code and units (never the note text) to billing and counts the units against the authorization.'),
    h('div', { class: 'card flush' }, notesTable(tab === 'review' ? [...notes].reverse() : notes)));
}

function renderNoteField(f, value) {
  const name = `v_${f.key}`;
  const req = f.required;
  let control;
  switch (f.type) {
    case 'textarea': control = textarea(name, { value, rows: 3 }); break;
    case 'number': control = input(name, { type: 'number', value, step: 'any' }); break;
    case 'select': control = select(name, f.options, { value, blank: '—' }); break;
    case 'checkbox': return h('div', { class: 'note-field' }, checkbox(name, f.label, !!value));
    case 'time': control = input(name, { type: 'time', value }); break;
    case 'date': control = input(name, { type: 'date', value }); break;
    default: control = input(name, { value });
  }
  return field(f.label, control, { required: req, help: f.help });
}

function readNoteValues(form, fields) {
  const v = formValues(form);
  const values = {};
  for (const f of fields) values[f.key] = v[`v_${f.key}`];
  return { session_date: v.session_date, start_time: v.start_time, end_time: v.end_time, service_code: v.service_code, values };
}

function unitsPreview(form, out) {
  const calc = () => {
    const [s, e] = [form.start_time.value, form.end_time.value];
    if (!s || !e) { out.textContent = ''; return; }
    const m = (Number(e.slice(0, 2)) * 60 + Number(e.slice(3))) - (Number(s.slice(0, 2)) * 60 + Number(s.slice(3)));
    out.textContent = m > 0 ? `${m} min · ${Math.floor(m / 15) + (m % 15 >= 8 ? 1 : 0)} billable units` : 'End must be after start';
  };
  form.addEventListener('input', calc);
  calc();
}

function noteForm({ fields, note = {}, defaultCode, onSave }) {
  const codes = listOptions('service_codes').map((c) => [c.value, c.label]);
  const units = h('span', { class: 'muted small' });
  const form = h('form', { class: 'card', onsubmit: (e) => e.preventDefault() },
    h('div', { class: 'form-grid' },
      field('Session date', input('session_date', { type: 'date', value: note.session_date || todayIso(), required: true }), { required: true }),
      field('Start', input('start_time', { type: 'time', value: note.start_time, required: true }), { required: true }),
      field('End', input('end_time', { type: 'time', value: note.end_time, required: true }), { required: true }),
      field('Service code', select('service_code', codes, { value: note.service_code || defaultCode, required: true }), { required: true })),
    h('div', { class: 'row' }, units),
    h('hr', { class: 'muted' }),
    fields.map((f) => renderNoteField(f, note.values?.[f.key])),
    h('div', { class: 'row end' },
      h('button', { type: 'button', class: 'btn', onclick: () => onSave(readNoteValues(form, fields), false) }, 'Save draft'),
      h('button', { type: 'button', class: 'btn primary', onclick: () => { if (form.reportValidity()) onSave(readNoteValues(form, fields), true); } }, 'Submit for review')));
  unitsPreview(form, units);
  return form;
}

export async function newNoteView(el, _, query) {
  const [clients, templates] = await Promise.all([api('/clients'), api('/templates')]);
  const active = clients.filter((c) => c.status === 'active');
  const clientSel = select('client', active.map((c) => [c.id, `${c.last_name}, ${c.first_name}`]), { value: query.client, blank: 'Choose client…' });
  const tplSel = select('template', templates.map((t) => [t.id, t.name]), { value: templates.length === 1 ? templates[0].id : query.template, blank: 'Choose template…' });
  const body = h('div');
  const draw = () => {
    const t = templates.find((x) => String(x.id) === tplSel.value);
    if (!clientSel.value || !t) { mount(body, empty('Choose a client and a note template to start.')); return; }
    mount(body, noteForm({
      fields: t.fields,
      defaultCode: t.service_code,
      onSave: async (v, submit) => {
        const r = await attempt(() => api('/notes', { method: 'POST', body: { ...v, client_id: Number(clientSel.value), template_id: t.id, submit } }),
          submit ? 'Submitted for review' : 'Draft saved');
        if (r) location.hash = `#/notes/${r.id}`;
      },
    }));
  };
  clientSel.addEventListener('change', draw);
  tplSel.addEventListener('change', draw);
  draw();
  mount(el,
    h('div', { class: 'page-head' }, h('div', {}, h('div', { class: 'small' }, h('a', { href: '#/notes' }, '← Session notes')), h('h1', {}, 'New session note'))),
    h('div', { class: 'card form-grid' }, field('Client', clientSel, { required: true }), field('Template', tplSel, { required: true })),
    body);
}

export async function noteView(el, [noteId]) {
  const n = await api(`/notes/${noteId}`);
  const me = state.me.user;
  const editable = n.author_id === me.id && ['draft', 'returned'].includes(n.status);
  const canReview = can('notes.approve') && n.status === 'submitted' && n.author_id !== me.id;

  const head = h('div', { class: 'page-head' },
    h('div', {},
      h('div', { class: 'small' }, h('a', { href: '#/notes' }, '← Session notes')),
      h('h1', {}, `${n.client_name} — ${fmtDate(n.session_date)}`),
      h('div', { class: 'row muted small' }, badge(n.status), h('span', {}, `${n.service_code} · ${fmtTime(n.start_time)}–${fmtTime(n.end_time)} · ${n.units} units · by ${n.author_name}`))),
    h('a', { class: 'btn', href: `#/clients/${n.client_id}/notes` }, 'Client record'));

  const feedback = n.review_comment && h('div', { class: `banner ${n.status === 'returned' ? 'warn' : 'info'}` },
    h('strong', {}, `${n.status === 'returned' ? 'Returned' : 'Reviewed'} by ${n.reviewer_name || 'reviewer'}: `), n.review_comment);

  if (editable) {
    mount(el, head, feedback, noteForm({
      fields: n.fields,
      note: n,
      onSave: async (v, submit) => {
        if (await attempt(() => api(`/notes/${n.id}`, { method: 'PATCH', body: { ...v, submit } }), submit ? 'Submitted for review' : 'Saved')) rerender();
      },
    }));
    return;
  }

  const review = canReview && h('form', { class: 'card', onsubmit: (e) => e.preventDefault() },
    h('h2', {}, 'Review'),
    field('Feedback', textarea('comment', { rows: 2, placeholder: 'Required when returning a note' })),
    h('div', { class: 'row end' },
      h('button', { type: 'button', class: 'btn', onclick: (e) => doReview(e.target.form, 'return') }, 'Return for changes'),
      h('button', { type: 'button', class: 'btn primary', onclick: (e) => doReview(e.target.form, 'approve') }, 'Approve')));

  async function doReview(form, action) {
    const r = await attempt(() => api(`/notes/${n.id}/review`, { method: 'POST', body: { action, comment: form.comment.value } }),
      action === 'approve' ? 'Approved' : 'Returned to author');
    if (r?.warning) toast(r.warning, 'error');
    if (r) location.hash = '#/notes?tab=review';
  }

  mount(el, head, feedback,
    n.status === 'approved' && h('div', { class: 'banner info' }, n.authorization_id ? 'Counted against the client\'s authorization.' : 'No matching authorization was found for this date and code.', n.billed_at ? ` Billed ${fmtDate(n.billed_at)}.` : ''),
    h('div', { class: 'card' }, n.fields.map((f) => {
      const v = n.values[f.key];
      const shown = f.type === 'checkbox' ? (v ? 'Yes' : 'No') : (v == null || v === '' ? '—' : String(v));
      return h('div', { class: 'note-field' }, h('div', { class: 'label' }, f.label), h('div', { class: 'pre' }, shown));
    })),
    review);
}

// ================= note templates =================
export async function templatesView(el) {
  const templates = await api('/templates?all=1');
  mount(el,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Note templates'), h('div', { class: 'muted' }, 'Build the session note forms your team fills out. Changes apply to new notes; existing notes keep the version they were written with.')),
      h('a', { class: 'btn primary', href: '#/templates/new' }, '+ New template')),
    h('div', { class: 'card flush' }, table([
      { label: 'Template', render: (t) => h('strong', {}, t.name) },
      { label: 'Default code', render: (t) => t.service_code || '—' },
      { label: 'Fields', render: (t) => t.fields.length },
      { label: 'Updated', render: (t) => `${fmtDate(t.updated_at)} · ${t.created_by_name || ''}` },
      { label: 'Status', render: (t) => badge(t.active ? 'active' : 'discontinued', t.active ? 'Active' : 'Retired') },
    ], templates, { onRow: (t) => { location.hash = `#/templates/${t.id}`; } })));
}

const FIELD_TYPES = [['text', 'Short text'], ['textarea', 'Paragraph'], ['number', 'Number'], ['select', 'Dropdown'], ['checkbox', 'Checkbox'], ['time', 'Time'], ['date', 'Date']];

export async function templateEditView(el, [tplId]) {
  const isNew = tplId === 'new';
  const t = isNew ? { name: '', service_code: '', fields: [{ label: 'Summary of session', type: 'textarea', required: true }], active: 1 }
    : (await api('/templates?all=1')).find((x) => String(x.id) === tplId);
  if (!t) throw new Error('Template not found.');
  const fields = t.fields.map((f) => ({ ...f, options: (f.options || []).join(', ') }));
  const codes = listOptions('service_codes').map((c) => [c.value, c.label]);
  const list = h('div');
  const preview = h('div');

  const drawPreview = () => mount(preview, fields.filter((f) => f.label).map((f) => renderNoteField({ ...f, options: String(f.options || '').split(',').map((s) => s.trim()).filter(Boolean) }, null)));
  const draw = () => {
    mount(list, fields.map((f, i) => h('div', { class: 'field-row' },
      h('input', { type: 'text', value: f.label, placeholder: 'Field label', 'aria-label': 'Field label', oninput: (e) => { f.label = e.target.value; drawPreview(); } }),
      select('', FIELD_TYPES, { value: f.type }),
      h('input', { type: 'text', value: f.options, placeholder: f.type === 'select' ? 'Options, comma separated' : 'Help text (optional)', 'aria-label': 'Options or help',
        oninput: (e) => { if (f.type === 'select') f.options = e.target.value; else f.help = e.target.value; drawPreview(); } }),
      h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: f.required, onchange: (e) => { f.required = e.target.checked; drawPreview(); } }), 'Required'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn small', 'aria-label': 'Move up', disabled: i === 0, onclick: () => { [fields[i - 1], fields[i]] = [fields[i], fields[i - 1]]; draw(); } }, '↑'),
        h('button', { type: 'button', class: 'btn small danger', 'aria-label': 'Remove field', onclick: () => { fields.splice(i, 1); draw(); } }, '✕')))));
    list.querySelectorAll('.field-row select').forEach((s, i) => s.addEventListener('change', () => { fields[i].type = s.value; draw(); }));
    list.querySelectorAll('.field-row').forEach((row, i) => {
      if (fields[i].type !== 'select') row.children[2].value = fields[i].help || '';
    });
    drawPreview();
  };
  draw();

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const v = formValues(form);
      const body = {
        name: v.name,
        service_code: v.service_code,
        active: v.active,
        fields: fields.map((f) => ({ key: f.key, label: f.label, type: f.type, required: !!f.required, help: f.help || undefined,
          options: f.type === 'select' ? String(f.options).split(',').map((s) => s.trim()).filter(Boolean) : undefined })),
      };
      const r = await attempt(() => (isNew ? api('/templates', { method: 'POST', body }) : api(`/templates/${t.id}`, { method: 'PATCH', body })), 'Template saved');
      if (r) location.hash = '#/templates';
    },
  },
  h('div', { class: 'card' },
    h('div', { class: 'form-grid' },
      field('Template name', input('name', { value: t.name, required: true }), { required: true }),
      field('Default service code', select('service_code', codes, { value: t.service_code, blank: '—' }))),
    !isNew && checkbox('active', 'Active (available for new notes)', !!t.active)),
  h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Fields'), h('button', { type: 'button', class: 'btn small', onclick: () => { fields.push({ label: '', type: 'text', required: false, options: '' }); draw(); } }, '+ Add field')),
    list),
  h('div', { class: 'row end' }, h('a', { class: 'btn', href: '#/templates' }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit' }, 'Save template')));

  mount(el,
    h('div', { class: 'page-head' }, h('div', {}, h('div', { class: 'small' }, h('a', { href: '#/templates' }, '← Templates')), h('h1', {}, isNew ? 'New template' : t.name))),
    h('div', { class: 'split' }, form, h('div', { class: 'card' }, h('h2', {}, 'Preview'), h('p', { class: 'muted small' }, 'What staff will see.'), preview)));
}
