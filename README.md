# ABA Practice Platform

One platform for an ABA practice with two workspaces, **Clinical** and **Admin**, that share one client
list and one communication system. Role-based permissions keep each side's private information private.

## Why one platform instead of two apps

Clinical and admin work on the same clients, and their work feeds into each other:

- An approved session note uses up units on an insurance authorization.
- Transportation depends on the client list and the schedule.
- Technicians need to report problems to the office manager, and drivers need to report to clinical staff.

With two apps, staff would re-type the same data in both places. That is the scattering problem the
platform is meant to fix. Privacy is handled by permissions instead:
**admin roles cannot open clinical records, and clinical roles cannot see insurance member IDs or billing.**
The whole policy is one table in [`src/permissions.js`](src/permissions.js), and the API enforces it on every request.

## How it maps to the problems

| Problem | What the platform does |
|---|---|
| Waiting on Motivity for updates and customizations | QSPs build their own **session note templates** (fields, dropdowns, required items) and **programs** (targets, measurement type, mastery criteria). Dropdown lists (categories, service codes, payers) can be edited in Settings. None of this needs a vendor. |
| "Different people say different things" | **Announcements** are the official word. They go to a department or to specific roles, and each person clicks "I have read this." Supervisors see who hasn't read it yet. Every **program change** is logged with who changed it and why, so everyone works from the same version. |
| Observations about clients end up scattered | Each client has one **client log**. Everyone on the care team adds to it and reads from it, filtered by category and flagged *info / concern / urgent*. Concerns from the past week appear on the dashboard. |
| Trial data | QSPs write **trials** for each program, and every trial needs a description (what to present, what counts as correct), so anyone running it does it the same way. Techs open **Collect data** on a client and tap *Correct / Prompted / Incorrect / No response* each time they run a trial, for all of that client's programs, then save once. The graph, mastery check and a trial-by-trial breakdown are calculated from those taps. Retired trials stay in the history. |
| Knowing how to work with a client | Each client has a **profile** that opens first: reinforcers ranked by strength (and ones that stopped working), how the client communicates, how to reinforce them, triggers, what calms them, sensory needs, family notes. Every change is logged with who made it. |
| Knowledge stuck with one person | Any tech on the team can **share what works** (a reinforcer, a calming strategy, a trigger). Others can tap "Worked for me too", and a lead or QSP adds it to the profile with the tech's name on it, or says why not. **Safety & medical alerts** are also shown to drivers and the front desk. |
| No way to report things higher up | **Report up** sends a concern to a level (for example "QSP and above" or "Office Manager"), and it is tracked until someone resolves it: acknowledged, replied to, sent higher, resolved. Urgent client observations go to the QSP automatically. Within your own department, reports can only go up. |
| Morning insurance checks on paper | **Eligibility checklist**: each morning shows which policies are due (never checked, past their check interval, or last result not "active"). Log each check in one click; the result and who checked it are visible to everyone who needs it. |
| Authorizations tracked in Excel | Units used are calculated from **approved session notes**. The dashboard flags authorizations that expire within 30 days, are 80% or more used, or are over their limit. QSPs see remaining units, but not member IDs, so they can plan hours. |
| Driver coordination on spreadsheets | **Transportation board**: one column per driver for the day, plus an "Unassigned" column. "Copy from another day" rebuilds a recurring week. Drivers get a phone-friendly "My rides" page with the guardian's phone number and a status dropdown. |
| Billing | Once a QSP approves a note, the **billing queue** receives the date, code, units, provider and authorization, **but never the note text**. Billing can export CSV and mark notes as billed. |

## Roles and who sees what

| Role | Department | Rank | Sees |
|---|---|---|---|
| Behavior Technician | Clinical | 1 | Only clients on their care team: profile, log, programs, trial data, their own notes. Can share ideas for the profile |
| Senior Technician / Lead | Clinical | 2 | Same as technicians, plus edits client profiles, reviews team ideas, posts announcements to clinical |
| QSP | Clinical | 3 | All clinical records, approves notes, builds programs and templates, sees authorization units remaining |
| Clinical Director | Clinical | 4 | Same as QSP |
| Driver | Admin | 1 | Only their own rides (client name, addresses, guardian phone, safety & medical alerts) |
| Admin Staff | Admin | 1 | Client roster, insurance and eligibility checks, transportation |
| Scheduling / Transport Coordinator | Admin | 2 | Roster, transportation, authorization units remaining |
| Insurance & Billing Specialist | Admin | 2 | Roster, insurance, authorizations, billing queue |
| Office Manager | Admin | 3 | Everything admin, plus staff accounts |
| Executive / Owner | Leadership | 5 | Everything, plus the audit log |

No admin role can open programs, program data, session notes or the client log.

## Running it

Requirements: **Node.js 22.5 or newer**. No database server is needed; data is stored in one SQLite file.

```bash
npm install
npm run seed            # loads fictional demo data into data/aba-practice.db
DEMO_MODE=1 npm start   # http://localhost:3000; the sign-in page lists the demo accounts
npm test                # API tests for the privacy rules and workflows
```

Every demo account uses the password `demo-password` (for example `tech@demo.test`, `qsp@demo.test`,
`frontdesk@demo.test`, `coord@demo.test`, `billing@demo.test`, `driver@demo.test`, `exec@demo.test`).
To see the privacy rules in action, sign in as different roles and compare what each one can see.

To start with a blank database, skip the seed step and create the first executive account:

```bash
ADMIN_EMAIL=you@yourpractice.com ADMIN_PASSWORD='a-long-password' npm start
```

## Built-in security

- Passwords are hashed with scrypt. Sessions use HttpOnly, SameSite=Strict cookies, and sign-in is rate-limited.
- Automatic sign-out after 30 minutes of inactivity.
- **Audit log** of every sign-in, every view of a client record, and every change. Executives can filter it by person or client.
- Health-record responses are sent with `Cache-Control: no-store`. A strict Content-Security-Policy is set, and the API only accepts JSON requests (CSRF protection).
- Session notes keep a snapshot of the template they were written with, so editing a template never changes old notes.
  Submitted and approved notes are locked.

## Before real client data goes in (important)

This is a working MVP, not a finished product. Before storing real PHI:

1. **Hosting with a BAA.** Run it on a HIPAA-eligible host that will sign a Business Associate Agreement
   (for example AWS, Azure or Google Cloud with a BAA). Serve it only over HTTPS and encrypt the disk.
2. **Backups.** Back up the SQLite file on a schedule and practice restoring it. For many users at once or several
   locations, move to PostgreSQL. The SQL is kept simple so that move is small.
3. **Policies.** Have your compliance lead review the role table in `src/permissions.js`. It is your
   minimum-necessary access policy in code.
4. **Two-factor sign-in** is not built yet and is strongly recommended.
5. **Motivity data**: export your programs, targets and client list from Motivity as CSV. An import script is a
   good next step.

## Not included yet

- Claim submission to payers (837 files or a clearinghouse). The billing queue ends at "export and mark billed".
- Electronic signatures on notes (caregiver and staff).
- Staff scheduling and session calendars.
- Direct messages between individuals (announcements and reports cover top-down and bottom-up communication).
- Incident report forms. The note template has an "incident occurred" checkbox, and urgent observations escalate automatically.

## Project layout

```
src/
  permissions.js   roles, ranks and the capability table (the privacy policy)
  db.js            SQLite schema
  auth.js          passwords, sessions, idle timeout
  access.js        per-client access checks, audit logging, validation
  escalations.js   report-up rules
  routes/          core (auth, users, lists, dashboard), clients, clinical, admin, comms
  seed.js          fictional demo data
public/            the web app (plain JavaScript modules, no build step)
test/              API tests (node --test)
```
