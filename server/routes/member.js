const router = require('express').Router();
const bcrypt = require('bcryptjs');
const config = require('../config');
const { requireLogin } = require('../middleware/auth');
const { User, Donation, Certificate, CertificateIssue, FormConfig, UserAccess } = require('../models');
const { qrDataUrl, barcodeDataUrl } = require('../utils/codes');
const { receiptPdf, certificatePdf, cardPdf } = require('../utils/pdf');

router.use(requireLogin);
router.use(async (req, res, next) => {
  req.user = await User.findByPk(req.session.userId);
  if (!req.user) return req.session.destroy(() => res.redirect('/portal/signin'));
  res.locals.user = req.user;
  next();
});

// 1. Profile / dashboard
router.get('/', async (req, res) => {
  const donations = await Donation.findAll({
    where: { userId: req.user.id, status: 'paid' },
    order: [['paidAt', 'DESC']], limit: 5
  });
  res.render('member/dashboard', { title: 'My profile', plans: config.plans, donations });
});

// Membership card
router.get('/card', async (req, res) => {
  if (!req.user.membershipValid) return res.redirect('/portal/member');
  res.render('member/card', {
    title: 'Membership card',
    qr: await qrDataUrl(req.user.memberId),
    barcode: await barcodeDataUrl(req.user.memberId)
  });
});
router.get('/card/pdf', async (req, res) => {
  if (!req.user.membershipValid) return res.redirect('/portal/member');
  await cardPdf(res, req.user);
});

// 2. Add donation
router.get('/donate', async (req, res) => {
  const form = await FormConfig.findOne({ where: { formKey: 'donation' } });
  res.render('member/donate', { title: 'Add donation', categories: config.donationCategories, extraFields: form ? form.fields : [] });
});

// 3. Donation list → certificate per donation
router.get('/donations', async (req, res) => {
  const donations = await Donation.findAll({ where: { userId: req.user.id }, order: [['createdAt', 'DESC']] });
  const issues = await CertificateIssue.findAll({
    where: { userId: req.user.id },
    include: [{ model: Certificate, as: 'certificate' }]
  });
  const certByDonation = {};
  issues.forEach(i => { if (i.donationId) certByDonation[String(i.donationId)] = { cert: i.certificate, issuance: i }; });
  res.render('member/donations', { title: 'Your donations', donations, certByDonation });
});

async function findIssue(req) {
  return CertificateIssue.findOne({
    where: { serial: req.params.serial, userId: req.user.id, certificateId: req.params.certId },
    include: [{ model: Certificate, as: 'certificate' }]
  });
}
router.get('/certificate/:certId/:serial', async (req, res) => {
  const issuance = await findIssue(req);
  if (!issuance) return res.status(404).render('error', { title: 'Not found', message: 'Certificate not found.' });
  res.render('member/certificate', {
    title: issuance.certificate.title, cert: issuance.certificate, issuance,
    qr: await qrDataUrl(issuance.serial),
    barcode: await barcodeDataUrl(issuance.serial)
  });
});
router.get('/certificate/:certId/:serial/pdf', async (req, res) => {
  const issuance = await findIssue(req);
  if (!issuance) return res.status(404).send('Not found');
  await certificatePdf(res, issuance.certificate, issuance, req.user);
});

// 4. Receipts
router.get('/receipt/:id', async (req, res) => {
  const d = await Donation.findOne({ where: { id: req.params.id, userId: req.user.id, status: 'paid' } });
  if (!d) return res.status(404).render('error', { title: 'Not found', message: 'Receipt not found.' });
  res.render('member/receipt', {
    title: 'Donation receipt', d,
    qr: await qrDataUrl(d.receiptNo),
    barcode: await barcodeDataUrl(d.receiptNo)
  });
});
router.get('/receipt/:id/pdf', async (req, res) => {
  const d = await Donation.findOne({ where: { id: req.params.id, userId: req.user.id, status: 'paid' } });
  if (!d) return res.status(404).send('Not found');
  await receiptPdf(res, d, req.user);
});

// 5. Edit profile
router.get('/profile', (req, res) => res.render('member/profile', { title: 'Edit profile', saved: false, error: null }));
router.post('/profile', async (req, res) => {
  const { name, phone, address, city, pan, password } = req.body;
  if (name) req.user.name = name;
  if (phone) req.user.phone = phone;
  req.user.address = address; req.user.city = city; req.user.pan = pan;
  if (password && password.length >= 6) req.user.passwordHash = await bcrypt.hash(password, 10);
  await req.user.save();
  res.render('member/profile', { title: 'Edit profile', saved: true, error: null });
});

/* ==========================================================================
   Change password

   Reachable — and, while a temporary password is outstanding, the ONLY thing
   reachable (see middleware/auth.js). An admin-issued password is meant to be
   used once and replaced, not to become the account's standing credential.
   ========================================================================== */
router.get('/password', async (req, res) => {
  const access = await UserAccess.findOne({ where: { userId: req.session.userId } });
  res.render('member/password', {
    title: 'Change password',
    forced: !!(access && access.mustChangePassword),
    error: null, saved: false
  });
});

router.post('/password', async (req, res) => {
  const access = await UserAccess.findOne({ where: { userId: req.session.userId } });
  const forced = !!(access && access.mustChangePassword);
  const view = (error, saved) => res.render('member/password',
    { title: 'Change password', forced, error, saved });

  const user = await User.findByPk(req.session.userId);
  const current = String(req.body.current || '');
  const next = String(req.body.next || '');

  if (!(await bcrypt.compare(current, user.passwordHash)))
    return view('That current password is not right.', false);
  if (next.length < 8)
    return view('Choose a new password of at least 8 characters.', false);
  if (next === current)
    return view('The new password has to be different from the current one.', false);

  user.passwordHash = await bcrypt.hash(next, 10);
  await user.save();

  if (access) { access.mustChangePassword = false; await access.save(); }
  view(null, true);
});

module.exports = router;
