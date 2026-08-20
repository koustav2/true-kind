/* ==========================================================================
   ID card, drawn to the client's supplied artwork.

   Two pages at true card size — front, then back — rather than one sheet with
   both side by side. A card printer wants one card per page; a sheet with two
   cards on it has to be cut by hand and will not feed. The proof sheet the
   client sent is a presentation of the design, not a print file.

   Size: CR80 portrait, 54 x 85.6 mm = 153.07 x 242.65 pt. That is the standard
   plastic-card size, so it fits every lanyard holder and every card printer
   without scaling.

   The card is drawn, not composited from a supplied image, for one reason: it
   has to carry live data. A background PNG with text laid over it looks right
   until a name is long, a designation wraps, or the photograph is portrait
   instead of square. Drawing it means the layout can respond.

   COLOURS are taken from the logo itself, which is also the site palette:
   green #59B306, blue #0392D4, purple #7D4AB1, red #DF3548. The deep blue in
   the artwork's banding is darker than the logo blue — #0E4C92 — and is used
   for the bands and the field labels.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const config = require('../config');
const { qrBuffer } = require('./codes');
const verify = require('./verify');

/* Card geometry, in points. */
const W = 153.07;          // 54 mm
const H = 242.65;          // 85.6 mm

const GREEN = '#59B306';
const BLUE  = '#0392D4';
const NAVY  = '#0E4C92';
const RED   = '#DF3548';
const PURPLE = '#7D4AB1';
const INK   = '#152238';
const SOFT  = '#5B6870';
const PAPER = '#FFFFFF';
const WASH  = '#F4F7FB';

/* The brand mark. The repo ships assets/img/logo.png, which is the full
   lock-up. If higher-resolution or dark-background variants are dropped in
   under these names they are picked up automatically — hence the list rather
   than a single hardcoded path. Nothing breaks if they are absent. */
const IMG_DIR = path.join(__dirname, '..', '..', 'assets', 'img');
const LOGO_CANDIDATES = ['logo-lockup@2x.png', 'logo-lockup.png', 'logo.png'];
const MARK_CANDIDATES = ['logo-icon@2x.png', 'logo-icon.png', 'logo.png'];

function firstExisting(names) {
  for (const n of names) {
    const p = path.join(IMG_DIR, n);
    try { if (fs.statSync(p).isFile()) return p; } catch (e) { /* next */ }
  }
  return null;
}

function fmtDate(d) {
  if (!d) return '—';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return '—';
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/* ---- decorative shapes -------------------------------------------------- */

/* The green-and-blue sweep across the top-left corner, and the mirrored one
   across the foot. Bezier curves rather than a bitmap so they stay crisp at
   any print resolution. */
function topSweep(doc) {
  doc.save();
  // A slim arc, not a wedge. The artwork's corner sweep is a ribbon; a big
  // filled triangle here crowded the logo and read as a colour block.
  doc.path(`M 0 0 L 46 0 C 27 22, 11 46, 0 76 Z`).fill(GREEN);
  doc.path(`M 0 0 L 27 0 C 15 20, 5 42, 0 64 Z`).fill(BLUE);
  doc.restore();
}

/* The foot band. FOOT_TOP is the single number that decides how much room the
   field rows above it get, so it is a constant rather than a magic number
   repeated in three bezier curves — the first version had the band starting at
   H-52 while the rows ran to H-30, and the last four fields printed underneath
   it. */
const FOOT_TOP = 30;          // front: points of card height given to the band
const BACK_FOOT_TOP = 46;     // back: taller, it carries the dates

function footSweep(doc) {
  const t = H - FOOT_TOP;
  doc.save();
  doc.path(`M 0 ${t + 4} C 42 ${t - 8}, 104 ${t + 12}, ${W} ${t} L ${W} ${H} L 0 ${H} Z`).fill(NAVY);
  doc.path(`M 54 ${t + 12} C 88 ${t + 2}, 124 ${t + 16}, ${W} ${t + 10} L ${W} ${H} L 44 ${H} Z`).fill(GREEN);
  doc.restore();
}

function backFootSweep(doc) {
  const t = H - BACK_FOOT_TOP;
  doc.save();
  doc.path(`M 0 ${t + 5} C 48 ${t - 9}, 108 ${t + 13}, ${W} ${t} L ${W} ${H} L 0 ${H} Z`).fill(NAVY);
  doc.restore();
}

/* The lanyard slot. Drawn as an outline, not punched — the die-cut is the
   printer's job; this shows them where it goes. */
function lanyardSlot(doc) {
  const w = 32, h = 6.5, x = (W - w) / 2, y = 8;
  doc.save().roundedRect(x, y, w, h, 3.5).lineWidth(0.8).strokeColor('#B9C4D2').stroke().restore();
}

/* A small filled circle with a glyph in it, standing in for the icon set in the
   artwork. Simple shapes on purpose: at 7pt across, a detailed icon is a smudge,
   and a solid disc with one clear stroke reads at card size. */
function iconDot(doc, x, y, colour, glyph, r) {
  r = r || 4.2;
  doc.save().circle(x + r, y + r, r).fill(colour);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(r * 1.05)
     .text(glyph, x, y + r - r * 0.52, { width: r * 2, align: 'center' });
  doc.restore();
}

/* ---- front ------------------------------------------------------------- */

const TYPE_LABEL = {
  member:    ['MEMBER', 'ID CARD'],
  staff:     ['EMPLOYEE', 'ID CARD'],
  volunteer: ['VOLUNTEER', 'ID CARD']
};

async function drawFront(doc, ctx) {
  const { user, profile, code, photoPath } = ctx;
  doc.rect(0, 0, W, H).fill(PAPER);
  topSweep(doc);
  footSweep(doc);
  lanyardSlot(doc);

  /* Logo lock-up, centred under the slot. */
  const logo = firstExisting(LOGO_CANDIDATES);
  if (logo) {
    try { doc.image(logo, (W - 86) / 2, 17, { fit: [86, 26], align: 'center' }); }
    catch (e) { /* a corrupt logo must not stop a card printing */ }
  } else {
    doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(10)
       .text(config.org.name.toUpperCase(), 0, 24, { width: W, align: 'center' });
  }

  /* Card type, two lines, navy over green — as in the artwork. */
  const [l1, l2] = TYPE_LABEL[profile.cardType] || TYPE_LABEL.member;
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(10.5)
     .text(l1, 0, 46, { width: W, align: 'center', characterSpacing: 0.4 });
  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(10.5)
     .text(l2, 0, 57.5, { width: W, align: 'center', characterSpacing: 0.4 });

  /* Photograph and QR, side by side. */
  const photoW = 55, photoH = 65, photoX = 11, photoY = 72;
  doc.save().roundedRect(photoX, photoY, photoW, photoH, 4)
     .lineWidth(1.2).strokeColor(NAVY).stroke().restore();
  let drewPhoto = false;
  if (photoPath) {
    try {
      doc.save().roundedRect(photoX + 1.2, photoY + 1.2, photoW - 2.4, photoH - 2.4, 3).clip();
      doc.image(photoPath, photoX + 1.2, photoY + 1.2,
        { cover: [photoW - 2.4, photoH - 2.4], align: 'center', valign: 'center' });
      doc.restore();
      drewPhoto = true;
    } catch (e) { doc.restore(); }
  }
  if (!drewPhoto) {
    // No photograph is a normal state, not an error. A tinted panel with the
    // holder's initials looks deliberate; an empty white box looks broken.
    doc.save().roundedRect(photoX + 1.2, photoY + 1.2, photoW - 2.4, photoH - 2.4, 3).fill(WASH);
    const initials = String(user.name || '?').trim().split(/\s+/).slice(0, 2)
      .map(w => w.charAt(0).toUpperCase()).join('');
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(18)
       .text(initials, photoX, photoY + photoH / 2 - 11, { width: photoW, align: 'center' });
    doc.fillColor(SOFT).font('Helvetica').fontSize(4.2)
       .text('PHOTOGRAPH', photoX, photoY + photoH - 10, { width: photoW, align: 'center', characterSpacing: 0.5 });
    doc.restore();
  }

  /* QR — the verification URL, not the bare serial. */
  const qrSize = 52, qrX = photoX + photoW + 9, qrY = photoY + 3;
  try {
    const qr = await qrBuffer(verify.verifyUrl(code), { ec: 'Q', width: 420 });
    doc.image(qr, qrX, qrY, { fit: [qrSize, qrSize] });
  } catch (e) { /* a QR failure must not stop the card */ }
  doc.fillColor(SOFT).font('Helvetica').fontSize(4)
     .text('SCAN TO VERIFY', qrX, qrY + qrSize + 2, { width: qrSize, align: 'center', characterSpacing: 0.4 });

  /* Field rows.

     ROW_TOP + 7 * ROW_STEP has to clear H - FOOT_TOP, or the last fields print
     underneath the navy band. That is exactly what happened in the first pass,
     so the arithmetic is spelled out rather than eyeballed. */
  const rows = [
    ['NAME',      user.name || '—',                              NAVY,   'N'],
    ['DESIGNATION', profile.designation || '—',                   GREEN,  'D'],
    [profile.cardType === 'staff' ? 'EMPLOYEE ID' : 'MEMBER ID',
                  profile.employeeCode || code || '—',            BLUE,   '#'],
    ['DEPARTMENT', profile.department || '—',                     PURPLE, 'T'],
    ['BLOOD GROUP', profile.bloodGroup || '—',                    RED,    'B'],
    ['MOBILE',     user.phone || '—',                             GREEN,  'M'],
    [profile.cardType === 'member' ? 'MEMBER SINCE' : 'DATE OF JOINING',
                  fmtDate(profile.joinedOn || user.createdAt),    NAVY,   'C']
  ];

  const ROW_TOP = 143, ROW_STEP = 9.7;
  const iconX = 9, labelX = 19, colonX = 65, valueX = 70;
  const valueW = W - valueX - 5;         // 78pt — about 27 characters at 5.3pt
  let y = ROW_TOP;
  rows.forEach(([label, value, colour, glyph]) => {
    iconDot(doc, iconX, y - 0.6, colour, glyph, 3.9);
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(4.5)
       .text(label, labelX, y + 1.2, { width: colonX - labelX - 1, characterSpacing: 0.25, lineBreak: false });
    doc.fillColor(SOFT).font('Helvetica').fontSize(4.5).text(':', colonX, y + 1.2);
    // The ID number is the one field worth colouring — it is what gets read out.
    const isId = label.endsWith('ID');
    doc.fillColor(isId ? BLUE : INK)
       .font(isId ? 'Helvetica-Bold' : 'Helvetica').fontSize(5.3)
       .text(String(value), valueX, y, { width: valueW, height: 9, ellipsis: true, lineBreak: false });
    y += ROW_STEP;
  });

  /* Signatory block, inside the foot band. */
  const bandTop = H - FOOT_TOP;
  doc.fillColor('#FFFFFF').font('Helvetica-Oblique').fontSize(7.5)
     .text('Authorised', 9, bandTop + 5.5);
  doc.moveTo(9, bandTop + 17).lineTo(55, bandTop + 17)
     .lineWidth(0.55).strokeColor('rgba(255,255,255,0.8)').stroke();
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(3.7)
     .text('AUTHORISED SIGNATORY', 9, bandTop + 19.5, { characterSpacing: 0.35 });
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(4.6)
     .text(profile.cardType === 'staff' ? 'AUTHORISED PERSONNEL'
         : profile.cardType === 'volunteer' ? 'REGISTERED VOLUNTEER' : 'VERIFIED MEMBER',
       76, bandTop + 12, { width: W - 82, align: 'right', characterSpacing: 0.3, lineBreak: false });
}

/* ---- back -------------------------------------------------------------- */

async function drawBack(doc, ctx) {
  const { profile, code } = ctx;
  doc.rect(0, 0, W, H).fill(PAPER);
  backFootSweep(doc);
  lanyardSlot(doc);

  const logo = firstExisting(LOGO_CANDIDATES);
  if (logo) {
    try { doc.image(logo, (W - 90) / 2, 17, { fit: [90, 27], align: 'center' }); } catch (e) {}
  }

  /* "IF FOUND, PLEASE RETURN TO:" with a rule either side. */
  const capY = 50;
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(4.7)
     .text('IF FOUND, PLEASE RETURN TO:', 0, capY, { width: W, align: 'center', characterSpacing: 0.3 });
  doc.moveTo(11, capY + 2.2).lineTo(28, capY + 2.2).lineWidth(0.7).strokeColor(NAVY).stroke();
  doc.moveTo(W - 28, capY + 2.2).lineTo(W - 11, capY + 2.2).lineWidth(0.7).strokeColor(NAVY).stroke();

  const boxX = 10, boxW = W - 20;

  /* Registration numbers, two columns in a bordered box. */
  doc.save().roundedRect(boxX, 60, boxW, 24, 3).lineWidth(0.7).strokeColor('#C9D4E2').stroke().restore();
  iconDot(doc, boxX + 4, 65.5, NAVY, 'R', 3.9);
  doc.fillColor(SOFT).font('Helvetica').fontSize(3.8).text('Reg. No.', boxX + 14, 65.5);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(4.7).text(config.org.regNo, boxX + 14, 72);
  doc.moveTo(boxX + boxW / 2, 64).lineTo(boxX + boxW / 2, 80).lineWidth(0.6).strokeColor('#C9D4E2').stroke();
  iconDot(doc, boxX + boxW / 2 + 4, 65.5, NAVY, 'D', 3.9);
  doc.fillColor(SOFT).font('Helvetica').fontSize(3.8).text('Darpan ID', boxX + boxW / 2 + 14, 65.5);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(4.3).text(config.org.darpan, boxX + boxW / 2 + 14, 72);

  /* Contact block. */
  doc.save().roundedRect(boxX, 90, boxW, 34, 3).lineWidth(0.7).strokeColor('#C9D4E2').stroke().restore();
  const contacts = [
    [GREEN, 'P', config.org.phone],
    [NAVY,  '@', config.org.email],
    [BLUE,  'W', 'www.truekindfoundation.org']
  ];
  let cy = 94.5;
  contacts.forEach(([colour, glyph, text]) => {
    iconDot(doc, boxX + 4, cy, colour, glyph, 3.9);
    doc.fillColor(INK).font('Helvetica').fontSize(4.5)
       .text(text, boxX + 15, cy + 1.4, { width: boxW - 20, lineBreak: false, ellipsis: true });
    cy += 10.4;
  });

  /* Registered office. */
  doc.save().roundedRect(boxX, 130, 55, 9.5, 4.75).fill(GREEN).restore();
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(4.1)
     .text('REGISTERED OFFICE:', boxX + 5, 132.6, { characterSpacing: 0.3 });
  iconDot(doc, boxX, 143, NAVY, 'L', 3.9);
  doc.fillColor(INK).font('Helvetica').fontSize(4.4)
     .text(config.org.address, boxX + 11, 143, { width: boxW - 13, lineGap: 1 });

  /* Verification block.

     Sits BELOW the address, not on top of it — the address wraps to three lines
     at this width and the first pass put this text at a fixed y that landed in
     the middle of it. Anchored to the band instead, which is the fixed thing. */
  const bandTop = H - BACK_FOOT_TOP;
  doc.fillColor(SOFT).font('Helvetica').fontSize(3.9)
     .text('Verify this card at', boxX, bandTop - 15, { width: boxW, align: 'center' });
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(4.3)
     .text(`${verify.origin().replace(/^https?:\/\//, '')}/verify  ·  ${code}`,
       boxX, bandTop - 10, { width: boxW, align: 'center', lineBreak: false, ellipsis: true });

  /* Signatory and dates over the navy band. */
  doc.fillColor('#FFFFFF').font('Helvetica-Oblique').fontSize(7.5)
     .text('Authorised', 9, bandTop + 8);
  doc.moveTo(9, bandTop + 19.5).lineTo(58, bandTop + 19.5)
     .lineWidth(0.55).strokeColor('rgba(255,255,255,0.8)').stroke();
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(3.7)
     .text('AUTHORISED SIGNATORY', 9, bandTop + 22, { characterSpacing: 0.35 });

  doc.moveTo(W / 2 + 2, bandTop + 6).lineTo(W / 2 + 2, bandTop + 27)
     .lineWidth(0.55).strokeColor('rgba(255,255,255,0.5)').stroke();
  doc.fillColor('rgba(255,255,255,0.85)').font('Helvetica-Bold').fontSize(3.7)
     .text('ISSUE DATE', W / 2 + 9, bandTop + 6.5, { characterSpacing: 0.3 });
  doc.fillColor('#FFFFFF').font('Helvetica').fontSize(4.6)
     .text(fmtDate(profile.issuedOn || new Date()), W / 2 + 9, bandTop + 11.5);
  doc.fillColor('rgba(255,255,255,0.85)').font('Helvetica-Bold').fontSize(3.7)
     .text('VALID UNTIL', W / 2 + 9, bandTop + 18, { characterSpacing: 0.3 });
  doc.fillColor('#FFFFFF').font('Helvetica').fontSize(4.6)
     .text(fmtDate(profile.validUntil), W / 2 + 9, bandTop + 23);

  /* Green footer strip with the tagline. */
  doc.rect(0, H - 12, W, 12).fill(GREEN);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(5)
     .text('TOGETHER, WE CAN', 0, H - 8.8, { width: W, align: 'center', characterSpacing: 0.7 });
}

/* ---- entry point -------------------------------------------------------- */

/**
 * @param res            express response
 * @param user           User instance
 * @param profile        IdCardProfile-shaped object (may be a bare {} — every
 *                       field is optional and the card degrades gracefully)
 * @param opts.photoPath absolute path to the holder's photograph, if any
 * @param opts.code      the code the QR verifies — the Member ID by default
 */
async function idCardPdf(res, user, profile, opts = {}) {
  const p = profile || {};
  const code = opts.code || p.employeeCode || user.memberId || '';
  const ctx = {
    user, code,
    profile: {
      cardType: p.cardType || 'member',
      employeeCode: p.employeeCode || null,
      designation: p.designation || null,
      department: p.department || null,
      bloodGroup: p.bloodGroup || null,
      joinedOn: p.joinedOn || null,
      issuedOn: p.issuedOn || null,
      validUntil: p.validUntil || user.membershipValidTill || null
    },
    photoPath: opts.photoPath || null
  };

  const doc = new PDFDocument({ size: [W, H], margin: 0, layout: 'portrait' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="idcard-${code || user.id}.pdf"`);
  doc.pipe(res);
  await drawFront(doc, ctx);
  doc.addPage({ size: [W, H], margin: 0 });
  await drawBack(doc, ctx);
  doc.end();
}

module.exports = { idCardPdf, CARD_W: W, CARD_H: H };
