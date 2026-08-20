/* ==========================================================================
   CSRF protection.

   The app had none — every state-changing POST (admin content saves,
   certificate issuing, volunteer status changes, payments, sign-out) was
   forgeable by any page the admin happened to visit while signed in. The only
   thing standing in the way was Chrome's default sameSite=Lax, which is
   browser-dependent and does not cover top-level GET navigation.

   Implementation is a per-session synchroniser token:
     - one secret per session, minted lazily
     - exposed to every EJS view as `csrfToken` (res.locals)
     - required on every unsafe method, from either the `_csrf` form field or
       the `X-CSRF-Token` header (the header form is what the click-to-edit
       fetch() calls use)
     - compared with timingSafeEqual, not ===

   Deliberately not a dependency: `csurf` is deprecated and unmaintained.
   ========================================================================== */
const crypto = require('crypto');

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function token(req) {
  if (!req.session) return '';
  if (!req.session.csrfSecret) req.session.csrfSecret = crypto.randomBytes(32).toString('hex');
  return req.session.csrfSecret;
}

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !a) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch (e) { return false; }
}

/* Publish the token to views. Mount this once, after session().

   Deliberately a lazy getter rather than `res.locals.csrfToken = token(req)`.
   This middleware runs on every request including the 9 static pages, and
   minting eagerly would write a session secret — and therefore persist a
   Sessions row — for every anonymous visitor and every crawler hit. With the
   getter, the secret is only created when a template actually renders it. */
function csrfContext(req, res, next) {
  Object.defineProperty(res.locals, 'csrfToken', {
    configurable: true,
    enumerable: true,
    get() { return token(req); }
  });
  next();
}

/* Enforce on unsafe methods. Mount after csrfContext.
   `exempt` — array of path prefixes that legitimately cannot carry a token:
   the public JSON form endpoints, which a visitor reaches with no session at
   all (the token here is session-bound, so there is nothing to bind), and the
   payment gateway's server-to-server callback, which comes from PhonePe and
   carries its own signature. Those are protected by rate limiting + honeypot
   instead. */
function csrfGuard(exempt = []) {
  return function (req, res, next) {
    if (SAFE.has(req.method)) return next();
    if (exempt.some(p => req.path === p || req.path.startsWith(p))) return next();

    // File uploads need the query fallback. This guard is a single global choke
    // point and therefore runs BEFORE multer, so on a multipart request
    // req.body is still empty and the _csrf form field is invisible here — a
    // plain <form enctype="multipart/form-data"> would fail every time, and it
    // cannot set a header to compensate. Those forms put the token in the action
    // URL instead. Restricted to multipart so the ordinary POST surface stays
    // header/body-only and tokens stay out of URLs everywhere else.
    const isMultipart = (req.get('content-type') || '').includes('multipart/form-data');
    const sent = (req.body && req.body._csrf)
              || req.get('X-CSRF-Token') || req.get('X-Csrf-Token')
              || (isMultipart ? req.query._csrf : null);
    if (sameToken(sent, req.session && req.session.csrfSecret)) return next();

    // Answer in the shape the caller asked for: fetch() callers get JSON so the
    // client can show a real message instead of parse-erroring on an HTML page.
    const wantsJson = req.get('X-Requested-With') === 'fetch' ||
                      (req.get('accept') || '').includes('application/json');
    if (wantsJson) return res.status(403).json({ ok: false, error: 'csrf', message: 'Session expired — reload the page and try again.' });
    return res.status(403).render('error', {
      title: 'Session expired',
      message: 'Your session expired or the form was stale. Go back, reload the page and try again.'
    });
  };
}

module.exports = { csrfContext, csrfGuard };
