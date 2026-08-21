const router = require('express').Router();
const { fn, col, Op } = require('sequelize');
const { requireAdmin, adminOnly } = require('../middleware/auth');
const { SECTIONS: STAFF_SECTIONS, cleanSections } = require('../middleware/staff');
const { User, Donation, Certificate, CertificateIssue, SiteContent, FormConfig, Volunteer, Enquiry,
        UserAccess, VolunteerLogin, CertificateFile, BoardMember,
        MembershipPayment, IdCardProfile, Revocation, VerificationScan,
        CertificateStyle, VisitorCertificate, OfflineDonation, Notice,
        ManagerAccess, AppointmentLetter } = require('../models');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const config = require('../config');
const membership = require('../utils/membership');
const { serial } = require('../utils/codes');
const { certificatePdf, visitorCertificatePdf, membershipReceiptPdf,
        MODE_LABEL, CERT_TEMPLATES, CERT_TEMPLATE_KEYS } = require('../utils/pdf');
const { idCardPdf, cardContext } = require('../utils/idcard');
const { appointmentLetterPdf } = require('../utils/letter');

/* The eight real blood groups. A free-text blood group on a card that may be
   read in an emergency is worse than a blank one. */
const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

// Uploads moved to utils/media.js, which adds the extension+mimetype allowlist
// this instance never had (an uploaded .html or .svg executed as first-party
// script on the portal origin) and splits image/video size limits.
const { uploadImage, uploadDoc, uploadErrorMessage, UPLOAD_DIR } = require('../utils/media');

router.use(requireAdmin);
router.use(async (req, res, next) => {
  res.locals.user = await User.findByPk(req.session.userId);
  next();
});

/* Nav badge counts.

   One middleware, one Promise.all, for every admin page — the alternative is
   each route remembering to pass them, which it will not.

   Wrapped in try/catch and defaulting to {}: the navigation is chrome, and a
   failed count query must never be able to 500 the page it decorates. The view
   guards every reference for the same reason. */
router.use(async (req, res, next) => {
  res.locals.navCounts = {};
  try {
    const [active, guests, certs, visitorCerts, donations, receipts,
           newVolunteers, newEnquiries, notices, users, blocked, managers] = await Promise.all([
      User.count({ where: { role: 'member', status: 'active' } }),
      User.count({ where: { role: 'member', status: 'guest' } }),
      CertificateIssue.count(),
      VisitorCertificate.count(),
      Donation.count({ where: { status: 'paid' } }),
      MembershipPayment.count(),
      Volunteer.count({ where: { status: 'new' } }),
      Enquiry.count({ where: { status: 'new' } }),
      Notice.count({ where: { active: true } }),
      User.count(),
      UserAccess.count({ where: { blocked: true } }),
      ManagerAccess.count({ where: { active: true } })
    ]);
    res.locals.navCounts = {
      active, guests,
      certificates: certs + visitorCerts,
      donations, receipts: receipts + donations,
      newVolunteers, newEnquiries, notices, users, blocked, managers
    };
  } catch (e) { /* chrome only — leave the counts empty */ }
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
//
// "Guest" is a registration whose membership fee has not been received. The tab
// is labelled New Memberships for that reason, and every row on it carries an
// Unpaid pill and the action that turns it into a paid, active member.
router.get('/members', async (req, res) => {
  const status = req.query.status === 'guest' ? 'guest' : 'active';
  const members = await User.findAll({ where: { role: 'member', status }, order: [['createdAt', 'DESC']] });

  // Three queries for the whole page rather than three per row.
  const ids = members.map(m => m.id);
  const [blocks, payments, issues, certs] = await Promise.all([
    UserAccess.findAll({ where: { blocked: true }, attributes: ['userId'] }),
    ids.length ? MembershipPayment.findAll({ where: { userId: ids }, order: [['paidAt', 'DESC']] }) : [],
    ids.length ? CertificateIssue.findAll({ where: { userId: ids } }) : [],
    // The dropdown on each row needs the list of certificates that can be issued.
    status === 'active' ? Certificate.findAll({ order: [['title', 'ASC']] }) : []
  ]);

  // userId -> most recent payment, and userId -> how many certificates issued.
  const lastPayment = {};
  payments.forEach(p => { if (!lastPayment[p.userId]) lastPayment[p.userId] = p; });
  const certCount = {};
  issues.forEach(i => { certCount[i.userId] = (certCount[i.userId] || 0) + 1; });

  res.render('admin/members', {
    title: status === 'guest' ? 'New memberships' : 'Active members',
    members, status,
    blockedIds: blocks.map(b => b.userId),
    lastPayment, certCount, certs,
    plans: config.plans,
    modes: membership.OFFLINE_MODES,
    saved: req.query.saved, error: req.query.error
  });
});

/* Record a membership fee taken offline, and activate the member.
   This is the other half of "registered but has not paid": the fee usually
   arrives as cash at an event or as a bank transfer, and until now there was no
   way to enter one — membership could only be granted by completing a PhonePe
   checkout. */
router.post('/members/:id/membership', async (req, res) => {
  const user = await User.findByPk(req.params.id);
  if (!user || user.role !== 'member') return res.status(404).send('No such member');

  const mode = String(req.body.mode || '').toLowerCase();
  if (!membership.isOfflineMode(mode)) {
    // 'online' is rejected on purpose — see utils/membership.js. A cash payment
    // must never be recordable as a gateway transaction.
    return res.redirect('/portal/admin/members?status=guest&error=mode');
  }

  const plan = membership.planKey(req.body.plan);
  // The amount is what was actually collected, which is not always the list
  // price. Blank means "the plan price".
  const rupees = parseFloat(req.body.amount);
  const amount = Number.isFinite(rupees) && rupees > 0 ? Math.round(rupees * 100) : undefined;
  if (req.body.amount && amount === undefined) {
    return res.redirect('/portal/admin/members?status=guest&error=amount');
  }

  const when = req.body.paidAt ? new Date(req.body.paidAt) : null;
  const paidAt = when && !isNaN(when) && when <= new Date(Date.now() + 86400000) ? when : new Date();

  const payment = await membership.activate({
    user, MembershipPayment, plan, amount, mode,
    reference: String(req.body.reference || '').trim().slice(0, 120) || null,
    note: String(req.body.note || '').trim().slice(0, 240) || null,
    recordedBy: req.session.userId,
    paidAt
  });

  res.redirect(`/portal/admin/members/${user.id}?saved=${encodeURIComponent(payment.receiptNo)}`);
});

/* One member, everything about them on one page — the "View" action.
   Membership and its payment history, certificates issued, donations given. */
router.get('/members/:id', async (req, res) => {
  const user = await User.findByPk(req.params.id);
  if (!user || user.role !== 'member') return res.status(404).render('error',
    { title: 'Not found', message: 'No such member.' });

  const [payments, issues, donations, access, certs, card] = await Promise.all([
    MembershipPayment.findAll({ where: { userId: user.id }, order: [['paidAt', 'DESC']] }),
    CertificateIssue.findAll({
      where: { userId: user.id },
      include: [{ model: Certificate, as: 'certificate', attributes: ['id', 'title'] }],
      order: [['issuedAt', 'DESC']]
    }),
    Donation.findAll({ where: { userId: user.id, status: 'paid' }, order: [['paidAt', 'DESC']] }),
    UserAccess.findOne({ where: { userId: user.id } }),
    Certificate.findAll({ order: [['title', 'ASC']] }),
    IdCardProfile.findOne({ where: { userId: user.id } })
  ]);

  /* Which of this person's codes have been withdrawn. One query for the page,
     so each certificate row can show its own state without N+1 lookups. */
  const codes = issues.map(i => i.serial).concat(user.memberId ? [user.memberId] : []);
  const revoked = codes.length
    ? (await Revocation.findAll({ where: { code: codes } })).reduce((m, r) => {
        m[r.code] = r; return m;
      }, {})
    : {};

  res.render('admin/member-detail', {
    title: user.name, member: user, payments, issues, donations, certs,
    card, revoked, bloodGroups: BLOOD_GROUPS,
    verifyUrl: user.memberId ? require('../utils/verify').verifyUrl(user.memberId) : null,
    blocked: !!(access && access.blocked),
    plans: config.plans, modes: membership.OFFLINE_MODES,
    saved: req.query.saved, error: req.query.error
  });
});

/* card.pdf was the old one-page landscape card. There is one card now and it is
   idcard.pdf, so this redirects rather than 404s: the old URL is sitting in
   open tabs and browser history, and somebody has certainly pasted it into a
   WhatsApp message. 302, not 301 — a permanent redirect is cached by the
   browser forever and would be impossible to walk back. */
router.get('/members/:id/card.pdf', (req, res) =>
  res.redirect(302, `/portal/admin/members/${encodeURIComponent(req.params.id)}/idcard.pdf`));

/* Their most recent membership receipt, straight from the row. */
router.get('/members/:id/receipt.pdf', async (req, res) => {
  const user = await User.findByPk(req.params.id);
  if (!user || user.role !== 'member') return res.status(404).send('No such member');
  const payment = await MembershipPayment.findOne({
    where: { userId: user.id }, order: [['paidAt', 'DESC']]
  });
  if (!payment) return res.status(404).render('error', {
    title: 'No receipt',
    message: `No membership payment has been recorded for ${user.name} yet.`
  });
  await membershipReceiptPdf(res, payment, user);
});

/* Issue a certificate to this member, from the member's own row.
   The existing route is POST /certificates/:id/issue, which starts from the
   certificate and picks a member; this starts from the member and picks a
   certificate. Same table, opposite direction — which is the direction you are
   facing when you are looking at a member. */
router.post('/members/:id/certificate', async (req, res) => {
  const user = await User.findByPk(req.params.id);
  if (!user || user.role !== 'member') return res.status(404).send('No such member');
  const cert = await Certificate.findByPk(req.body.certificateId);
  if (!cert) return res.redirect(`/portal/admin/members/${user.id}?error=nocert`);

  // Do not issue the same certificate to the same person twice: the serial is
  // what makes it verifiable, and two live serials for one award is a mess to
  // unpick later.
  const already = await CertificateIssue.findOne({
    where: { certificateId: cert.id, userId: user.id }
  });
  if (already) return res.redirect(`/portal/admin/members/${user.id}?error=duplicate`);

  const issue = await CertificateIssue.create({
    certificateId: cert.id, userId: user.id, serial: serial('TKF-C')
  });
  res.redirect(`/portal/admin/members/${user.id}?saved=${encodeURIComponent(issue.serial)}`);
});

/* ==========================================================================
   Revocation.

   This used to be a DELETE. Destroying the issue row was wrong in a way that
   only shows up once the certificates are verifiable: the paper certificate is
   still in somebody's hands, and after a delete its serial verified as "not
   recognised" — as though we had never issued it. That is indistinguishable
   from a forgery, and it loses the record that we ever made the award.

   A revocation is a row instead. The serial keeps resolving, and now says
   "withdrawn on <date>", with a reason. It can also be undone, which a delete
   could not be.
   ========================================================================== */

async function revoke(code, kind, req) {
  const [row] = await Revocation.findOrCreate({
    where: { code },
    defaults: {
      kind,
      reason: String(req.body.reason || '').trim().slice(0, 240) || null,
      revokedBy: req.session.userId,
      revokedAt: new Date()
    }
  });
  return row;
}

router.post('/members/:id/certificate/:issueId/revoke', async (req, res) => {
  const row = await CertificateIssue.findOne({
    where: { id: req.params.issueId, userId: req.params.id }
  });
  if (row) await revoke(row.serial, 'certificate', req);
  res.redirect(`/portal/admin/members/${req.params.id}?saved=revoked`);
});

router.post('/members/:id/certificate/:issueId/restore', async (req, res) => {
  const row = await CertificateIssue.findOne({
    where: { id: req.params.issueId, userId: req.params.id }
  });
  if (row) await Revocation.destroy({ where: { code: row.serial } });
  res.redirect(`/portal/admin/members/${req.params.id}?saved=restored`);
});

/* Revoking the membership CARD, which is a different thing from deactivating
   the account: a card can be reported lost and cancelled while the person
   remains a member in good standing and gets a replacement. */
router.post('/members/:id/card/revoke', async (req, res) => {
  const user = await User.findByPk(req.params.id);
  if (!user || !user.memberId) return res.redirect(`/portal/admin/members/${req.params.id}?error=nocard`);
  await revoke(user.memberId, 'member', req);
  res.redirect(`/portal/admin/members/${user.id}?saved=revoked`);
});

router.post('/members/:id/card/restore', async (req, res) => {
  const user = await User.findByPk(req.params.id);
  if (user && user.memberId) await Revocation.destroy({ where: { code: user.memberId } });
  res.redirect(`/portal/admin/members/${req.params.id}?saved=restored`);
});

/* ==========================================================================
   ID card details and printing.
   ========================================================================== */

const cardPhoto = (req, res, next) => {
  uploadImage.single('photo')(req, res, err => {
    if (err) return res.status(err.status || 400).render('error',
      { title: 'Upload failed', message: uploadErrorMessage(err) });
    next();
  });
};

router.post('/members/:id/idcard', cardPhoto, async (req, res) => {
  const user = await User.findByPk(req.params.id);
  if (!user) {
    if (req.file) dropPhoto(req.file.filename);
    return res.status(404).send('No such member');
  }

  const s = (v, n) => String(v == null ? '' : v).trim().slice(0, n) || null;
  const day = v => {
    const d = v ? new Date(v) : null;
    return d && !isNaN(d) ? d.toISOString().slice(0, 10) : null;
  };
  const type = ['member', 'staff', 'volunteer'].includes(req.body.cardType) ? req.body.cardType : 'member';

  const data = {
    cardType: type,
    employeeCode: s(req.body.employeeCode, 60),
    designation:  s(req.body.designation, 80),
    department:   s(req.body.department, 80),
    // Constrained: a blood group is one of eight values, and "O positive
    // (maybe)" on a card that might be read in an emergency is worse than blank.
    bloodGroup:   BLOOD_GROUPS.includes(req.body.bloodGroup) ? req.body.bloodGroup : null,
    joinedOn:   day(req.body.joinedOn),
    issuedOn:   day(req.body.issuedOn) || new Date().toISOString().slice(0, 10),
    validUntil: day(req.body.validUntil),
    updatedBy:  req.session.userId
  };

  const [profile] = await IdCardProfile.findOrCreate({
    where: { userId: user.id }, defaults: { userId: user.id }
  });
  if (req.file) {
    dropPhoto(profile.photoFile);
    data.photoUrl = '/uploads/' + req.file.filename;
    data.photoFile = req.file.filename;
  } else if (req.body.removePhoto === 'on') {
    dropPhoto(profile.photoFile);
    data.photoUrl = null;
    data.photoFile = null;
  }
  await profile.update(data);
  res.redirect(`/portal/admin/members/${user.id}?saved=card`);
});

/* The one ID card. cardContext gathers the profile, the photograph and the code
   the QR carries, so this route and the member's own download produce the same
   document byte for byte. */
router.get('/members/:id/idcard.pdf', async (req, res) => {
  const user = await User.findByPk(req.params.id);
  if (!user) return res.status(404).send('No such member');
  const { profile, photoPath, code, reason } = await cardContext(IdCardProfile, user);
  if (!code) return res.status(400).render('error', { title: 'No ID number yet', message: reason });
  await idCardPdf(res, user, profile, { photoPath, code });
});

/* ==========================================================================
   Appointment letters.

   Generated per use. Nothing is stored but the row; the PDF is re-rendered from
   it on every request, so a reprint is free and there is no file store.

   WHO CAN RECEIVE ONE. Active members only — the same rule, and the same
   reason, as Certificates -> Generate: the letter prints a Member ID and
   verifies against it, and a person with no Member ID has nothing for the QR to
   resolve to. Registrations whose fee has not arrived are not offered, because
   they are not members yet.
   ========================================================================== */

/* The letter's own defaults. Deliberately thin: these are the values an admin
   would otherwise retype on every letter, NOT policy decisions. Anything that
   is a real term of employment is left blank so somebody has to think about it
   and type it in. */
const LETTER_KINDS = ['staff', 'volunteer', 'board'];
const LETTER_KIND_LABEL = { staff: 'Staff', volunteer: 'Volunteer', board: 'Board / trustee' };

/* Read the form once, for both preview and issue, so the document you looked at
   is the document you sent. Two readers would drift. */
function letterFromForm(body, user) {
  const s = (v, n) => String(v == null ? '' : v).trim().slice(0, n) || null;
  const n = (v) => {
    const x = parseInt(String(v == null ? '' : v).replace(/[^\d]/g, ''), 10);
    return Number.isFinite(x) && x > 0 ? x : null;
  };
  return {
    userId: user ? user.id : null,
    kind: LETTER_KINDS.includes(body.kind) ? body.kind : 'staff',
    // Snapshotted from the member record, overridable — the address on file is
    // often the one the letter should go to, but not always.
    name:    s(body.name, 120) || (user && user.name) || null,
    address: s(body.address, 240) || (user && user.city) || null,
    phone:   s(body.phone, 30)  || (user && user.phone) || null,
    email:   s(body.email, 160) || (user && user.email) || null,

    designation:    s(body.designation, 120),
    department:     s(body.department, 120),
    reportsTo:      s(body.reportsTo, 120),
    location:       s(body.location, 120),
    joiningDate:    s(body.joiningDate, 10),
    employmentType: s(body.employmentType, 60),
    probation:      s(body.probation, 60),
    grossMonthly:   n(body.grossMonthly),
    annualCtc:      n(body.annualCtc),
    hours:          s(body.hours, 120),
    notice:         s(body.notice, 60),

    signatoryName: s(body.signatoryName, 120),
    signatoryRole: s(body.signatoryRole, 120) || 'Authorised Signatory',
    letterDate:    s(body.letterDate, 10) || new Date().toISOString().slice(0, 10)
  };
}

/* The list: active members on the left, letters already issued below. */
router.get('/appointments', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const where = { role: 'member', status: 'active' };
  if (q) {
    where[Op.or] = [
      { name: { [Op.like]: `%${q}%` } },
      { email: { [Op.like]: `%${q}%` } },
      { memberId: { [Op.like]: `%${q}%` } }
    ];
  }
  const [members, letters] = await Promise.all([
    User.findAll({ where, order: [['name', 'ASC']], limit: 300 }),
    AppointmentLetter.findAll({ order: [['createdAt', 'DESC']], limit: 300 })
  ]);
  const revoked = {};
  const revs = letters.length
    ? await Revocation.findAll({ where: { code: letters.map(l => l.serial) } })
    : [];
  revs.forEach(r => { revoked[r.code] = r; });

  // userId -> how many letters that person already has, so the row can say so
  // rather than letting somebody issue a second one by accident.
  const counts = {};
  letters.forEach(l => { if (l.userId) counts[l.userId] = (counts[l.userId] || 0) + 1; });

  res.render('admin/appointments', {
    title: 'Appointment letters',
    members, letters, revoked, counts, q,
    kinds: LETTER_KINDS, kindLabel: LETTER_KIND_LABEL,
    org: config.org,
    saved: req.query.saved, error: req.query.error
  });
});

/* Preview. Renders from the form WITHOUT writing a row, watermarked SPECIMEN.
   The point is to see the wording and the spacing before a serial is burned —
   serials are permanent and a mistyped one cannot be tidied away. */
router.post('/appointments/preview', async (req, res) => {
  const user = req.body.userId ? await User.findByPk(req.body.userId) : null;
  const draft = letterFromForm(req.body, user);
  if (!draft.name) return res.redirect('/portal/admin/appointments?error=name');
  await appointmentLetterPdf(res, draft, { specimen: true });
});

/* Issue. Mints the serial, writes the row. */
router.post('/appointments', async (req, res) => {
  const user = req.body.userId ? await User.findByPk(req.body.userId) : null;
  if (!user || user.role !== 'member' || user.status !== 'active') {
    return res.redirect('/portal/admin/appointments?error=member');
  }
  const data = letterFromForm(req.body, user);
  if (!data.name) return res.redirect('/portal/admin/appointments?error=name');
  if (!data.designation) return res.redirect('/portal/admin/appointments?error=designation');

  const row = await AppointmentLetter.create(Object.assign(data, {
    serial: serial('TKF-AL'),
    issuedBy: req.session.userId
  }));
  res.redirect(`/portal/admin/appointments?saved=${encodeURIComponent(row.serial)}`);
});

/* The document. Re-rendered from the row every time — this is the "per use"
   part. specimen:false, and this is the ONLY caller that passes it. */
router.get('/appointments/:id.pdf', async (req, res) => {
  const l = await AppointmentLetter.findByPk(req.params.id);
  if (!l) return res.status(404).send('Not found');
  await appointmentLetterPdf(res, l, { specimen: false });
});

/* Withdrawal, not deletion — same as cards and certificates. A letter that has
   been handed over exists whether or not the row does; deleting it would make a
   scan say "not recognised", which reads as forgery rather than withdrawal. */
router.post('/appointments/:id/revoke', async (req, res) => {
  const l = await AppointmentLetter.findByPk(req.params.id);
  if (l) await revoke(l.serial, 'appointment', req);
  res.redirect('/portal/admin/appointments?saved=withdrawn');
});

router.post('/appointments/:id/restore', async (req, res) => {
  const l = await AppointmentLetter.findByPk(req.params.id);
  if (l) await Revocation.destroy({ where: { code: l.serial } });
  res.redirect('/portal/admin/appointments?saved=restored');
});

/* ==========================================================================
   Verification scan log — who checked what, and what they were told.
   ========================================================================== */
router.get('/verification-log', async (req, res) => {
  const scans = await VerificationScan.findAll({ order: [['createdAt', 'DESC']], limit: 500 });
  const counts = scans.reduce((acc, s) => {
    acc[s.result] = (acc[s.result] || 0) + 1;
    return acc;
  }, {});
  const revocations = await Revocation.findAll({ order: [['revokedAt', 'DESC']] });
  res.render('admin/verification-log', {
    title: 'Verification log', scans, counts, revocations
  });
});

/* A certificate PDF for any member, without signing in as them. */
router.get('/members/:id/certificate/:issueId.pdf', async (req, res) => {
  const issue = await CertificateIssue.findOne({
    where: { id: req.params.issueId, userId: req.params.id },
    include: [{ model: Certificate, as: 'certificate' }]
  });
  if (!issue) return res.status(404).send('Not found');
  const user = await User.findByPk(req.params.id);
  const style = await CertificateStyle.findOne({ where: { certificateId: issue.certificateId } });
  await certificatePdf(res, issue.certificate, issue, user, style ? style.template : 'navy');
});

/* 1b. Membership receipts — every fee received, in one list. */
router.get('/membership-receipts', async (req, res) => {
  const payments = await MembershipPayment.findAll({
    include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'memberId'] }],
    order: [['paidAt', 'DESC']]
  });
  const total = payments.reduce((n, p) => n + p.amount, 0);
  res.render('admin/membership-receipts', {
    title: 'Membership receipts', payments, total,
    modeLabel: MODE_LABEL, plans: config.plans
  });
});

router.get('/membership-receipts/:id/pdf', async (req, res) => {
  const payment = await MembershipPayment.findByPk(req.params.id);
  if (!payment) return res.status(404).send('Not found');
  const user = await User.findByPk(payment.userId);
  await membershipReceiptPdf(res, payment, user);
});

router.get('/membership-receipts.csv', async (req, res) => {
  const payments = await MembershipPayment.findAll({
    include: [{ model: User, as: 'user', attributes: ['name', 'email', 'memberId'] }],
    order: [['paidAt', 'DESC']]
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="membership-receipts.csv"');
  const rows = [['Receipt', 'Date', 'MemberId', 'Name', 'Email', 'Plan', 'Amount(INR)', 'Mode', 'Reference', 'ValidTill', 'RecordedOffline'].join(',')];
  payments.forEach(p => {
    const u = p.user || {};
    rows.push([
      p.receiptNo, (p.paidAt || p.createdAt).toISOString().slice(0, 10),
      u.memberId || '', JSON.stringify(u.name || ''), u.email || '',
      p.plan || '', (p.amount / 100).toFixed(2), p.mode || '',
      JSON.stringify(p.reference || ''),
      p.validTill ? p.validTill.toISOString().slice(0, 10) : '',
      p.recordedBy ? 'yes' : 'no'
    ].join(','));
  });
  res.send(rows.join('\n'));
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
/* ORDER MATTERS. These two must stay ABOVE '/certificates/:id' — Express
   matches in declaration order, so with :id first a request for
   /certificates/generate is handled as certificate id "generate" and dies in
   findByPk. Do not move them below it. */
/* "Generate Certificate" — the reference admin's flow. Starts from the list of
   active members rather than from a certificate, which is the direction you are
   facing when you have a batch of people to award. */
router.get('/certificates/generate', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const where = { role: 'member', status: 'active' };
  if (q) {
    where[Op.or] = [
      { name: { [Op.like]: `%${q}%` } },
      { email: { [Op.like]: `%${q}%` } },
      { memberId: { [Op.like]: `%${q}%` } }
    ];
  }
  const [members, certs] = await Promise.all([
    User.findAll({ where, order: [['name', 'ASC']], limit: 300 }),
    Certificate.findAll({ order: [['title', 'ASC']] })
  ]);
  const issues = members.length
    ? await CertificateIssue.findAll({ where: { userId: members.map(m => m.id) } })
    : [];
  // userId -> Set of certificateIds already issued, so the page can grey out a
  // duplicate instead of letting the admin click it and get an error.
  const already = {};
  issues.forEach(i => {
    (already[i.userId] = already[i.userId] || []).push(i.certificateId);
  });
  res.render('admin/cert-generate', {
    title: 'Generate certificate', members, certs, already, q,
    saved: req.query.saved, error: req.query.error
  });
});

/* Every certificate ever issued — members and visitors together, because
   "which certificates exist" is one question, not two. */
router.get('/certificates/issued', async (req, res) => {
  const [issues, visitors] = await Promise.all([
    CertificateIssue.findAll({
      include: [
        { model: Certificate, as: 'certificate', attributes: ['id', 'title'] },
        { model: User, as: 'user', attributes: ['id', 'name', 'email', 'memberId'] }
      ],
      order: [['issuedAt', 'DESC']]
    }),
    VisitorCertificate.findAll({ order: [['createdAt', 'DESC']] })
  ]);

  const codes = issues.map(i => i.serial).concat(visitors.map(v => v.serial));
  const revoked = codes.length
    ? (await Revocation.findAll({ where: { code: codes } }))
        .reduce((m, r) => { m[r.code] = r; return m; }, {})
    : {};

  /* One list, sorted together — an admin looking for a serial does not know or
     care which table it came from. */
  const rows = issues.map(i => ({
    serial: i.serial, title: i.certificate ? i.certificate.title : '—',
    holder: i.user ? i.user.name : '—', extra: i.user ? (i.user.memberId || i.user.email) : '',
    issuedAt: i.issuedAt, kind: 'member',
    pdf: i.user ? `/portal/admin/members/${i.user.id}/certificate/${i.id}.pdf` : null,
    memberId: i.user ? i.user.id : null, issueId: i.id
  })).concat(visitors.map(v => ({
    serial: v.serial, title: v.programme || 'Certificate',
    holder: v.name, extra: v.mobile || v.email || '',
    issuedAt: v.issuedOn ? new Date(v.issuedOn) : v.createdAt, kind: 'visitor',
    pdf: `/portal/admin/visitor-certificates/${v.id}.pdf`,
    visitorId: v.id
  }))).sort((a, b) => new Date(b.issuedAt) - new Date(a.issuedAt));

  res.render('admin/cert-issued', {
    title: 'Issued certificates', rows, revoked,
    liveCount: rows.filter(r => !revoked[r.serial]).length,
    saved: req.query.saved
  });
});

router.get('/certificates/:id', async (req, res) => {
  const cert = await Certificate.findByPk(req.params.id, {
    include: [{ model: CertificateIssue, as: 'issued', include: [{ model: User, as: 'user', attributes: ['name', 'email', 'memberId'] }] }]
  });
  if (!cert) return res.status(404).render('error', { title: 'Not found', message: 'No such certificate.' });
  const members = await User.findAll({ where: { role: 'member', status: 'active' }, order: [['name', 'ASC']] });
  const file = await CertificateFile.findOne({ where: { certificateId: cert.id } });
  const style = await CertificateStyle.findOne({ where: { certificateId: cert.id } });
  res.render('admin/certificate-detail', {
    title: cert.title, cert, members, file,
    templates: CERT_TEMPLATES, template: style ? style.template : 'navy',
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
  const offlineBy = (await OfflineDonation.findAll({
    where: donations.length ? { donationId: donations.map(d => d.id) } : { donationId: -1 }
  })).reduce((m, r) => { m[r.donationId] = r; return m; }, {});
  res.render('admin/donations', {
    title: 'Donations', donations, kind, offlineBy, modeLabel: MODE_LABEL,
    categories: config.donationCategories, modes: membership.OFFLINE_MODES,
    saved: req.query.saved, error: req.query.error
  });
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

/* ==========================================================================
   Certificate designs, the Generate page, and the issued-certificate register.
   ========================================================================== */

/* Which of the three designs a certificate type prints in. Stored per type in
   CertificateStyle — see models/index.js on why it cannot be a column. */
async function styleMap(ids) {
  if (!ids.length) return {};
  const rows = await CertificateStyle.findAll({ where: { certificateId: ids } });
  return rows.reduce((m, r) => { m[r.certificateId] = r.template; return m; }, {});
}

router.post('/certificates/:id/style', async (req, res) => {
  const cert = await Certificate.findByPk(req.params.id);
  if (!cert) return res.status(404).send('No such certificate');
  const template = CERT_TEMPLATE_KEYS.includes(req.body.template) ? req.body.template : 'navy';
  const [row] = await CertificateStyle.findOrCreate({
    where: { certificateId: cert.id }, defaults: { certificateId: cert.id, template }
  });
  if (row.template !== template) await row.update({ template });
  res.redirect(`/portal/admin/certificates/${cert.id}?saved=style`);
});

/* ==========================================================================
   Visitor certificates — for somebody with no account.
   ========================================================================== */

router.get('/visitor-certificates', async (req, res) => {
  const list = await VisitorCertificate.findAll({ order: [['createdAt', 'DESC']], limit: 300 });
  const revoked = list.length
    ? (await Revocation.findAll({ where: { code: list.map(v => v.serial) } }))
        .reduce((m, r) => { m[r.code] = r; return m; }, {})
    : {};
  res.render('admin/visitor-certificates', {
    title: 'Visitor certificates', list, revoked,
    templates: CERT_TEMPLATES, programmes: config.donationCategories,
    saved: req.query.saved, error: req.query.error
  });
});

router.post('/visitor-certificates', async (req, res) => {
  const s = (v, n) => String(v == null ? '' : v).trim().slice(0, n) || null;
  const name = s(req.body.name, 120);
  if (!name) return res.redirect('/portal/admin/visitor-certificates?error=name');

  const vc = await VisitorCertificate.create({
    serial: serial('TKF-VC'),
    name,
    fatherName: s(req.body.fatherName, 120),
    mobile:     s(req.body.mobile, 30),
    email:      s(req.body.email, 160),
    programme:  s(req.body.programme, 120),
    template:   CERT_TEMPLATE_KEYS.includes(req.body.template) ? req.body.template : 'navy',
    issuedOn:   new Date().toISOString().slice(0, 10),
    issuedBy:   req.session.userId
  });
  res.redirect(`/portal/admin/visitor-certificates?saved=${encodeURIComponent(vc.serial)}`);
});

router.get('/visitor-certificates/:id.pdf', async (req, res) => {
  const vc = await VisitorCertificate.findByPk(req.params.id);
  if (!vc) return res.status(404).send('Not found');
  await visitorCertificatePdf(res, vc);
});

router.post('/visitor-certificates/:id/revoke', async (req, res) => {
  const vc = await VisitorCertificate.findByPk(req.params.id);
  if (vc) await revoke(vc.serial, 'certificate', req);
  res.redirect('/portal/admin/visitor-certificates?saved=revoked');
});

router.post('/visitor-certificates/:id/restore', async (req, res) => {
  const vc = await VisitorCertificate.findByPk(req.params.id);
  if (vc) await Revocation.destroy({ where: { code: vc.serial } });
  res.redirect('/portal/admin/visitor-certificates?saved=restored');
});

/* ==========================================================================
   A donation taken offline.

   Stored as an ordinary Donation so it appears in every list and total, with an
   OfflineDonation row recording how it arrived and who entered it. Same
   reasoning as a membership fee taken in cash.
   ========================================================================== */
router.post('/donations/offline', async (req, res) => {
  const s = (v, n) => String(v == null ? '' : v).trim().slice(0, n) || null;
  const mode = String(req.body.mode || '').toLowerCase();
  if (!membership.isOfflineMode(mode)) return res.redirect('/portal/admin/donations?error=mode');

  const rupees = parseFloat(req.body.amount);
  if (!Number.isFinite(rupees) || rupees < 1) return res.redirect('/portal/admin/donations?error=amount');
  const name = s(req.body.name, 120);
  if (!name) return res.redirect('/portal/admin/donations?error=name');

  const category = config.donationCategories.includes(req.body.category)
    ? req.body.category : 'Where it is needed most';

  const when = req.body.paidAt ? new Date(req.body.paidAt) : null;
  const paidAt = when && !isNaN(when) && when <= new Date(Date.now() + 86400000) ? when : new Date();

  /* An offline donation is `guest` kind even when the donor is a member: `kind`
     records HOW it arrived (through the member portal, or not), and this one did
     not come through the portal at all. If they are a member we still link the
     userId, so it shows on their record. */
  const linkedMember = req.body.userId ? await User.findByPk(req.body.userId) : null;

  const donation = await Donation.create({
    kind: 'guest',
    guest: {
      name,
      email: s(req.body.email, 160),
      phone: s(req.body.phone, 30),
      city:  s(req.body.city, 80),
      pan:   s(req.body.pan, 20)
    },
    userId: linkedMember ? linkedMember.id : null,
    category,
    amount: Math.round(rupees * 100),
    status: 'paid',
    // Prefixed so it is obvious in the list that no gateway was involved.
    txnId: 'OFFLINE' + Date.now() + crypto.randomBytes(3).toString('hex').toUpperCase(),
    receiptNo: serial('TKF-R'),
    paidAt
  });
  await OfflineDonation.create({
    donationId: donation.id, mode,
    reference: s(req.body.reference, 120),
    note: s(req.body.note, 240),
    recordedBy: req.session.userId
  });
  res.redirect(`/portal/admin/donations?saved=${encodeURIComponent(donation.receiptNo)}`);
});

/* ==========================================================================
   All Receipts — one hub, four lists.
   ========================================================================== */

const RECEIPT_TABS = [
  { key: 'membership', label: 'Membership receipts' },
  { key: 'member',     label: 'Member donation receipts' },
  { key: 'visitor',    label: 'Visitor donation receipts' },
  { key: 'offline',    label: 'Cash & offline receipts' }
];

router.get('/receipts', async (req, res) => {
  const [memberships, memberDon, visitorDon, offline] = await Promise.all([
    MembershipPayment.count(),
    Donation.count({ where: { kind: 'member', status: 'paid' } }),
    Donation.count({ where: { kind: 'guest', status: 'paid' } }),
    OfflineDonation.count()
  ]);
  const [mTotal, dTotal] = await Promise.all([
    MembershipPayment.sum('amount'),
    Donation.sum('amount', { where: { status: 'paid' } })
  ]);
  res.render('admin/receipts', {
    title: 'All receipts', tabs: RECEIPT_TABS,
    counts: { membership: memberships, member: memberDon, visitor: visitorDon, offline },
    totals: { membership: mTotal || 0, donations: dTotal || 0 }
  });
});

router.get('/receipts/:kind', async (req, res) => {
  const kind = RECEIPT_TABS.some(t => t.key === req.params.kind) ? req.params.kind : 'membership';

  if (kind === 'membership') {
    const payments = await MembershipPayment.findAll({
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'memberId'] }],
      order: [['paidAt', 'DESC']]
    });
    return res.render('admin/membership-receipts', {
      title: 'Membership receipts', payments,
      total: payments.reduce((n, p) => n + p.amount, 0),
      modeLabel: MODE_LABEL, plans: config.plans
    });
  }

  /* The three donation lists. `offline` cuts across the other two — it is the
     ones an admin keyed in rather than a kind of donor — so it is selected by
     the presence of an OfflineDonation row, not by Donation.kind. */
  let where = { status: 'paid' };
  let offlineIds = null;
  if (kind === 'member') where.kind = 'member';
  if (kind === 'visitor') where.kind = 'guest';
  if (kind === 'offline') {
    const rows = await OfflineDonation.findAll({ attributes: ['donationId'] });
    offlineIds = rows.map(r => r.donationId);
    where.id = offlineIds.length ? offlineIds : [-1];
  }
  const donations = await Donation.findAll({
    where, include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'memberId'] }],
    order: [['paidAt', 'DESC']]
  });
  const offlineBy = (await OfflineDonation.findAll({
    where: donations.length ? { donationId: donations.map(d => d.id) } : { donationId: -1 }
  })).reduce((m, r) => { m[r.donationId] = r; return m; }, {});

  res.render('admin/donation-receipts', {
    title: RECEIPT_TABS.find(t => t.key === kind).label,
    kind, tabs: RECEIPT_TABS, donations, offlineBy, modeLabel: MODE_LABEL,
    total: donations.reduce((n, d) => n + d.amount, 0)
  });
});

/* ==========================================================================
   All Users Data, and the Blocked Users list.
   ========================================================================== */

router.get('/users', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const where = {};
  if (q) {
    where[Op.or] = [
      { name: { [Op.like]: `%${q}%` } },
      { email: { [Op.like]: `%${q}%` } },
      { phone: { [Op.like]: `%${q}%` } },
      { memberId: { [Op.like]: `%${q}%` } }
    ];
  }
  const users = await User.findAll({ where, order: [['createdAt', 'DESC']], limit: 500 });
  const ids = users.map(u => u.id);
  const [access, managers, payments] = await Promise.all([
    ids.length ? UserAccess.findAll({ where: { userId: ids } }) : [],
    ids.length ? ManagerAccess.findAll({ where: { userId: ids } }) : [],
    ids.length ? MembershipPayment.findAll({ where: { userId: ids }, attributes: ['userId'] }) : []
  ]);
  const accessBy = access.reduce((m, a) => { m[a.userId] = a; return m; }, {});
  const managerBy = managers.reduce((m, a) => { m[a.userId] = a; return m; }, {});
  const paidIds = new Set(payments.map(p => p.userId));
  res.render('admin/users', {
    title: 'All users', users, accessBy, managerBy, paidIds, q,
    total: await User.count()
  });
});

router.get('/blocked', async (req, res) => {
  const blocks = await UserAccess.findAll({ where: { blocked: true }, order: [['blockedAt', 'DESC']] });
  const users = blocks.length
    ? await User.findAll({ where: { id: blocks.map(b => b.userId) } })
    : [];
  const byId = users.reduce((m, u) => { m[u.id] = u; return m; }, {});
  res.render('admin/blocked', { title: 'Deactivated accounts', blocks, byId });
});

/* ==========================================================================
   Notices.

   In-portal only. There is no mail sender in this application, so the view says
   so in as many words — see the note on the Notice model.
   ========================================================================== */

router.get('/notices', async (req, res) => {
  const notices = await Notice.findAll({ order: [['pinned', 'DESC'], ['createdAt', 'DESC']] });
  const [members, guests] = await Promise.all([
    User.count({ where: { role: 'member', status: 'active' } }),
    User.count({ where: { role: 'member', status: 'guest' } })
  ]);
  res.render('admin/notices', {
    title: 'Notices', notices, audienceCounts: { members, guests, all: members + guests },
    saved: req.query.saved, error: req.query.error
  });
});

router.post('/notices', async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 160);
  const body = String(req.body.body || '').trim().slice(0, 4000);
  if (!title || !body) return res.redirect('/portal/admin/notices?error=empty');
  const audience = ['all', 'members', 'guests'].includes(req.body.audience) ? req.body.audience : 'all';
  const exp = req.body.expiresOn ? new Date(req.body.expiresOn) : null;
  await Notice.create({
    title, body, audience,
    pinned: req.body.pinned === 'on',
    expiresOn: exp && !isNaN(exp) ? exp.toISOString().slice(0, 10) : null,
    createdBy: req.session.userId
  });
  res.redirect('/portal/admin/notices?saved=1');
});

router.post('/notices/:id/toggle', async (req, res) => {
  const n = await Notice.findByPk(req.params.id);
  if (n) await n.update({ active: !n.active });
  res.redirect('/portal/admin/notices?saved=1');
});

router.post('/notices/:id/delete', adminOnly, async (req, res) => {
  const n = await Notice.findByPk(req.params.id);
  if (n) await n.destroy();
  res.redirect('/portal/admin/notices?saved=1');
});

/* ==========================================================================
   Manager section.

   Admin-only throughout, including the GET: the list of who can see what is
   itself sensitive, and a manager who can read it is halfway to editing it.
   `adminOnly` is redundant with the allow table (which does not mention these
   paths at all) and that is the point — two independent checks on the one thing
   where a mistake is a privilege escalation.
   ========================================================================== */

router.get('/managers', adminOnly, async (req, res) => {
  const grants = await ManagerAccess.findAll({ order: [['createdAt', 'DESC']] });
  const users = grants.length
    ? await User.findAll({ where: { id: grants.map(g => g.userId) } })
    : [];
  const byId = users.reduce((m, u) => { m[u.id] = u; return m; }, {});
  // Candidates: ordinary member accounts that are not already managers.
  const taken = new Set(grants.map(g => g.userId));
  const candidates = (await User.findAll({
    where: { role: 'member' }, order: [['name', 'ASC']], limit: 500
  })).filter(u => !taken.has(u.id));
  res.render('admin/managers', {
    title: 'Managers', grants, byId, candidates,
    sections: STAFF_SECTIONS, saved: req.query.saved, error: req.query.error
  });
});

router.post('/managers', adminOnly, async (req, res) => {
  const user = await User.findByPk(req.body.userId);
  if (!user) return res.redirect('/portal/admin/managers?error=nouser');
  if (user.role === 'admin') return res.redirect('/portal/admin/managers?error=isadmin');
  const sections = cleanSections([].concat(req.body.sections || []));
  const [grant] = await ManagerAccess.findOrCreate({
    where: { userId: user.id },
    defaults: { userId: user.id, sections, grantedBy: req.session.userId }
  });
  await grant.update({
    sections,
    note: String(req.body.note || '').trim().slice(0, 240) || null,
    active: true,
    grantedBy: req.session.userId
  });
  res.redirect('/portal/admin/managers?saved=1');
});

router.post('/managers/:id/update', adminOnly, async (req, res) => {
  const grant = await ManagerAccess.findByPk(req.params.id);
  if (!grant) return res.redirect('/portal/admin/managers?error=nouser');
  await grant.update({
    sections: cleanSections([].concat(req.body.sections || [])),
    note: String(req.body.note || '').trim().slice(0, 240) || null,
    active: req.body.active === 'on'
  });
  res.redirect('/portal/admin/managers?saved=1');
});

router.post('/managers/:id/delete', adminOnly, async (req, res) => {
  const grant = await ManagerAccess.findByPk(req.params.id);
  if (grant) await grant.destroy();
  res.redirect('/portal/admin/managers?saved=1');
});

/* ==========================================================================
   Report downloads — every export in one place.
   ========================================================================== */

const REPORTS = [
  { key: 'donations',           label: 'All donations',        href: '/portal/admin/donations.csv',
    note: 'Every paid donation, member and visitor, with receipt number and transaction.' },
  { key: 'membership-receipts', label: 'Membership fees',      href: '/portal/admin/membership-receipts.csv',
    note: 'Every membership fee received, flagged by whether it came from the gateway or was keyed in.' },
  { key: 'members',             label: 'Members',              href: '/portal/admin/members.csv',
    note: 'Member list with ID, plan, validity and fee state.' },
  { key: 'certificates',        label: 'Issued certificates',  href: '/portal/admin/certificates.csv',
    note: 'Every certificate issued, members and visitors, with its verification status.' },
  { key: 'volunteers',          label: 'Volunteer applications', href: '/portal/admin/volunteers.csv',
    note: 'Volunteer registrations from the public form.' },
  { key: 'enquiries',           label: 'Contact enquiries',    href: '/portal/admin/enquiries.csv',
    note: 'Messages from the contact form.' }
];

router.get('/reports', async (req, res) => {
  res.render('admin/reports', { title: 'Report downloads', reports: REPORTS });
});

const csvCell = v => {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
function sendCsv(res, filename, header, rows) {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send([header.join(','), ...rows.map(r => r.map(csvCell).join(','))].join('\n'));
}

router.get('/members.csv', async (req, res) => {
  const members = await User.findAll({ where: { role: 'member' }, order: [['createdAt', 'DESC']] });
  const paid = new Set((await MembershipPayment.findAll({ attributes: ['userId'] })).map(p => p.userId));
  sendCsv(res, 'members.csv',
    ['MemberId', 'Name', 'Email', 'Phone', 'City', 'State', 'Plan', 'PaidOn', 'ValidTill', 'FeeReceived', 'Registered'],
    members.map(u => [
      u.memberId || '', u.name, u.email, u.phone, u.city || '',
      u.status, u.membershipPlan || '',
      u.membershipPaidAt ? u.membershipPaidAt.toISOString().slice(0, 10) : '',
      u.membershipValidTill ? u.membershipValidTill.toISOString().slice(0, 10) : '',
      paid.has(u.id) ? 'yes' : 'no',
      u.createdAt.toISOString().slice(0, 10)
    ]));
});

router.get('/certificates.csv', async (req, res) => {
  const [issues, visitors] = await Promise.all([
    CertificateIssue.findAll({
      include: [
        { model: Certificate, as: 'certificate', attributes: ['title'] },
        { model: User, as: 'user', attributes: ['name', 'email', 'memberId'] }
      ], order: [['issuedAt', 'DESC']]
    }),
    VisitorCertificate.findAll({ order: [['createdAt', 'DESC']] })
  ]);
  const revoked = new Set((await Revocation.findAll({ attributes: ['code'] })).map(r => r.code));
  const rows = issues.map(i => [
    i.serial, 'member', i.certificate ? i.certificate.title : '',
    i.user ? i.user.name : '', i.user ? (i.user.memberId || '') : '',
    i.user ? i.user.email : '', i.issuedAt.toISOString().slice(0, 10),
    revoked.has(i.serial) ? 'withdrawn' : 'valid'
  ]).concat(visitors.map(v => [
    v.serial, 'visitor', v.programme || '', v.name, '', v.email || '',
    v.issuedOn || v.createdAt.toISOString().slice(0, 10),
    revoked.has(v.serial) ? 'withdrawn' : 'valid'
  ]));
  sendCsv(res, 'certificates.csv',
    ['Serial', 'Type', 'Title', 'Holder', 'MemberId', 'Email', 'Issued', 'Status'], rows);
});

module.exports = router;
