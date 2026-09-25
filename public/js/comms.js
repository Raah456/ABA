import {
  state, h, mount, api, can, roleLabel, attempt, rerender, modal, field, input, textarea, select, checkbox, formValues,
  fmtDateTime, ago, badge, empty, table, listOptions, toast,
} from './lib.js';

const DEPT_LABELS = { clinical: 'Clinical', admin: 'Admin', leadership: 'Leadership' };

function audienceText(aud) {
  const depts = aud.depts?.length ? aud.depts.map((d) => DEPT_LABELS[d]).join(' + ') : 'Everyone';
  return aud.roles?.length ? `${depts}: ${aud.roles.map(roleLabel).join(', ')}` : depts;
}

// ================= announcements =================
export async function announcementsView(el, _, query) {
  const rows = await api('/announcements');
  const me = state.me.user;
  const pending = rows.filter((a) => a.requires_ack && !a.acked_at && a.author_id !== me.id);

  const item = (a) => h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', {}, h('h2', {}, a.pinned ? '📌 ' : '', a.title),
        h('div', { class: 'muted small' }, `${a.author_name} (${roleLabel(a.author_role)}) · ${fmtDateTime(a.created_at)} · To: ${audienceText(a.audience)}`)),
      h('div', { class: 'row' },
        a.audience_size !== undefined && a.requires_ack ? h('button', { class: 'btn small', onclick: () => showAcks(a) }, `${a.ack_count}/${a.audience_size} read`) : null,
        (a.author_id === me.id || me.dept === 'leadership') && h('button', { class: 'btn small', onclick: async () => {
          if (await attempt(() => api(`/announcements/${a.id}`, { method: 'PATCH', body: { pinned: !a.pinned } }))) rerender();
        } }, a.pinned ? 'Unpin' : 'Pin'))),
    h('div', { class: 'pre' }, a.body),
    a.requires_ack && a.author_id !== me.id ? h('div', { class: 'row end' },
      a.acked_at ? h('span', { class: 'muted small' }, `✓ You acknowledged ${ago(a.acked_at)}`)
        : h('button', { class: 'btn primary', onclick: async () => { if (await attempt(() => api(`/announcements/${a.id}/ack`, { method: 'POST', body: {} }), 'Acknowledged')) rerender(); } }, 'I have read this')) : null);

  mount(el,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Announcements'), h('div', { class: 'muted' }, 'The official word. If it is not posted here, it is not the new procedure.')),
      can('announcements.create') && h('button', { class: 'btn primary', onclick: openAnnouncementForm }, '+ Post announcement')),
    pending.length > 0 && h('div', { class: 'banner warn' }, `You have ${pending.length} announcement(s) to acknowledge.`),
    rows.length ? rows.map(item) : empty('No announcements yet.'));
  if (query.new && can('announcements.create')) openAnnouncementForm();
}

async function showAcks(a) {
  const people = await api(`/announcements/${a.id}/acks`);
  const unread = people.filter((p) => !p.acked_at);
  modal(`Read receipts — ${a.title}`, h('div', {},
    h('p', { class: 'muted' }, `${people.length - unread.length} of ${people.length} have acknowledged.`),
    table([
      { label: 'Name', key: 'name' },
      { label: 'Role', render: (p) => roleLabel(p.role) },
      { label: 'Acknowledged', render: (p) => (p.acked_at ? fmtDateTime(p.acked_at) : badge('open', 'Not yet')) },
    ], [...unread, ...people.filter((p) => p.acked_at)])), { wide: true });
}

function openAnnouncementForm() {
  const depts = state.me.announceDepts;
  const roles = Object.entries(state.me.roles).filter(([, r]) => depts.includes(r.dept));
  modal('Post an announcement', h('div', {},
    field('Title', input('title', { required: true }), { required: true }),
    field('Message', textarea('body', { required: true, rows: 6 }), { required: true }),
    h('div', { class: 'form-grid' },
      h('div', {}, h('div', { class: 'small muted' }, 'Departments'),
        depts.map((d) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'depts', value: d, 'data-multi': '1', checked: true }), DEPT_LABELS[d]))),
      h('div', {}, h('div', { class: 'small muted' }, 'Only these roles (optional)'),
        roles.map(([k, r]) => h('label', { class: 'check small' }, h('input', { type: 'checkbox', name: 'roles', value: k, 'data-multi': '1' }), r.label)))),
    checkbox('requires_ack', 'Require everyone to acknowledge they read it', true),
    state.me.user.rank >= 3 && checkbox('pinned', 'Pin to top')),
  {
    wide: true,
    submitLabel: 'Post',
    onSubmit: async (form) => {
      const v = formValues(form);
      await api('/announcements', { method: 'POST', body: v });
      toast('Posted');
      location.hash = '#/announcements';
      rerender();
      return true;
    },
  });
}

// ================= reports / escalations =================
export async function openReportForm(prefill = {}) {
  const [targets, clients] = await Promise.all([
    api('/escalation-targets'),
    (can('clients.view_basic') || can('clinical.view_assigned')) ? api('/clients') : Promise.resolve([]),
  ]);
  const cats = listOptions('escalation_categories');
  modal('Report something up', h('div', {},
    h('p', { class: 'muted small' }, 'Goes to everyone at the level you pick and above. You will see every reply and status change until it is resolved.'),
    h('div', { class: 'form-grid' },
      field('Send to', select('target', targets.map((t) => [`${t.target_dept}:${t.target_rank}`, `${DEPT_LABELS[t.target_dept]} — ${t.label}`]), { required: true }), { required: true }),
      field('Category', select('category', cats.map((c) => [c.value, c.label]), { required: true, value: prefill.category }), { required: true }),
      field('Priority', select('priority', [['low', 'Low'], ['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent']], { value: 'normal' })),
      clients.length > 0 && field('About a client (optional)', select('client_id', clients.map((c) => [c.id, `${c.last_name}, ${c.first_name}`]), { value: prefill.client_id, blank: '—' }))),
    field('Subject', input('subject', { required: true }), { required: true }),
    field('Details', textarea('body', { required: true, rows: 5, placeholder: 'What happened, when, who was involved, what you need' }), { required: true })),
  {
    wide: true,
    submitLabel: 'Send report',
    onSubmit: async (form) => {
      const v = formValues(form);
      const [target_dept, target_rank] = v.target.split(':');
      const r = await api('/escalations', { method: 'POST', body: { ...v, target_dept, target_rank: Number(target_rank), client_id: v.client_id || null } });
      toast('Report sent');
      location.hash = `#/reports/${r.id}`;
      return true;
    },
  });
}

export async function reportsView(el, _, query) {
  const box = ['inbox', 'sent', 'all'].includes(query.box) ? query.box : 'inbox';
  const status = query.status || 'active';
  const rows = await api(`/escalations?box=${box}&status=${status}`);
  const link = (b, s) => `#/reports?box=${b}&status=${s}`;
  mount(el,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Reports & escalations'), h('div', { class: 'muted' }, 'Concerns sent up the chain, tracked until someone resolves them.')),
      h('button', { class: 'btn primary', onclick: () => openReportForm() }, '+ Report something up')),
    h('div', { class: 'tabs' },
      [['inbox', 'Sent to my level'], ['sent', 'Sent by me'], ['all', 'All I can see']].map(([k, l]) => h('a', { href: link(k, status), class: k === box ? 'active' : '' }, l)),
      h('span', { class: 'spacer' }),
      [['active', 'Open'], ['resolved', 'Resolved']].map(([k, l]) => h('a', { href: link(box, k), class: k === status ? 'active' : '' }, l))),
    h('div', { class: 'card flush' }, table([
      { label: 'Priority', render: (e) => badge(e.priority) },
      { label: 'Subject', render: (e) => [h('strong', {}, e.subject), h('div', { class: 'muted small' }, [e.category, e.client_name].filter(Boolean).join(' · '))] },
      { label: 'From', render: (e) => [e.created_by_name, h('div', { class: 'muted small' }, roleLabel(e.created_by_role))] },
      { label: 'To', render: (e) => targetLabel(e) },
      { label: 'Status', render: (e) => [badge(e.status), e.owner_name && h('div', { class: 'muted small' }, e.owner_name)] },
      { label: 'Updated', render: (e) => ago(e.updated_at) },
    ], rows, { onRow: (e) => { location.hash = `#/reports/${e.id}`; }, emptyText: box === 'inbox' ? 'Nothing waiting on your level.' : 'No reports.' })));
}

function targetLabel(e) {
  if (e.target_dept === 'leadership') return 'Leadership';
  const labels = Object.values(state.me.roles).filter((r) => r.dept === e.target_dept && r.rank === e.target_rank).map((r) => r.label);
  return `${DEPT_LABELS[e.target_dept]}: ${labels.join(' / ')}+`;
}

export async function reportView(el, [escId]) {
  const e = await api(`/escalations/${escId}`);
  const me = state.me.user;
  const mine = e.created_by === me.id;
  const recipient = !mine || me.dept === 'leadership';

  const setStatus = (status, needNote) => {
    if (!needNote) {
      attempt(() => api(`/escalations/${e.id}/status`, { method: 'POST', body: { status } }), 'Updated').then((ok) => ok && rerender());
      return;
    }
    modal(status === 'resolved' ? 'Resolve report' : 'Update status', field('Resolution / what was decided', textarea('note', { required: recipient, rows: 3 }), { required: recipient }), {
      submitLabel: 'Resolve',
      onSubmit: async (form) => {
        await api(`/escalations/${e.id}/status`, { method: 'POST', body: { status, note: form.note.value } });
        toast('Resolved');
        rerender();
        return true;
      },
    });
  };

  const raise = async () => {
    const targets = (await api('/escalation-targets')).filter((t) => t.target_dept !== e.target_dept || t.target_rank > e.target_rank);
    if (!targets.length) return toast('There is no higher level to send this to.', 'error');
    modal('Send higher', h('div', {},
      field('Send to', select('target', targets.map((t) => [`${t.target_dept}:${t.target_rank}`, `${DEPT_LABELS[t.target_dept]} — ${t.label}`]), { required: true }), { required: true }),
      field('Priority', select('priority', ['low', 'normal', 'high', 'urgent'], { value: e.priority })),
      field('Why is this going higher?', textarea('reason', { required: true, rows: 3 }), { required: true })), {
      submitLabel: 'Send higher',
      onSubmit: async (form) => {
        const v = formValues(form);
        const [target_dept, target_rank] = v.target.split(':');
        await api(`/escalations/${e.id}/raise`, { method: 'POST', body: { ...v, target_dept, target_rank: Number(target_rank) } });
        toast('Raised');
        rerender();
        return true;
      },
    });
    return undefined;
  };

  const comment = h('form', {
    class: 'card',
    onsubmit: async (ev) => {
      ev.preventDefault();
      if (await attempt(() => api(`/escalations/${e.id}/comment`, { method: 'POST', body: { body: comment.body.value } }))) rerender();
    },
  }, field('Add a reply', textarea('body', { required: true, rows: 3 })), h('div', { class: 'row end' }, h('button', { class: 'btn primary', type: 'submit' }, 'Reply')));

  mount(el,
    h('div', { class: 'page-head' },
      h('div', {},
        h('div', { class: 'small' }, h('a', { href: '#/reports' }, '← Reports')),
        h('h1', {}, e.subject),
        h('div', { class: 'row muted small' }, badge(e.priority), badge(e.status), h('span', {}, e.category),
          e.client_id && h('a', { href: `#/clients/${e.client_id}` }, e.client_name))),
      h('div', { class: 'row' },
        recipient && e.status === 'open' && h('button', { class: 'btn', onclick: () => setStatus('acknowledged') }, 'Acknowledge — I\'m on it'),
        e.status !== 'resolved' && h('button', { class: 'btn', onclick: raise }, 'Send higher'),
        e.status !== 'resolved' && h('button', { class: 'btn primary', onclick: () => setStatus('resolved', true) }, mine && !recipient ? 'Withdraw / mark resolved' : 'Resolve'),
        e.status === 'resolved' && recipient && h('button', { class: 'btn', onclick: () => setStatus('open') }, 'Reopen'))),
    h('div', { class: 'card' },
      h('div', { class: 'muted small' }, `From ${e.created_by_name} (${roleLabel(e.created_by_role)}) to ${targetLabel(e)} · ${fmtDateTime(e.created_at)}${e.owner_name ? ` · Owner: ${e.owner_name}` : ''}`),
      h('div', { class: 'pre' }, e.body)),
    h('div', { class: 'card' }, h('h2', {}, 'Activity'),
      e.events.length ? h('ul', { class: 'timeline' }, e.events.map((v) => h('li', { class: v.kind },
        v.kind === 'comment' ? h('div', { class: 'pre' }, v.body) : h('div', {}, h('em', {}, v.kind === 'raised' ? v.body : `Status → ${v.body}`)),
        h('div', { class: 'muted small' }, `${v.user_name} (${roleLabel(v.user_role)}) · ${fmtDateTime(v.at)}`)))) : empty('No replies yet.')),
    e.status !== 'resolved' && comment);
}
