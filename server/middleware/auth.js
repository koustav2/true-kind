/* ==========================================================================
   Auth guards.

   Two things changed here beyond the original redirect logic:

   1. BLOCKING IS ENFORCED PER REQUEST, not at sign-in. requireAdmin used to
      trust `req.session.role`, a value snapshotted when the session was created.
      That meant demoting or deactivating someone had no effect until their
      cookie expired — up to seven days of continued access. Both guards now read
      the account state, so a deactivation takes effect on that user's very next
      click and their session is destroyed.

   2. A TEMPORARY PASSWORD IS A DEAD END until it is changed. When an admin
      issues one, the holder can reach the change-password page and nothing else.
      Otherwise a password read off an admin screen and sent over WhatsApp would
      stay valid indefinitely.

   The cost is one indexed lookup per authenticated request. On a portal with a
   handful of concurrent users that is the right trade against handing a
   deactivated account a week of access.
   ========================================================================== */

const CHANGE_PATH = '/portal/member/password';

/* Required lazily: ../models pulls in ../db, which reads DB_DIALECT at load
   time, and this file is required by routes that load very early. */
function models() { return require('../models'); }

async function loadAccount(req) {
  const { User, UserAccess } = models();
  const user = await User.findByPk(req.session.userId);
  if (!user) return { user: null, access: null };
  const access = await UserAccess.findOne({ where: { userId: user.id } });
  return { user, access };
}

/* The full path, not req.path.

   These guards run inside routers mounted at /portal/member and /portal/admin,
   and inside a mounted router req.path is relative to the mount point — the
   change-password page arrives as '/password', never as
   '/portal/member/password'. Comparing req.path to CHANGE_PATH therefore never
   matched, so a user holding a temporary password was redirected to the page
   they were already on: ERR_TOO_MANY_REDIRECTS, and no way to sign in at all. */
function fullPath(req) {
  return (req.baseUrl || '') + (req.path === '/' ? '' : req.path) || req.path;
}

function wantsJson(req) {
  return req.get('X-Requested-With') === 'fetch' ||
         (req.get('accept') || '').includes('application/json');
}

function deny(req, res, status, code, message) {
  if (wantsJson(req)) return res.status(status).json({ ok: false, error: code, message });
  return res.status(status).render('error', { title: 'Not available', message });
}

async function requireLogin(req, res, next) {
  if (!req.session.userId) return res.redirect('/portal/signin');
  let acct;
  try { acct = await loadAccount(req); } catch (e) { return next(e); }

  if (!acct.user) {
    // The account was deleted while its session was still alive.
    return req.session.destroy(() => res.redirect('/portal/signin'));
  }
  if (acct.access && acct.access.blocked) {
    return req.session.destroy(() => deny(req, res, 403, 'blocked',
      'This account has been deactivated. Please contact the Foundation if you think this is a mistake.'));
  }
  if (acct.access && acct.access.mustChangePassword && fullPath(req) !== CHANGE_PATH) {
    return res.redirect(CHANGE_PATH);
  }
  req.account = acct.user;
  next();
}

async function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.redirect('/portal/signin');
  let acct;
  try { acct = await loadAccount(req); } catch (e) { return next(e); }

  if (!acct.user) {
    return req.session.destroy(() => res.redirect('/portal/signin'));
  }
  if (acct.access && acct.access.blocked) {
    return req.session.destroy(() => deny(req, res, 403, 'blocked',
      'This account has been deactivated.'));
  }
  // Role comes from the database, not the session, so a demotion applies at once
  // rather than surviving until the cookie expires.
  if (acct.user.role !== 'admin') {
    return deny(req, res, 403, 'forbidden', 'Admin access only.');
  }
  if (acct.access && acct.access.mustChangePassword && fullPath(req) !== CHANGE_PATH) {
    return res.redirect(CHANGE_PATH);
  }
  req.account = acct.user;
  req.session.role = acct.user.role;   // keep the views' copy honest
  next();
}

module.exports = { requireLogin, requireAdmin, CHANGE_PATH };
