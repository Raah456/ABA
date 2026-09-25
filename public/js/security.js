// Two-factor sign-in (setup, account settings) and the owner's Security & backups page.
import {
  state, h, mount, api, attempt, rerender, modal, field, input, formValues, fmtDate, fmtDateTime, badge, table, toast, roleLabel,
  confirmDialog, empty,
} from './lib.js';

const codeInput = (name = 'code', placeholder = '6-digit code') => h('input', {
  name, type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9 ]*', maxlength: 7,
  placeholder, required: true, class: 'code-input', 'aria-label': placeholder,
});

function recoveryCodesBlock(codes) {
  const text = codes.join('\n');
  const copy = h('button', { type: 'button', class: 'btn small', onclick: async () => {
    try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { window.getSelection().selectAllChildren(list); }
  } }, 'Copy codes');
  const list = h('ol', { class: 'recovery-codes' }, codes.map((c) => h('li', {}, c)));
  return h('div', { class: 'stack' },
    h('div', { class: 'banner warn' }, 'Save these recovery codes somewhere safe, like a password manager. Each one works once if you lose your phone. You won\'t see them again.'),
    list, copy);
}

// Walks a person through turning on two-factor. `forced`: required by the practice before they can continue.
export function twoFactorSetup(el, { forced = false, onDone }) {
  const intro = () => mount(el,
    h('h2', {}, forced ? 'Set up two-factor sign-in' : 'Turn on two-factor sign-in'),
    forced && h('p', {}, 'Your practice requires a second step when you sign in, to protect client records. It takes about two minutes.'),
    h('ol', { class: 'steps' },
      h('li', {}, 'Install an authenticator app on your phone if you don\'t have one: Google Authenticator, Microsoft Authenticator, or your password manager.'),
      h('li', {}, 'Scan the code on the next screen with that app.'),
      h('li', {}, 'Type the 6-digit code the app shows.')),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: scan }, 'Get started')));

  const scan = async () => {
    const s = await attempt(() => api('/me/2fa/setup', { method: 'POST', body: {} }));
    if (!s) return;
    const form = h('form', {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        const r = await attempt(() => api('/me/2fa/enable', { method: 'POST', body: { code: form.code.value } }));
        if (r) done(r.recoveryCodes);
      },
    },
    h('h2', {}, 'Scan this with your authenticator app'),
    h('div', { class: 'qr-wrap' }, h('img', { class: 'qr', alt: 'QR code to add ABA Practice to your authenticator app', src: `data:image/svg+xml;utf8,${encodeURIComponent(s.qrSvg)}` })),
    h('details', {}, h('summary', { class: 'small' }, 'Can\'t scan? Enter this key instead'),
      h('p', { class: 'mono' }, s.secret), h('p', { class: 'muted small' }, 'Choose "time-based" if the app asks.')),
    field('Code from the app', codeInput(), { required: true }),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Turn on')));
    mount(el, form);
    form.code.focus();
  };

  const done = (codes) => mount(el,
    h('h2', {}, '✓ Two-factor sign-in is on'),
    recoveryCodesBlock(codes),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: () => onDone?.() }, 'I saved my codes, continue')));

  intro();
}

// Full-screen setup shown right after sign-in when the practice requires it.
export function renderForcedSetup(app, { onDone, onSignOut }) {
  const box = h('div', { class: 'card' });
  mount(app, h('div', { class: 'login' }, h('div', {}, box,
    h('p', { class: 'muted small center' }, `Signed in as ${state.me.user.email}. `, h('button', { class: 'link', type: 'button', onclick: onSignOut }, 'Sign out')))));
  twoFactorSetup(box, { forced: true, onDone });
}

// "Two-factor sign-in" card on My account.
export async function twoFactorCard() {
  const s = await api('/me/2fa');
  const card = h('div', { class: 'card' });
  if (!s.enabled) {
    mount(card, h('h2', {}, 'Two-factor sign-in'), badge('open', 'Off'),
      h('p', { class: 'muted small' }, 'Adds a 6-digit code from your phone when you sign in, so a stolen password alone can\'t open client records.'),
      h('button', { class: 'btn primary', onclick: () => twoFactorSetup(card, { onDone: rerender }) }, 'Turn on'));
    return card;
  }
  mount(card, h('h2', {}, 'Two-factor sign-in'), badge('active', 'On'),
    h('p', { class: 'small' }, `${s.recoveryRemaining} of 10 recovery codes left.`),
    s.recoveryRemaining <= 3 && h('div', { class: 'banner warn' }, 'You are running low on recovery codes. Make new ones.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => modal('New recovery codes', h('div', {},
        h('p', { class: 'muted small' }, 'Your old recovery codes will stop working.'), field('Code from your authenticator app', codeInput(), { required: true })), {
        submitLabel: 'Make new codes',
        onSubmit: async (form) => {
          const r = await api('/me/2fa/recovery-codes', { method: 'POST', body: { code: form.code.value } });
          modal('Your new recovery codes', recoveryCodesBlock(r.recoveryCodes), { onClose: rerender });
          return true;
        },
      }) }, 'New recovery codes'),
      !s.required && h('button', { class: 'btn danger', onclick: () => modal('Turn off two-factor sign-in', h('div', {},
        field('Password', input('password', { type: 'password', required: true }), { required: true }),
        field('Code from your app (or a recovery code)', h('input', { name: 'code', type: 'text', required: true, autocomplete: 'one-time-code' }), { required: true })), {
        submitLabel: 'Turn off', danger: true,
        onSubmit: async (form) => { await api('/me/2fa/disable', { method: 'POST', body: formValues(form) }); toast('Two-factor sign-in is off'); rerender(); return true; },
      }) }, 'Turn off')),
    s.required && h('p', { class: 'muted small' }, 'Your practice requires two-factor sign-in. Lost your phone? Use a recovery code, or ask your office manager to reset it.'));
  return card;
}

// ---------- owner: Security & backups ----------
const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export async function securityView(el) {
  const s = await api('/security');
  const withApp = s.users.filter((u) => u.active && u.totp_enabled).length;
  const active = s.users.filter((u) => u.active).length;

  const policy = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Two-factor sign-in'), badge(s.require2fa ? 'active' : 'open', s.require2fa ? 'Required' : 'Optional')),
    h('p', { class: 'small' }, `${withApp} of ${active} active staff have it turned on.`),
    h('p', { class: 'muted small' }, 'When required, anyone without it must set it up the next time they use the app. Required is recommended before real client records go in.'),
    h('button', { class: `btn ${s.require2fa ? '' : 'primary'}`, onclick: async () => {
      const turningOn = !s.require2fa;
      if (!turningOn && !await confirmDialog('Make two-factor optional? Staff could then sign in with just a password.', { confirmLabel: 'Make optional' })) return;
      if (await attempt(() => api('/security/require-2fa', { method: 'PUT', body: { required: turningOn } }), turningOn ? 'Two-factor is now required' : 'Two-factor is now optional')) rerender();
    } }, s.require2fa ? 'Make optional' : 'Require for everyone'),
    h('details', {}, h('summary', { class: 'small' }, 'Who has it on'),
      table([
        { label: 'Name', key: 'name' },
        { label: 'Role', render: (u) => roleLabel(u.role) },
        { label: 'Two-factor', render: (u) => (u.totp_enabled ? badge('active', 'On') : badge(s.require2fa ? 'open' : '', 'Off')) },
      ], s.users.filter((u) => u.active))),
    h('p', { class: 'muted small' }, 'Lost phone? Staff accounts → the person → "Reset two-factor".'));

  let backups;
  if (!s.backups) {
    backups = h('div', { class: 'card' }, h('h2', {}, 'Backups'), empty('Backups run on the real server, not in this demo.'));
  } else {
    const b = s.backups;
    backups = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Backups'),
        badge(b.lastError ? 'urgent' : b.overdue ? 'high' : 'active', b.lastError ? 'Failing' : b.overdue ? 'Overdue' : 'OK')),
      b.lastError && h('div', { class: 'banner bad' }, `Last backup failed ${fmtDateTime(b.lastError.at.replace('T', ' ').slice(0, 19))}: ${b.lastError.message}`),
      !b.enabled && h('div', { class: 'banner warn' }, 'Automatic backups are turned off (BACKUP_INTERVAL_HOURS=0).'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Last backup'), h('dd', {}, b.latest ? `${fmtDateTime(b.latest.at.replace('T', ' ').slice(0, 19))} (${kb(b.latest.size)})` : 'None yet'),
        h('dt', {}, 'Schedule'), h('dd', {}, b.enabled ? `Every ${b.intervalHours} hours` : 'Off'),
        h('dt', {}, 'Kept'), h('dd', {}, `${b.count} backup${b.count === 1 ? '' : 's'}, ${kb(b.totalBytes)}: every backup for ${b.keepDays} days, then one a month for ${b.keepMonths} months`),
        h('dt', {}, 'Protection'), h('dd', {}, 'Encrypted (AES-256). Restoring needs the practice\'s encryption key.')),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async (e) => {
        e.target.disabled = true;
        const r = await attempt(() => api('/security/backup-now', { method: 'POST', body: {} }));
        if (r) { toast('Backup finished'); rerender(); } else e.target.disabled = false;
      } }, 'Back up now')),
      h('p', { class: 'muted small' }, 'Backups on the same server don\'t survive losing the server. Turn on the off-site copy in the hosting guide (docs/DEPLOY.md).'));
  }

  mount(el,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Security & backups'),
      h('div', { class: 'muted' }, s.production ? 'Running in production mode: HTTPS only.' : 'Not in production mode. Use the hosting guide before storing real client records.'))),
    h('div', { class: 'grid' }, policy, backups));
}
