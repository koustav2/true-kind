/* ==========================================================================
   Manager access — a second, restricted tier inside /portal/admin.

   THE CONSTRAINT
   --------------
   User.role is ENUM('member','admin') on a live table, and a bare
   sequelize.sync() cannot extend an ENUM. So a manager is not a third role: it
   is a MEMBER row with a grant in ManagerAccess listing the sections they may
   work.

   THE RULE, and why it is this way round
   --------------------------------------
   DEFAULT DENY. A route reaches a manager only if it appears in the ALLOW table
   below. Anything not listed is admin-only.

   That direction is the whole design. The alternative — deny-list — would mean
   every route added to routes/admin.js in future is silently manager-accessible
   the moment it is written, and the person writing it has no reason to think
   about who should see it. With an allow-list, forgetting to think about
   permissions fails closed: the manager gets a 403 and somebody asks why. That
   is a bug report. The other way round is a data leak nobody notices.

   NEVER GRANTABLE, at any section level:
     - account deactivation and reactivation      (/members/:id/access)
     - issuing volunteer logins and passwords     (/volunteers/:id/login)
     - the CMS, the media library, the board      (separate routers + /board)
     - the manager section itself                 (/managers*)
     - deleting anything
   A manager who can create managers is an admin with extra steps; a manager who
   can issue a password can take over any account.

   The mount path is stripped before matching, so these patterns are written
   against paths relative to /portal/admin — the same way they are declared in
   routes/admin.js. Matching the full path would silently break if the router
   were ever mounted elsewhere.
   ========================================================================== */
'use strict';

/* The sections an admin can grant. Order is the order they appear in the UI. */
const SECTIONS = [
  { key: 'memberships',  label: 'New memberships & payments',
    help: 'See unpaid registrations and record a fee taken in cash, bank, UPI or cheque.' },
  { key: 'members',      label: 'Member list (read only)',
    help: 'Open the member list and member pages. Cannot deactivate anyone.' },
  { key: 'certificates', label: 'Certificates',
    help: 'Issue, withdraw and print certificates, including visitor certificates.' },
  { key: 'idcards',      label: 'ID cards',
    help: 'Fill in card details and print ID cards.' },
  { key: 'donations',    label: 'Donations',
    help: 'See donations and record one taken offline.' },
  { key: 'volunteers',   label: 'Volunteer applications',
    help: 'Work the volunteer queue and update statuses. Cannot create logins.' },
  { key: 'enquiries',    label: 'Contact enquiries',
    help: 'Read and update contact enquiries.' },
  { key: 'notices',      label: 'Notices',
    help: 'Post and withdraw portal notices.' },
  { key: 'verification', label: 'Verification log',
    help: 'See which cards and certificates have been scanned.' },
  { key: 'reports',      label: 'Report downloads',
    help: 'Download the CSV exports.' }
];

const SECTION_KEYS = SECTIONS.map(s => s.key);

/* ---- the allow table ----------------------------------------------------
   [section, method, RegExp] against the path relative to /portal/admin.
   GET-only entries are read access; the POST entries are named individually so
   that "can see the member list" never accidentally means "can change it".
   ------------------------------------------------------------------------- */
const ALLOW = [
  // The dashboard is visible to any manager — it is counts, nothing more.
  [null,           'GET',  /^\/$/],

  ['memberships',  'GET',  /^\/members(\?.*)?$/],
  ['memberships',  'POST', /^\/members\/\d+\/membership$/],
  ['memberships',  'GET',  /^\/membership-receipts$/],
  ['memberships',  'GET',  /^\/membership-receipts\/\d+\/pdf$/],
  ['memberships',  'GET',  /^\/members\/\d+\/receipt\.pdf$/],

  ['members',      'GET',  /^\/members$/],
  ['members',      'GET',  /^\/members\/\d+$/],
  ['members',      'GET',  /^\/users$/],
  ['members',      'GET',  /^\/members\/\d+\/card\.pdf$/],

  ['certificates', 'GET',  /^\/certificates$/],
  ['certificates', 'GET',  /^\/certificates\/\d+$/],
  ['certificates', 'POST', /^\/certificates$/],
  ['certificates', 'POST', /^\/certificates\/\d+\/issue$/],
  ['certificates', 'POST', /^\/certificates\/\d+\/style$/],
  ['certificates', 'GET',  /^\/certificates\/generate$/],
  ['certificates', 'GET',  /^\/certificates\/issued$/],
  ['certificates', 'POST', /^\/members\/\d+\/certificate$/],
  ['certificates', 'GET',  /^\/members\/\d+\/certificate\/\d+\.pdf$/],
  ['certificates', 'POST', /^\/members\/\d+\/certificate\/\d+\/revoke$/],
  ['certificates', 'GET',  /^\/visitor-certificates$/],
  ['certificates', 'POST', /^\/visitor-certificates$/],
  ['certificates', 'GET',  /^\/visitor-certificates\/\d+\.pdf$/],
  ['certificates', 'POST', /^\/visitor-certificates\/\d+\/revoke$/],

  ['idcards',      'POST', /^\/members\/\d+\/idcard$/],
  ['idcards',      'GET',  /^\/members\/\d+\/idcard\.pdf$/],

  ['donations',    'GET',  /^\/donations$/],
  ['donations',    'GET',  /^\/receipts$/],
  ['donations',    'GET',  /^\/receipts\/[a-z-]+$/],
  ['donations',    'POST', /^\/donations\/offline$/],

  ['volunteers',   'GET',  /^\/volunteers$/],
  ['volunteers',   'POST', /^\/volunteers\/\d+\/status$/],

  ['enquiries',    'GET',  /^\/enquiries$/],
  ['enquiries',    'POST', /^\/enquiries\/\d+\/status$/],

  ['notices',      'GET',  /^\/notices$/],
  ['notices',      'POST', /^\/notices$/],
  ['notices',      'POST', /^\/notices\/\d+\/toggle$/],

  ['verification', 'GET',  /^\/verification-log$/],

  ['reports',      'GET',  /^\/reports$/],
  ['reports',      'GET',  /^\/[a-z-]+\.csv$/]
];

/**
 * Can a manager holding `sections` perform `method` on `path`?
 * `path` is relative to the /portal/admin mount, without a query string.
 */
function managerMay(sections, method, path) {
  const held = new Set(Array.isArray(sections) ? sections : []);
  const m = String(method || 'GET').toUpperCase();
  const p = String(path || '/').split('?')[0].replace(/\/+$/, '') || '/';
  for (const [section, verb, re] of ALLOW) {
    if (verb !== m) continue;
    if (!re.test(p)) continue;
    // section === null means "any manager", not "everyone".
    if (section === null || held.has(section)) return true;
  }
  return false;
}

/** Keep only real section keys — an admin cannot invent a permission. */
function cleanSections(raw) {
  const list = [].concat(raw || []);
  return SECTION_KEYS.filter(k => list.includes(k));
}

module.exports = { SECTIONS, SECTION_KEYS, ALLOW, managerMay, cleanSections };
