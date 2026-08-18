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
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '64kb' }));   // public-site forms POST JSON to /api

const sessionOpts = {
  secret: process.env.SESSION_SECRET || 'dev-only-secret',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 24 * 7 }
};
if (process.env.DB_DIALECT !== 'sqlite') {
  // Sessions persist in the same database as everything else — works with
  // Postgres and MySQL alike (a Sessions table inside truekind).
  const SequelizeStore = require('connect-session-sequelize')(session.Store);
  sessionOpts.store = new SequelizeStore({ db: sequelize });
}
app.use(session(sessionOpts));

app.use((req, res, next) => { res.locals.session = req.session; res.locals.user = null; next(); });

// Portal
app.use('/portal', require('./routes/auth'));
app.use('/portal/pay', require('./routes/payment'));
app.use('/portal/member', require('./routes/member'));
app.use('/portal/admin', require('./routes/admin'));
app.get('/portal', (req, res) =>
  res.redirect(req.session.userId ? (req.session.role === 'admin' ? '/portal/admin' : '/portal/member') : '/portal/signin'));

// Guest donation + guest receipt
const config = require('./config');
const { Donation, FormConfig, SiteContent, Volunteer, Enquiry } = require('./models');
const { qrDataUrl, barcodeDataUrl } = require('./utils/codes');
const { receiptPdf } = require('./utils/pdf');
app.get('/portal/donate', async (req, res) => {
  let extraFields = [];
  try { const f = await FormConfig.findOne({ where: { formKey: 'donation' } }); extraFields = f ? f.fields : []; } catch (e) {}
  res.render('guest-donate', { title: 'Donate', categories: config.donationCategories, extraFields });
});
app.get('/portal/receipt/:txnId', async (req, res) => {
  const d = await Donation.findOne({ where: { txnId: req.params.txnId, status: 'paid' } });
  if (!d) return res.status(404).render('error', { title: 'Not found', message: 'Receipt not found.' });
  res.render('member/receipt', { title: 'Donation receipt', d, qr: await qrDataUrl(d.receiptNo), barcode: await barcodeDataUrl(d.receiptNo) });
});
app.get('/portal/receipt/:txnId/pdf', async (req, res) => {
  const d = await Donation.findOne({ where: { txnId: req.params.txnId, status: 'paid' } });
  if (!d) return res.status(404).send('Not found');
  await receiptPdf(res, d, null);
});

// CORS for the /api routes — the public site runs on a different origin
// (Vercel now, the real domain later). Comma-separated list in ALLOWED_ORIGINS.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://true-kind-psi.vercel.app')
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

// Public content API for the static pages
app.get('/api/content/:key', async (req, res) => {
  try {
    const doc = await SiteContent.findOne({ where: { key: req.params.key } });
    res.json(doc ? doc.data : {});
  } catch (e) { res.status(500).json({}); }
});

// Uploads + the static site
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use(express.static(path.join(__dirname, '..'), { extensions: ['html'] }));
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
