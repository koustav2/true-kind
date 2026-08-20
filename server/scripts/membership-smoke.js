/* ==========================================================================
   Membership + certificate smoke test.     Run with:  npm run member:smoke

   Covers the flow the client described — "if some register but not pay the
   membership amount then will unpaid, after paid they will become active
   member" — plus the certificate section added to the active-members table.

   Specifically:
     - a fresh signup is Unpaid and sits on the New memberships tab
     - it has no Member ID, no card, no receipt
     - an admin records a cash/bank/UPI/cheque fee -> Member ID, validity,
       numbered receipt, and the row moves to Active members
     - the online gateway path produces the same shape of record
     - renewal EXTENDS from the current expiry instead of resetting to today
     - certificates issue from the member's own row, refuse duplicates, and
       produce a PDF an admin can pull without signing in as the member
     - the receipts list, its CSV and its PDFs
     - none of it is reachable without an admin session or a CSRF token

   Run: npm run member:smoke
   ========================================================================== */
process.env.SESSION_SECRET = 'membership-smoke';
process.env.APP_BASE_URL = 'http://127.0.0.1:3995';
process.env.PORT = '3995';
process.env.DB_DIALECT = 'sqlite';

const base = 'http://127.0.0.1:3995';

(async () => {
  require('../server');
  await new Promise(r => setTimeout(r, 1500));

  const bcrypt = require('bcryptjs');
  const models = require('../models');
  const config = require('../config');
  await models.User.create({
    name: 'Admin', email: 'admin@test.org', phone: '0', role: 'admin', status: 'active',
    passwordHash: await bcrypt.hash('admin123', 10)
  });
  await models.FormConfig.findOrCreate({ where: { formKey: 'donation' }, defaults: { fields: [] } });
  const cert = await models.Certificate.create({ title: 'Volunteer of the Year', description: 'For outstanding service.' });
  const cert2 = await models.Certificate.create({ title: 'Training Completion' });

  /* Two cookie jars: one for the admin, one for a member. */
  const jar = {}, tok = {};
  function keep(who, res) {
    const s = res.headers.get('set-cookie');
    if (s) jar[who] = s.split(';')[0];
    return res;
  }
  async function get(path, who = 'admin') {
    return keep(who, await fetch(base + path, { headers: { cookie: jar[who] || '' }, redirect: 'manual' }));
  }
  async function grabToken(who, path) {
    const html = await (await get(path, who)).text();
    const m = html.match(/name="_csrf" value="([^"]+)"/);
    tok[who] = m ? m[1] : '';
    return html;
  }
  async function post(path, fields, who = 'admin') {
    return keep(who, await fetch(base + path, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: jar[who] || '', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...fields, _csrf: tok[who] || '' }).toString()
    }));
  }

  const results = [];
  const check = (name, ok, detail) => {
    results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : '  -> ' + detail}`);
    if (!ok) process.exitCode = 1;
  };

  /* ---- a registration with no payment ---------------------------------- */

  await grabToken('cash', '/portal/signup');
  let r = await post('/portal/signup', {
    name: 'Cash Payer', email: 'cash@test.org', phone: '9000000001', password: 'secret1'
  }, 'cash');
  check('signup lands in the member area', [302, 303].includes(r.status) &&
    r.headers.get('location') === '/portal/member', r.status + ' ' + r.headers.get('location'));

  const cashUser = await models.User.findOne({ where: { email: 'cash@test.org' } });
  check('a new signup is a guest, not a member', cashUser.status === 'guest', cashUser.status);
  check('...with no Member ID', !cashUser.memberId, cashUser.memberId);
  check('...and no membership', !cashUser.membership);

  await grabToken('admin', '/portal/signin');
  r = await post('/portal/signin', { email: 'admin@test.org', password: 'admin123' });
  check('admin signs in', [302, 303].includes(r.status));

  let html = await grabToken('admin', '/portal/admin/members?status=guest');
  check('the guest tab is titled New memberships', html.includes('New membership requests'));
  check('the unpaid registration is listed there', html.includes('Cash Payer'));
  check('...marked Unpaid', /Cash Payer[\s\S]{0,900}?pill warn">Unpaid/.test(html));
  check('...with the record-payment form on the row',
    html.includes(`action="/portal/admin/members/${cashUser.id}/membership"`));
  check('the payment form offers cash, bank, UPI and cheque',
    ['cash', 'bank', 'upi', 'cheque'].every(m => html.includes(`value="${m}"`)));
  check('the form does NOT offer "online" as a choice',
    !/<option value="online"/.test(html));

  /* No card and no receipt before payment. */
  r = await get(`/portal/admin/members/${cashUser.id}/card.pdf`);
  check('no ID card before the fee is recorded', r.status === 400, String(r.status));
  r = await get(`/portal/admin/members/${cashUser.id}/receipt.pdf`);
  check('no receipt before the fee is recorded', r.status === 404, String(r.status));

  /* ---- record a fee taken in cash -------------------------------------- */

  r = await post(`/portal/admin/members/${cashUser.id}/membership`, {
    plan: 'annual', mode: 'cash', amount: '750',
    reference: 'Bhadrak camp box 3', note: 'collected at the Bhadrak camp'
  });
  check('recording the payment redirects to the member',
    [302, 303].includes(r.status) && /\/portal\/admin\/members\/\d+\?saved=TKF-MR-/.test(r.headers.get('location') || ''),
    r.status + ' ' + r.headers.get('location'));

  await cashUser.reload();
  check('the member is now active', cashUser.status === 'active', cashUser.status);
  check('...and has a Member ID', /^TKF-M-\d{4}-/.test(cashUser.memberId || ''), cashUser.memberId);
  check('...on the annual plan', cashUser.membershipPlan === 'annual', cashUser.membershipPlan);
  check('...valid for 12 months', (() => {
    const t = cashUser.membershipValidTill, p = cashUser.membershipPaidAt;
    const months = (t.getFullYear() - p.getFullYear()) * 12 + (t.getMonth() - p.getMonth());
    return months === 12;
  })(), String(cashUser.membershipValidTill));
  check('...and is a valid membership right now', cashUser.membershipValid === true);

  const cashPay = await models.MembershipPayment.findOne({ where: { userId: cashUser.id } });
  check('a receipt row exists', !!cashPay);
  check('the receipt has a serial', /^TKF-MR-\d{4}-/.test(cashPay.receiptNo || ''), cashPay.receiptNo);
  check('the amount recorded is what was collected, not the plan price',
    cashPay.amount === 75000 && config.plans.annual.amount === 100000,
    cashPay.amount + ' vs plan ' + config.plans.annual.amount);
  check('the mode is cash', cashPay.mode === 'cash', cashPay.mode);
  check('the reference and note are kept',
    cashPay.reference === 'Bhadrak camp box 3' && /Bhadrak camp/.test(cashPay.note || ''));
  check('it is stamped with the admin who entered it', !!cashPay.recordedBy, String(cashPay.recordedBy));

  /* Tab movement. */
  html = await (await get('/portal/admin/members?status=guest')).text();
  check('the row has left the New memberships tab', !html.includes('Cash Payer'));
  html = await (await get('/portal/admin/members')).text();
  check('...and appears under Active members', html.includes('Cash Payer'));
  check('...marked Paid', /Cash Payer[\s\S]{0,900}?pill ok">Paid/.test(html));
  check('...showing the Member ID', html.includes(cashUser.memberId));

  /* Card + receipt now work. */
  r = await get(`/portal/admin/members/${cashUser.id}/card.pdf`);
  check('the ID card PDF is served', r.status === 200 && r.headers.get('content-type') === 'application/pdf',
    r.status + ' ' + r.headers.get('content-type'));
  r = await get(`/portal/admin/members/${cashUser.id}/receipt.pdf`);
  check('the membership receipt PDF is served', r.status === 200 && r.headers.get('content-type') === 'application/pdf',
    r.status + ' ' + r.headers.get('content-type'));

  /* ---- mode is validated ---------------------------------------------- */

  await grabToken('admin', '/portal/admin/members?status=guest');
  r = await post(`/portal/admin/members/${cashUser.id}/membership`, { plan: 'annual', mode: 'online' });
  check('a payment cannot be recorded as "online" by hand',
    /error=mode/.test(r.headers.get('location') || ''), r.headers.get('location'));
  r = await post(`/portal/admin/members/${cashUser.id}/membership`, { plan: 'annual', mode: 'bitcoin' });
  check('an unknown payment mode is refused', /error=mode/.test(r.headers.get('location') || ''));
  r = await post(`/portal/admin/members/${cashUser.id}/membership`, { plan: 'annual', mode: 'cash', amount: 'lots' });
  check('a non-numeric amount is refused', /error=amount/.test(r.headers.get('location') || ''));
  check('none of those created a payment row',
    (await models.MembershipPayment.count({ where: { userId: cashUser.id } })) === 1);

  /* ---- renewal extends, it does not reset ----------------------------- */

  const beforeRenewal = new Date(cashUser.membershipValidTill);
  r = await post(`/portal/admin/members/${cashUser.id}/membership`, { plan: 'monthly', mode: 'upi' });
  check('a renewal is accepted', [302, 303].includes(r.status));
  await cashUser.reload();
  const gained = Math.round((cashUser.membershipValidTill - beforeRenewal) / 86400000);
  check('renewing EXTENDS from the current expiry rather than resetting to today',
    gained >= 28 && gained <= 31, `moved ${gained} days (was ${beforeRenewal.toDateString()})`);
  check('both payments are kept, not overwritten',
    (await models.MembershipPayment.count({ where: { userId: cashUser.id } })) === 2);

  /* ---- the online path produces the same shape ------------------------ */

  await grabToken('online', '/portal/signup');
  await post('/portal/signup', {
    name: 'Online Payer', email: 'online@test.org', phone: '9000000002', password: 'secret1'
  }, 'online');
  r = await post('/portal/pay/membership', { plan: 'annual' }, 'online');
  const mockUrl = r.headers.get('location') || '';
  check('membership checkout reaches the gateway', /\/portal\/pay\/mock\?txnId=/.test(mockUrl), mockUrl);
  r = await get('/portal/pay/return?txnId=' + mockUrl.split('txnId=')[1], 'online');
  const payHtml = await r.text();
  check('the gateway return activates the membership', payHtml.includes('Membership active'));
  check('...and shows the receipt number on screen', /TKF-MR-\d{4}-/.test(payHtml));

  const onlineUser = await models.User.findOne({ where: { email: 'online@test.org' } });
  const onlinePay = await models.MembershipPayment.findOne({ where: { userId: onlineUser.id } });
  check('the online payment writes a receipt row too', !!onlinePay);
  check('...at the plan price', onlinePay && onlinePay.amount === config.plans.annual.amount,
    onlinePay && String(onlinePay.amount));
  check('...marked online', onlinePay && onlinePay.mode === 'online', onlinePay && onlinePay.mode);
  check('...and NOT stamped as entered by hand', onlinePay && !onlinePay.recordedBy);

  /* ---- certificates from the member row ------------------------------- */

  html = await grabToken('admin', '/portal/admin/members');
  check('the active-members table has a certificate control',
    html.includes(`action="/portal/admin/members/${cashUser.id}/certificate"`));
  check('...listing the certificates that exist',
    html.includes('Volunteer of the Year') && html.includes('Training Completion'));

  r = await post(`/portal/admin/members/${cashUser.id}/certificate`, { certificateId: String(cert.id) });
  check('a certificate issues from the member row',
    /\?saved=TKF-C-\d{4}-/.test(r.headers.get('location') || ''), r.headers.get('location'));

  const issue = await models.CertificateIssue.findOne({ where: { userId: cashUser.id } });
  check('the issue row has a verifiable serial', /^TKF-C-\d{4}-/.test(issue.serial || ''), issue.serial);

  r = await post(`/portal/admin/members/${cashUser.id}/certificate`, { certificateId: String(cert.id) });
  check('the same certificate is not issued twice',
    /error=duplicate/.test(r.headers.get('location') || ''), r.headers.get('location'));
  check('...and no second row was created',
    (await models.CertificateIssue.count({ where: { userId: cashUser.id } })) === 1);

  r = await post(`/portal/admin/members/${cashUser.id}/certificate`, { certificateId: String(cert2.id) });
  check('a DIFFERENT certificate can still be issued', [302, 303].includes(r.status) &&
    !/error=/.test(r.headers.get('location') || ''));

  r = await post(`/portal/admin/members/${cashUser.id}/certificate`, { certificateId: '99999' });
  check('an unknown certificate id is refused', /error=nocert/.test(r.headers.get('location') || ''));

  r = await get(`/portal/admin/members/${cashUser.id}/certificate/${issue.id}.pdf`);
  check('an admin can download the certificate PDF',
    r.status === 200 && r.headers.get('content-type') === 'application/pdf',
    r.status + ' ' + r.headers.get('content-type'));

  /* A certificate belonging to someone else must not come back under this id. */
  r = await get(`/portal/admin/members/${onlineUser.id}/certificate/${issue.id}.pdf`);
  check('a certificate cannot be fetched under the wrong member', r.status === 404, String(r.status));

  html = await (await get('/portal/admin/members')).text();
  check('the active-members table shows the certificate count', /2 issued/.test(html));

  /* ---- member detail page --------------------------------------------- */

  html = await (await get(`/portal/admin/members/${cashUser.id}`)).text();
  check('member detail renders', html.includes('Membership payments'));
  check('...showing both payments', (html.match(/TKF-MR-/g) || []).length >= 2);
  check('...both certificates', html.includes('Volunteer of the Year') && html.includes('Training Completion'));
  check('...the by-hand vs gateway distinction', html.includes('by hand'));
  check('...and the note that was entered', html.includes('collected at the Bhadrak camp'));

  /* Withdrawing.

     This used to be a DELETE and the assertion used to be "the row is gone".
     Both were wrong once certificates became verifiable: the paper certificate
     is still in somebody's hand, and a deleted row made its serial verify as
     "not recognised" — indistinguishable from a forgery. It is a revocation
     now, so the record survives and the serial reports withdrawn.
     verify:smoke covers what a scan of it says. */
  await grabToken('admin', `/portal/admin/members/${cashUser.id}`);
  r = await post(`/portal/admin/members/${cashUser.id}/certificate/${issue.id}/revoke`,
    { reason: 'Issued in error' });
  check('a certificate can be withdrawn', [302, 303].includes(r.status));
  check('...the issue record survives, so the serial still resolves',
    !!(await models.CertificateIssue.findByPk(issue.id)));
  check('...and a revocation is recorded against its serial',
    !!(await models.Revocation.findOne({ where: { code: issue.serial } })));

  /* ---- receipts list -------------------------------------------------- */

  html = await (await get('/portal/admin/membership-receipts')).text();
  check('the membership receipts page renders', html.includes('Membership receipts'));
  check('...listing every payment', (html.match(/TKF-MR-/g) || []).length >= 3);
  check('...both the cash and the online one', html.includes('Cash') && html.includes('Online (PhonePe)'));
  check('...and separating by-hand from gateway',
    html.includes('by hand') && html.includes('gateway'));

  const totalPaise = (await models.MembershipPayment.findAll()).reduce((n, p) => n + p.amount, 0);
  check('the total shown is the sum of the payments',
    html.includes('₹' + (totalPaise / 100).toLocaleString('en-IN')), String(totalPaise));

  r = await get('/portal/admin/membership-receipts.csv');
  const csv = await r.text();
  // Express appends "; charset=utf-8" to a text/* Content-Type on send(), so
  // match the type and not the whole header.
  check('the CSV downloads', /^text\/csv\b/.test(r.headers.get('content-type') || ''),
    r.headers.get('content-type'));
  check('...with a header row and one line per payment',
    csv.split('\n')[0].startsWith('Receipt,Date,MemberId') && csv.trim().split('\n').length === 4,
    String(csv.trim().split('\n').length));
  check('...and flags which rows were entered by hand',
    /,yes$/m.test(csv) && /,no$/m.test(csv));

  r = await get(`/portal/admin/membership-receipts/${cashPay.id}/pdf`);
  check('a receipt PDF is served from the list',
    r.status === 200 && r.headers.get('content-type') === 'application/pdf');

  /* ---- what the member sees ------------------------------------------- */

  /* Before payment. A fresh unpaid signup, using its own jar. */
  await grabToken('unpaid', '/portal/signup');
  await post('/portal/signup', {
    name: 'Not Paid Yet', email: 'unpaid@test.org', phone: '9000000003', password: 'secret1'
  }, 'unpaid');
  html = await (await get('/portal/member', 'unpaid')).text();
  check('an unpaid member is told the fee has not arrived',
    html.includes('Membership fee not received yet'));
  check('...and is told a cash payment needs nothing further from them',
    /Already paid in cash/.test(html));
  check('...with no membership payments table', !html.includes('Membership payments'));

  /* After payment — the cash payer, signed in as themselves. */
  await grabToken('cash', '/portal/signin');
  r = await post('/portal/signin', { email: 'cash@test.org', password: 'secret1' }, 'cash');
  check('the activated member can sign in', [302, 303].includes(r.status));
  html = await (await get('/portal/member', 'cash')).text();
  check('the member now sees Active member', html.includes('Active member'));
  check('...their Member ID', html.includes(cashUser.memberId));
  check('...and both membership receipts, cash payment included',
    html.includes('Membership payments') && (html.match(/TKF-MR-/g) || []).length >= 2);
  check('...with a receipt PDF link of their own',
    html.includes(`/portal/member/membership-receipt/${cashPay.id}/pdf`));

  r = await get(`/portal/member/membership-receipt/${cashPay.id}/pdf`, 'cash');
  check('the member can download their own membership receipt',
    r.status === 200 && r.headers.get('content-type') === 'application/pdf',
    r.status + ' ' + r.headers.get('content-type'));

  /* Someone else's receipt must not be readable. */
  r = await get(`/portal/member/membership-receipt/${onlinePay.id}/pdf`, 'cash');
  check('a member cannot download another member\'s receipt', r.status === 404, String(r.status));

  /* ---- guards --------------------------------------------------------- */

  /* Signed in as an ordinary member, not an admin. */
  r = await get('/portal/admin/members', 'online');
  check('a member cannot open the admin member list',
    [302, 303, 403].includes(r.status), String(r.status));
  r = await get('/portal/admin/membership-receipts', 'online');
  check('a member cannot open the receipts list', [302, 303, 403].includes(r.status), String(r.status));
  r = await get(`/portal/admin/members/${cashUser.id}/card.pdf`, 'online');
  check('a member cannot pull another member\'s ID card', [302, 303, 403].includes(r.status), String(r.status));

  /* Signed out entirely. */
  r = await fetch(base + '/portal/admin/membership-receipts', { redirect: 'manual' });
  check('a stranger cannot open the receipts list', [302, 303, 403].includes(r.status), String(r.status));

  /* CSRF. */
  const noToken = await fetch(base + `/portal/admin/members/${onlineUser.id}/membership`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: jar.admin, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'plan=annual&mode=cash'
  });
  check('recording a payment without a CSRF token is refused', noToken.status === 403, String(noToken.status));

  console.log('\n' + results.join('\n'));
  console.log(process.exitCode ? '\nFAILURES' : '\nALL PASS');
  process.exit(process.exitCode || 0);
})().catch(e => { console.error(e); process.exit(1); });
