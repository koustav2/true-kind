const crypto = require('crypto');

// Razorpay Checkout.js. With no RAZORPAY_KEY_ID configured the module runs in
// MOCK mode: createOrder() returns a fake order id and the checkout view skips
// the real widget entirely, sending the browser straight to /portal/pay/mock —
// so the whole flow is testable locally with no gateway account at all.
const MOCK = () => !process.env.RAZORPAY_KEY_ID;

/* Which environment a key belongs to. Razorpay prefixes test keys
   rzp_test_... and live keys rzp_live_..., so this is the one place that
   decides "was this a real payment" — used to tag every PaymentEvent row and
   to show a "Test mode" notice on the checkout page, so a test-key donation is
   never mistaken for a real one. */
function mode() {
  if (MOCK()) return 'mock';
  return /^rzp_live_/.test(process.env.RAZORPAY_KEY_ID) ? 'live' : 'test';
}

let _client = null;
function client() {
  if (_client) return _client;
  const Razorpay = require('razorpay');
  _client = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });
  return _client;
}

/**
 * Create a Razorpay order for the checkout modal to open against.
 * `notes.txnId` is how the webhook (which has no session, no query string —
 * just whatever Razorpay echoes back) finds its way back to the Donation or
 * pending-membership row this payment belongs to.
 */
async function createOrder({ amount, txnId }) {
  if (MOCK()) {
    return { mock: true, orderId: 'MOCK-' + txnId, keyId: null };
  }
  const order = await client().orders.create({
    amount, // paise
    currency: 'INR',
    receipt: txnId,
    notes: { txnId }
  });
  return { mock: false, orderId: order.id, keyId: process.env.RAZORPAY_KEY_ID };
}

/* Checkout.js's success handler returns an order id, a payment id and an
   HMAC-SHA256 of "order_id|payment_id" signed with the key secret — proof the
   response actually came from Razorpay and was not forged client-side. */
function verifyPayment({ orderId, paymentId, signature }) {
  if (MOCK()) return String(paymentId || '').startsWith('MOCK-');
  if (!orderId || !paymentId || !signature) return false;
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch (e) { return false; }
}

/* The webhook's own signature, over the raw request body — separate secret
   from the checkout signature above, set per Test/Live mode in the Razorpay
   dashboard (see .env.example). */
function verifyWebhookSignature(rawBody, signature) {
  if (MOCK()) return true;
  if (!signature || !process.env.RAZORPAY_WEBHOOK_SECRET) return false;
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch (e) { return false; }
}

module.exports = { MOCK, mode, createOrder, verifyPayment, verifyWebhookSignature };
