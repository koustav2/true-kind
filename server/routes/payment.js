const router = require('express').Router();
const crypto = require('crypto');
const config = require('../config');
const phonepe = require('../utils/phonepe');
const { serial } = require('../utils/codes');
const { User, Donation } = require('../models');

function txn() { return 'TXN' + Date.now() + crypto.randomBytes(3).toString('hex').toUpperCase(); }
const base = () => process.env.APP_BASE_URL || '';

router.post('/membership', async (req, res) => {
  if (!req.session.userId) return res.redirect('/portal/signin');
  const plan = config.plans[req.body.plan] ? req.body.plan : 'annual';
  const user = await User.findByPk(req.session.userId);
  const txnId = txn();
  req.session.pending = { type: 'membership', plan, txnId };
  const { url } = await phonepe.initiate({
    amount: config.plans[plan].amount, txnId, userPhone: user.phone,
    redirectUrl: `${base()}/portal/pay/return?txnId=${txnId}`
  });
  res.redirect(url);
});

router.post('/donation', async (req, res) => {
  const { category, amount, ...rest } = req.body;
  const paise = Math.round(parseFloat(amount) * 100);
  if (!paise || paise < 100) return res.status(400).send('Enter a valid amount (min ₹1).');
  const txnId = txn();
  const isMember = !!req.session.userId;
  const doc = {
    kind: isMember ? 'member' : 'guest',
    category: category || 'Where it is needed most',
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
  const { url } = await phonepe.initiate({
    amount: paise, txnId,
    userPhone: isMember ? undefined : rest.phone,
    redirectUrl: `${base()}/portal/pay/return?txnId=${txnId}`
  });
  res.redirect(url);
});

router.get('/mock', (req, res) => res.render('pay-mock', { title: 'Mock payment', txnId: req.query.txnId }));

router.get('/return', async (req, res) => {
  const { txnId } = req.query;
  const st = await phonepe.status(txnId);
  if (req.session.pending && req.session.pending.txnId === txnId) {
    const { plan } = req.session.pending;
    delete req.session.pending;
    if (!st.success) return res.render('pay-result', { title: 'Payment failed', ok: false, message: 'The payment did not complete. No money was captured — try again.' });
    const user = await User.findByPk(req.session.userId);
    const till = new Date(); till.setMonth(till.getMonth() + config.plans[plan].months);
    user.status = 'active';
    user.memberId = user.memberId || serial('TKF-M');
    user.membershipPlan = plan;
    user.membershipPaidAt = new Date();
    user.membershipValidTill = till;
    user.membershipTxn = st.gatewayRef || txnId;
    await user.save();
    return res.render('pay-result', { title: 'Membership active', ok: true, message: `Welcome — your membership is active. Member ID ${user.memberId}.`, cta: { href: '/portal/member/card', label: 'View your membership card' } });
  }
  const donation = await Donation.findOne({ where: { txnId } });
  if (!donation) return res.status(404).render('error', { title: 'Not found', message: 'Unknown transaction.' });
  if (st.success && donation.status !== 'paid') {
    donation.status = 'paid';
    donation.paidAt = new Date();
    donation.gatewayRef = st.gatewayRef || txnId;
    donation.receiptNo = serial('TKF-R');
    await donation.save();
  } else if (!st.success) {
    donation.status = 'failed'; await donation.save();
    return res.render('pay-result', { title: 'Payment failed', ok: false, message: 'The payment did not complete. No money was captured — try again.' });
  }
  res.render('pay-result', {
    title: 'Thank you', ok: true,
    message: `Donation received — receipt ${donation.receiptNo}.`,
    cta: donation.userId ? { href: `/portal/member/receipt/${donation.id}`, label: 'View receipt' }
                         : { href: `/portal/receipt/${donation.txnId}`, label: 'View receipt' }
  });
});
module.exports = router;
