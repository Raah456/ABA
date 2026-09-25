import {
  state, h, mount, api, can, roleLabel, attempt, rerender, modal, field, input, select, formValues, fmtDate,
  fmtDateTime, badge, table, loadLists, loadUsers, toast,
} from './lib.js';
import { twoFactorCard } from './security.js';

const LIST_LABELS = {
  observation_categories: ['Client log categories', 'Categories staff choose when logging an observation.'],
  program_domains: ['Program domains', 'Used to group programs.'],
  service_codes: ['Service codes', 'Billing codes available on session notes and authorizations.'],
  escalation_categories: ['Report categories', 'Categories for reports sent up the chain.'],
  payers: ['Insurance payers', 'Payers available when adding a policy.'],
};

export async function listsView(el) {
  const { lists, editable } = await loadLists(true);
  mount(el,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Lists & categories'), h('div', { class: 'muted' }, 'Customize the dropdowns your team uses. Retired values stay on old records but cannot be picked for new ones.'))),
    h('div', { class: 'grid' }, editable.map((key) => {
      const [title, help] = LIST_LABELS[key] || [key, ''];
      const form = h('form', {
        class: 'row',
        onsubmit: async (e) => {
          e.preventDefault();
          const v = formValues(form);
          if (await attempt(() => api('/lists', { method: 'POST', body: { list_key: key, value: v.value, label: v.label || v.value } }), 'Added')) { await loadLists(true); rerender(); }
        },
      },
      h('input', { type: 'text', name: 'value', placeholder: key === 'service_codes' ? 'Code' : 'New value', required: true, 'aria-label': 'Value' }),
      key === 'service_codes' && h('input', { type: 'text', name: 'label', placeholder: 'Description', 'aria-label': 'Description' }),
      h('button', { class: 'btn small primary', type: 'submit' }, 'Add'));
      return h('div', { class: 'card' },
        h('h2', {}, title), h('p', { class: 'muted small' }, help),
        lists[key].map((item) => h('div', { class: 'list-item row' },
          h('span', { class: item.active ? '' : 'muted' }, item.label), h('span', { class: 'spacer' }),
          h('button', { class: 'btn small', onclick: () => rename(item) }, 'Rename'),
          h('button', { class: 'btn small', onclick: async () => {
            if (await attempt(() => api(`/lists/${item.id}`, { method: 'PATCH', body: { active: !item.active } }))) { await loadLists(true); rerender(); }
          } }, item.active ? 'Retire' : 'Restore'))),
        form);
    })));
}

function rename(item) {
  modal('Rename', field('Label', input('label', { value: item.label, required: true })), {
    onSubmit: async (form) => {
      await api(`/lists/${item.id}`, { method: 'PATCH', body: { label: form.label.value } });
      await loadLists(true);
      rerender();
      return true;
    },
  });
}

export async function usersView(el) {
  const users = await loadUsers(true);
  const roles = Object.entries(state.me.roles).filter(([k]) => k !== 'executive' || state.me.user.role === 'executive');
  const byDept = (dept) => roles.filter(([, r]) => r.dept === dept).map(([k, r]) => [k, r.label]);
  const roleOptions = (value) => h('select', { name: 'role', required: true },
    ['clinical', 'admin', 'leadership'].map((d) => h('optgroup', { label: d[0].toUpperCase() + d.slice(1) },
      byDept(d).map(([k, l]) => h('option', { value: k, selected: k === value }, l)))));

  const openForm = (u = {}) => modal(u.id ? `Edit ${u.name}` : 'Add staff account', h('div', {},
    field('Name', input('name', { value: u.name, required: true }), { required: true }),
    !u.id && field('Email', input('email', { type: 'email', required: true }), { required: true }),
    field('Role', roleOptions(u.role), { required: true, help: 'controls exactly what they can see' }),
    field(u.id ? 'Reset password' : 'Temporary password', input('password', { type: 'password', required: !u.id }), { required: !u.id, help: 'at least 10 characters' }),
    u.id && u.id !== state.me.user.id && h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: !!u.active }), 'Active (can sign in)'),
    u.id && u.id !== state.me.user.id && u.totp_enabled ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'reset_2fa' }),
      'Reset two-factor (lost phone). They set it up again at next sign-in.') : null),
  {
    onSubmit: async (form) => {
      const v = formValues(form);
      if (!v.password) delete v.password;
      if (u.id) await api(`/users/${u.id}`, { method: 'PATCH', body: v });
      else await api('/users', { method: 'POST', body: v });
      toast('Saved');
      rerender();
      return true;
    },
  });

  mount(el,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Staff accounts'), h('div', { class: 'muted' }, 'Deactivate accounts the day someone leaves; their history stays intact.')),
      h('button', { class: 'btn primary', onclick: () => openForm() }, '+ Add staff')),
    h('div', { class: 'card flush' }, table([
      { label: 'Name', render: (u) => h('strong', {}, u.name) },
      { label: 'Email', key: 'email' },
      { label: 'Role', render: (u) => [roleLabel(u.role), ' ', badge(state.me.roles[u.role]?.dept === 'clinical' ? 'info' : 'low', state.me.roles[u.role]?.dept)] },
      { label: 'Status', render: (u) => badge(u.active ? 'active' : 'discontinued', u.active ? 'Active' : 'Inactive') },
      { label: 'Two-factor', render: (u) => (u.totp_enabled ? badge('active', 'On') : badge('', 'Off')) },
      { label: 'Since', render: (u) => fmtDate(u.created_at) },
    ], users, { onRow: (u) => { if (u.role !== 'executive' || state.me.user.role === 'executive') openForm(u); } })));
}

export async function auditView(el, _, query) {
  const params = new URLSearchParams(Object.entries(query).filter(([, v]) => v));
  const rows = await api(`/audit?${params}`);
  const users = await loadUsers();
  const form = h('form', {
    class: 'card row',
    onsubmit: (e) => {
      e.preventDefault();
      const v = formValues(form);
      location.hash = `#/settings/audit?${new URLSearchParams(Object.entries(v).filter(([, x]) => x))}`;
    },
  },
  select('user_id', users.map((u) => [u.id, u.name]), { value: query.user_id, blank: 'Any person', class: 'inline-select' }),
  h('input', { type: 'text', name: 'action', value: query.action || '', placeholder: 'Action starts with… (e.g. note.)', 'aria-label': 'Action' }),
  h('button', { class: 'btn', type: 'submit' }, 'Filter'));
  mount(el,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Audit log'), h('div', { class: 'muted' }, 'Every sign-in, every view of a client record, and every change. Latest 300 shown.'))),
    form,
    h('div', { class: 'card flush' }, table([
      { label: 'When', render: (r) => fmtDateTime(r.at) },
      { label: 'Who', render: (r) => r.user_name || '—' },
      { label: 'Action', render: (r) => h('code', {}, r.action) },
      { label: 'Client', render: (r) => (r.client_id ? h('a', { href: `#/settings/audit?client_id=${r.client_id}` }, r.client_name) : '—') },
      { label: 'Detail', render: (r) => h('span', { class: 'small muted' }, [r.entity && `${r.entity} #${r.entity_id}`, r.detail].filter(Boolean).join(' · ')) },
    ], rows)));
}

export async function accountView(el) {
  const me = state.me.user;
  const form = h('form', {
    class: 'card',
    onsubmit: async (e) => {
      e.preventDefault();
      const v = formValues(form);
      if (v.next !== v.confirm) return toast('New passwords do not match.', 'error');
      if (await attempt(() => api('/me/password', { method: 'POST', body: v }), 'Password changed')) form.reset();
      return undefined;
    },
  },
  h('h2', {}, 'Change password'),
  field('Current password', input('current', { type: 'password', required: true })),
  field('New password', input('next', { type: 'password', required: true }), { help: 'at least 10 characters' }),
  field('Confirm new password', input('confirm', { type: 'password', required: true })),
  h('button', { class: 'btn primary', type: 'submit' }, 'Change password'));
  const twoFactor = await twoFactorCard();
  mount(el,
    h('div', { class: 'page-head' }, h('h1', {}, 'My account')),
    h('div', { class: 'grid' }, twoFactor,
      h('div', { class: 'card' }, h('h2', {}, me.name),
        h('dl', { class: 'kv' },
          h('dt', {}, 'Email'), h('dd', {}, me.email),
          h('dt', {}, 'Role'), h('dd', {}, roleLabel(me.role)),
          h('dt', {}, 'Department'), h('dd', {}, state.me.departments[me.dept])),
        h('p', { class: 'muted small' }, `For privacy you are signed out after ${Math.round(state.me.idleTimeoutMs / 60000)} minutes of inactivity.`),
        can('users.manage') ? null : h('p', { class: 'muted small' }, 'Need a different role or access? Ask your office manager.')),
      form));
}
