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
const { Donation, FormConfig, SiteContent } = require('./models');
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
