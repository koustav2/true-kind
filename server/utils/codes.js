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

/* QR options.

   errorCorrectionLevel defaults to 'M' in the library. For anything that gets
   PRINTED and then handled — a card in a lanyard, a certificate in a folder —
   'Q' is the right level: it tolerates ~25% damage instead of ~15%, which is
   the difference between a scuffed card that still scans and one that does not.
   Screens get 'M', since a screen does not scuff.

   `width` is the pixel size of the generated PNG, not the printed size. A card
   QR is only ~20mm across, so it needs a high pixel count to survive being
   scaled down into a PDF without the module edges going soft. */
async function qrDataUrl(text, opts = {}) {
  return QRCode.toDataURL(text, {
    margin: opts.margin == null ? 1 : opts.margin,
    width: opts.width || 260,
    errorCorrectionLevel: opts.ec || 'M'
  });
}
async function qrBuffer(text, opts = {}) {
  return QRCode.toBuffer(text, {
    margin: opts.margin == null ? 1 : opts.margin,
    width: opts.width || 320,
    errorCorrectionLevel: opts.ec || 'Q'
  });
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
