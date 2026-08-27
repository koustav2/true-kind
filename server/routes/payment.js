const router = require('express').Router();
const crypto = require('crypto');
const config = require('../config');
const razorpay = require('../utils/razorpay');
const { serial } = require('../utils/codes');
const membership = require('../utils/membership');
const { User, Donation, MembershipPayment, PaymentEvent } = require('../models');

function txn() { return 'TXN' + Date.now() + crypto.randomBytes(3).toString('hex').toUpperCase(); }

/* ==========================================================================
   Both flows share the same shape: create a Razorpay order, send the browser
   to a checkout page that opens the Checkout.js modal, and confirm on the way
   back. Confirmation happens TWICE — once from the browser (`/verify`, driven
   by Checkout.js's success handler) and once from Razorpay itself
   (`/webhook`) — because the browser callback alone is not guaranteed to
   fire: a closed tab or a dropped connection after a real capture would
   otherwise leave a paid donation stuck at "initiated" forever. Both call the
   same finalize() below, which is written to be safe to call twice for the
   same payment.
   ========================================================================== */

router.post('/membership', async (req, res) => {
  if (!req.session.userId) return res.redirect('/portal/signin');
  const plan = config.plans[req.body.plan] ? req.body.plan : 'annual';
  const user = await User.findByPk(req.session.userId);
  const txnId = txn();
  const order = await razorpay.createOrder({
    amount: config.plans[plan].amount, txnId,
    notes: { type: 'membership', plan, userId: String(user.id) }
  });
  if (order.mock) {
    return res.redirect(`/portal/pay/mock?txnId=${txnId}&orderId=${order.orderId}&type=membership&plan=${plan}`);
  }
  res.render('pay-checkout', {
    title: 'Complete payment',
    orderId: order.orderId, keyId: order.keyId, amount: config.plans[plan].amount,
    txnId, type: 'membership', plan,
    name: user.name, email: user.email, phone: user.phone,
    testMode: razorpay.mode() === 'test'
  });
});

router.post('/donation', async (req, res) => {
  const { category, amount, ...rest } = req.body;
  const isMember = !!req.session.userId;

  /* Server-side validation.
     The form marks these fields required, but `required` is a browser courtesy —
     anything can POST straight here. Without this check a guest donation could
     be created with no name and no email, and the receipt built from it would
     have nobody to send it to. A rejected guest submission goes back to the form
     with a message instead of a bare 400 page. */
  const reject = () => isMember
    ? res.status(400).send('Enter a valid amount (min ₹1).')
    : res.redirect('/portal/donate?error=invalid');

  const rupees = parseFloat(amount);
  const paise = Number.isFinite(rupees) ? Math.round(rupees * 100) : 0;
  if (!paise || paise < 100 || paise > 100000000) return reject();

  const str = v => String(v == null ? '' : v).trim();
  if (!isMember) {
    if (str(rest.name).length < 2) return reject();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(str(rest.email))) return reject();
    if (str(rest.phone).replace(/\D/g, '').length < 8) return reject();
  }

  /* The category lands on a receipt and in the admin's reporting, so it is
     matched against the configured list rather than trusted as free text. */
  const cat = config.donationCategories.includes(category) ? category : 'Where it is needed most';

  const txnId = txn();
  const doc = {
    kind: isMember ? 'member' : 'guest',
    category: cat,
    amount: paise, txnId, status: 'initiated', extra: {}
  };
  if (isMember) doc.userId = req.session.userId;
  else doc.guest = {
    name: rest.name, email: rest.email, phone: rest.phone,
    address: rest.address, city: rest.city,
    pan: rest.pan, bankName: rest.bankName, branchName: rest.branchName
  };
  for (const k of Object.keys(rest)) if (k.startsWith('x_')) doc.extra[k.slice(2)] = rest[k];
  await Donation.create(doc);

  const order = await razorpay.createOrder({ amount: paise, txnId, notes: { type: 'donation' } });
  if (order.mock) {
    return res.redirect(`/portal/pay/mock?txnId=${txnId}&orderId=${order.orderId}&type=donation`);
  }
  res.render('pay-checkout', {
    title: 'Complete payment',
    orderId: order.orderId, keyId: order.keyId, amount: paise,
    txnId, type: 'donation', plan: null,
    name: isMember ? undefined : rest.name,
    email: isMember ? undefined : rest.email,
    phone: isMember ? undefined : rest.phone,
    testMode: razorpay.mode() === 'test'
  });
});

router.get('/mock', (req, res) => res.render('pay-mock', {
  title: 'Mock payment',
  txnId: req.query.txnId, orderId: req.query.orderId,
  type: req.query.type, plan: req.query.plan
}));

/* ==========================================================================
   finalize() — the single place a confirmed payment turns into a receipt or
   an active membership. Called from both /verify (the browser, right after
   Checkout.js's handler fires) and /webhook (Razorpay itself). Must be safe
   to call twice for the same payment:

     - donation: guarded by `status !== 'paid'` — the existing Donation state.
     - membership: guarded by looking up a MembershipPayment already carrying
       this exact `paymentId` as its reference. There is no "pending" row for
       a membership attempt before it succeeds (see PaymentEvent's comment in
       models/index.js for why), so the payment id itself is the only thing
       that can say "this one is already done".

   `userId` has to travel with the call rather than come from req.session,
   because /webhook has no session at all — it is a server-to-server POST from
   Razorpay. Both callers source it the same way in spirit: /verify from the
   still-live browser session, /webhook from the order's notes (set at
   creation time in the two routes above), so this function never has to care
   which one is calling.
   ========================================================================== */
async function finalize({ txnId, paymentId, type, plan, userId }) {
  if (type === 'membership') {
    if (!userId) return null;
    const already = await MembershipPayment.findOne({ where: { reference: paymentId } });
    const user = await User.findByPk(userId);
    if (!user) return null;
    const payment = already || await membership.activate({
      user, MembershipPayment, plan,
      amount: config.plans[membership.planKey(plan)].amount,
      mode: 'online',
      reference: paymentId
    });
    return {
      title: 'Membership active', ok: true,
      message: `Welcome — your membership is active. Member ID ${user.memberId}. Receipt ${payment.receiptNo}.`,
      cta: { href: '/portal/member/card', label: 'View your membership card' }
    };
  }

  const donation = await Donation.findOne({ where: { txnId } });
  if (!donation) return null;
  if (donation.status !== 'paid') {
    donation.status = 'paid';
    donation.paidAt = new Date();
    donation.gatewayRef = paymentId;
    donation.receiptNo = serial('TKF-R');
    await donation.save();
  }
  return {
    title: 'Thank you', ok: true,
    message: `Donation received — receipt ${donation.receiptNo}.`,
    cta: donation.userId ? { href: `/portal/member/receipt/${donation.id}`, label: 'View receipt' }
                         : { href: `/portal/receipt/${donation.txnId}`, label: 'View receipt' }
  };
}

/* Reached by the checkout page's JS handler (real gateway) or the mock page's
   "Simulate successful payment" button — a normal, session-bound, CSRF-
   protected POST from the browser. Not a webhook. */
router.post('/verify', async (req, res) => {
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId,
          razorpay_signature: signature, txnId, type, plan } = req.body;
  if (!txnId) return res.status(400).render('error', { title: 'Invalid request', message: 'Missing transaction reference.' });

  if (!razorpay.verifyPayment({ orderId, paymentId, signature })) {
    return res.render('pay-result', {
      title: 'Payment failed', ok: false,
      message: 'We could not verify that payment. No money was captured — try again.'
    });
  }

  const result = await finalize({ txnId, paymentId, type, plan, userId: req.session.userId });
  if (!result) return res.status(404).render('error', { title: 'Not found', message: 'Unknown transaction.' });
  res.render('pay-result', result);
});

/* Razorpay's server-to-server webhook. Verified by its own HMAC signature
   (not a session, not CSRF — see server.js for the exemption and the raw-body
   middleware this route depends on), and the ONE place every event Razorpay
   sends is recorded, success or failure — see PaymentEvent in models/index.js.
   Always answers 200 once an event is logged, so Razorpay's retry policy
   never turns a slow response into a storm of duplicate deliveries. */
router.post('/webhook', async (req, res) => {
  const signature = req.get('x-razorpay-signature');
  const raw = req.body; // Buffer — express.raw() is scoped to this path in server.js
  if (!Buffer.isBuffer(raw) || !razorpay.verifyWebhookSignature(raw, signature)) {
    return res.sendStatus(400);
  }
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch (e) { return res.sendStatus(400); }

  const paymentEntity = body.payload && body.payload.payment && body.payload.payment.entity;
  const orderEntity = body.payload && body.payload.order && body.payload.order.entity;
  const notes = (paymentEntity && paymentEntity.notes) || (orderEntity && orderEntity.notes) || {};
  const txnId = notes.txnId || null;

  await PaymentEvent.create({
    event: body.event || 'unknown',
    mode: razorpay.mode(),
    txnId,
    orderId: (paymentEntity && paymentEntity.order_id) || (orderEntity && orderEntity.id) || null,
    paymentId: paymentEntity ? paymentEntity.id : null,
    amount: (paymentEntity && paymentEntity.amount) || (orderEntity && orderEntity.amount) || null,
    status: (paymentEntity && paymentEntity.status) || (orderEntity && orderEntity.status) || 'other',
    errorCode: (paymentEntity && paymentEntity.error_code) || null,
    errorDescription: (paymentEntity && paymentEntity.error_description) || null,
    payload: body
  }).catch(() => {});   // logging must never be why a 200 fails to go back

  try {
    if (txnId && paymentEntity && paymentEntity.status === 'captured') {
      await finalize({
        txnId, paymentId: paymentEntity.id,
        type: notes.type, plan: notes.plan,
        userId: notes.userId ? Number(notes.userId) : undefined
      });
    } else if (txnId && paymentEntity && paymentEntity.status === 'failed') {
      const donation = await Donation.findOne({ where: { txnId } });
      if (donation && donation.status !== 'paid') {
        donation.status = 'failed';
        donation.extra = { ...(donation.extra || {}), failure: {
          code: paymentEntity.error_code, description: paymentEntity.error_description
        } };
        await donation.save();
      }
      // A failed membership attempt has nothing to update — see finalize()'s
      // comment — the PaymentEvent row above is its only record.
    }
  } catch (e) { /* the event is already logged; a finalize error here is not the webhook's to report */ }

  res.sendStatus(200);
});

module.exports = router;
