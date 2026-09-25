'use strict';

const { ROLES, deptOf, rankOf } = require('./permissions');
const { HttpError } = require('./auth');

const TARGET_DEPTS = ['clinical', 'admin', 'leadership'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

function maxRank(dept) {
  return Math.max(...Object.values(ROLES).filter((r) => r.dept === dept).map((r) => r.rank));
}

// Validates a (dept, rank) target for `user`. Within your own department you
// can only report upward; leadership is always rank 5.
function checkTarget(user, dept, rank) {
  if (!TARGET_DEPTS.includes(dept)) throw new HttpError(400, 'Choose who this goes to.');
  if (dept === 'leadership') return maxRank('leadership');
  const top = maxRank(dept);
  if (!Number.isInteger(rank) || rank < 1 || rank > top) throw new HttpError(400, 'Choose a valid level.');
  if (dept === deptOf(user) && rank <= rankOf(user)) {
    throw new HttpError(400, 'Within your department, reports go to a level above yours.');
  }
  return rank;
}

function createEscalation(db, user, { target_dept, target_rank, client_id = null, category, priority = 'normal', subject, body }) {
  const rank = checkTarget(user, target_dept, target_rank);
  if (!PRIORITIES.includes(priority)) throw new HttpError(400, 'Invalid priority.');
  const info = db.prepare(`INSERT INTO escalations (created_by, target_dept, target_rank, client_id, category, priority, subject, body)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(user.id, target_dept, rank, client_id, category, priority, subject, body);
  return Number(info.lastInsertRowid);
}

// The next level up from the user within their department (or leadership at the top).
function defaultUpTarget(user) {
  const dept = deptOf(user);
  if (dept === 'leadership') return { target_dept: 'leadership', target_rank: maxRank('leadership') };
  const higher = Object.values(ROLES).filter((r) => r.dept === dept && r.rank > rankOf(user)).map((r) => r.rank);
  if (!higher.length) return { target_dept: 'leadership', target_rank: maxRank('leadership') };
  return { target_dept: dept, target_rank: Math.min(...higher) };
}

module.exports = { TARGET_DEPTS, PRIORITIES, maxRank, checkTarget, createEscalation, defaultUpTarget };
