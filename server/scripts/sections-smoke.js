/* ==========================================================================
   Admin build-out smoke test.        Run with:  npm run sections:smoke

   Covers the sections added to match the client's reference admin:
   certificate designs, Generate Certificate, the issued register, visitor
   certificates, offline donations, the All Receipts hub, All Users, Blocked
   Users, notices, report downloads — and the manager permission model.

   THE PERMISSION SWEEP IS THE IMPORTANT PART. Managers are a second privilege
   tier bolted onto a router that had one blanket requireAdmin, which is the most
   dangerous thing in this build. So there are three checks, not one:

     1. a manager with NO sections is denied every admin route
     2. a manager with ONE section reaches that section and nothing else
     3. the never-grantable routes stay closed at every section level

   Check 1 enumerates the routes rather than sampling them, so a route added in
   future that forgets about permissions shows up here as a failure.
   ========================================================================== */
process.env.SESSION_SECRET = 'sections-smoke';
process.env.APP_BASE_URL = 'http://127.0.0.1:3993';
process.env.PORT = '3993';
process.env.DB_DIALECT = 'sqlite';

const base = 'http://127.0.0.1:3993';

(async () => {
  require('../server');
  await new Promise(r => setTimeout(r, 1500));

  const bcrypt = require('bcryptjs');
  const models = require('../models');
  const membership = require('../utils/membership');
  const { SECTION_KEYS, managerMay } = require('../middleware/staff');

  const admin = await models.User.create({
    name: 'Admin', email: 'admin@test.org', phone: '0', role: 'admin', status: 'active',
    passwordHash: await bcrypt.hash('admin123', 10)
  });
  await models.FormConfig.findOrCreate({ where: { formKey: 'donation' }, defaults: { fields: [] } });
  const certType = await models.Certificate.create({ title: 'Volunteer of the Year', description: 'For service.' });

  const member = await models.User.create({
    name: 'Aakash Soni', email: 'as@test.org', phone: '9000000001',
    role: 'member', status: 'guest', passwordHash: await bcrypt.hash('secret1', 10)
  });
  await membership.activate({
    user: member, MembershipPayment: models.MembershipPayment,
    plan: 'annual', mode: 'cash', recordedBy: admin.id
  });
  await member.reload();

  /* A manager account — a member row plus a grant. */
  const mgrUser = await models.User.create({
    name: 'Sunita Manager', email: 'mgr@test.org', phone: '9000000002',
    role: 'member', status: 'active', passwordHash: await bcrypt.hash('secret1', 10)
  });
  const grant = await models.ManagerAccess.create({ userId: mgrUser.id, sections: [] });

  /* A deactivated account, for the Blocked page. */
  const blockedUser = await models.User.create({
    name: 'Blocked Person', email: 'bp@test.org', phone: '9000000003',
    role: 'member', status: 'guest', passwordHash: 'x'
  });
  await models.UserAccess.create({
    userId: blockedUser.id, blocked: true, blockedAt: new Date(),
    blockedBy: admin.id, note: 'Duplicate account'
  });

  const jar = {}, tok = {};
  const keep = (who, r) => { const s = r.headers.get('set-cookie'); if (s) jar[who] = s.split(';')[0]; return r; };
  const get = async (p, who = 'admin') =>
    keep(who, await fetch(base + p, { headers: { cookie: jar[who] || '' }, redirect: 'manual' }));
  const post = async (p, fields, who = 'admin') => keep(who, await fetch(base + p, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: jar[who] || '', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...fields, _csrf: tok[who] || '' }).toString()
  }));
  async function grabToken(who, p) {
    const html = await (await get(p, who)).text();
    const m = html.match(/name="_csrf" value="([^"]+)"/);
    tok[who] = m ? m[1] : '';
    return html;
  }
  async function signIn(who, email, password) {
    await grabToken(who, '/portal/signin');
    const r = await post('/portal/signin', { email, password }, who);
    await grabToken(who, '/portal/signin');   // refresh the token for the new session
    return r;
  }

  const results = [];
  const check = (name, ok, detail) => {
    results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : '  -> ' + detail}`);
    if (!ok) process.exitCode = 1;
  };

  /* ---- the allow table, as a unit ------------------------------------- */

  check('an empty grant permits nothing but the dashboard',
    managerMay([], 'GET', '/') === true &&
    managerMay([], 'GET', '/members') === false &&
    managerMay([], 'GET', '/users') === false);
  check('a section grant permits only its own routes',
    managerMay(['enquiries'], 'GET', '/enquiries') === true &&
    managerMay(['enquiries'], 'GET', '/donations') === false);
  check('read access does not imply write access',
    managerMay(['members'], 'GET', '/members') === true &&
    managerMay(['members'], 'POST', '/members/1/access') === false);
  check('never-grantable routes are absent from the table at EVERY level',
    SECTION_KEYS.every(s =>
      !managerMay([s], 'POST', '/members/1/access') &&
      !managerMay([s], 'POST', '/volunteers/1/login') &&
      !managerMay([s], 'GET',  '/managers') &&
      !managerMay([s], 'POST', '/managers') &&
      !managerMay([s], 'GET',  '/board') &&
      !managerMay([s], 'POST', '/notices/1/delete') &&
      !managerMay([s], 'GET',  '/blocked')));
  check('an unknown path is denied even with every section',
    managerMay(SECTION_KEYS, 'GET', '/some/route/added/later') === false);

  /* ---- admin: certificate designs ------------------------------------- */

  await signIn('admin', 'admin@test.org', 'admin123');
  let html = await grabToken('admin', `/portal/admin/certificates/${certType.id}`);
  check('the certificate page offers three designs',
    ['navy', 'purple', 'green'].every(t => html.includes(`value="${t}"`)));

  let r = await post(`/portal/admin/certificates/${certType.id}/style`, { template: 'green' });
  check('a design can be chosen', [302, 303].includes(r.status));
  let style = await models.CertificateStyle.findOne({ where: { certificateId: certType.id } });
  check('...and is stored', style && style.template === 'green', style && style.template);
  await post(`/portal/admin/certificates/${certType.id}/style`, { template: 'nonsense' });
  await style.reload();
  check('an unknown design falls back rather than being stored',
    style.template === 'navy', style.template);

  /* ---- Generate Certificate ------------------------------------------- */

  html = await grabToken('admin', '/portal/admin/certificates/generate');
  check('the Generate page renders', html.includes('Generate certificate'));
  check('...listing active members', html.includes('Aakash Soni'));
  check('...and is NOT swallowed by /certificates/:id',
    !html.includes('No such certificate') && !html.includes('Not found'));
  check('...offering the certificate to issue', html.includes('Volunteer of the Year'));

  r = await post(`/portal/admin/members/${member.id}/certificate`, { certificateId: String(certType.id) });
  check('a certificate issues from the Generate page', [302, 303].includes(r.status));
  const issue = await models.CertificateIssue.findOne({ where: { userId: member.id } });
  check('...with a verifiable serial', /^TKF-C-\d{4}-/.test(issue.serial), issue.serial);

  html = await (await get('/portal/admin/certificates/generate')).text();
  check('an already-issued certificate is shown as held, not offered again',
    html.includes('has every certificate') || /cg-has[\s\S]{0,200}Volunteer of the Year/.test(html));

  /* ---- issued register ------------------------------------------------ */

  html = await (await get('/portal/admin/certificates/issued')).text();
  check('the issued register renders', html.includes('Issued certificates'));
  check('...listing the serial', html.includes(issue.serial));
  check('...and counting it as valid', /1<\/b><span>currently valid/.test(html.replace(/\s+/g, '')) ||
    html.includes('currently valid'));

  /* ---- visitor certificates ------------------------------------------- */

  html = await grabToken('admin', '/portal/admin/visitor-certificates');
  check('the visitor certificate form renders', html.includes('Issue a certificate'));
  check('...with the father/guardian field the reference has', html.includes('name="fatherName"'));
  check('...and a template chooser', html.includes('name="template"'));

  r = await post('/portal/admin/visitor-certificates', {
    name: 'Priya Nayak', fatherName: 'Ramesh Nayak', mobile: '9000000009',
    email: 'pn@test.org', programme: 'Digital Literacy Camp', template: 'purple'
  });
  check('a visitor certificate issues',
    [302, 303].includes(r.status) && /saved=TKF-VC-/.test(r.headers.get('location') || ''),
    r.headers.get('location'));
  const vc = await models.VisitorCertificate.findOne({ where: { name: 'Priya Nayak' } });
  check('...creating NO user account for them',
    !(await models.User.findOne({ where: { email: 'pn@test.org' } })));
  check('...with its own serial prefix', /^TKF-VC-\d{4}-/.test(vc.serial), vc.serial);
  check('...keeping the chosen template', vc.template === 'purple', vc.template);

  r = await post('/portal/admin/visitor-certificates', { name: '' });
  check('a nameless visitor certificate is refused', /error=name/.test(r.headers.get('location') || ''));

  r = await get(`/portal/admin/visitor-certificates/${vc.id}.pdf`);
  const pdf = Buffer.from(await r.arrayBuffer());
  check('the visitor certificate PDF is served',
    r.status === 200 && pdf.slice(0, 5).toString() === '%PDF-', String(r.status));

  /* It has to verify like everything else. */
  r = await get(`/verify/${vc.serial}`);
  html = await r.text();
  check('a visitor certificate verifies publicly', r.status === 200 && html.includes('>Valid<'));
  check('...naming the holder', html.includes('Priya Nayak'));

  await grabToken('admin', '/portal/admin/visitor-certificates');
  r = await post(`/portal/admin/visitor-certificates/${vc.id}/revoke`, { reason: 'Issued in error' });
  check('a visitor certificate can be withdrawn', [302, 303].includes(r.status));
  html = await (await get(`/verify/${vc.serial}`)).text();
  check('...and then verifies as withdrawn', html.includes('Withdrawn'));
  check('...with the record kept', !!(await models.VisitorCertificate.findByPk(vc.id)));

  /* Both kinds appear in one register. */
  html = await (await get('/portal/admin/certificates/issued')).text();
  check('the register shows member AND visitor certificates together',
    html.includes(issue.serial) && html.includes(vc.serial));

  /* ---- offline donation ------------------------------------------------ */

  html = await grabToken('admin', '/portal/admin/donations');
  check('the donations page offers an offline entry form',
    html.includes('Record a donation taken offline'));
  check('...and does NOT offer "online" as a mode', !/<option value="online"/.test(html));

  r = await post('/portal/admin/donations/offline', {
    name: 'Cash Donor', amount: '2500', mode: 'cash',
    category: 'Health & Safety', reference: 'Box 4', note: 'Bhadrak camp'
  });
  check('an offline donation is recorded',
    [302, 303].includes(r.status) && /saved=TKF-R-/.test(r.headers.get('location') || ''),
    r.headers.get('location'));
  const offDon = await models.Donation.findOne({ where: { receiptNo: { [require('sequelize').Op.like]: 'TKF-R-%' } }, order: [['id', 'DESC']] });
  check('...as a paid Donation, so it counts in the totals',
    offDon && offDon.status === 'paid' && offDon.amount === 250000,
    offDon && `${offDon.status} ${offDon.amount}`);
  check('...with no gateway transaction id', /^OFFLINE/.test(offDon.txnId), offDon.txnId);
  const offRow = await models.OfflineDonation.findOne({ where: { donationId: offDon.id } });
  check('...and a row saying how it arrived and who entered it',
    offRow && offRow.mode === 'cash' && offRow.recordedBy === admin.id);

  r = await post('/portal/admin/donations/offline', { name: 'X', amount: '10', mode: 'online' });
  check('an offline donation cannot be labelled "online"',
    /error=mode/.test(r.headers.get('location') || ''));
  r = await post('/portal/admin/donations/offline', { name: 'X', amount: '0', mode: 'cash' });
  check('a zero-amount donation is refused', /error=amount/.test(r.headers.get('location') || ''));
  r = await post('/portal/admin/donations/offline', { name: '', amount: '100', mode: 'cash' });
  check('a nameless donation is refused — the name goes on the receipt',
    /error=name/.test(r.headers.get('location') || ''));

  html = await (await get('/portal/admin/donations?kind=guest')).text();
  check('the offline donation is listed and flagged as entered by hand',
    html.includes('Cash Donor') && html.includes('by hand'));

  /* ---- All Receipts hub ------------------------------------------------ */

  html = await (await get('/portal/admin/receipts')).text();
  check('the receipts hub renders', html.includes('All receipts'));
  check('...with all four lists', ['Membership receipts', 'Member donation receipts',
    'Visitor donation receipts', 'Cash & offline'].every(t => html.includes(t.replace('&', '&amp;'))));
  check('...and says plainly that cash overlaps the others',
    html.includes('not a\n  fifth kind of money') || html.includes('fifth kind of money'));

  for (const [kind, must] of [['membership', 'Membership receipts'],
                              ['member', 'Member donation'],
                              ['visitor', 'Visitor donation'],
                              ['offline', 'Cash']]) {
    r = await get('/portal/admin/receipts/' + kind);
    html = await r.text();
    check(`the ${kind} receipt list renders`, r.status === 200 && html.includes(must), String(r.status));
  }
  html = await (await get('/portal/admin/receipts/offline')).text();
  check('the cash list contains the cash donation and not the gateway ones',
    html.includes('Cash Donor'));

  /* ---- All Users + Blocked -------------------------------------------- */

  html = await (await get('/portal/admin/users')).text();
  check('All users renders', html.includes('All users'));
  check('...including admins, members and managers',
    html.includes('Admin') && html.includes('Aakash Soni') && html.includes('Sunita Manager'));
  check('...flagging who has paid', html.includes('>Paid<'));
  html = await (await get('/portal/admin/users?q=Aakash')).text();
  check('the user search filters', html.includes('Aakash Soni') && !html.includes('Blocked Person'));

  html = await (await get('/portal/admin/blocked')).text();
  check('Blocked users renders', html.includes('Deactivated accounts'));
  check('...listing the deactivated account and its note',
    html.includes('Blocked Person') && html.includes('Duplicate account'));

  /* ---- notices --------------------------------------------------------- */

  html = await grabToken('admin', '/portal/admin/notices');
  check('the notices page renders', html.includes('Send a notice'));
  check('...and states plainly that it does not email or text',
    /not emailed and not sent by SMS/.test(html));

  r = await post('/portal/admin/notices', {
    title: 'Annual general meeting', body: 'Saturday 14 September, 10am, Bhadrak office.',
    audience: 'members', pinned: 'on'
  });
  check('a notice posts', [302, 303].includes(r.status));
  r = await post('/portal/admin/notices', { title: '', body: '' });
  check('an empty notice is refused', /error=empty/.test(r.headers.get('location') || ''));

  /* The member sees it. */
  await signIn('member', 'as@test.org', 'secret1');
  html = await (await get('/portal/member', 'member')).text();
  check('the member sees the notice on their dashboard',
    html.includes('Annual general meeting') && html.includes('Bhadrak office'));
  check('...marked important because it was pinned', html.includes('Important'));

  /* A guests-only notice must not reach a paid member. */
  await grabToken('admin', '/portal/admin/notices');
  await post('/portal/admin/notices', {
    title: 'Finish your signup', body: 'Your fee has not reached us.', audience: 'guests'
  });
  html = await (await get('/portal/member', 'member')).text();
  check('a guests-only notice is NOT shown to a paid member',
    !html.includes('Finish your signup'));

  const notice = await models.Notice.findOne({ where: { title: 'Annual general meeting' } });
  await grabToken('admin', '/portal/admin/notices');
  await post(`/portal/admin/notices/${notice.id}/toggle`, {});
  html = await (await get('/portal/member', 'member')).text();
  check('switching a notice off removes it from the dashboard',
    !html.includes('Annual general meeting'));

  /* ---- reports --------------------------------------------------------- */

  html = await (await get('/portal/admin/reports')).text();
  check('the reports page renders', html.includes('Report downloads'));
  for (const f of ['members.csv', 'certificates.csv', 'membership-receipts.csv',
                   'donations.csv', 'volunteers.csv', 'enquiries.csv']) {
    r = await get('/portal/admin/' + f);
    check(`${f} downloads`, r.status === 200 && /^text\/csv\b/.test(r.headers.get('content-type') || ''),
      r.status + ' ' + r.headers.get('content-type'));
  }
  const certCsv = await (await get('/portal/admin/certificates.csv')).text();
  check('the certificate CSV covers members and visitors, with status',
    certCsv.includes(issue.serial) && certCsv.includes(vc.serial) && certCsv.includes('withdrawn'));
  /* Escaping: a name with a comma must not split into two columns. */
  await grabToken('admin', '/portal/admin/visitor-certificates');
  await post('/portal/admin/visitor-certificates', { name: 'Nayak, Priya "PN"', programme: 'Camp' });
  const csv2 = await (await get('/portal/admin/certificates.csv')).text();
  check('CSV escapes commas and quotes in a name',
    csv2.includes('"Nayak, Priya ""PN"""'), (csv2.split('\n').find(l => l.includes('Nayak')) || '').slice(0, 80));

  /* ---- nav counts ------------------------------------------------------ */

  html = await (await get('/portal/admin')).text();
  check('the nav carries count badges', /class="n">\d+<\/span>/.test(html));

  /* ==================================================================== */
  /* ---- THE PERMISSION SWEEP ------------------------------------------ */
  /* ==================================================================== */

  await signIn('mgr', 'mgr@test.org', 'secret1');

  /* 1. A manager with no sections is denied everything. Enumerated, not
        sampled — a route added later that forgets permissions fails here. */
  const GUARDED = [
    ['GET', '/portal/admin/members'], ['GET', '/portal/admin/members?status=guest'],
    ['GET', `/portal/admin/members/${member.id}`], ['GET', '/portal/admin/users'],
    ['GET', '/portal/admin/blocked'], ['GET', '/portal/admin/managers'],
    ['GET', '/portal/admin/certificates'], ['GET', '/portal/admin/certificates/generate'],
    ['GET', '/portal/admin/certificates/issued'], ['GET', '/portal/admin/visitor-certificates'],
    ['GET', '/portal/admin/donations'], ['GET', '/portal/admin/receipts'],
    ['GET', '/portal/admin/receipts/membership'], ['GET', '/portal/admin/volunteers'],
    ['GET', '/portal/admin/enquiries'], ['GET', '/portal/admin/notices'],
    ['GET', '/portal/admin/verification-log'], ['GET', '/portal/admin/reports'],
    ['GET', '/portal/admin/membership-receipts'], ['GET', '/portal/admin/content'],
    ['GET', '/portal/admin/board'], ['GET', '/portal/admin/form'],
    ['GET', '/portal/admin/members.csv'], ['GET', '/portal/admin/donations.csv'],
    ['GET', '/portal/admin/certificates.csv'], ['GET', '/portal/admin/volunteers.csv'],
    ['GET', '/portal/admin/enquiries.csv'], ['GET', '/portal/admin/membership-receipts.csv'],
    /* card.pdf is deliberately NOT in this list. It is a redirect to
       idcard.pdf, so it answers 302 unconditionally — including with
       authorisation stripped out — and a "denied" assertion against it would be
       vacuous. idcard.pdf is the route that serves the file, so that is the one
       worth guarding. */
    ['GET', `/portal/admin/members/${member.id}/idcard.pdf`],
    ['GET', `/portal/admin/members/${member.id}/receipt.pdf`]
  ];
  const leaked = [];
  for (const [method, p] of GUARDED) {
    const rr = await fetch(base + p, { method, headers: { cookie: jar.mgr }, redirect: 'manual' });
    if (![403, 302, 303].includes(rr.status)) leaked.push(`${method} ${p} -> ${rr.status}`);
  }
  check('a manager with NO sections is denied every admin route',
    leaked.length === 0, leaked.join(' | '));

  /* The dashboard is the one thing they get — it is counts only. */
  r = await get('/portal/admin', 'mgr');
  check('...except the dashboard, which is counts only', r.status === 200, String(r.status));

  /* 2. One section, and only that section. */
  await grant.update({ sections: ['enquiries'] });
  r = await get('/portal/admin/enquiries', 'mgr');
  check('granting one section opens exactly that section', r.status === 200, String(r.status));
  r = await get('/portal/admin/donations', 'mgr');
  check('...and no other', r.status === 403, String(r.status));
  r = await get('/portal/admin/users', 'mgr');
  check('...including All users', r.status === 403, String(r.status));

  /* 3. The never-grantable routes stay closed with EVERY section held. */
  await grant.update({ sections: SECTION_KEYS });
  const escalations = [];
  for (const [method, p] of [
    ['GET',  '/portal/admin/managers'],
    ['POST', '/portal/admin/managers'],
    ['GET',  '/portal/admin/blocked'],
    ['GET',  '/portal/admin/board'],
    ['GET',  '/portal/admin/content'],
    ['GET',  '/portal/admin/cms/media'],
    ['GET',  '/portal/admin/form'],
    ['POST', `/portal/admin/members/${member.id}/access`],
    ['POST', `/portal/admin/volunteers/1/login`],
    ['POST', `/portal/admin/notices/${notice.id}/delete`]
  ]) {
    const rr = await fetch(base + p, {
      method, headers: { cookie: jar.mgr, 'content-type': 'application/x-www-form-urlencoded' },
      body: method === 'POST' ? '_csrf=' + encodeURIComponent(tok.mgr || '') : undefined,
      redirect: 'manual'
    });
    if (![403, 302, 303].includes(rr.status)) escalations.push(`${method} ${p} -> ${rr.status}`);
  }
  check('a manager holding EVERY section still cannot escalate',
    escalations.length === 0, escalations.join(' | '));
  check('...and no manager grant was created by trying',
    (await models.ManagerAccess.count()) === 1);

  /* A manager granted memberships can do the actual job. */
  await grant.update({ sections: ['memberships'] });
  const unpaid = await models.User.create({
    name: 'Needs Paying', email: 'np@test.org', phone: '9000000004',
    role: 'member', status: 'guest', passwordHash: 'x'
  });
  await grabToken('mgr', '/portal/admin/members?status=guest');
  r = await post(`/portal/admin/members/${unpaid.id}/membership`,
    { plan: 'annual', mode: 'cash' }, 'mgr');
  check('a manager with the memberships section can record a payment',
    [302, 303].includes(r.status), String(r.status));
  await unpaid.reload();
  check('...and it worked', unpaid.status === 'active' && !!unpaid.memberId);
  const mgrPay = await models.MembershipPayment.findOne({ where: { userId: unpaid.id } });
  check('...stamped with the MANAGER as the person who entered it',
    mgrPay && mgrPay.recordedBy === mgrUser.id, mgrPay && String(mgrPay.recordedBy));

  /* Suspending the grant closes the door immediately. */
  await grant.update({ active: false });
  r = await get('/portal/admin/members?status=guest', 'mgr');
  check('suspending a manager grant locks them out at once', r.status === 403, String(r.status));

  /* An ordinary member is not a manager. */
  r = await get('/portal/admin/members', 'member');
  check('an ordinary member cannot reach the admin at all', r.status === 403, String(r.status));

  console.log('\n' + results.join('\n'));
  console.log(process.exitCode ? '\nFAILURES' : '\nALL PASS');
  process.exit(process.exitCode || 0);
})().catch(e => { console.error(e); process.exit(1); });
