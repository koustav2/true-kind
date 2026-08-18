const PDFDocument = require('pdfkit');
const config = require('../config');
const { qrBuffer, barcodeBuffer } = require('./codes');

const INK = '#101F29', PURPLE = '#7D4AB1', SOFT = '#5B6870', RULE = '#D8D4CA';

function money(paise) { return '₹' + (paise / 100).toLocaleString('en-IN'); }

async function codesRow(doc, serialText, x, y) {
  const [qr, bar] = await Promise.all([qrBuffer(serialText), barcodeBuffer(serialText)]);
  doc.image(qr, x, y, { width: 78 });
  doc.image(bar, x + 95, y + 14, { width: 190 });
  doc.font('Helvetica').fontSize(8).fillColor(SOFT)
     .text('Verify this document by quoting the serial above.', x + 95, y + 62);
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

async function certificatePdf(res, cert, issuance, user) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 60 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="certificate-${issuance.serial}.pdf"`);
  doc.pipe(res);
  doc.rect(0, 0, doc.page.width, 8).fill(PURPLE);
  doc.rect(0, doc.page.height - 8, doc.page.width, 8).fill(PURPLE);
  doc.fillColor(SOFT).font('Helvetica').fontSize(11)
     .text(config.org.name.toUpperCase(), 0, 70, { align: 'center', characterSpacing: 2 });
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(30)
     .text(cert.title, 0, 110, { align: 'center' });
  doc.font('Helvetica').fontSize(12).fillColor(SOFT)
     .text('This certificate is proudly presented to', 0, 170, { align: 'center' });
  doc.font('Helvetica-Bold').fontSize(24).fillColor(PURPLE)
     .text(user ? user.name : '—', 0, 195, { align: 'center' });
  if (cert.description)
    doc.font('Helvetica').fontSize(11).fillColor(INK)
       .text(cert.description, 140, 240, { align: 'center', width: doc.page.width - 280 });
  doc.font('Helvetica').fontSize(9).fillColor(SOFT)
     .text(`Serial ${issuance.serial}  ·  Issued ${issuance.issuedAt.toDateString()}`, 0, 310, { align: 'center' });
  await codesRow(doc, issuance.serial, doc.page.width / 2 - 140, 340);
  doc.end();
}

async function cardPdf(res, user) {
  // Membership card, credit-card-ish ratio
  const doc = new PDFDocument({ size: [430, 270], margin: 24 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="card-${user.memberId}.pdf"`);
  doc.pipe(res);
  doc.rect(0, 0, 430, 64).fill(PURPLE);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(15).text(config.org.name, 24, 20);
  doc.font('Helvetica').fontSize(8).text('MEMBERSHIP CARD', 24, 40, { characterSpacing: 2 });
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(14).text(user.name, 24, 84);
  doc.font('Helvetica').fontSize(9).fillColor(SOFT)
     .text(`Member ID  ${user.memberId}`, 24, 104)
     .text(`Plan  ${user.membership.plan}  ·  Valid till  ${user.membership.validTill.toDateString()}`, 24, 118)
     .text(`${user.email}  ·  ${user.phone}`, 24, 132);
  await codesRow(doc, user.memberId, 24, 158);
  doc.end();
}

module.exports = { receiptPdf, certificatePdf, cardPdf };
