const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const { fn, col } = require('sequelize');
const { requireAdmin } = require('../middleware/auth');
const { User, Donation, Certificate, CertificateIssue, SiteContent, FormConfig, Volunteer, Enquiry } = require('../models');
const { serial } = require('../utils/codes');

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '..', '..', 'uploads'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^\w.\-]/g, '_'))
  }),
  limits: { fileSize: 4 * 1024 * 1024 }
});

router.use(requireAdmin);
router.use(async (req, res, next) => {
  res.locals.user = await User.findByPk(req.session.userId);
  next();
});

router.get('/', async (req, res) => {
  const [active, guests, rows, newVolunteers, newEnquiries] = await Promise.all([
    User.count({ where: { status: 'active', role: 'member' } }),
    User.count({ where: { status: 'guest', role: 'member' } }),
    Donation.findAll({
      where: { status: 'paid' },
      attributes: ['kind', [fn('SUM', col('amount')), 'total'], [fn('COUNT', col('id')), 'n']],
      group: ['kind'], raw: true
    }),
    Volunteer.count({ where: { status: 'new' } }),
    Enquiry.count({ where: { status: 'new' } })
  ]);
  const donations = rows.map(r => ({ _id: r.kind, total: +r.total, n: +r.n }));
  res.render('admin/dashboard', { title: 'Admin', active, guests, donations, newVolunteers, newEnquiries });
});

// 1. Member list — Active / Guest
router.get('/members', async (req, res) => {
  const status = req.query.status === 'guest' ? 'guest' : 'active';
  const members = await User.findAll({ where: { role: 'member', status }, order: [['createdAt', 'DESC']] });
  res.render('admin/members', { title: 'Members', members, status });
});

// 2. Certificates
router.get('/certificates', async (req, res) => {
  const certs = await Certificate.findAll({
    include: [{ model: CertificateIssue, as: 'issued' }],
    order: [['createdAt', 'DESC']]
  });
  res.render('admin/certificates', { title: 'Certificates', certs });
});
router.post('/certificates', async (req, res) => {
  await Certificate.create({ title: req.body.title, description: req.body.description });
  res.redirect('/portal/admin/certificates');
});
router.get('/certificates/:id', async (req, res) => {
  const cert = await Certificate.findByPk(req.params.id, {
    include: [{ model: CertificateIssue, as: 'issued', include: [{ model: User, as: 'user', attributes: ['name', 'email', 'memberId'] }] }]
  });
  if (!cert) return res.status(404).render('error', { title: 'Not found', message: 'No such certificate.' });
  const members = await User.findAll({ where: { role: 'member', status: 'active' }, order: [['name', 'ASC']] });
  res.render('admin/certificate-detail', { title: cert.title, cert, members });
});
router.post('/certificates/:id/issue', async (req, res) => {
  await CertificateIssue.create({
    certificateId: req.params.id,
    userId: req.body.userId,
    serial: serial('TKF-C')
  });
  res.redirect('/portal/admin/certificates/' + req.params.id);
});

// 3. Donation lists
router.get('/donations', async (req, res) => {
  const kind = req.query.kind === 'guest' ? 'guest' : 'member';
  const donations = await Donation.findAll({
    where: { kind, status: 'paid' },
    include: [{ model: User, as: 'user', attributes: ['name', 'email', 'memberId'] }],
    order: [['paidAt', 'DESC']]
  });
  res.render('admin/donations', { title: 'Donations', donations, kind });
});
router.get('/donations.csv', async (req, res) => {
  const donations = await Donation.findAll({
    where: { status: 'paid' },
    include: [{ model: User, as: 'user', attributes: ['name', 'email'] }],
    order: [['paidAt', 'DESC']]
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="donations.csv"');
  const rows = [['Receipt', 'Date', 'Kind', 'Name', 'Email', 'Category', 'Amount(INR)', 'Txn'].join(',')];
  donations.forEach(d => {
    const who = d.user || d.guest || {};
    rows.push([d.receiptNo, (d.paidAt || d.createdAt).toISOString().slice(0, 10), d.kind,
      JSON.stringify(who.name || ''), who.email || '', JSON.stringify(d.category),
      (d.amount / 100).toFixed(2), d.gatewayRef || d.txnId].join(','));
  });
  res.send(rows.join('\n'));
});

// 4. Website content
const CONTENT_KEYS = ['about', 'banner', 'team', 'works', 'press'];
router.get('/content', async (req, res) => {
  const docs = await SiteContent.findAll({ where: { key: CONTENT_KEYS } });
  const byKey = Object.fromEntries(docs.map(d => [d.key, d.data]));
  res.render('admin/content', { title: 'Website content', byKey, keys: CONTENT_KEYS, saved: req.query.saved });
});
router.post('/content/:key', upload.single('image'), async (req, res) => {
  if (!CONTENT_KEYS.includes(req.params.key)) return res.status(400).send('Unknown key');
  const data = { ...req.body };
  if (req.file) data.image = '/uploads/' + req.file.filename;
  const [row] = await SiteContent.findOrCreate({ where: { key: req.params.key }, defaults: { data } });
  row.data = data; await row.save();
  res.redirect('/portal/admin/content?saved=1');
});

// 6. Volunteer registrations (from the public site — no login for volunteers)
const VOL_STATUSES = ['new', 'contacted', 'active', 'inactive'];
router.get('/volunteers', async (req, res) => {
  const status = VOL_STATUSES.includes(req.query.status) ? req.query.status : 'all';
  const where = status === 'all' ? {} : { status };
  const volunteers = await Volunteer.findAll({ where, order: [['createdAt', 'DESC']] });
  res.render('admin/volunteers', { title: 'Volunteers', volunteers, status, statuses: VOL_STATUSES });
});
router.post('/volunteers/:id/status', async (req, res) => {
  if (VOL_STATUSES.includes(req.body.status))
    await Volunteer.update({ status: req.body.status }, { where: { id: req.params.id } });
  res.redirect('/portal/admin/volunteers' + (req.body.back ? '?status=' + req.body.back : ''));
});
router.get('/volunteers.csv', async (req, res) => {
  const volunteers = await Volunteer.findAll({ order: [['createdAt', 'DESC']] });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="volunteers.csv"');
  const rows = [['Date', 'Name', 'Email', 'Phone', 'City', 'Type', 'Availability', 'Interests', 'Message', 'Status'].join(',')];
  volunteers.forEach(v => rows.push([
    v.createdAt.toISOString().slice(0, 10), JSON.stringify(v.name || ''), v.email, JSON.stringify(v.phone || ''),
    JSON.stringify(v.city || ''), JSON.stringify(v.type || ''), JSON.stringify(v.availability || ''),
    JSON.stringify(v.interests || ''), JSON.stringify(v.message || ''), v.status
  ].join(',')));
  res.send(rows.join('\n'));
});

// 7. Contact enquiries (from the public site contact form)
const ENQ_STATUSES = ['new', 'replied', 'closed'];
router.get('/enquiries', async (req, res) => {
  const status = ENQ_STATUSES.includes(req.query.status) ? req.query.status : 'all';
  const where = status === 'all' ? {} : { status };
  const enquiries = await Enquiry.findAll({ where, order: [['createdAt', 'DESC']] });
  res.render('admin/enquiries', { title: 'Enquiries', enquiries, status, statuses: ENQ_STATUSES });
});
router.post('/enquiries/:id/status', async (req, res) => {
  if (ENQ_STATUSES.includes(req.body.status))
    await Enquiry.update({ status: req.body.status }, { where: { id: req.params.id } });
  res.redirect('/portal/admin/enquiries' + (req.body.back ? '?status=' + req.body.back : ''));
});
router.get('/enquiries.csv', async (req, res) => {
  const enquiries = await Enquiry.findAll({ order: [['createdAt', 'DESC']] });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="enquiries.csv"');
  const rows = [['Date', 'Name', 'Email', 'Subject', 'Message', 'Status'].join(',')];
  enquiries.forEach(e => rows.push([
    e.createdAt.toISOString().slice(0, 10), JSON.stringify(e.name || ''), e.email,
    JSON.stringify(e.subject || ''), JSON.stringify(e.message || ''), e.status
  ].join(',')));
  res.send(rows.join('\n'));
});

// 5. Donation form config
router.get('/form', async (req, res) => {
  const form = await FormConfig.findOne({ where: { formKey: 'donation' } });
  res.render('admin/form', { title: 'Donation form fields', fields: form ? form.fields : [], saved: req.query.saved });
});
router.post('/form/add', async (req, res) => {
  const { label, type, required } = req.body;
  const name = (req.body.name || label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  if (!label || !name) return res.redirect('/portal/admin/form');
  const [form] = await FormConfig.findOrCreate({ where: { formKey: 'donation' }, defaults: { fields: [] } });
  form.fields = [...form.fields, {
    name, label, type: type || 'text', required: !!required,
    options: (req.body.options || '').split(',').map(s => s.trim()).filter(Boolean)
  }];
  await form.save();
  res.redirect('/portal/admin/form?saved=1');
});
router.post('/form/remove', async (req, res) => {
  const form = await FormConfig.findOne({ where: { formKey: 'donation' } });
  if (form) { form.fields = form.fields.filter(f => f.name !== req.body.name); await form.save(); }
  res.redirect('/portal/admin/form');
});
module.exports = router;
