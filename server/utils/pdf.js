const PDFDocument = require('pdfkit');
const config = require('../config');
const { qrBuffer, barcodeBuffer } = require('./codes');
const verify = require('./verify');

const INK = '#101F29', PURPLE = '#7D4AB1', SOFT = '#5B6870', RULE = '#D8D4CA';

function money(paise) { return '₹' + (paise / 100).toLocaleString('en-IN'); }

/* The QR and the barcode carry DIFFERENT payloads, on purpose.

   QR -> the verification URL. Phones scan QR codes with the camera app and open
   URLs, so a QR is a link. It used to encode the bare serial, which meant
   scanning a certificate produced a line of text and nothing else.

   Barcode -> the bare serial. A Code128 scanner is a keyboard: it types what it
   reads into whatever field has focus. A URL there is noise; the serial is what
   somebody wants in their spreadsheet.

   The caption changed with it. It used to say "verify by quoting the serial",
   which meant telephoning the office. Now it says where the document verifies,
   because that is now a place that exists. */
async function codesRow(doc, serialText, x, y) {
  const [qr, bar] = await Promise.all([
    qrBuffer(verify.verifyUrl(serialText), { ec: 'Q', width: 420 }),
    barcodeBuffer(serialText)
  ]);
  doc.image(qr, x, y, { width: 78 });
  doc.image(bar, x + 95, y + 14, { width: 190 });
  doc.font('Helvetica').fontSize(7.5).fillColor(SOFT)
     .text('Scan the QR code, or check this serial at', x + 95, y + 58)
     .fillColor(PURPLE).font('Helvetica-Bold')
     .text(verify.origin().replace(/^https?:\/\//, '') + '/verify', x + 95, y + 67);
}

function header(doc, title) {
  doc.rect(0, 0, doc.page.width, 6).fill(PURPLE);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(18).text(config.org.name, 50, 34);
  doc.font('Helvetica').fontSize(9).fillColor(SOFT)
     .text(`Reg. No ${config.org.regNo}  ·  Darpan ${config.org.darpan}  ·  PAN ${config.org.pan}`, 50, 56)
     .text(config.org.address, 50, 68);
  doc.moveTo(50, 88).lineTo(doc.page.width - 50, 88).strokeColor(RULE).stroke();
  doc.font('Helvetica-Bold').fontSize(14).fillColor(PURPLE).text(title, 50, 102);
}

async function receiptPdf(res, donation, user) {
  const doc = new PDFDocument({ size: 'A5', layout: 'landscape', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="receipt-${donation.receiptNo}.pdf"`);
  doc.pipe(res);
  header(doc, 'Donation Receipt');
  const d = donation, who = user || d.guest || {};
  doc.font('Helvetica').fontSize(10).fillColor(INK);
  const rows = [
    ['Receipt No', d.receiptNo],
    ['Date', (d.paidAt || d.createdAt).toDateString()],
    ['Received from', who.name || '-'],
    ['Email / Phone', `${who.email || '-'}  ·  ${who.phone || '-'}`],
    ['PAN', who.pan || '—'],
    ['Program', d.category],
    ['Amount', money(d.amount)],
    ['Transaction', d.gatewayRef || d.txnId]
  ];
  let y = 132;
  rows.forEach(([k, v]) => {
    doc.font('Helvetica-Bold').text(k, 50, y, { width: 110 });
    doc.font('Helvetica').text(String(v), 170, y);
    y += 18;
  });
  await codesRow(doc, d.receiptNo, 50, y + 8);
  doc.end();
}

/* Membership fee receipt. Deliberately separate from receiptPdf: that one is
   built around a Donation (programme, 80G, donor-or-guest), and a membership
   receipt has to state the plan and the period it covers instead. One function
   doing both would print a receipt with empty rows on it. */
const MODE_LABEL = {
  online: 'Online (PhonePe)', cash: 'Cash', bank: 'Bank transfer',
  upi: 'UPI', cheque: 'Cheque'
};

async function membershipReceiptPdf(res, payment, user) {
  const doc = new PDFDocument({ size: 'A5', layout: 'landscape', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="membership-${payment.receiptNo}.pdf"`);
  doc.pipe(res);
  header(doc, 'Membership Fee Receipt');
  const p = payment, who = user || {};
  const plan = config.plans[p.plan] ? config.plans[p.plan].name : (p.plan || '—');
  doc.font('Helvetica').fontSize(10).fillColor(INK);
  const rows = [
    ['Receipt No', p.receiptNo],
    ['Date', (p.paidAt || p.createdAt).toDateString()],
    ['Received from', who.name || '-'],
    ['Member ID', who.memberId || '—'],
    ['Email / Phone', `${who.email || '-'}  ·  ${who.phone || '-'}`],
    ['Plan', plan],
    ['Valid till', p.validTill ? p.validTill.toDateString() : '—'],
    ['Amount', money(p.amount)],
    ['Paid by', MODE_LABEL[p.mode] || p.mode || '—'],
    ['Reference', p.reference || '—']
  ];
  let y = 126;
  rows.forEach(([k, v]) => {
    doc.font('Helvetica-Bold').text(k, 50, y, { width: 110 });
    doc.font('Helvetica').text(String(v), 170, y);
    y += 15;
  });
  await codesRow(doc, p.receiptNo, 50, y + 4);
  doc.end();
}

/* ==========================================================================
   Certificates, in three designs.

   The client's reference admin offers three templates at issue time, so this
   does too. They differ in the frame colour, the seal and the corner treatment —
   not in the information, which is identical on all three. A template that moved
   the serial or dropped the QR would be a different document, not a different
   design.

   Each one is drawn rather than composited over a background image so that a
   long title or a long name reflows instead of overprinting the border.
   ========================================================================== */
const CERT_TEMPLATES = {
  navy:   { key: 'navy',   label: 'Navy & gold',   frame: '#0E4C92', accent: '#B8860B', wash: '#F7F9FC' },
  purple: { key: 'purple', label: 'Purple',        frame: '#7D4AB1', accent: '#C0397A', wash: '#FAF7FD' },
  green:  { key: 'green',  label: 'Green',         frame: '#2F5D03', accent: '#59B306', wash: '#F6FAF2' }
};
const CERT_TEMPLATE_KEYS = Object.keys(CERT_TEMPLATES);

function certTemplate(key) {
  return CERT_TEMPLATES[key] || CERT_TEMPLATES.navy;
}

/* A ribbon seal, drawn. Three concentric arcs and two tails — enough to read as
   a seal at print size without shipping an image per template. */
function seal(doc, x, y, t) {
  doc.save();
  doc.path(`M ${x - 9} ${y + 16} L ${x - 4} ${y + 34} L ${x} ${y + 26} L ${x + 4} ${y + 34} L ${x + 9} ${y + 16} Z`).fill(t.accent);
  doc.circle(x, y, 17).fill(t.frame);
  doc.circle(x, y, 13).fill(t.accent);
  doc.circle(x, y, 8).fill(t.frame);
  doc.restore();
}

/* One renderer for member certificates and visitor certificates alike. `doc`
   subject fields are already resolved by the caller, so this function knows
   nothing about which table the record came from. */
async function drawCertificate(doc, opts) {
  const t = certTemplate(opts.template);
  const W = doc.page.width, H = doc.page.height;

  doc.rect(0, 0, W, H).fill(t.wash);
  // Double frame.
  doc.save().lineWidth(3).strokeColor(t.frame).rect(22, 22, W - 44, H - 44).stroke().restore();
  doc.save().lineWidth(0.8).strokeColor(t.accent).rect(30, 30, W - 60, H - 60).stroke().restore();
  // Corner wedges, so the three templates are distinguishable at a glance.
  [[30, 30, 1, 1], [W - 30, 30, -1, 1], [30, H - 30, 1, -1], [W - 30, H - 30, -1, -1]]
    .forEach(([cx, cy, sx, sy]) => {
      doc.save().path(`M ${cx} ${cy} L ${cx + 34 * sx} ${cy} L ${cx} ${cy + 34 * sy} Z`).fill(t.accent).restore();
    });

  const logo = certLogo();
  if (logo) {
    try { doc.image(logo, W / 2 - 52, 46, { fit: [104, 34], align: 'center' }); } catch (e) {}
  }
  doc.fillColor(SOFT).font('Helvetica').fontSize(9)
     .text(config.org.name.toUpperCase(), 0, 86, { align: 'center', characterSpacing: 2.2 });
  doc.fillColor(SOFT).font('Helvetica').fontSize(7)
     .text(`Reg. No ${config.org.regNo}   ·   NGO Darpan ${config.org.darpan}`, 0, 99,
       { align: 'center', characterSpacing: 0.6 });

  doc.fillColor(t.frame).font('Helvetica-Bold').fontSize(27)
     .text(opts.title || 'Certificate', 70, 150, { align: 'center', width: W - 140 });

  doc.font('Helvetica').fontSize(11).fillColor(SOFT)
     .text('is proudly presented to', 0, 206, { align: 'center' });
  doc.font('Helvetica-Bold').fontSize(23).fillColor(t.accent)
     .text(opts.holder || '—', 70, 228, { align: 'center', width: W - 140 });
  doc.save().lineWidth(0.7).strokeColor(t.accent)
     .moveTo(W / 2 - 140, 262).lineTo(W / 2 + 140, 262).stroke().restore();

  /* Sub-line: a father's name for a visitor certificate, a member id for a
     member. Whichever the caller supplied. */
  if (opts.subline) {
    doc.font('Helvetica').fontSize(9.5).fillColor(SOFT)
       .text(opts.subline, 70, 269, { align: 'center', width: W - 140 });
  }
  if (opts.body) {
    doc.font('Helvetica').fontSize(10.5).fillColor(INK)
       .text(opts.body, 130, 293, { align: 'center', width: W - 260, lineGap: 2 });
  }

  seal(doc, W - 118, H - 132, t);

  doc.font('Helvetica').fontSize(8.5).fillColor(SOFT)
     .text(`Serial ${opts.serial}`, 60, H - 152, { characterSpacing: 0.4 })
     .text(`Issued ${opts.issuedOn}`, 60, H - 141);

  doc.save().lineWidth(0.7).strokeColor(SOFT)
     .moveTo(W - 210, H - 74).lineTo(W - 60, H - 74).stroke().restore();
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(SOFT)
     .text('AUTHORISED SIGNATORY', W - 210, H - 70, { width: 150, align: 'center', characterSpacing: 0.5 });

  await codesRow(doc, opts.serial, 60, H - 128);
}

function certLogo() {
  const fsx = require('fs'), px = require('path');
  for (const n of ['logo-lockup@2x.png', 'logo-lockup.png', 'logo.png']) {
    const f = px.join(__dirname, '..', '..', 'assets', 'img', n);
    try { if (fsx.statSync(f).isFile()) return f; } catch (e) {}
  }
  return null;
}

async function certificatePdf(res, cert, issuance, user, template) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="certificate-${issuance.serial}.pdf"`);
  doc.pipe(res);
  await drawCertificate(doc, {
    template,
    title: cert.title,
    holder: user ? user.name : '—',
    subline: user && user.memberId ? `Member ID ${user.memberId}` : null,
    body: cert.description || null,
    serial: issuance.serial,
    issuedOn: (issuance.issuedAt || new Date()).toDateString()
  });
  doc.end();
}

/* A certificate for somebody with no account. Same renderer, different record —
   see models/index.js on why VisitorCertificate is its own table. */
async function visitorCertificatePdf(res, vc) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="certificate-${vc.serial}.pdf"`);
  doc.pipe(res);
  await drawCertificate(doc, {
    template: vc.template,
    title: vc.programme || 'Certificate of Participation',
    holder: vc.name,
    subline: vc.fatherName ? `S/o, D/o ${vc.fatherName}` : null,
    body: vc.programme
      ? `for participation in ${vc.programme} organised by ${config.org.name}.`
      : null,
    serial: vc.serial,
    issuedOn: vc.issuedOn ? new Date(vc.issuedOn).toDateString() : new Date().toDateString()
  });
  doc.end();
}

/* The membership card USED TO LIVE HERE — a 430x270 landscape rectangle, one
   page, no photograph, no logo, generic purple band. It has been deleted.
   The card is now `idCardPdf` in ./idcard.js: CR80 portrait, two pages
   (front and back), drawn to the artwork the client supplied.

   It is deleted rather than kept as a "simple" alternative on purpose. Both
   existed side by side for a while, on two routes, behind two buttons that
   were both labelled "ID card" — so which card a member got depended on which
   button somebody happened to click, and the printed cards did not match each
   other. One card, one generator, one route. */

module.exports = {
  receiptPdf, membershipReceiptPdf, certificatePdf, visitorCertificatePdf,
  MODE_LABEL, CERT_TEMPLATES, CERT_TEMPLATE_KEYS
};
