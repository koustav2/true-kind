require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const { sequelize, ensureDatabase } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1); // behind nginx
// 1mb, not the old 64kb: a CMS save can carry a long article body plus the
// surrounding block metadata. Same for urlencoded, whose default was 100kb.
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '1mb' }));    // public-site forms POST JSON to /api

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.error('✗ SESSION_SECRET is not set. Refusing to start in production with a known secret.');
  process.exit(1);
}
/* A `secure` cookie is only ever sent over HTTPS, so tying it to NODE_ENV is
   wrong: the Dockerfile sets NODE_ENV=production, and until certbot has run the
   site is still plain HTTP on port 80 — the browser would silently discard the
   session cookie and NOBODY COULD SIGN IN. So derive it from the scheme we are
   actually reachable on, with an explicit override for odd setups.
     COOKIE_SECURE=true|false   wins if set
     otherwise                  on when APP_BASE_URL is https://…            */
const SECURE_COOKIE = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === 'true'
  : /^https:/i.test(process.env.APP_BASE_URL || '');
if (process.env.NODE_ENV === 'production' && !SECURE_COOKIE) {
  console.warn('⚠ Session cookie is NOT marked secure — APP_BASE_URL is not https. ' +
               'Fine before certbot; set APP_BASE_URL to the https:// URL once TLS is live.');
}
const sessionOpts = {
  secret: process.env.SESSION_SECRET || 'dev-only-secret',
  resave: false, saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7,
    // Both were unset before. Without sameSite the cookie rode along on
    // cross-site POSTs in older browsers.
    sameSite: 'lax',
    secure: SECURE_COOKIE
  }
};
if (process.env.DB_DIALECT !== 'sqlite') {
  // Sessions persist in the same database as everything else — works with
  // Postgres and MySQL alike (a Sessions table inside truekind).
  const SequelizeStore = require('connect-session-sequelize')(session.Store);
  sessionOpts.store = new SequelizeStore({ db: sequelize });
}
app.use(session(sessionOpts));

app.use((req, res, next) => { res.locals.session = req.session; res.locals.user = null; next(); });

// CSRF. Exempt only the two public JSON endpoints (called cross-origin from the
// Vercel-hosted site, where there is no session cookie to bind a token to — they
// are guarded by the rate limiter and honeypot instead) and the PhonePe callback,
// which is a server-to-server POST carrying its own signature.
const { csrfContext, csrfGuard } = require('./middleware/csrf');
app.use(csrfContext);
app.use(csrfGuard(['/api/volunteer', '/api/contact']));

// Portal
app.use('/portal', require('./routes/auth'));
app.use('/portal/pay', require('./routes/payment'));
app.use('/portal/member', require('./routes/member'));
app.use('/portal/admin', require('./routes/admin'));
app.use('/portal/admin/cms', require('./routes/cms'));
app.get('/portal', async (req, res) => {
  if (!req.session.userId) return res.redirect('/portal/signin');
  if (req.session.role === 'admin') return res.redirect('/portal/admin');
  // A manager is a member row with a grant, so the session role does not say so.
  try {
    const { ManagerAccess } = require('./models');
    const grant = await ManagerAccess.findOne({ where: { userId: req.session.userId, active: true } });
    if (grant && (grant.sections || []).length) return res.redirect('/portal/admin');
  } catch (e) { /* fall through to the member area */ }
  res.redirect('/portal/member');
});

// Guest donation + guest receipt
const config = require('./config');
const { Donation, FormConfig, SiteContent, Volunteer, Enquiry, BoardMember } = require('./models');
const { qrDataUrl, barcodeDataUrl } = require('./utils/codes');
const verify = require('./utils/verify');
const { receiptPdf } = require('./utils/pdf');
app.get('/portal/donate', async (req, res) => {
  let extraFields = [];
  try { const f = await FormConfig.findOne({ where: { formKey: 'donation' } }); extraFields = f ? f.fields : []; } catch (e) {}
  // The public Donate page links here with ?amount= and ?category= from its cost
  // tiers, so "₹6,000 — a community health camp" arrives pre-filled instead of
  // asking the donor to retype it. Both are validated: an out-of-range amount or
  // an unknown category is simply ignored rather than trusted into the form.
  const amt = parseInt(req.query.amount, 10);
  const preset = {
    amount: Number.isFinite(amt) && amt > 0 && amt <= 10000000 ? amt : '',
    category: config.donationCategories.includes(req.query.category) ? req.query.category : ''
  };
  res.render('guest-donate', {
    title: 'Donate', categories: config.donationCategories, extraFields, preset,
    presets: config.donationPresets,
    blurbs: config.donationCategoryBlurbs || {},
    impact: config.donationImpact || {},
    org: config.org,
    // Set when the server rejected a submission (see routes/payment.js), so the
    // donor comes back to a form that says what went wrong rather than a bare
    // 400 page.
    error: req.query.error === 'invalid'
      ? 'Please check your details — we need a name, a working email address, a mobile number and an amount of at least ₹1.'
      : null
  });
});
app.get('/portal/receipt/:txnId', async (req, res) => {
  const d = await Donation.findOne({ where: { txnId: req.params.txnId, status: 'paid' } });
  if (!d) return res.status(404).render('error', { title: 'Not found', message: 'Receipt not found.' });
  res.render('member/receipt', { title: 'Donation receipt', d, qr: await qrDataUrl(verify.verifyUrl(d.receiptNo)), barcode: await barcodeDataUrl(d.receiptNo) });
});
app.get('/portal/receipt/:txnId/pdf', async (req, res) => {
  const d = await Donation.findOne({ where: { txnId: req.params.txnId, status: 'paid' } });
  if (!d) return res.status(404).send('Not found');
  await receiptPdf(res, d, null);
});

// CORS for the /api routes.
//
// The site is served by this server, so /api is same-origin and no CORS is
// needed at all — the default is now an EMPTY allowlist. It used to default to
// the Vercel origin, which meant any deployment inherited a cross-origin grant
// nobody asked for. Set ALLOWED_ORIGINS explicitly (comma-separated) only if
// some other origin genuinely has to read the public content API.
//
// Note this grant can never carry credentials: there is no
// Access-Control-Allow-Credentials header, so a cross-origin caller gets the
// public read endpoints and nothing authenticated. That is deliberate.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.sendStatus(204);
  }
  next();
});

// Very small in-memory rate limit for the public form endpoints —
// enough to stop a dumb spam loop without any extra dependency.
const formHits = new Map();  // ip -> [timestamps]
function rateLimited(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || 'unknown';
  const now = Date.now();
  const hits = (formHits.get(ip) || []).filter(t => now - t < 60 * 60 * 1000);
  hits.push(now);
  formHits.set(ip, hits);
  if (formHits.size > 5000) formHits.clear();   // memory guard
  return hits.length > 20;                      // 20 submissions / hour / IP
}
const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const validEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

/* ==========================================================================
   Document verification — the public end of the QR codes.

   Every membership card, certificate and receipt carries a QR that now encodes
   a link to /verify/<serial>. Scanning one with a phone camera lands here and
   gets a plain answer: valid, expired, withdrawn, or not one of ours.

   Rate limited separately from the forms, and more tightly than it looks: a
   serial is PREFIX-YEAR-6HEX, so guessing one is a 16-million-attempt job, and
   30 lookups an hour per address makes that pointless. This limiter — not the
   URL signature — is what actually stops enumeration. (utils/verify.js explains
   at length why the signature is advisory and must never be a gate.)
   ========================================================================== */
const { IdCardProfile, Revocation, VerificationScan, User: UserModel,
        CertificateIssue, Certificate, MembershipPayment,
        VisitorCertificate } = require('./models');

const verifyHits = new Map();
function verifyRateLimited(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || 'unknown';
  const now = Date.now();
  const hits = (verifyHits.get(ip) || []).filter(t => now - t < 60 * 60 * 1000);
  hits.push(now);
  verifyHits.set(ip, hits);
  if (verifyHits.size > 5000) verifyHits.clear();
  return hits.length > 30;
}

const VERIFY_MODELS = () => ({
  User: UserModel, CertificateIssue, Certificate, Donation, MembershipPayment,
  VisitorCertificate, Revocation
});

/* Logging a scan must never be able to fail a verification. Fire and forget. */
function logScan(req, result, signature) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || null;
  VerificationScan.create({
    code: result.code,
    kind: result.kind || null,
    result: result.status,
    signature,
    ipHash: verify.hashIp(ip),
    userAgent: String(req.get('user-agent') || '').slice(0, 240)
  }).catch(() => {});
}

// The typed-in form, and the landing page when someone strips the serial off.
app.get('/verify', async (req, res) => {
  const typed = req.query.code ? verify.normalise(req.query.code) : '';
  if (!typed) return res.render('verify', { result: null, typed: '', org: config.org, signature: null });
  // A recognised prefix goes straight to the canonical URL, so the address bar
  // ends up with something shareable rather than a query string.
  if (verify.kindOf(typed)) return res.redirect(`/verify/${encodeURIComponent(typed)}`);
  // Unrecognised prefix: re-render the form and say so, without a database hit.
  res.status(404).render('verify', { result: null, typed, org: config.org, signature: null });
});

app.get('/verify/:code', async (req, res) => {
  if (verifyRateLimited(req)) {
    return res.status(429).render('error', {
      title: 'Too many checks',
      message: 'Too many verification attempts from this connection. Wait a few minutes and try again, or call ' + config.org.phone + '.'
    });
  }
  const code = verify.normalise(req.params.code);
  const signature = verify.checkTag(code, req.query.k);
  let result;
  try {
    result = await verify.resolve(VERIFY_MODELS(), code);
  } catch (e) {
    return res.status(500).render('error', {
      title: 'Could not check that',
      message: 'Something went wrong looking that up. Try again in a moment, or call ' + config.org.phone + '.'
    });
  }
  logScan(req, result, signature);
  res.set('Cache-Control', 'no-store');   // a revocation must take effect at once
  res.status(result.found ? 200 : 404)
     .render('verify', { result, typed: null, org: config.org, signature });
});

/* Machine-readable, for a scanner app or a gate device. Same resolution, same
   rate limit, same narrow field set. */
app.get('/api/verify/:code', async (req, res) => {
  if (verifyRateLimited(req)) return res.status(429).json({ ok: false, error: 'rate_limited' });
  const code = verify.normalise(req.params.code);
  const signature = verify.checkTag(code, req.query.k);
  try {
    const result = await verify.resolve(VERIFY_MODELS(), code);
    logScan(req, result, signature);
    res.set('Cache-Control', 'no-store');
    res.status(result.found ? 200 : 404).json({ ok: true, signature, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'lookup_failed' });
  }
});

// Public form endpoints — volunteer registrations and contact enquiries
// land in the portal database and show up in the admin.
app.post('/api/volunteer', async (req, res) => {
  try {
    if (req.body._hp) return res.json({ ok: true });          // honeypot: pretend success
    if (rateLimited(req)) return res.status(429).json({ ok: false, error: 'Too many submissions — please try again later.' });
    const b = req.body || {};
    const name = clean(b.name, 120), email = clean(b.email, 160).toLowerCase(), phone = clean(b.phone, 30);
    if (!name || !validEmail(email) || phone.replace(/\D/g, '').length < 7)
      return res.status(400).json({ ok: false, error: 'Name, a valid email and phone number are required.' });
    await Volunteer.create({
      name, email, phone,
      city: clean(b.city, 120), type: clean(b.type, 60),
      availability: clean(b.availability, 60),
      interests: clean(b.interest || b.interests, 400),
      message: String(b.message ?? '').trim().slice(0, 2000)
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: 'Could not save your registration.' }); }
});
app.post('/api/contact', async (req, res) => {
  try {
    if (req.body._hp) return res.json({ ok: true });
    if (rateLimited(req)) return res.status(429).json({ ok: false, error: 'Too many submissions — please try again later.' });
    const b = req.body || {};
    const name = clean(b.name, 120), email = clean(b.email, 160).toLowerCase();
    const message = String(b.message ?? '').trim().slice(0, 4000);
    if (!name || !validEmail(email) || !message)
      return res.status(400).json({ ok: false, error: 'Name, a valid email and a message are required.' });
    await Enquiry.create({ name, email, subject: clean(b.subject, 200), message });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: 'Could not save your message.' }); }
});

// Public content API for the static pages.
// Kept as-is for the five original keys (banner/about/team/works/press) that
// assets/js/content.js still consumes.
app.get('/api/content/:key', async (req, res) => {
  try {
    const doc = await SiteContent.findOne({ where: { key: req.params.key } });
    res.json(doc ? doc.data : {});
  } catch (e) { res.status(500).json({}); }
});

// The CMS bundle: everything one page needs in a single request.
// Only overridden fields are sent — the defaults are already in the HTML, so
// echoing them back would double the payload and risk a stale copy overwriting
// good markup.
const cms = require('./cms');
app.get('/api/cms/:page', async (req, res) => {
  try {
    const known = ['global', ...cms.PAGE_KEYS];
    if (!known.includes(req.params.page)) return res.json({ page: req.params.page, fields: {} });
    const bundle = await cms.bundleForPage(SiteContent, req.params.page);
    res.set('Cache-Control', 'no-cache');
    res.json(bundle);
  } catch (e) { res.status(500).json({ page: req.params.page, fields: {} }); }
});

/* The board of trustees, for the About page.
   A separate endpoint rather than part of the CMS bundle because it is a LIST of
   unknown length, and the CMS bundle is a map of known field ids. Only visible
   rows are exposed, and only the fields the page renders — no internal ids, no
   on-disk filenames. On any failure this returns an empty list, and about.html
   keeps the four cards already in its markup. */
app.get('/api/board', async (req, res) => {
  try {
    const rows = await BoardMember.findAll({
      where: { visible: true },
      order: [['sortOrder', 'ASC'], ['id', 'ASC']]
    });
    res.set('Cache-Control', 'no-cache');
    res.json({ ok: true, members: rows.map(m => ({
      name: m.name,
      designation: m.designation || '',
      email: m.email || '',
      photo: m.photoUrl || '',
      bio: m.bio || '',
      social: {
        facebook: m.facebook || '', linkedin: m.linkedin || '',
        twitter: m.twitter || '', instagram: m.instagram || ''
      }
    })) });
  } catch (e) { res.status(500).json({ ok: false, members: [] }); }
});

// --------------------------------------------------------------------------
// Static serving.
//
// The static root is the repo root, so before serving anything we have to deny
// the paths that are not meant to be public. Without this, GET /server/config.js
// returned 200 with the source of every route — including the CMS write logic —
// and /package.json, /docker-compose.yml and /Dockerfile were all readable.
// (.env escaped only because serve-static ignores dotfiles by default.)
// --------------------------------------------------------------------------
const PRIVATE_PREFIXES = ['/server', '/deploy', '/node_modules', '/.git', '/.claude'];
// Entries must be lowercase — they are matched against a lowercased path so
// that /DOCKERFILE and /Dockerfile are both caught (case-insensitive filesystems
// like macOS would otherwise serve the file under a spelling the list missed).
const PRIVATE_FILES = new Set([
  '/package.json', '/package-lock.json', '/docker-compose.yml', '/dockerfile',
  '/readme-portal.md', '/readme.md', '/.dockerignore', '/.vercelignore',
  '/.gitignore', '/.env.example', '/.ds_store'
]);
app.use((req, res, next) => {
  // Decode first: /%73erver/... and /server/../server/x must not slip past.
  let p;
  try { p = decodeURIComponent(req.path); } catch (e) { return res.sendStatus(400); }
  p = path.posix.normalize(p);
  const lower = p.toLowerCase();
  if (PRIVATE_FILES.has(lower) || PRIVATE_PREFIXES.some(pre => lower === pre || lower.startsWith(pre + '/'))) {
    return res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' });
  }
  next();
});

// Uploads. nosniff + a locked-down CSP because these are user-supplied files
// served from the same origin as the portal session cookie — an uploaded
// .html or .svg would otherwise execute as first-party script.
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads'), {
  index: false,
  dotfiles: 'deny',
  maxAge: '7d',
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; media-src 'self'; img-src 'self'");
  }
}));
app.use(express.static(path.join(__dirname, '..'), { extensions: ['html'], dotfiles: 'ignore' }));
app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' }));

(async () => {
  try {
    await ensureDatabase();
    await sequelize.authenticate();
    await sequelize.sync();                 // creates tables on first boot
    console.log(`✓ Database connected (${process.env.DB_DIALECT || 'postgres'}), schema synced`);
  } catch (e) {
    console.error('✗ Database not reachable — portal pages will fail until it is.', e.message);
  }
  app.listen(PORT, () => console.log(`True Kind portal → http://localhost:${PORT}  (site at /, portal at /portal)`));
})();
