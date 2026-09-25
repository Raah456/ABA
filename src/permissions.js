'use strict';

// Every role belongs to a department and has a rank. Rank drives "report up"
// (escalations go to a department at a minimum rank) and announcement targeting.
const ROLES = {
  technician:        { label: 'Behavior Technician',          dept: 'clinical',   rank: 1 },
  senior_tech:       { label: 'Senior Technician / Lead',     dept: 'clinical',   rank: 2 },
  qsp:               { label: 'QSP (Supervising Professional)', dept: 'clinical', rank: 3 },
  clinical_director: { label: 'Clinical Director',            dept: 'clinical',   rank: 4 },
  driver:            { label: 'Driver',                       dept: 'admin',      rank: 1 },
  admin_staff:       { label: 'Admin Staff',                  dept: 'admin',      rank: 1 },
  coordinator:       { label: 'Scheduling / Transport Coordinator', dept: 'admin', rank: 2 },
  billing:           { label: 'Insurance & Billing Specialist', dept: 'admin',    rank: 2 },
  office_manager:    { label: 'Office Manager',               dept: 'admin',      rank: 3 },
  executive:         { label: 'Executive / Owner',            dept: 'leadership', rank: 5 },
};

const DEPARTMENTS = {
  clinical: 'Clinical',
  admin: 'Admin',
  leadership: 'Leadership',
};

// Capability -> roles that hold it. This table is the privacy policy of the
// platform: if a role is not listed, the API refuses the request.
const CAPABILITIES = {
  // People & accounts
  'users.manage':            ['executive', 'office_manager'],
  'assignments.manage':      ['qsp', 'clinical_director', 'office_manager', 'executive'],

  // Client demographics (name, DOB, guardian, address) for the whole roster.
  // Technicians see only their assigned clients (via clinical.view_assigned);
  // drivers only see what is on their own rides.
  'clients.view_basic':      ['qsp', 'clinical_director', 'admin_staff', 'coordinator',
                              'billing', 'office_manager', 'executive'],
  'clients.edit_basic':      ['qsp', 'clinical_director', 'admin_staff', 'coordinator',
                              'billing', 'office_manager', 'executive'],

  // Clinical record: programs, data, session notes, client log.
  // Admin roles never see these.
  'clinical.view_all':       ['qsp', 'clinical_director', 'executive'],
  'clinical.view_assigned':  ['technician', 'senior_tech'],
  'clinical.write':          ['technician', 'senior_tech', 'qsp', 'clinical_director'],
  'programs.manage':         ['qsp', 'clinical_director'],
  'notes.approve':           ['qsp', 'clinical_director'],
  'templates.manage':        ['qsp', 'clinical_director'],
  // Client profile (reinforcers, triggers, what helps). Everyone on the team reads it
  // and can share ideas; leads and QSPs keep the profile itself current.
  'profile.edit':            ['senior_tech', 'qsp', 'clinical_director'],

  // Insurance, eligibility checks, authorizations.
  'insurance.view':          ['admin_staff', 'billing', 'office_manager', 'executive'],
  'insurance.edit':          ['admin_staff', 'billing', 'office_manager'],
  // Remaining authorized units only (no member IDs), so clinicians can plan hours.
  'insurance.view_summary':  ['qsp', 'clinical_director', 'coordinator'],

  // Billing queue: date / code / units / provider of approved notes. Never note content.
  'billing.view':            ['billing', 'office_manager', 'executive'],
  'billing.mark':            ['billing', 'office_manager'],

  // Transportation
  'transport.manage':        ['admin_staff', 'coordinator', 'office_manager', 'executive'],
  'transport.view_own':      ['driver'],
  'transport.view_assigned': ['technician', 'senior_tech', 'qsp', 'clinical_director'],

  // Communication
  'announcements.create':    ['senior_tech', 'qsp', 'clinical_director', 'coordinator',
                              'billing', 'office_manager', 'executive'],

  // Settings / oversight
  'lists.manage.clinical':   ['qsp', 'clinical_director', 'executive'],
  'lists.manage.admin':      ['office_manager', 'executive'],
  'audit.view':              ['executive'],
};

function roleInfo(role) {
  return ROLES[role] || null;
}

function can(user, capability) {
  if (!user) return false;
  const roles = CAPABILITIES[capability];
  if (!roles) throw new Error(`Unknown capability: ${capability}`);
  return roles.includes(user.role);
}

function capabilitiesFor(role) {
  return Object.keys(CAPABILITIES).filter((c) => CAPABILITIES[c].includes(role));
}

function deptOf(user) {
  return roleInfo(user.role)?.dept;
}

function rankOf(user) {
  return roleInfo(user.role)?.rank ?? 0;
}

// Can this user see an escalation addressed to (dept, rank)?
// Visible to its author, to anyone in the target department at or above the
// target rank, and to leadership.
function canSeeEscalation(user, esc) {
  if (esc.created_by === user.id) return true;
  if (deptOf(user) === 'leadership') return true;
  return deptOf(user) === esc.target_dept && rankOf(user) >= esc.target_rank;
}

// Can this user see an announcement? `audience` is { depts: [], roles: [] };
// empty arrays mean "everyone". Leadership sees every announcement.
function isInAudience(user, audience) {
  if (deptOf(user) === 'leadership') return true;
  const depts = audience.depts || [];
  const roles = audience.roles || [];
  if (depts.length && !depts.includes(deptOf(user))) return false;
  if (roles.length && !roles.includes(user.role)) return false;
  return true;
}

// Which departments may this user address an announcement to?
function announceableDepts(user) {
  if (!can(user, 'announcements.create')) return [];
  if (deptOf(user) === 'leadership' || rankOf(user) >= 3) return ['clinical', 'admin'];
  return [deptOf(user)];
}

module.exports = {
  ROLES,
  DEPARTMENTS,
  CAPABILITIES,
  roleInfo,
  can,
  capabilitiesFor,
  deptOf,
  rankOf,
  canSeeEscalation,
  isInAudience,
  announceableDepts,
};
