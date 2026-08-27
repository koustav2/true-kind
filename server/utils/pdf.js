const PDFDocument = require('pdfkit');
const config = require('../config');
const { qrBuffer, barcodeBuffer } = require('./codes');
const verify = require('./verify');

const INK = '#101F29', PURPLE = '#7D4AB1', SOFT = '#5B6870', RULE = '#D8D4CA';

/* "Rs." and not "₹", and this is not a style choice.

   PDFKit's built-in Helvetica is encoded WinAnsi, which has no U+20B9. Handed a
   ₹ it silently substitutes the nearest codepoint it does have — `¹`, superscript
   one — so every receipt this portal has ever generated printed the amount as
   "¹1,500". Silently: no error, no warning, and it looks close enough to a thin
   glyph on screen that it survived review.

   Two ways out. This one costs nothing and cannot fail: "Rs. 1,500" is ordinary
   on an Indian receipt and unambiguous everywhere. The other is to bundle a TTF
   that has the glyph (DejaVuSans does; ~744 KB) in assets/fonts and register it
   with doc.registerFont — a system font is NOT an option, because the runtime
   image is node:20-alpine and ships no fonts at all, so it would render here and
   break in production.

   Every amount in every PDF goes through this one function, so switching to the
   symbol later is a one-line change here and nowhere else. */
function money(paise) { return 'Rs. ' + (paise / 100).toLocaleString('en-IN'); }

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
  online: 'Online (Razorpay)', cash: 'Cash', bank: 'Bank transfer',
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
   Certificates, in six designs across three LAYOUTS.

   The first three (navy/purple/green) are one layout — a double frame with
   corner wedges and a corner seal — in three colourways. The other three
   (maroon, teal, slate) are genuinely different compositions, not recolours
   of the same drawing: a ribbon banner with a centred medallion (maroon,
   teal), and a left-aligned, seal-free modern strip (slate). `layout` on
   each entry says which drawing function it uses; `certTemplate()` falls
   back to 'frame' for anything undeclared, so an entry that forgets the key
   still renders instead of crashing.

   Whatever the layout, the INFORMATION is identical on every template — the
   serial, the issued date, the QR, the barcode and the signatory line are
   drawn once, by the single shared `drawFooter`, never by a per-layout
   function. A template that moved the serial or dropped the QR would be a
   different document, not a different design; putting the footer in one
   place, called by all six, makes that impossible to get wrong per-template.

   Every layout is drawn rather than composited over a background image so
   that a long title or a long name reflows instead of overprinting the
   border.
   ========================================================================== */
const CERT_TEMPLATES = {
  navy:   { key: 'navy',   label: 'Navy & gold',          layout: 'frame',  frame: '#0E4C92', accent: '#B8860B', wash: '#F7F9FC' },
  purple: { key: 'purple', label: 'Purple',               layout: 'frame',  frame: '#7D4AB1', accent: '#C0397A', wash: '#FAF7FD' },
  green:  { key: 'green',  label: 'Green',                layout: 'frame',  frame: '#2F5D03', accent: '#59B306', wash: '#F6FAF2' },
  maroon: { key: 'maroon', label: 'Maroon & gold ribbon', layout: 'ribbon', frame: '#7A1F2B', accent: '#C89A3A', wash: '#FBF7EE' },
  teal:   { key: 'teal',   label: 'Teal ribbon',          layout: 'ribbon', frame: '#0B5E5A', accent: '#D97B3F', wash: '#F2FAF9' },
  slate:  { key: 'slate',  label: 'Slate modern',         layout: 'modern', frame: '#1F2937', accent: '#E4572E', wash: '#FFFFFF' }
};
const CERT_TEMPLATE_KEYS = Object.keys(CERT_TEMPLATES);

function certTemplate(key) {
  return CERT_TEMPLATES[key] || CERT_TEMPLATES.navy;
}

/* A ribbon seal, drawn. Three concentric arcs and two tails — enough to read as
   a seal at print size without shipping an image per template. Used by the
   'frame' layout, corner-mounted. */
function cornerSeal(doc, x, y, t) {
  doc.save();
  doc.path(`M ${x - 9} ${y + 16} L ${x - 4} ${y + 34} L ${x} ${y + 26} L ${x + 4} ${y + 34} L ${x + 9} ${y + 16} Z`).fill(t.accent);
  doc.circle(x, y, 17).fill(t.frame);
  doc.circle(x, y, 13).fill(t.accent);
  doc.circle(x, y, 8).fill(t.frame);
  doc.restore();
}

/* Same idea, bigger, with two tails instead of one, sat bottom-centre for the
   'ribbon' layout's medallion. */
function medallionSeal(doc, x, y, t) {
  doc.save();
  doc.path(`M ${x - 11} ${y + 18} L ${x - 5} ${y + 40} L ${x} ${y + 30} L ${x + 5} ${y + 40} L ${x + 11} ${y + 18} Z`).fill(t.frame);
  doc.circle(x, y, 20).fill(t.frame);
  doc.circle(x, y, 15).fill(t.accent);
  doc.circle(x, y, 9).fill(t.frame);
  doc.restore();
}

/* ---- shared footer -------------------------------------------------------
   Serial, issued date, signatory line, QR and barcode — at the SAME position
   regardless of which layout drew everything above it. This is what keeps the
   "identical information on every template" promise true by construction:
   there is exactly one place in the code that draws the serial, and every
   layout function calls it instead of drawing its own. */
async function drawFooter(doc, t, opts, W, H) {
  doc.font('Helvetica').fontSize(8.5).fillColor(SOFT)
     .text(`Serial ${opts.serial}`, 60, H - 152, { characterSpacing: 0.4 })
     .text(`Issued ${opts.issuedOn}`, 60, H - 141);

  doc.save().lineWidth(0.7).strokeColor(SOFT)
     .moveTo(W - 210, H - 74).lineTo(W - 60, H - 74).stroke().restore();
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(SOFT)
     .text('AUTHORISED SIGNATORY', W - 210, H - 70, { width: 150, align: 'center', characterSpacing: 0.5 });

  await codesRow(doc, opts.serial, 60, H - 128);
}

/* ---- layout: frame --------------------------------------------------------
   Double rectangle border, four corner wedges, a seal in the corner. The
   original three-colourway design. */
function drawFrameLayout(doc, t, opts, W, H) {
  doc.rect(0, 0, W, H).fill(t.wash);
  doc.save().lineWidth(3).strokeColor(t.frame).rect(22, 22, W - 44, H - 44).stroke().restore();
  doc.save().lineWidth(0.8).strokeColor(t.accent).rect(30, 30, W - 60, H - 60).stroke().restore();
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

  cornerSeal(doc, W - 118, H - 132, t);
}

/* ---- layout: ribbon --------------------------------------------------------
   A single thin border with L-shaped corner brackets (not wedges — the point
   is that this reads as a different design from across a room, not just a
   different colour), a notched ribbon banner carrying the title, and a
   medallion with two hanging tails centred at the bottom. Formal / award-like,
   for the client who wants something closer to a printed award than a
   frame-and-logo layout. */
function drawRibbonLayout(doc, t, opts, W, H) {
  doc.rect(0, 0, W, H).fill(t.wash);
  doc.save().lineWidth(1.4).strokeColor(t.frame).rect(26, 26, W - 52, H - 52).stroke().restore();

  const L = 22;
  [[30, 30, 1, 1], [W - 30, 30, -1, 1], [30, H - 30, 1, -1], [W - 30, H - 30, -1, -1]]
    .forEach(([cx, cy, sx, sy]) => {
      doc.save().lineWidth(2).strokeColor(t.accent)
         .moveTo(cx, cy + L * sy).lineTo(cx, cy).lineTo(cx + L * sx, cy).stroke().restore();
    });

  const logo = certLogo();
  if (logo) {
    try { doc.image(logo, W / 2 - 44, 40, { fit: [88, 28], align: 'center' }); } catch (e) {}
  }
  doc.fillColor(SOFT).font('Helvetica').fontSize(8)
     .text(config.org.name.toUpperCase(), 0, 74, { align: 'center', characterSpacing: 2 });
  doc.fillColor(SOFT).font('Helvetica').fontSize(6.5)
     .text(`Reg. No ${config.org.regNo}   ·   NGO Darpan ${config.org.darpan}`, 0, 86,
       { align: 'center', characterSpacing: 0.5 });

  // Notched ribbon banner holding the title — a hexagon-ish flag, not a plain box.
  const bw = Math.min(420, W - 200), bh = 40, bx = W / 2 - bw / 2, by = 104, notch = 16;
  doc.save().path(
    `M ${bx} ${by} L ${bx + bw} ${by} L ${bx + bw - notch} ${by + bh / 2} L ${bx + bw} ${by + bh} ` +
    `L ${bx} ${by + bh} L ${bx + notch} ${by + bh / 2} Z`
  ).fill(t.frame).restore();
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(17)
     .text(opts.title || 'Certificate', bx + notch + 6, by + bh / 2 - 9, { width: bw - 2 * notch - 12, align: 'center' });

  doc.font('Helvetica').fontSize(11).fillColor(SOFT)
     .text('is proudly presented to', 0, by + bh + 22, { align: 'center' });
  doc.font('Helvetica-Bold').fontSize(22).fillColor(t.frame)
     .text(opts.holder || '—', 70, by + bh + 44, { align: 'center', width: W - 140 });
  doc.save().lineWidth(0.7).strokeColor(t.accent)
     .moveTo(W / 2 - 130, by + bh + 76).lineTo(W / 2 + 130, by + bh + 76).stroke().restore();

  let y2 = by + bh + 84;
  if (opts.subline) {
    doc.font('Helvetica').fontSize(9.5).fillColor(SOFT)
       .text(opts.subline, 70, y2, { align: 'center', width: W - 140 });
    y2 += 16;
  }
  if (opts.body) {
    doc.font('Helvetica').fontSize(10.5).fillColor(INK)
       .text(opts.body, 130, y2 + 6, { align: 'center', width: W - 260, lineGap: 2 });
  }

  // Medallion sits centred, clear of the QR block (left) and signatory (right) —
  // see the footer positions in drawFooter, which this layout never touches.
  medallionSeal(doc, W / 2, H - 92, t);
}

/* ---- layout: modern ---------------------------------------------------------
   Left-aligned, no seal, no double frame — a thin colour strip across the top,
   a solid corner flag, and an accent tick beside the recipient's name instead
   of a centred underline. For a client who finds the award-certificate look
   too formal for something like a workshop-completion note. */
function drawModernLayout(doc, t, opts, W, H) {
  doc.rect(0, 0, W, H).fill(t.wash);
  doc.rect(0, 0, W, 10).fill(t.frame);
  doc.save().path('M 0 10 L 90 10 L 0 70 Z').fill(t.accent).restore();

  const logo = certLogo();
  if (logo) {
    try { doc.image(logo, 50, 34, { fit: [92, 30] }); } catch (e) {}
  }
  doc.fillColor(SOFT).font('Helvetica-Bold').fontSize(9)
     .text(config.org.name.toUpperCase(), 150, 40, { characterSpacing: 1.6 });
  doc.fillColor(SOFT).font('Helvetica').fontSize(7)
     .text(`Reg. No ${config.org.regNo}   ·   NGO Darpan ${config.org.darpan}`, 150, 54);

  doc.fillColor(t.accent).font('Helvetica-Bold').fontSize(30)
     .text(opts.title || 'Certificate', 60, 130, { width: W - 120 });

  doc.font('Helvetica').fontSize(11).fillColor(SOFT).text('presented to', 60, 186);
  doc.rect(60, 210, 6, 30).fill(t.accent);
  doc.font('Helvetica-Bold').fontSize(24).fillColor(INK)
     .text(opts.holder || '—', 78, 214, { width: W - 200 });

  let y2 = 250;
  if (opts.subline) {
    doc.font('Helvetica').fontSize(9.5).fillColor(SOFT).text(opts.subline, 78, y2);
    y2 += 18;
  }
  if (opts.body) {
    doc.font('Helvetica').fontSize(10.5).fillColor(INK)
       .text(opts.body, 78, y2 + 6, { width: W - 260, lineGap: 2 });
  }
}

const LAYOUT_DRAWERS = { frame: drawFrameLayout, ribbon: drawRibbonLayout, modern: drawModernLayout };

/* One renderer for member certificates and visitor certificates alike. `doc`
   subject fields are already resolved by the caller, so this function knows
   nothing about which table the record came from. The layout draws
   everything decorative; drawFooter always draws the serial/QR/barcode —
   see the comment above CERT_TEMPLATES for why that split matters. */
async function drawCertificate(doc, opts) {
  const t = certTemplate(opts.template);
  const W = doc.page.width, H = doc.page.height;
  (LAYOUT_DRAWERS[t.layout] || LAYOUT_DRAWERS.frame)(doc, t, opts, W, H);
  await drawFooter(doc, t, opts, W, H);
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
