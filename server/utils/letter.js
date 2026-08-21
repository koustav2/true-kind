/* ==========================================================================
   Appointment letter.

   Generated PER USE: there is no stored PDF anywhere. Issuing a letter writes
   one AppointmentLetter row — the recipient and the terms as agreed on the day
   — and every request for the document re-renders it from that row. So the
   letter can be reprinted forever, a lost copy costs nothing, and there is no
   file store to back up or to leak.

   Reuses the letterhead idiom of utils/pdf.js so an appointment letter looks
   like it came from the same office as the membership receipt and the
   certificate. A letter that does not match the receipt reads as though it came
   from somewhere else.

   THE SPECIMEN WATERMARK DEFAULTS TO ON, and the default is load-bearing rather
   than lazy. The admin has a Preview button that renders an unsaved letter from
   whatever is currently typed into the form, and that preview must be
   unmistakably not-a-letter — otherwise the natural thing to do is preview it,
   like it, save the PDF and email that, and the organisation has sent out a
   letter with no serial, no row and nothing to verify against. Only the route
   that has an issued row with a real serial passes {specimen:false}.

   TWO THINGS THIS FILE WILL NOT DO:

     1. It does not invent policy. Probation, notice, hours — every one of those
        is a value handed in from the form. The general conditions on page 2 are
        boilerplate that the organisation and its lawyer must read before the
        first real letter goes out; they are the one thing here not driven by
        per-letter data, and they are flagged again at the point of use.

     2. It does not compute pay. There is no payroll in this system. It prints
        the figure it is handed, formatted, and nothing more.
   ========================================================================== */
'use strict';

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { qrBuffer } = require('./codes');
const verify = require('./verify');

const INK = '#101F29', PURPLE = '#7D4AB1', SOFT = '#5B6870', RULE = '#D8D4CA';
const GREEN = '#3F7F04';
const M = 56;                     // page margin, points
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* A plain "YYYY-MM-DD" is read FIELD BY FIELD, not through new Date().
   Sequelize DATEONLY hands back exactly that string, and new Date('2026-09-01')
   parses it as UTC midnight — so in any timezone behind UTC the date printed on
   the letter is the day before the one that was typed into the form. India is
   ahead of UTC so it happens to be right today, which is exactly the kind of
   bug that ships and then surfaces on somebody else's server. */
function fmt(v) {
  if (!v) return '—';
  const m = typeof v === 'string' && v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[3] + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1];
  const t = v instanceof Date ? v : new Date(v);
  if (isNaN(t)) return '—';
  return ('0' + t.getDate()).slice(-2) + ' ' + MONTHS[t.getMonth()] + ' ' + t.getFullYear();
}

/* "Rs.", not "₹" — see the long note on money() in utils/pdf.js. PDFKit's
   built-in Helvetica has no U+20B9 and silently substitutes superscript one, so
   a ₹ here would print "¹28,000". Not fixable with a system font: the runtime
   image is node:20-alpine and has none. */
function rupees(n) {
  if (n === null || n === undefined || n === '') return '—';
  return 'Rs. ' + Number(n).toLocaleString('en-IN');
}

/* ---- page furniture ---------------------------------------------------- */

function letterhead(doc) {
  const W = doc.page.width;
  doc.rect(0, 0, W, 6).fill(PURPLE);

  const logo = path.join(__dirname, '..', '..', 'assets', 'img', 'logo.png');
  let textX = M;
  try {
    if (fs.statSync(logo).isFile()) { doc.image(logo, M, 26, { fit: [104, 34] }); textX = M + 118; }
  } catch (e) { /* a missing logo must not stop a letter printing */ }

  doc.fillColor(INK).font('Helvetica-Bold').fontSize(15).text(config.org.name, textX, 28);
  doc.font('Helvetica').fontSize(7.6).fillColor(SOFT)
     .text(config.org.address, textX, 46, { width: W - textX - M })
     .text(`Reg. No ${config.org.regNo}  ·  Darpan ${config.org.darpan}  ·  PAN ${config.org.pan}`,
           textX, 57)
     .text(`${config.org.phone}  ·  ${config.org.email}`, textX, 68);

  doc.moveTo(M, 86).lineTo(W - M, 86).lineWidth(0.8).strokeColor(RULE).stroke();
}

/* Diagonal SPECIMEN wash. Drawn UNDER the text — over it, at any opacity that
   is actually visible, the letter becomes hard to read, and an unreadable demo
   is not a demo. */
function watermark(doc) {
  const W = doc.page.width, H = doc.page.height;
  doc.save();
  doc.rotate(-32, { origin: [W / 2, H / 2] });
  doc.font('Helvetica-Bold').fontSize(78).fillColor('#7D4AB1').fillOpacity(0.07)
     .text('SPECIMEN', 0, H / 2 - 46, { width: W, align: 'center', lineBreak: false });
  doc.fillOpacity(1).restore();
}

function footer(doc, page, pages) {
  const W = doc.page.width, y = doc.page.height - 46;
  doc.moveTo(M, y).lineTo(W - M, y).lineWidth(0.8).strokeColor(RULE).stroke();
  doc.font('Helvetica').fontSize(7).fillColor(SOFT)
     .text(config.org.name, M, y + 7)
     .text(`Page ${page} of ${pages}`, M, y + 7, { width: W - M * 2, align: 'right' });
}

/* A label/value row, the shape used on the receipt so the two documents feel
   related. Returns the y to carry on from. */
function row(doc, label, value, x, y, labelW, valueW, bold) {
  doc.font('Helvetica').fontSize(8.6).fillColor(SOFT).text(label, x, y, { width: labelW });
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.4).fillColor(INK)
     .text(value === '' || value === undefined || value === null ? '—' : String(value),
           x + labelW, y - 0.8, { width: valueW });
  return y + 19;
}

/* ---- the letter -------------------------------------------------------- */

/**
 * @param res       a writable stream (an Express response, or a file stream)
 * @param a         the appointment. Every field is optional; anything missing
 *                  prints an em dash rather than throwing, so a half-filled
 *                  draft can still be previewed.
 * @param opts.specimen  watermark on. DEFAULTS TO TRUE — see the header.
 */
async function appointmentLetterPdf(res, a, opts = {}) {
  const specimen = opts.specimen !== false;
  const serial = a.serial || 'TKF-AL-0000-XXXXXX';
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });

  /* The document SAYS what it is, in its metadata, not only in ink.
   *
   * The diagonal wash is the thing a person sees, and it is genuinely there —
   * but it cannot be read back out of the file, because PDFKit writes text as
   * encoded glyph indices rather than literal strings. So "is this a specimen"
   * was not answerable by any check short of rendering the page to a bitmap and
   * comparing pixels, which is not a thing to make a test suite do.
   *
   * Declaring it in the info dictionary fixes that, and is worth having anyway:
   * the title shows in the viewer's window and in a file listing, so a preview
   * that gets saved to somebody's desktop is still labelled a specimen when the
   * watermark is no longer in front of them. */
  doc.info.Title = (specimen ? 'SPECIMEN — ' : '') + `Appointment letter ${serial}`;
  doc.info.Author = config.org.name;
  doc.info.Subject = specimen
    ? 'SPECIMEN. Layout preview only — not issued, not verifiable, not a valid appointment.'
    : `Appointment letter ${serial}`;
  /* KEEP THIS ONE PURE ASCII. Title and Subject above contain an em dash, which
     makes PDFKit write them as UTF-16BE inside the string object — so the word
     SPECIMEN lands in the file as S\0P\0E\0C\0... and no plain text search finds
     it. Keywords is the field the test greps, so it stays ASCII on purpose. */
  doc.info.Keywords = specimen ? 'SPECIMEN preview' : 'appointment letter';

  if (res.setHeader) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="appointment-${serial}.pdf"`);
  }
  doc.pipe(res);

  const W = doc.page.width;
  const CW = W - M * 2;                     // content width

  /* ---------- page 1 ---------- */
  if (specimen) watermark(doc);
  letterhead(doc);

  /* Reference and date, on one line, opposite ends — the way a letter is read:
     "which letter is this" on the left, "when" on the right. */
  /* Ref left, date right, both on one line. NOT with `continued:true` plus
     align:'right' — pdfkit applies the alignment per fragment, so the label and
     the value each get right-aligned independently and print on top of each
     other. Right-aligned text has to be one finished string. */
  let y = 102;
  doc.font('Helvetica').fontSize(8.6).fillColor(SOFT)
     .text('Ref: ', M, y, { continued: true })
     .font('Helvetica-Bold').fillColor(INK).text(serial);
  doc.font('Helvetica').fontSize(8.6).fillColor(SOFT)
     .text('Date: ' + fmt(a.letterDate || new Date()), M, y, { width: CW, align: 'right' });

  y += 30;
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text('To,', M, y);
  y += 15;
  doc.font('Helvetica-Bold').fontSize(11).text(a.name || '—', M, y);
  y += 15;
  doc.font('Helvetica').fontSize(9).fillColor(SOFT)
     .text(a.address || '—', M, y, { width: CW * 0.6 });
  y = doc.y + 6;
  if (a.phone || a.email) {
    doc.fontSize(8.6).text([a.phone, a.email].filter(Boolean).join('  ·  '), M, y);
    y = doc.y + 4;
  }

  y += 16;
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(PURPLE)
     .text(`Subject: Appointment as ${a.designation || '—'}`, M, y, { width: CW });
  y = doc.y + 16;

  doc.font('Helvetica').fontSize(10).fillColor(INK)
     .text(`Dear ${(a.name || '').split(' ')[0] || 'Sir/Madam'},`, M, y);
  y = doc.y + 12;

  doc.fontSize(9.8).fillColor(INK).text(
    `With reference to your application and the interview that followed, we are pleased to ` +
    `appoint you as ${a.designation || '—'} at ${config.org.name}. Your appointment takes ` +
    `effect from ${fmt(a.joiningDate)} and is governed by the terms set out below.`,
    M, y, { width: CW, align: 'justify', lineGap: 2.2 });
  y = doc.y + 18;

  /* ---- the terms box. A table, not prose: these are the facts somebody will
     come back to look up, and they should be findable in one glance. ---- */
  doc.font('Helvetica-Bold').fontSize(9).fillColor(PURPLE)
     .text('TERMS OF APPOINTMENT', M, y, { characterSpacing: 0.8 });
  y = doc.y + 8;

  const boxTop = y;
  const labelW = 132, valueW = CW - labelW - 28;
  let ry = y + 14;
  ry = row(doc, 'Designation',      a.designation,                 M + 14, ry, labelW, valueW, true);
  ry = row(doc, 'Department',       a.department,                  M + 14, ry, labelW, valueW);
  ry = row(doc, 'Reporting to',     a.reportsTo,                   M + 14, ry, labelW, valueW);
  ry = row(doc, 'Place of posting', a.location,                    M + 14, ry, labelW, valueW);
  ry = row(doc, 'Date of joining',  fmt(a.joiningDate),            M + 14, ry, labelW, valueW, true);
  ry = row(doc, 'Employment type',  a.employmentType,              M + 14, ry, labelW, valueW);
  ry = row(doc, 'Probation',        a.probation,                   M + 14, ry, labelW, valueW);
  ry = row(doc, 'Gross remuneration',
           a.grossMonthly ? rupees(a.grossMonthly) + ' per month' : '—',
           M + 14, ry, labelW, valueW, true);
  if (a.annualCtc) {
    ry = row(doc, 'Annual (indicative)', rupees(a.annualCtc), M + 14, ry, labelW, valueW);
  }
  ry = row(doc, 'Working hours',    a.hours,                       M + 14, ry, labelW, valueW);
  ry = row(doc, 'Notice period',    a.notice,                      M + 14, ry, labelW, valueW);

  doc.roundedRect(M, boxTop, CW, ry - boxTop + 2, 6)
     .lineWidth(0.9).strokeColor(RULE).stroke();
  y = ry + 22;

  doc.font('Helvetica').fontSize(8.4).fillColor(SOFT).text(
    'Remuneration is stated gross, before statutory deductions. Deductions, if any, are made ' +
    'as required by law and shown on your monthly pay statement.',
    M, y, { width: CW, lineGap: 1.6 });

  footer(doc, 1, 2);

  /* ---------- page 2 ---------- */
  doc.addPage({ size: 'A4', margin: 0 });
  if (specimen) watermark(doc);
  doc.rect(0, 0, W, 6).fill(PURPLE);

  y = 44;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(PURPLE)
     .text('GENERAL CONDITIONS', M, y, { characterSpacing: 0.8 });
  y = doc.y + 10;

  /* Numbered, short, one idea each. These are PLACEHOLDERS — see the file
     header. Nothing here has been checked by anybody's lawyer. */
  const clauses = [
    `You will be on probation for ${a.probation || 'the period stated above'} from the date of ` +
      `joining. Confirmation in writing follows a satisfactory review; the probation may be ` +
      `extended once, in writing, with reasons.`,
    `This appointment is subject to verification of the documents you have submitted and of the ` +
      `information given in your application. Any material misstatement makes the appointment ` +
      `void from the outset.`,
    `You will keep confidential all information about the organisation, its donors, its staff and ` +
      `the people it serves, both during and after your engagement, other than where disclosure ` +
      `is required by law.`,
    `You will comply with the organisation's code of conduct, its child and vulnerable adult ` +
      `safeguarding policy, and its policy on the prevention of sexual harassment at the ` +
      `workplace. Each is available from the office and forms part of these terms.`,
    `Either party may end this engagement by giving ${a.notice || 'the notice stated above'} in ` +
      `writing, or payment in lieu. The organisation may terminate without notice for misconduct.`,
    `You may be assigned to any of the organisation's programmes or locations as the work ` +
      `requires, with reasonable notice.`,
    `Your entitlement to leave and to statutory benefits is per the organisation's policy in ` +
      `force from time to time.`
  ];

  doc.font('Helvetica').fontSize(9.4).fillColor(INK);
  clauses.forEach((c, i) => {
    doc.font('Helvetica-Bold').fillColor(PURPLE).fontSize(9.4)
       .text((i + 1) + '.', M, y, { width: 16 });
    doc.font('Helvetica').fillColor(INK).fontSize(9.4)
       .text(c, M + 18, y, { width: CW - 18, align: 'justify', lineGap: 2 });
    y = doc.y + 9;
  });

  y += 6;
  doc.font('Helvetica').fontSize(9.8).fillColor(INK).text(
    'Please sign and return the duplicate copy of this letter as your acceptance of the above. ' +
    'We look forward to your joining us.',
    M, y, { width: CW, align: 'justify', lineGap: 2.2 });
  y = doc.y + 26;

  /* ---- signatures. Two blocks side by side: the organisation signs on the
     left, the appointee accepts on the right. One document, both parties. ---- */
  const colW = (CW - 30) / 2;
  doc.font('Helvetica').fontSize(9).fillColor(SOFT).text(`For ${config.org.name}`, M, y);
  doc.text('Accepted by me', M + colW + 30, y);

  const sigY = y + 46;
  doc.moveTo(M, sigY).lineTo(M + colW - 20, sigY).lineWidth(0.9).strokeColor(INK).stroke();
  doc.moveTo(M + colW + 30, sigY).lineTo(M + colW + 30 + colW - 20, sigY).stroke();

  doc.font('Helvetica-Bold').fontSize(9.4).fillColor(INK)
     .text(a.signatoryName || '—', M, sigY + 6);
  doc.font('Helvetica').fontSize(8.4).fillColor(SOFT)
     .text(a.signatoryRole || 'Authorised Signatory', M, sigY + 19);

  doc.font('Helvetica-Bold').fontSize(9.4).fillColor(INK)
     .text(a.name || '—', M + colW + 30, sigY + 6);
  doc.font('Helvetica').fontSize(8.4).fillColor(SOFT)
     .text('Date: ______________', M + colW + 30, sigY + 19);

  /* ---- verification. Same treatment as the certificate and the receipt: the
     QR is a URL a phone can open, the serial is the thing to quote on the
     telephone. See warning 1 in the file header — the prefix must be registered
     in verify.js first or this scans as "not recognised". ---- */
  const vy = doc.page.height - 150;
  doc.moveTo(M, vy - 14).lineTo(W - M, vy - 14).lineWidth(0.8).strokeColor(RULE).stroke();
  try {
    const qr = await qrBuffer(verify.verifyUrl(serial), { ec: 'Q', width: 320 });
    doc.image(qr, M, vy, { width: 62 });
  } catch (e) { /* no QR is better than no letter */ }
  doc.font('Helvetica-Bold').fontSize(8.6).fillColor(INK)
     .text('Verify this letter', M + 76, vy + 6);
  doc.font('Helvetica').fontSize(8).fillColor(SOFT)
     .text('Scan the code, or check the reference at', M + 76, vy + 20);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(PURPLE)
     .text(verify.origin().replace(/^https?:\/\//, '') + '/verify', M + 76, vy + 31);
  doc.font('Helvetica').fontSize(8).fillColor(SOFT)
     .text('Reference ', M + 76, vy + 45, { continued: true })
     .font('Helvetica-Bold').fillColor(INK).text(serial);

  if (specimen) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(GREEN)
       .text('SPECIMEN — layout demonstration only. Not a valid appointment.',
             M, vy + 66, { width: CW });
  }

  footer(doc, 2, 2);
  doc.end();
}

module.exports = { appointmentLetterPdf };
