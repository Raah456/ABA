import {
  state, h, mount, api, can, roleLabel, deptOfRole, attempt, rerender, modal, field, input, textarea, select, checkbox,
  formValues, fmtDate, fmtDateTime, fmtTime, age, todayIso, shiftDate, badge, empty, table, usageBar, lineChart,
  listOptions, loadUsers, toast, confirmDialog,
} from './lib.js';
import { openRideForm, rideStatusSelect, openPolicyForm, openCheckForm, openAuthForm } from './admin.js';
import { openReportForm } from './comms.js';
import { draftKey, readDraft, writeDraft, clearDraft, keepScreenOn, canKeepScreenOn, stillWorking } from './device.js';

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

export async function clientView(el, [clientId, tabArg]) {
  const { client, team, sections, alerts } = await api(`/clients/${clientId}`);
  let tab = tabArg || (sections.clinical ? 'profile' : 'overview');
  const tabs = [
    ['profile', 'Profile', sections.clinical],
    ['collect', 'Collect data', sections.clinicalWrite],
    ['overview', 'Details & team', true],
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
    alerts && h('div', { class: 'banner bad alert-banner' }, h('strong', {}, '⚠ Safety & medical: '), h('span', { class: 'pre' }, alerts)),
    h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([k, label]) => h('a', { href: `#/clients/${clientId}/${k}`, class: k === tab ? 'active' : '' }, label))),
    body);
  const views = { profile: profileTab, collect: collectTab, overview: overviewTab, log: logTab, programs: programsTab, notes: clientNotesTab, insurance: insuranceTab, transport: transportTab };
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
        h('div', { class: 'muted small' }, [p.domain, MEASUREMENT_LABELS[p.measurement], p.trials.length && `${p.trials.length} trial${p.trials.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')),
        lineChart(p.recent.map((d) => ({ date: d.session_date, value: d.value })), { spark: true, width: 300, height: 50, criterion: p.mastery_value, max: p.measurement === 'percent' ? 100 : null }),
        h('div', { class: 'row small' },
          last ? h('span', {}, `Last: ${Math.round(last.value * 10) / 10}${unit} on ${fmtDate(last.session_date)}`) : h('span', { class: 'muted' }, 'No data yet'),
          h('span', { class: 'spacer' }),
          p.mastery.met && p.status === 'active' && badge('mastered', 'Criteria met')));
    }) : [empty('No programs yet.')]));
}

// Editable list of trials, each with a name and a description of how to run it.
function trialEditor(initial) {
  const trials = initial.map((t) => ({ ...t }));
  const box = h('div');
  const draw = () => {
    mount(box,
      trials.map((t, i) => h('div', { class: 'trial-edit' },
        h('div', { class: 'row' },
          h('input', { type: 'text', value: t.name, placeholder: `Trial ${i + 1} name (e.g. "Juice")`, 'aria-label': 'Trial name', required: true, oninput: (e) => { t.name = e.target.value; } }),
          h('button', { type: 'button', class: 'btn small danger', 'aria-label': 'Remove trial', onclick: () => { trials.splice(i, 1); draw(); } }, 'Remove')),
        h('textarea', { rows: 2, value: t.description, required: true, 'aria-label': 'Trial description',
          placeholder: 'How to run it: what to present, what to say, what counts as correct', oninput: (e) => { t.description = e.target.value; } }))),
      trials.length === 0 && h('p', { class: 'muted small' }, 'No trials yet. Add the trials staff will run for this program.'),
      h('button', { type: 'button', class: 'btn small', onclick: () => { trials.push({ name: '', description: '' }); draw(); box.querySelector('.trial-edit:last-of-type input')?.focus(); } }, '+ Add trial'));
  };
  draw();
  return { el: box, value: () => trials.map((t) => ({ id: t.id, name: t.name.trim(), description: t.description.trim() })) };
}

function openProgramForm(p, trials = []) {
  const editing = !!p.id;
  const domains = listOptions('program_domains').map((d) => [d.value, d.label]);
  const trialBox = trialEditor(trials.filter((t) => t.active !== 0));
  modal(editing ? 'Edit program' : 'Add program', h('div', {},
    field('Program name', input('name', { value: p.name, required: true }), { required: true }),
    h('div', { class: 'form-grid' },
      field('Domain', select('domain', domains, { value: p.domain, blank: '—' })),
      field('Measurement', select('measurement', Object.entries(MEASUREMENT_LABELS), { value: p.measurement || 'percent', required: true }), { required: true }),
      editing && field('Status', select('status', Object.entries(STATUS_LABELS), { value: p.status }))),
    field('Goal', textarea('goal', { value: p.goal, rows: 2 })),
    h('div', { class: 'field' }, h('span', { class: 'label-text' }, 'Trials'), h('p', { class: 'muted small' }, 'Every trial needs a description so anyone on the team runs it the same way.'), trialBox.el),
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
      v.trials = trialBox.value();
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

const RESULTS = [
  { key: 'correct', label: 'Correct', short: '✓', kind: 'ok', help: 'Independent, no prompt' },
  { key: 'prompted', label: 'Prompted', short: 'P', kind: 'warn', help: 'Correct after a prompt' },
  { key: 'incorrect', label: 'Incorrect', short: '✗', kind: 'bad', help: 'Wrong response' },
  { key: 'no_response', label: 'No response', short: 'NR', kind: '', help: 'No response' },
];
const RESULT = Object.fromEntries(RESULTS.map((r) => [r.key, r]));

function resultChip(result, title) {
  const r = RESULT[result];
  return h('span', { class: `result ${r.kind}`, title: title || r.label }, r.short);
}

// "Juice ✓✓P · iPad ✓✗" for one session's trial-by-trial data.
function trialBreakdown(trials) {
  const byName = new Map();
  for (const t of trials) (byName.get(t.trial_name) || byName.set(t.trial_name, []).get(t.trial_name)).push(t);
  return h('div', { class: 'breakdown' }, [...byName.entries()].map(([name, list]) => h('span', { class: 'breakdown-item' },
    h('span', { class: 'small' }, name), list.map((t) => resultChip(t.result, t.note ? `${RESULT[t.result].label}: ${t.note}` : undefined)))));
}

export async function programView(el, [programId]) {
  const { program: p, trials, data, changes, mastery } = await api(`/programs/${programId}`);
  const { client, sections } = await api(`/clients/${p.client_id}`);
  const unit = p.measurement === 'percent' ? '%' : '';
  const mine = state.me.user.id;
  const active = trials.filter((t) => t.active);
  const retired = trials.filter((t) => !t.active);

  const totalsForm = sections.clinicalWrite && h('form', {
    class: 'stack',
    onsubmit: async (e) => {
      e.preventDefault();
      if (await attempt(() => api(`/programs/${p.id}/data`, { method: 'POST', body: formValues(totalsForm) }), 'Data saved')) rerender();
    },
  },
  h('div', { class: 'form-grid' },
    field('Session date', input('session_date', { type: 'date', value: todayIso(), required: true }), { required: true }),
    ...(p.measurement === 'percent'
      ? [active.length > 0 && field('Trial', select('target', active.map((t) => t.name), { blank: 'All / mixed' })),
        field('Correct', input('correct', { type: 'number', min: 0, required: true }), { required: true }),
        field('Total trials', input('total', { type: 'number', min: 1, value: 10, required: true }), { required: true })]
      : [field(MEASUREMENT_LABELS[p.measurement], input('value', { type: 'number', min: 0, step: 'any', required: true }), { required: true })])),
  field('Note', input('note')),
  h('button', { class: 'btn primary', type: 'submit' }, 'Save'));

  const entry = sections.clinicalWrite && h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Record data'),
      h('a', { class: 'btn primary', href: `#/clients/${client.id}/collect` }, p.measurement === 'percent' ? 'Run trials' : 'Collect session data')),
    p.measurement === 'percent'
      ? h('details', {}, h('summary', { class: 'small' }, 'Or enter totals from a paper data sheet'), totalsForm)
      : totalsForm);

  const trialsCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, `Trials (${active.length})`),
      sections.manageprograms && h('button', { class: 'btn small', onclick: () => openProgramForm(p, trials) }, 'Edit trials')),
    active.length ? h('ol', { class: 'trial-list' }, active.map((t) => h('li', {}, h('strong', {}, t.name), h('div', { class: 'pre small' }, t.description))))
      : empty(p.measurement === 'percent' ? 'No trials yet. A QSP adds them with "Edit trials".' : 'This program is measured as a count or duration, not by trials.'),
    retired.length > 0 && h('p', { class: 'muted small' }, `Retired: ${retired.map((t) => t.name).join(', ')}`));

  const recent = [...data].reverse();
  mount(el,
    h('div', { class: 'page-head' },
      h('div', {},
        h('div', { class: 'small' }, h('a', { href: `#/clients/${client.id}/programs` }, `← ${client.first_name} ${client.last_name}`)),
        h('h1', {}, p.name),
        h('div', { class: 'row muted small' }, badge(p.status, STATUS_LABELS[p.status]), h('span', {}, [p.domain, MEASUREMENT_LABELS[p.measurement]].filter(Boolean).join(' · ')))),
      sections.manageprograms && h('button', { class: 'btn', onclick: () => openProgramForm(p, trials) }, 'Edit program')),
    mastery.met && p.status === 'active' && h('div', { class: 'banner info' },
      `Mastery criterion met (${p.mastery_direction === 'at_most' ? '≤' : '≥'} ${p.mastery_value}${unit} for ${p.mastery_sessions} sessions). QSP: review and update the status.`),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Progress'), p.mastery_value != null && h('span', { class: 'muted small' }, `Dashed line = mastery criterion (${p.mastery_value}${unit})`)),
      lineChart(data.map((d) => ({ date: d.session_date, value: d.value })), { criterion: p.mastery_value, max: p.measurement === 'percent' ? 100 : null, unit })),
    h('div', { class: 'grid' },
      h('div', {}, trialsCard, entry,
        h('div', { class: 'card' }, h('h2', {}, 'Program details'),
          h('dl', { class: 'kv' },
            h('dt', {}, 'Goal'), h('dd', { class: 'pre' }, p.goal || '—'),
            h('dt', {}, 'Mastery'), h('dd', {}, p.mastery_value != null ? `${p.mastery_direction === 'at_most' ? '≤' : '≥'} ${p.mastery_value}${unit} across ${p.mastery_sessions} sessions` : '—'),
            h('dt', {}, 'Instructions'), h('dd', { class: 'pre' }, p.instructions || '—')))),
      h('div', {},
        h('div', { class: 'card flush' }, table([
          { label: 'Date', render: (d) => fmtDate(d.session_date) },
          { label: 'Result', render: (d) => [h('strong', {}, d.total != null ? `${d.value}%` : `${d.value}`), d.total != null && h('span', { class: 'muted small' }, ` (${d.correct}/${d.total})`),
            d.trials.length ? trialBreakdown(d.trials) : d.target && h('div', { class: 'muted small' }, d.target)] },
          { label: 'By', render: (d) => [d.recorded_by_name, d.note && h('div', { class: 'muted small' }, d.note)] },
          { label: '', render: (d) => sections.clinicalWrite && (d.recorded_by === mine || can('programs.manage')) && h('button', {
            class: 'btn small danger',
            onclick: async (e) => { e.stopPropagation(); if (await confirmDialog('Remove this session\'s data from the graph?', { confirmLabel: 'Remove' }) && await attempt(() => api(`/program-data/${d.id}`, { method: 'DELETE' }), 'Removed')) rerender(); },
          }, 'Remove') },
        ], recent.slice(0, 50), { emptyText: 'No data recorded yet.' })),
        h('div', { class: 'card' }, h('h2', {}, 'Change history'),
          h('p', { class: 'muted small' }, 'Every change to this program and its trials, who made it and why.'),
          h('ul', { class: 'timeline' }, changes.map((c) => h('li', { class: 'status' },
            h('div', {}, c.summary), c.reason && h('div', { class: 'small pre' }, `“${c.reason}”`),
            h('div', { class: 'muted small' }, `${c.changed_by_name} · ${fmtDateTime(c.at)}`))))))));
}

// ---------- client profile ----------
const CATEGORY_LABELS = { edible: 'Edible', tangible: 'Toy / item', activity: 'Activity', social: 'Social', sensory: 'Sensory', other: 'Other' };
const KIND_LABELS = { reinforcer: 'Reinforcer', strategy: 'Something that helps', trigger: 'Trigger to avoid', other: 'Other' };

function openSuggestionForm(clientId, first) {
  const cat = h('div', {}, field('Type of reinforcer', select('category', Object.entries(CATEGORY_LABELS), { value: 'activity' })));
  const kinds = h('div', { class: 'seg seg-wrap' }, Object.entries(KIND_LABELS).map(([k, l]) => h('label', {},
    h('input', { type: 'radio', name: 'kind', value: k, checked: k === 'reinforcer', onchange: () => { cat.hidden = k !== 'reinforcer'; } }), l)));
  modal(`Share something that works for ${first}`, h('div', {},
    h('p', { class: 'muted small' }, 'Everyone on the team will see this with your name. A lead or QSP can add it to the profile.'),
    field('What kind of idea?', kinds),
    cat,
    field('What worked?', input('title', { required: true, placeholder: 'e.g. Bubbles, sand timer before transitions' }), { required: true }),
    field('Details', textarea('details', { rows: 3, placeholder: 'When you tried it, how it went, anything to watch for' }))),
  {
    submitLabel: 'Share with the team',
    onSubmit: async (form) => {
      await api(`/clients/${clientId}/suggestions`, { method: 'POST', body: formValues(form) });
      toast('Shared with the team');
      rerender();
      return true;
    },
  });
}

function openReinforcerForm(clientId, r = {}) {
  modal(r.id ? `Edit ${r.name}` : 'Add reinforcer', h('div', {},
    field('Reinforcer', input('name', { value: r.name, required: true }), { required: true }),
    h('div', { class: 'form-grid' },
      field('Type', select('category', Object.entries(CATEGORY_LABELS), { value: r.category || 'activity' })),
      field('Strength', select('strength', [['high', 'High'], ['medium', 'Medium'], ['low', 'Low']], { value: r.strength || 'medium' }))),
    field('Notes', textarea('notes', { value: r.notes, rows: 2, placeholder: 'How much, how often, when it stops working' }))),
  {
    onSubmit: async (form) => {
      const v = formValues(form);
      if (r.id) await api(`/reinforcers/${r.id}`, { method: 'PATCH', body: v });
      else await api(`/clients/${clientId}/reinforcers`, { method: 'POST', body: v });
      toast('Saved');
      rerender();
      return true;
    },
  });
}

function openSectionForm(clientId, sec) {
  modal(sec.label, h('div', {},
    h('p', { class: 'muted small' }, sec.help, sec.shared ? '. Drivers and front desk also see this.' : '.'),
    field(sec.label, textarea('body', { value: sec.body, rows: 8 }))),
  {
    wide: true,
    onSubmit: async (form) => {
      await api(`/clients/${clientId}/profile/${sec.key}`, { method: 'PUT', body: { body: form.body.value } });
      toast('Profile updated');
      rerender();
      return true;
    },
  });
}

function openReviewForm(s, action) {
  const adding = action === 'add';
  modal(adding ? `Add "${s.title}" to the profile` : `Not using "${s.title}"`, h('div', {},
    adding && s.kind === 'reinforcer' && field('Strength', select('strength', [['high', 'High'], ['medium', 'Medium'], ['low', 'Low']], { value: 'medium' })),
    adding && s.kind !== 'reinforcer' && h('p', { class: 'muted small' }, `It will be added to "${s.kind === 'trigger' ? 'Things that upset me' : s.kind === 'strategy' ? 'What helps when I am upset' : 'About me'}" with ${s.author_name}'s name.`),
    field(adding ? 'Note (optional)' : 'Why not? (the person who shared it will see this)', textarea('note', { rows: 2, required: !adding }), { required: !adding })),
  {
    submitLabel: adding ? 'Add to profile' : 'Mark as not used',
    onSubmit: async (form) => {
      await api(`/suggestions/${s.id}/review`, { method: 'POST', body: { action, ...formValues(form) } });
      toast(adding ? 'Added to the profile' : 'Marked as not used');
      rerender();
      return true;
    },
  });
}

async function profileTab(el, client) {
  const d = await api(`/clients/${client.id}/profile`);
  const first = client.first_name;
  const active = d.reinforcers.filter((r) => r.active);
  const stopped = d.reinforcers.filter((r) => !r.active);
  const open = d.suggestions.filter((s) => s.status === 'open');
  const reviewed = d.suggestions.filter((s) => s.status !== 'open');

  const reinforcerItem = (r) => h('div', { class: 'list-item' },
    h('div', { class: 'row' }, h('strong', {}, r.name), h('span', { class: 'badge' }, CATEGORY_LABELS[r.category]), h('span', { class: 'spacer' }),
      d.canEdit && h('button', { class: 'btn small', onclick: () => openReinforcerForm(client.id, r) }, 'Edit'),
      d.canEdit && h('button', { class: 'btn small', onclick: async () => {
        if (await attempt(() => api(`/reinforcers/${r.id}`, { method: 'PATCH', body: { active: !r.active } }), r.active ? 'Marked as not working' : 'Marked as working')) rerender();
      } }, r.active ? 'Stopped working' : 'Working again')),
    r.notes && h('div', { class: 'small pre' }, r.notes),
    h('div', { class: 'meta' }, r.suggested_by_name ? `Suggested by ${r.suggested_by_name} · added by ${r.added_by_name}` : `Added by ${r.added_by_name}`, ` · ${fmtDate(r.updated_at)}`));

  const reinforcers = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Reinforcers'), d.canEdit && h('button', { class: 'btn small', onclick: () => openReinforcerForm(client.id) }, '+ Add')),
    active.length ? ['high', 'medium', 'low'].map((level) => {
      const items = active.filter((r) => r.strength === level);
      return items.length > 0 && h('div', { class: 'strength-group' }, h('div', { class: `strength-label ${level}` }, `${level[0].toUpperCase()}${level.slice(1)} preference`), items.map(reinforcerItem));
    }) : empty('No reinforcers listed yet. Share what works below.'),
    stopped.length > 0 && h('details', {}, h('summary', { class: 'small' }, `No longer working (${stopped.length})`), stopped.map(reinforcerItem)));

  const ideaItem = (s) => h('div', { class: 'list-item' },
    h('div', { class: 'row' }, h('span', { class: 'badge info' }, KIND_LABELS[s.kind]), h('strong', {}, s.title),
      s.status !== 'open' && badge(s.status === 'added' ? 'approved' : 'discontinued', s.status === 'added' ? 'Added to profile' : 'Not used')),
    s.details && h('div', { class: 'small pre' }, s.details),
    h('div', { class: 'meta' }, `${s.author_name} · ${fmtDate(s.created_at)}`),
    s.review_note && h('div', { class: 'small' }, h('em', {}, `${s.reviewer_name}: ${s.review_note}`)),
    s.status === 'open' && h('div', { class: 'row' },
      d.canSuggest && s.author_id !== state.me.user.id && h('button', { class: `btn small ${s.voted ? 'primary' : ''}`, 'aria-pressed': s.voted ? 'true' : 'false', onclick: async () => {
        if (await attempt(() => api(`/suggestions/${s.id}/vote`, { method: 'POST', body: {} }))) rerender();
      } }, s.voted ? '✓ Worked for me too' : 'Worked for me too'),
      s.votes > 0 && h('span', { class: 'muted small' }, `${s.votes} other${s.votes === 1 ? '' : 's'} agree${s.votes === 1 ? 's' : ''}`),
      h('span', { class: 'spacer' }),
      d.canEdit && h('button', { class: 'btn small', onclick: () => openReviewForm(s, 'not_used') }, 'Not using'),
      d.canEdit && h('button', { class: 'btn small primary', onclick: () => openReviewForm(s, 'add') }, 'Add to profile')));

  const ideas = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, `Team ideas${open.length ? ` (${open.length})` : ''}`),
      d.canSuggest && h('button', { class: 'btn small primary', onclick: () => openSuggestionForm(client.id, first) }, '+ Share what works')),
    h('p', { class: 'muted small' }, `Found something that works with ${first}? Share it so it doesn't stay with one person.`),
    open.length ? open.map(ideaItem) : empty('No new ideas right now.'),
    reviewed.length > 0 && h('details', {}, h('summary', { class: 'small' }, `Reviewed ideas (${reviewed.length})`), reviewed.map(ideaItem)));

  const sectionCard = (sec) => h('div', { class: `card profile-section ${sec.key === 'alerts' && sec.body ? 'alert' : ''}` },
    h('div', { class: 'card-head' }, h('h3', {}, sec.label), d.canEdit && h('button', { class: 'btn small', onclick: () => openSectionForm(client.id, sec) }, sec.body ? 'Edit' : 'Add')),
    sec.shared && h('div', { class: 'muted small' }, 'Also shown to drivers and front desk'),
    sec.body ? h('div', { class: 'pre' }, sec.body) : h('div', { class: 'empty' }, `${sec.help}.`),
    sec.updated_at && h('div', { class: 'meta' }, `Updated by ${sec.updated_by_name} · ${fmtDate(sec.updated_at)}`));

  mount(el,
    h('div', { class: 'row' },
      h('p', { class: 'muted small spacer' }, `Everything the team knows about working with ${first}, in one place. ${d.canEdit ? 'You can edit it.' : 'Leads and QSPs keep it current; share your ideas with "Share what works".'}`),
      h('button', { class: 'btn small', onclick: () => modal('Profile history', d.changes.length ? h('ul', { class: 'timeline' }, d.changes.map((c) => h('li', { class: 'status' },
        h('div', {}, c.summary), h('div', { class: 'muted small' }, `${c.changed_by_name} · ${fmtDateTime(c.at)}`)))) : empty('No changes yet.'), { wide: true }) }, 'Profile history')),
    h('div', { class: 'grid' }, reinforcers, ideas),
    h('div', { class: 'grid profile-grid' }, d.sections.map(sectionCard)));
}

// ---------- collect data (trial by trial) ----------
// Built for a phone or iPad at the table: big buttons, taps kept on the device until
// saved (so a locked screen, a dead battery or a timed-out sign-in loses nothing), and an
// option to keep the screen on. On a laptop, keys 1-4 record results for the focused trial.
async function collectTab(el, client) {
  const programs = (await api(`/clients/${client.id}/programs`)).filter((p) => ['active', 'baseline'].includes(p.status));
  const key = draftKey(state.me.user.id, client.id);
  const draft = readDraft(key);
  const liveTrials = new Set(programs.flatMap((p) => p.trials.map((t) => t.id)));
  // runs[programId] = [{ trial_id, result }] in the order they were run
  const runs = new Map(programs.map((p) => [p.id, (draft?.runs?.[p.id] || []).filter((r) => liveTrials.has(r.trial_id))]));
  const values = new Map(Object.entries(draft?.values || {}).map(([k, v]) => [Number(k), v]));
  const notes = new Map(Object.entries(draft?.notes || {}).map(([k, v]) => [Number(k), v]));
  const dateInput = input('session_date', { type: 'date', value: draft?.date || todayIso(), required: true });
  const saveBtn = h('button', { class: 'btn primary', type: 'button' }, 'Save session data');
  const count = h('span', { class: 'muted small', role: 'status' });
  const hasData = () => [...runs.values()].some((r) => r.length) || [...values.values()].some((v) => v !== '' && v != null);

  const persist = () => {
    stillWorking();
    if (!hasData()) { clearDraft(key); return; }
    writeDraft(key, {
      date: dateInput.value,
      runs: Object.fromEntries(runs),
      values: Object.fromEntries(values),
      notes: Object.fromEntries(notes),
      at: new Date().toISOString(),
    });
  };
  dateInput.addEventListener('change', persist);

  const updateCount = () => {
    const trials = [...runs.values()].reduce((a, r) => a + r.length, 0);
    const other = [...values.values()].filter((v) => v !== '' && v != null).length;
    count.textContent = trials || other
      ? `${trials} trial${trials === 1 ? '' : 's'}${other ? ` + ${other} count${other === 1 ? '' : 's'}` : ''} not saved yet (kept on this device)`
      : 'Nothing recorded yet';
    saveBtn.disabled = !trials && !other;
  };

  const programCard = (p) => {
    const run = runs.get(p.id);
    const summary = h('span', { class: 'run-summary' });
    const tallies = new Map();
    const refresh = () => {
      const correct = run.filter((r) => r.result === 'correct').length;
      summary.textContent = run.length ? `${correct}/${run.length} correct · ${Math.round((correct / run.length) * 100)}%` : '';
      for (const [trialId, box] of tallies) {
        const mineRuns = run.map((r, i) => ({ ...r, i })).filter((r) => r.trial_id === trialId);
        mount(box, mineRuns.map((r) => h('button', { type: 'button', class: `result ${RESULT[r.result].kind}`, title: `${RESULT[r.result].label}. Tap to undo.`,
          'aria-label': `Undo ${RESULT[r.result].label}`, onclick: () => { run.splice(r.i, 1); refresh(); persist(); } }, RESULT[r.result].short)));
      }
      updateCount();
    };
    const record = (trialId, result) => { run.push({ trial_id: trialId, result }); refresh(); persist(); };
    let body;
    if (p.measurement === 'percent') {
      body = p.trials.length ? p.trials.map((t) => {
        const tally = h('div', { class: 'tally' });
        tallies.set(t.id, tally);
        return h('div', {
          class: 'trial-run', tabindex: '0', 'aria-label': `${t.name}. Keys 1 to 4 record a result, Backspace undoes.`,
          onkeydown: (e) => {
            if (e.target !== e.currentTarget) return;
            const idx = ['1', '2', '3', '4'].indexOf(e.key);
            if (idx >= 0) { e.preventDefault(); record(t.id, RESULTS[idx].key); }
            if (e.key === 'Backspace') {
              e.preventDefault();
              const last = run.map((r) => r.trial_id).lastIndexOf(t.id);
              if (last >= 0) { run.splice(last, 1); refresh(); persist(); }
            }
          },
        },
        h('div', { class: 'trial-info' }, h('strong', {}, t.name), h('div', { class: 'muted small pre' }, t.description)),
        h('div', { class: 'trial-buttons' }, RESULTS.map((r, i) => h('button', {
          type: 'button', class: `btn small result-btn ${r.kind}`, title: `${r.help} (key ${i + 1})`,
          onclick: () => record(t.id, r.key),
        }, `${r.short} ${r.label}`))),
        tally);
      }) : empty('No trials written yet. Ask your QSP to add them.');
    } else {
      const inp = h('input', { type: 'number', inputmode: 'decimal', min: 0, step: 'any', value: values.get(p.id) ?? '', 'aria-label': MEASUREMENT_LABELS[p.measurement], placeholder: MEASUREMENT_LABELS[p.measurement],
        oninput: (e) => { values.set(p.id, e.target.value); updateCount(); persist(); } });
      body = h('div', { class: 'row' }, inp, p.measurement === 'frequency' && h('button', { type: 'button', class: 'btn result-btn', onclick: () => {
        inp.value = String((Number(inp.value) || 0) + 1); values.set(p.id, inp.value); updateCount(); persist();
      } }, '+1'));
    }
    const card = h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', {}, h('h2', {}, h('a', { href: `#/programs/${p.id}` }, p.name)), h('div', { class: 'muted small' }, [p.domain, MEASUREMENT_LABELS[p.measurement]].filter(Boolean).join(' · '))),
        summary),
      p.instructions && h('details', {}, h('summary', { class: 'small' }, 'Program instructions'), h('p', { class: 'pre small' }, p.instructions)),
      body,
      h('input', { type: 'text', class: 'session-note', value: notes.get(p.id) || '', placeholder: 'Note for this program (optional)', 'aria-label': 'Note',
        oninput: (e) => { notes.set(p.id, e.target.value); persist(); } }));
    refresh();
    return card;
  };

  saveBtn.addEventListener('click', async () => {
    const entries = [];
    for (const p of programs) {
      const run = runs.get(p.id);
      if (p.measurement === 'percent' && run.length) entries.push({ program_id: p.id, trials: run, note: notes.get(p.id) || null });
      else if (p.measurement !== 'percent' && values.get(p.id) !== undefined && values.get(p.id) !== '') {
        entries.push({ program_id: p.id, value: Number(values.get(p.id)), note: notes.get(p.id) || null });
      }
    }
    saveBtn.disabled = true;
    const r = await attempt(() => api(`/clients/${client.id}/session-data`, { method: 'POST', body: { session_date: dateInput.value, entries } }));
    if (r) { clearDraft(key); toast(`Saved data for ${r.saved.length} program${r.saved.length === 1 ? '' : 's'}`); rerender(); } else saveBtn.disabled = false;
  });

  const restored = draft && hasData() && h('div', { class: 'banner info row' },
    h('span', { class: 'spacer' }, `Picked up where you left off: unsaved data from ${fmtDateTime(draft.at.replace('T', ' ').slice(0, 19))} was kept on this device.`),
    h('button', { class: 'btn small', type: 'button', onclick: async () => {
      if (await confirmDialog('Delete the unsaved data on this device? It has not been saved to the client\'s record.', { confirmLabel: 'Delete' })) { clearDraft(key); rerender(); }
    } }, 'Discard'));

  const awake = canKeepScreenOn && h('label', { class: 'check' },
    h('input', { type: 'checkbox', onchange: async (e) => { const ok = await keepScreenOn(e.target.checked); if (e.target.checked && !ok) { e.target.checked = false; toast('This device would not keep the screen on.', 'error'); } } }),
    'Keep screen on');

  mount(el,
    restored,
    h('div', { class: 'card collect-head' },
      h('div', { class: 'row' }, field('Session date', dateInput), h('span', { class: 'spacer' }), awake),
      h('p', { class: 'muted small' }, 'Tap a result each time you run a trial; tap a result chip to undo it. Only "Correct" counts toward % correct. Your taps are kept on this device until you save.'),
      h('p', { class: 'muted small keyboard-hint' }, 'Keyboard: click a trial, then press 1 Correct, 2 Prompted, 3 Incorrect, 4 No response, Backspace to undo.')),
    programs.length ? programs.map(programCard) : empty('No active programs for this client yet.'),
    programs.length > 0 && h('div', { class: 'save-bar' }, count, h('span', { class: 'spacer' }), saveBtn));
  updateCount();
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
