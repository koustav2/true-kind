const crypto = require('crypto');
const axios = require('axios');

// PhonePe PG Standard Checkout. With no PHONEPE_MERCHANT_ID configured the
// module runs in MOCK mode: initiate() returns our own /portal/pay/mock URL,
// which immediately "succeeds" — so the whole flow is testable locally.
const MOCK = () => !process.env.PHONEPE_MERCHANT_ID;

function xVerify(base64Payload, path) {
  const salt = process.env.PHONEPE_SALT_KEY;
  const idx = process.env.PHONEPE_SALT_INDEX || '1';
  const hash = crypto.createHash('sha256').update(base64Payload + path + salt).digest('hex');
  return `${hash}###${idx}`;
}

async function initiate({ amount, txnId, userPhone, redirectUrl }) {
  if (MOCK()) {
    return { mock: true, url: `${process.env.APP_BASE_URL || ''}/portal/pay/mock?txnId=${txnId}` };
  }
  const payload = {
    merchantId: process.env.PHONEPE_MERCHANT_ID,
    merchantTransactionId: txnId,
    amount, // paise
    redirectUrl, redirectMode: 'REDIRECT',
    callbackUrl: redirectUrl,
    mobileNumber: userPhone,
    paymentInstrument: { type: 'PAY_PAGE' }
  };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  const res = await axios.post(
    `${process.env.PHONEPE_BASE_URL}/pg/v1/pay`,
    { request: b64 },
    { headers: { 'Content-Type': 'application/json', 'X-VERIFY': xVerify(b64, '/pg/v1/pay') } }
  );
  return { mock: false, url: res.data.data.instrumentResponse.redirectInfo.url };
}

async function status(txnId) {
  if (MOCK()) return { success: true, gatewayRef: 'MOCK-' + txnId };
  const mid = process.env.PHONEPE_MERCHANT_ID;
  const path = `/pg/v1/status/${mid}/${txnId}`;
  const res = await axios.get(`${process.env.PHONEPE_BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      'X-VERIFY': xVerify('', path),
      'X-MERCHANT-ID': mid
    }
  });
  const ok = res.data.success && res.data.code === 'PAYMENT_SUCCESS';
  return { success: ok, gatewayRef: res.data.data && res.data.data.transactionId };
}

module.exports = { initiate, status, MOCK };
