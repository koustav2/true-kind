/* ==========================================================================
   Granting membership — the single place it happens.

   There are now two ways a membership fee arrives:

     1. The member pays online and Razorpay confirms it (routes/payment.js).
     2. An admin records a fee taken in cash, by bank transfer, by UPI or by
        cheque (routes/admin.js).

   Both must produce EXACTLY the same result — a Member ID, a plan, a validity
   date, an active account and a numbered receipt — or the two paths drift and
   an offline member ends up with a half-filled record. So neither route does
   any of that itself; both call activate() below.

   It also fixes a renewal bug that was in the online path: it set validTill to
   "now + plan months" unconditionally, so a member who renewed a month early
   silently forfeited the month they had left. Renewing now extends from the
   existing expiry whenever that is still in the future.
   ========================================================================== */
'use strict';

const config = require('../config');
const { serial } = require('./codes');

/** The plan key, defaulting to annual — the same fallback routes/payment.js used. */
function planKey(plan) {
  return config.plans[plan] ? plan : 'annual';
}

/**
 * Grant or renew membership and record the payment.
 *
 * @param {object}  opts
 * @param {object}  opts.user        a Sequelize User instance (will be saved)
 * @param {object}  opts.MembershipPayment  the model (passed in to keep this
 *                                   module free of a circular require)
 * @param {string}  opts.plan        'monthly' | 'annual'
 * @param {number} [opts.amount]     paise actually received; defaults to the
 *                                   plan price. Pass the real figure for cash —
 *                                   what was collected is not always the list
 *                                   price, and the receipt must say what was
 *                                   actually taken.
 * @param {string} [opts.mode]       'online' | 'cash' | 'bank' | 'upi' | 'cheque'
 * @param {string} [opts.reference]  gateway ref, UTR, cheque number
 * @param {number} [opts.recordedBy] admin user id; omit when self-paid online
 * @param {string} [opts.note]
 * @param {Date}   [opts.paidAt]     defaults to now; an offline fee may have
 *                                   been collected days before it was entered
 * @returns {Promise<object>} the MembershipPayment row
 */
async function activate(opts) {
  const { user, MembershipPayment } = opts;
  const plan = planKey(opts.plan);
  const spec = config.plans[plan];
  const paidAt = opts.paidAt instanceof Date && !isNaN(opts.paidAt) ? opts.paidAt : new Date();

  // Renewal extends from the current expiry if it has not passed yet.
  const from = (user.membershipValidTill && user.membershipValidTill > paidAt)
    ? new Date(user.membershipValidTill)
    : new Date(paidAt);
  const validTill = new Date(from);
  validTill.setMonth(validTill.getMonth() + spec.months);

  const amount = Number.isFinite(opts.amount) && opts.amount > 0 ? Math.round(opts.amount) : spec.amount;

  user.status = 'active';
  user.memberId = user.memberId || serial('TKF-M');
  user.membershipPlan = plan;
  user.membershipPaidAt = paidAt;
  user.membershipValidTill = validTill;
  user.membershipTxn = opts.reference || user.membershipTxn;
  await user.save();

  return MembershipPayment.create({
    userId: user.id,
    plan,
    amount,
    mode: opts.mode || 'online',
    reference: opts.reference || null,
    receiptNo: serial('TKF-MR'),
    paidAt,
    validTill,
    recordedBy: opts.recordedBy || null,
    note: opts.note || null
  });
}

/* The payment modes the admin form offers. 'online' is not in this list: that
   one is only ever set by the gateway callback, so an admin cannot label a cash
   payment as an online one and make it indistinguishable from a real
   transaction. */
const OFFLINE_MODES = ['cash', 'bank', 'upi', 'cheque'];

function isOfflineMode(m) {
  return OFFLINE_MODES.includes(String(m || '').toLowerCase());
}

module.exports = { activate, planKey, OFFLINE_MODES, isOfflineMode };
