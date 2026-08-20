const router = require('express').Router();
const { fn, col } = require('sequelize');
const { requireAdmin } = require('../middleware/auth');
const { User, Donation, Certificate, CertificateIssue, SiteContent, FormConfig, Volunteer, Enquiry,
        UserAccess, VolunteerLogin, CertificateFile, BoardMember } = require('../models');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { serial } = require('../utils/codes');

// Uploads moved to utils/media.js, which adds the extension+mimetype allowlist
// this instance never had (an uploaded .html or .svg executed as first-party
// script on the portal origin) and splits image/video size limits.
const { uploadImage, uploadDoc, uploadErrorMessage, UPLOAD_DIR } = require('../utils/media');

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
  // One query for the whole page rather than one per row.
  const blocks = await UserAccess.findAll({ where: { blocked: true }, attributes: ['userId'] });
  res.render('admin/members', {
    title: 'Members', members, status,
    blockedIds: blocks.map(b => b.userId)
  });
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
  const file = await CertificateFile.findOne({ where: { certificateId: cert.id } });
  res.render('admin/certificate-detail', {
    title: cert.title, cert, members, file,
    saved: req.query.saved, error: req.query.error
  });
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
router.post('/content/:key', (req, res, next) => {
  uploadImage.single('image')(req, res, err => {
    if (err) return res.status(err.status || 400).render('error', { title: 'Upload failed', message: uploadErrorMessage(err) });
    next();
  });
}, async (req, res) => {
  if (!CONTENT_KEYS.includes(req.params.key)) return res.status(400).send('Unknown key');
  const patch = { ...req.body };
  delete patch._csrf;
  if (req.file) patch.image = '/uploads/' + req.file.filename;

  const [row] = await SiteContent.findOrCreate({ where: { key: req.params.key }, defaults: { data: {} } });
  // MERGE, not replace. This used to be `row.data = data`, which meant editing
  // the banner headline without re-picking a file silently deleted the stored
  // banner image — even though the form displayed it as "Current:" right above.
  // Note the whole-object reassignment: Sequelize does not detect in-place
  // mutation of a JSON column as dirty, so `row.data.x = y` would not persist.
  row.data = { ...(row.data || {}), ...patch };
  await row.save();
  res.redirect('/portal/admin/content?saved=1');
});

// 6. Volunteer registrations (from the public site — no login for volunteers)
const VOL_STATUSES = ['new', 'contacted', 'active', 'inactive'];
router.get('/volunteers', async (req, res) => {
  const status = VOL_STATUSES.includes(req.query.status) ? req.query.status : 'all';
  const where = status === 'all' ? {} : { status };
  const volunteers = await Volunteer.findAll({ where, order: [['createdAt', 'DESC']] });
  const links = await VolunteerLogin.findAll({ attributes: ['volunteerId', 'userId'] });

  // A freshly generated password is passed through the redirect and shown once.
  // It is never persisted in plaintext — only its bcrypt hash reached the
  // database — so this is the only moment it can be read.
  let issued = { password: null, email: null, name: null };
  if (req.query.pw && req.query.issued) {
    const u = await User.findByPk(parseInt(req.query.issued, 10));
    if (u) issued = { password: String(req.query.pw), email: u.email, name: u.name };
  }

  res.render('admin/volunteers', {
    title: 'Volunteers', volunteers, status, statuses: VOL_STATUSES,
    loginIds: links.map(l => l.volunteerId),
    issuedPassword: issued.password, issuedEmail: issued.email, issuedFor: issued.name
  });
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

/* ==========================================================================
   Account control — activate / deactivate
   ========================================================================== */

/* Deliberately NOT User.status. That column is a membership state (payment.js
   sets it to 'active' when someone pays), so reusing it would make a deactivated
   member look like an unpaid guest — and paying again would silently reactivate
   them. Access lives in its own table. */
router.post('/members/:id/access', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const block = req.body.action === 'block';

  const target = await User.findByPk(id);
  if (!target) return res.status(404).send('No such user');

  // Two guards against locking the organisation out of its own portal.
  if (target.id === req.session.userId) {
    return res.status(400).render('error', { title: 'Not allowed',
      message: 'You cannot deactivate your own account.' });
  }
  if (block && target.role === 'admin') {
    const admins = await User.count({ where: { role: 'admin' } });
    if (admins <= 1) {
      return res.status(400).render('error', { title: 'Not allowed',
        message: 'This is the only administrator account. Promote another admin before deactivating this one.' });
    }
  }

  const [access] = await UserAccess.findOrCreate({ where: { userId: id }, defaults: {} });
  access.blocked = block;
  access.blockedAt = block ? new Date() : null;
  access.blockedBy = block ? req.session.userId : null;
  access.note = String(req.body.note || '').slice(0, 255);
  await access.save();
  res.redirect(req.get('referer') || '/portal/admin/members');
});

/* ==========================================================================
   Volunteer logins
   ========================================================================== */

/* A readable one-time password. Ambiguous characters are left out so it survives
   being read off a screen and typed on a phone — no O/0, l/1/I. */
function tempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out.slice(0, 4) + '-' + out.slice(4, 8) + '-' + out.slice(8, 12);
}

/* Create a login for a volunteer, or reissue its password.

   The generated password is returned to the admin ONCE, in this response, and
   never stored — only its bcrypt hash goes to the database. That is why there is
   no "show password" screen anywhere: a stored password that can be displayed is
   a stored password that can be stolen. Reissuing is free, so losing it costs
   nothing.  */
router.post('/volunteers/:id/login', async (req, res) => {
  const vol = await Volunteer.findByPk(req.params.id);
  if (!vol) return res.status(404).send('No such volunteer');

  const password = tempPassword();
  const hash = await bcrypt.hash(password, 10);
  const email = String(vol.email || '').toLowerCase().trim();

  let link = await VolunteerLogin.findOne({ where: { volunteerId: vol.id } });
  let user = link ? await User.findByPk(link.userId) : await User.findOne({ where: { email } });

  if (user) {
    user.passwordHash = hash;
    await user.save();
  } else {
    user = await User.create({
      name: vol.name, email, phone: vol.phone || '0',
      role: 'member', status: 'guest', passwordHash: hash
    });
  }
  if (!link) await VolunteerLogin.create({ volunteerId: vol.id, userId: user.id });
  else { link.issuedAt = new Date(); await link.save(); }

  // Force a change at first sign-in; until then the account can reach nothing
  // but the change-password page (see middleware/auth.js).
  const [access] = await UserAccess.findOrCreate({ where: { userId: user.id }, defaults: {} });
  access.mustChangePassword = true;
  access.passwordIssuedAt = new Date();
  await access.save();

  const status = req.query.status || 'all';
  res.redirect(`/portal/admin/volunteers?status=${encodeURIComponent(status)}` +
               `&issued=${user.id}&pw=${encodeURIComponent(password)}`);
});

/* ==========================================================================
   Certificate file upload — image or PDF
   ========================================================================== */

/* Stored in its own table rather than MediaAsset, whose `kind` is
   ENUM('image','video'). That table is already live and a bare sequelize.sync()
   cannot extend an enum, so 'document' has nowhere to go. */
router.post('/certificates/:id/file', (req, res, next) => {
  uploadDoc.single('file')(req, res, err => {
    if (err) return res.status(err.status || 400).render('error',
      { title: 'Upload failed', message: uploadErrorMessage(err) });
    next();
  });
}, async (req, res) => {
  const cert = await Certificate.findByPk(req.params.id);
  if (!cert) return res.status(404).send('No such certificate');
  if (!req.file) return res.redirect(`/portal/admin/certificates/${cert.id}?error=nofile`);

  const existing = await CertificateFile.findOne({ where: { certificateId: cert.id } });
  if (existing) {
    // Replace: drop the old row first, then unlink. A dangling file is harmless;
    // a row pointing at a missing file shows a broken preview.
    const old = existing.filename;
    await existing.destroy();
    require('fs').promises.unlink(require('path').join(UPLOAD_DIR, old)).catch(() => {});
  }
  await CertificateFile.create({
    certificateId: cert.id,
    url: '/uploads/' + req.file.filename,
    filename: req.file.filename,
    original: req.file.originalname,
    mimetype: req.file.mimetype,
    bytes: req.file.size,
    uploadedBy: req.session.userId
  });
  res.redirect(`/portal/admin/certificates/${cert.id}?saved=1`);
});

router.post('/certificates/:id/file/delete', async (req, res) => {
  const row = await CertificateFile.findOne({ where: { certificateId: req.params.id } });
  if (row) {
    const name = row.filename;
    await row.destroy();
    require('fs').promises.unlink(require('path').join(UPLOAD_DIR, name)).catch(() => {});
  }
  res.redirect(`/portal/admin/certificates/${req.params.id}`);
});

/* ==========================================================================
   Board of trustees — the admin side of the About page's "Our Board" section.

   Photo upload, name, designation, email, an optional short note and the four
   social handles the client asked for. Order and visibility are per-person, so
   a trustee can be taken off the website without deleting the record.
   ========================================================================== */

const BOARD_ORDER = [['sortOrder', 'ASC'], ['id', 'ASC']];

/* A social field accepts a full URL or a bare handle. Handles are far more
   likely to be what someone types, and "koustav" is not a link — so it is
   expanded against the right host. Anything that is a URL but not http(s) is
   dropped: a javascript: or data: value here would end up in an href on the
   public page. */
const SOCIAL_HOSTS = {
  facebook:  'https://www.facebook.com/',
  linkedin:  'https://www.linkedin.com/in/',
  twitter:   'https://x.com/',
  instagram: 'https://www.instagram.com/'
};
function socialUrl(kind, raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith('//')) {
    // Looks like a URL (or a protocol-relative one) — only http(s) may pass.
    let u;
    try { u = new URL(v.startsWith('//') ? 'https:' + v : v); } catch (e) { return null; }
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
  }
  if (v.includes('/') || v.includes('.')) {
    // A bare domain path like "facebook.com/someone" — assume https.
    try { return new URL('https://' + v).href; } catch (e) { return null; }
  }
  return SOCIAL_HOSTS[kind] + encodeURIComponent(v.replace(/^@/, ''));
}

function boardFields(body) {
  const s = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const order = parseInt(body.sortOrder, 10);
  return {
    name:        s(body.name, 120),
    designation: s(body.designation, 120),
    // Not validated as strictly as the donor email: this is an admin typing a
    // colleague's address, and a mailto: with a typo is a smaller problem than
    // a form that refuses a valid unusual address.
    email:       s(body.email, 160),
    bio:         s(body.bio, 600),
    facebook:    socialUrl('facebook',  body.facebook),
    linkedin:    socialUrl('linkedin',  body.linkedin),
    twitter:     socialUrl('twitter',   body.twitter),
    instagram:   socialUrl('instagram', body.instagram),
    sortOrder:   Number.isFinite(order) ? Math.max(0, Math.min(999, order)) : 0,
    visible:     body.visible === 'on' || body.visible === 'true' || body.visible === '1'
  };
}

/* Photographs live in the same uploads directory as everything else. Dropping a
   row's old file on replace keeps the directory from growing with every edit;
   the unlink is best-effort because a missing file must never fail the save. */
function dropPhoto(name) {
  if (!name) return;
  require('fs').promises.unlink(require('path').join(UPLOAD_DIR, name)).catch(() => {});
}

router.get('/board', async (req, res) => {
  const members = await BoardMember.findAll({ order: BOARD_ORDER });
  res.render('admin/board', {
    title: 'Board', members,
    saved: req.query.saved, error: req.query.error
  });
});

const boardPhoto = (req, res, next) => {
  uploadImage.single('photo')(req, res, err => {
    if (err) return res.status(err.status || 400).render('error',
      { title: 'Upload failed', message: uploadErrorMessage(err) });
    next();
  });
};

router.post('/board', boardPhoto, async (req, res) => {
  const data = boardFields(req.body);
  if (!data.name) {
    if (req.file) dropPhoto(req.file.filename);
    return res.redirect('/portal/admin/board?error=name');
  }
  if (req.file) {
    data.photoUrl = '/uploads/' + req.file.filename;
    data.photoFile = req.file.filename;
  }
  // A new person goes to the end of the list unless an order was typed.
  if (!req.body.sortOrder) {
    const last = await BoardMember.max('sortOrder');
    data.sortOrder = (Number.isFinite(last) ? last : 0) + 10;
  }
  await BoardMember.create(data);
  res.redirect('/portal/admin/board?saved=1');
});

router.post('/board/:id', boardPhoto, async (req, res) => {
  const m = await BoardMember.findByPk(req.params.id);
  if (!m) {
    if (req.file) dropPhoto(req.file.filename);
    return res.status(404).send('No such board member');
  }
  const data = boardFields(req.body);
  if (!data.name) {
    if (req.file) dropPhoto(req.file.filename);
    return res.redirect('/portal/admin/board?error=name');
  }
  if (req.file) {
    dropPhoto(m.photoFile);
    data.photoUrl = '/uploads/' + req.file.filename;
    data.photoFile = req.file.filename;
  } else if (req.body.removePhoto === 'on') {
    dropPhoto(m.photoFile);
    data.photoUrl = null;
    data.photoFile = null;
  }
  await m.update(data);
  res.redirect('/portal/admin/board?saved=1');
});

router.post('/board/:id/delete', async (req, res) => {
  const m = await BoardMember.findByPk(req.params.id);
  if (m) {
    const file = m.photoFile;
    await m.destroy();
    dropPhoto(file);
  }
  res.redirect('/portal/admin/board?saved=1');
});

module.exports = router;
