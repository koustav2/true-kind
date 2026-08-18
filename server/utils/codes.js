const crypto = require('crypto');
const QRCode = require('qrcode');
const bwipjs = require('bwip-js');

// Every card, certificate and receipt carries the same trio:
// human-readable serial + QR + Code128 barcode of that serial.
function serial(prefix) {
  const y = new Date().getFullYear();
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
  return `${prefix}-${y}-${rand}`;
}

async function qrDataUrl(text) {
  return QRCode.toDataURL(text, { margin: 1, width: 220 });
}
async function qrBuffer(text) {
  return QRCode.toBuffer(text, { margin: 1, width: 220 });
}
function barcodeBuffer(text) {
  return bwipjs.toBuffer({
    bcid: 'code128', text, scale: 2, height: 12,
    includetext: true, textxalign: 'center'
  });
}
async function barcodeDataUrl(text) {
  const buf = await barcodeBuffer(text);
  return 'data:image/png;base64,' + buf.toString('base64');
}

module.exports = { serial, qrDataUrl, qrBuffer, barcodeBuffer, barcodeDataUrl };
