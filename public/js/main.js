import {
  state, h, mount, api, can, roleLabel, attempt, loadLists, confirmDialog, fmtDate, fmtTime, ago, badge, empty,
  usageBar, field, input,
} from './lib.js';
import { clientsView, clientView, programView, notesView, noteView, newNoteView, templatesView, templateEditView } from './clinical.js';
import { insuranceView, transportView, billingView } from './admin.js';
import { announcementsView, reportsView, reportView, openReportForm } from './comms.js';
import { listsView, usersView, auditView, accountView } from './settings.js';
import { icon, keepScreenOn, userDraftKeys, clearDraft } from './device.js';

const app = document.getElementById('app');
let main;
let sidebar;

const routes = [
  [/^\/$/, dashboardView],
  [/^\/clients$/, clientsView],
  [/^\/clients\/(\d+)(?:\/(\w+))?$/, clientView],
  [/^\/programs\/(\d+)$/, programView],
  [/^\/notes$/, notesView],
  [/^\/notes\/new$/, newNoteView],
  [/^\/notes\/(\d+)$/, noteView],
  [/^\/templates$/, templatesView],
  [/^\/templates\/(new|\d+)$/, templateEditView],
  [/^\/insurance$/, insuranceView],
  [/^\/transport$/, transportView],
  [/^\/billing$/, billingView],
  [/^\/announcements$/, announcementsView],
  [/^\/reports$/, reportsView],
  [/^\/reports\/(\d+)$/, reportView],
  [/^\/settings\/lists$/, listsView],
  [/^\/settings\/users$/, usersView],
  [/^\/settings\/audit$/, auditView],
  [/^\/account$/, accountView],
];

function parseHash() {
  const raw = location.hash.slice(1) || '/';
  const [path, qs] = raw.split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(qs || '')) };
}

async function route() {
  if (!state.me) return;
  let { path, query } = parseHash();
  // Drivers work from a phone in the vehicle: their rides are their home screen.
  if (path === '/' && can('transport.view_own')) path = '/transport';
  sidebar?.classList.remove('open');
  document.body.classList.remove('menu-open');
  keepScreenOn(false);
  highlightNav(path);
  for (const [re, view] of routes) {
    const m = path.match(re);
    if (m) {
      mount(main, h('div', { class: 'muted' }, 'Loading…'));
      try {
        await view(main, m.slice(1), query);
      } catch (e) {
        mount(main, h('div', { class: 'banner bad' }, e.message));
      }
      main.focus({ preventScroll: true });
      refreshCounts();
      return;
    }
  }
  mount(main, h('h1', {}, 'Page not found'), h('a', { href: '#/' }, 'Go home'));
}

// ---------- shell ----------
function navLink(href, label, countKey) {
  return h('a', { href: `#${href}`, 'data-path': href }, h('span', {}, label), countKey && h('span', { class: 'count hidden', 'data-count': countKey }));
}

function highlightNav(path) {
  for (const a of document.querySelectorAll('.nav a, .bottom-nav a')) {
    const p = a.dataset.path;
    a.classList.toggle('active', p === '/' ? path === '/' : path === p || path.startsWith(`${p}/`));
  }
}

async function refreshCounts() {
  const d = await api('/dashboard').catch(() => null);
  if (!d) return;
  const counts = {
    announcements: d.unacked?.length || 0,
    reports: d.escalationsInbox?.filter((e) => e.status === 'open').length || 0,
    notes: (d.notesToReview || 0) + (d.myNotes?.find((n) => n.status === 'returned')?.n || 0),
    insurance: d.eligibilityDue || 0,
  };
  for (const el of document.querySelectorAll('[data-count]')) {
    const n = counts[el.dataset.count] || 0;
    el.textContent = n;
    el.classList.toggle('hidden', !n);
  }
}

// Phone/tablet tab bar: the four screens each role uses most, plus "More" for the full menu.
const TAB_ORDER = {
  driver: ['rides', 'reports', 'announcements'],
  technician: ['home', 'clients', 'notes', 'reports'],
  senior_tech: ['home', 'clients', 'notes', 'reports'],
  qsp: ['home', 'clients', 'notes', 'reports'],
  clinical_director: ['home', 'clients', 'notes', 'reports'],
  admin_staff: ['home', 'insurance', 'rides', 'reports'],
  coordinator: ['home', 'rides', 'clients', 'reports'],
  billing: ['home', 'billing', 'insurance', 'reports'],
  office_manager: ['home', 'clients', 'insurance', 'reports'],
  executive: ['home', 'clients', 'reports', 'announcements'],
};

function bottomNav() {
  const tabs = {
    home: ['/', 'Home', 'home'],
    clients: ['/clients', 'Clients', 'clients'],
    notes: ['/notes', 'Notes', 'notes', 'notes'],
    reports: ['/reports', 'Reports', 'reports', 'reports'],
    rides: ['/transport', can('transport.view_own') ? 'My rides' : 'Rides', 'rides'],
    insurance: ['/insurance', 'Insurance', 'insurance', 'insurance'],
    billing: ['/billing', 'Billing', 'billing'],
    announcements: ['/announcements', 'News', 'announcements', 'announcements'],
  };
  const keys = TAB_ORDER[state.me.user.role] || ['home', 'reports', 'announcements'];
  return h('nav', { class: 'bottom-nav', 'aria-label': 'Quick' },
    keys.map((k) => {
      const [href, label, ic, countKey] = tabs[k];
      return h('a', { href: `#${href}`, 'data-path': href }, icon(ic), h('span', {}, label),
        countKey && h('span', { class: 'count hidden', 'data-count': countKey }));
    }),
    h('button', { type: 'button', onclick: toggleMenu, 'aria-label': 'More' }, icon('more'), h('span', {}, 'More')));
}

function toggleMenu() {
  sidebar.classList.toggle('open');
  document.body.classList.toggle('menu-open', sidebar.classList.contains('open'));
}

function renderShell() {
  const me = state.me.user;
  const clinical = can('clinical.view_all') || can('clinical.view_assigned');
  const admin = can('insurance.view') || can('insurance.view_summary') || can('transport.manage') || can('transport.view_own') || can('billing.view');
  sidebar = h('nav', { class: 'sidebar', 'aria-label': 'Main' },
    h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, 'AP'), 'ABA Practice Platform'),
    h('div', { class: 'nav' },
      navLink('/', 'Home'),
      (clinical || can('clients.view_basic')) && navLink('/clients', 'Clients'),
      h('div', { class: 'nav-group' }, 'Communication'),
      navLink('/announcements', 'Announcements', 'announcements'),
      navLink('/reports', 'Reports & escalations', 'reports'),
      clinical && h('div', { class: 'nav-group' }, 'Clinical'),
      can('clinical.write') || can('notes.approve') ? navLink('/notes', 'Session notes', 'notes') : null,
      can('templates.manage') && navLink('/templates', 'Note templates'),
      admin && h('div', { class: 'nav-group' }, 'Admin'),
      can('insurance.view') && navLink('/insurance', 'Insurance & auths', 'insurance'),
      !can('insurance.view') && can('insurance.view_summary') && navLink('/insurance', 'Authorizations'),
      (can('transport.manage') || can('transport.view_own') || can('transport.view_assigned')) && navLink('/transport', can('transport.view_own') ? 'My rides' : 'Transportation'),
      can('billing.view') && navLink('/billing', 'Billing queue'),
      h('div', { class: 'nav-group' }, 'Settings'),
      (state.lists?.editable.length > 0) && navLink('/settings/lists', 'Lists & categories'),
      can('users.manage') && navLink('/settings/users', 'Staff accounts'),
      can('audit.view') && navLink('/settings/audit', 'Audit log'),
      navLink('/account', 'My account')),
    h('div', { class: 'me-box' },
      h('div', {}, h('strong', {}, me.name)),
      h('div', { class: 'role' }, roleLabel(me.role)),
      h('button', { class: 'btn small', onclick: logout }, 'Sign out')));
  main = h('main', { class: 'main', tabindex: '-1' });
  const topbar = h('div', { class: 'topbar' },
    h('button', { class: 'icon-btn', 'aria-label': 'Menu', onclick: toggleMenu }, '☰'),
    h('strong', {}, 'ABA Practice Platform'));
  const scrim = h('div', { class: 'scrim', onclick: toggleMenu });
  mount(app, h('div', { class: 'shell' }, sidebar, scrim, h('div', {}, topbar, main)), bottomNav());
}

async function logout() {
  // On a shared iPad, don't leave one person's unsaved data behind for the next person.
  const drafts = userDraftKeys(state.me.user.id);
  if (drafts.length) {
    const ok = await confirmDialog(`You have unsaved session data for ${drafts.length} client${drafts.length === 1 ? '' : 's'} on this device. Signing out deletes it. Go back and tap "Save session data" to keep it.`,
      { confirmLabel: 'Delete it and sign out' });
    if (!ok) return;
    drafts.forEach(clearDraft);
  }
  await api('/logout', { method: 'POST', body: {} }).catch(() => {});
  state.me = null;
  renderLogin();
}

// ---------- login ----------
async function renderLogin(message) {
  const err = h('div', { class: `banner bad ${message ? '' : 'hidden'}` }, message || '');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.classList.add('hidden');
      try {
        await api('/login', { method: 'POST', body: { email: form.email.value, password: form.password.value } });
        await start();
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove('hidden');
      }
    },
  },
  h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, 'AP'), 'ABA Practice Platform'),
  h('p', { class: 'muted small' }, 'Clinical and admin workspace. Sign in with your staff account.'),
  err,
  field('Email', input('email', { type: 'email', required: true })),
  field('Password', input('password', { type: 'password', required: true })),
  h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'));

  const demo = await fetch('/api/demo-accounts').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const demoBox = demo?.accounts?.length ? h('div', { class: 'demo-accounts muted' },
    h('div', {}, `Demo accounts (password: ${demo.password})`),
    demo.accounts.map((a) => h('div', {}, h('button', { type: 'button', onclick: () => { form.email.value = a.email; form.password.value = demo.password; } }, a.email), ` — ${a.label}`))) : null;
  mount(app, h('div', { class: 'login' }, h('div', { class: 'card' }, form, demoBox)));
  form.email.focus();
}

// ---------- dashboard ----------
async function dashboardView(el) {
  const d = await api('/dashboard');
  const me = state.me.user;
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  const quick = h('div', { class: 'row' },
    can('clinical.write') && h('a', { class: 'btn primary', href: '#/notes/new' }, '+ Session note'),
    h('button', { class: 'btn', onclick: () => openReportForm() }, 'Report something up'),
    can('announcements.create') && h('a', { class: 'btn', href: '#/announcements?new=1' }, 'Post announcement'));

  const stats = [];
  if (d.notesToReview !== undefined) stats.push(['#/notes?tab=review', d.notesToReview, 'Notes to review']);
  if (d.myNotes) {
    const ret = d.myNotes.find((n) => n.status === 'returned')?.n || 0;
    const drafts = d.myNotes.find((n) => n.status === 'draft')?.n || 0;
    stats.push(['#/notes', ret, 'My notes returned']);
    stats.push(['#/notes', drafts, 'My drafts']);
  }
  if (d.eligibilityDue !== undefined) stats.push(['#/insurance', d.eligibilityDue, 'Eligibility checks due']);
  if (d.unbilled) stats.push(['#/billing', d.unbilled.n, `Notes to bill (${d.unbilled.units} units)`]);
  if (d.ridesToday) stats.push(['#/transport', d.ridesToday.reduce((a, r) => a + (r.status === 'cancelled' ? 0 : r.n), 0), 'Rides today']);

  const cards = [];

  if (d.unacked.length) {
    cards.push(h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Please read & acknowledge'), h('a', { href: '#/announcements' }, 'All')),
      d.unacked.map((a) => h('div', { class: 'list-item row' },
        h('div', { class: 'spacer' }, h('a', { href: '#/announcements' }, a.title), h('div', { class: 'meta' }, `${a.author_name} · ${ago(a.created_at)}`)),
        h('button', { class: 'btn small', onclick: async () => { if (await attempt(() => api(`/announcements/${a.id}/ack`, { method: 'POST', body: {} }), 'Acknowledged')) route(); } }, 'Got it')))));
  }

  cards.push(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Reports waiting on your level'), h('a', { href: '#/reports' }, 'All')),
    d.escalationsInbox.length ? d.escalationsInbox.slice(0, 6).map(escItem) : empty('Nothing waiting on you.')));

  if (d.escalationsMine.length) {
    cards.push(h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Your open reports'), h('a', { href: '#/reports?box=sent' }, 'All')),
      d.escalationsMine.slice(0, 6).map(escItem)));
  }

  if (d.recentConcerns) {
    cards.push(h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Client concerns this week')),
      d.recentConcerns.length ? d.recentConcerns.slice(0, 6).map((o) => h('div', { class: 'list-item' },
        h('div', { class: 'row' }, badge(o.severity), h('a', { href: `#/clients/${o.client_id}/log` }, o.client_name), h('span', { class: 'muted small' }, o.category)),
        h('div', { class: 'small' }, o.body.length > 160 ? `${o.body.slice(0, 160)}…` : o.body),
        h('div', { class: 'meta' }, `${o.author_name} · ${ago(o.at)}`))) : empty('No concerns logged in the last 7 days.')));
  }

  if (d.myClients) {
    const quick = can('clinical.write') && !can('clinical.view_all');
    cards.unshift(h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, can('clinical.view_all') ? 'Active clients' : 'My clients'), h('a', { href: '#/clients' }, 'All')),
      !d.myClients.length ? empty('You are not assigned to any clients yet.')
        : quick ? d.myClients.map((c) => h('div', { class: 'list-item client-quick' },
          h('a', { class: 'client-name', href: `#/clients/${c.id}/profile` }, `${c.first_name} ${c.last_name}`),
          h('div', { class: 'row' },
            h('a', { class: 'btn small', href: `#/clients/${c.id}/profile` }, 'Profile'),
            h('a', { class: 'btn small primary', href: `#/clients/${c.id}/collect` }, 'Collect data'))))
          : h('div', { class: 'chips' }, d.myClients.map((c) => h('a', { class: 'chip', href: `#/clients/${c.id}` }, `${c.first_name} ${c.last_name}`)))));
  }

  if (d.authAlerts) {
    cards.push(h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Authorizations needing attention'), h('a', { href: '#/insurance' }, 'All')),
      d.authAlerts.length ? d.authAlerts.slice(0, 6).map((a) => h('div', { class: 'list-item' },
        h('div', { class: 'row' }, h('a', { href: `#/clients/${a.client_id}/insurance` }, a.client_name), h('span', { class: 'muted small' }, a.service_code), h('span', { class: 'spacer' }), h('span', { class: 'small' }, `${a.units_used}/${a.units_approved}`)),
        usageBar(a.pct_used),
        h('div', { class: 'meta' }, a.alert_reasons.join(' · ')))) : empty('All authorizations look fine.')));
  }

  if (d.ideasToReview) {
    cards.push(h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Team ideas to review')),
      d.ideasToReview.length ? d.ideasToReview.slice(0, 6).map((s) => h('div', { class: 'list-item' },
        h('div', { class: 'row' }, h('a', { href: `#/clients/${s.client_id}/profile` }, s.client_name), h('span', { class: 'muted small' }, s.kind), h('span', { class: 'spacer' }),
          s.votes > 0 && h('span', { class: 'badge ok' }, `+${s.votes}`)),
        h('div', { class: 'small' }, s.title),
        h('div', { class: 'meta' }, `${s.author_name} · ${ago(s.created_at)}`))) : empty('No new ideas from the team.')));
  }

  if (d.myRidesToday) {
    cards.push(h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'My rides today'), h('a', { href: '#/transport' }, 'Open')),
      d.myRidesToday.length ? d.myRidesToday.map((r) => h('div', { class: 'list-item row' },
        h('strong', {}, fmtTime(r.scheduled_time)), h('span', {}, `${r.direction === 'pickup' ? 'Pick up' : 'Drop off'} ${r.client_name}`), h('span', { class: 'spacer' }), badge(r.status)))
        : empty('No rides assigned today.')));
  }

  mount(el,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, `${greet}, ${me.name.split(' ')[0]}`), h('div', { class: 'muted' }, fmtDate(new Date().toISOString().slice(0, 10)))),
      quick),
    stats.length && h('div', { class: 'stats' }, stats.map(([href, n, label]) => h('a', { class: 'card', href }, h('div', { class: 'stat' }, n), h('div', { class: 'stat-label' }, label)))),
    h('div', { class: 'grid' }, cards));
}

function escItem(e) {
  return h('div', { class: 'list-item' },
    h('div', { class: 'row' }, badge(e.priority), h('a', { href: `#/reports/${e.id}` }, e.subject), h('span', { class: 'spacer' }), badge(e.status)),
    h('div', { class: 'meta' }, `${e.created_by_name} · ${e.category} · ${ago(e.updated_at)}`));
}

// ---------- boot ----------
async function start() {
  try {
    state.me = await api('/me');
  } catch {
    return renderLogin();
  }
  await loadLists();
  renderShell();
  route();
}

state.onAuthLost = () => renderLogin('Your session ended. Please sign in again.');
window.addEventListener('hashchange', route);
window.addEventListener('app:rerender', route);
start();
