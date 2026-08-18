// End-to-end smoke test on an in-memory MongoDB: seeds an admin, signs up a
// member, pays membership (mock gateway), makes a member + guest donation,
// issues a certificate, downloads PDFs.
process.env.SESSION_SECRET = 'smoke';
process.env.APP_BASE_URL = 'http://127.0.0.1:3999';
process.env.PORT = '3999';
process.env.ADMIN_EMAIL = 'admin@test.org';
process.env.ADMIN_PASSWORD = 'admin123';



(async () => {
  
  process.env.DB_DIALECT = "sqlite";

  // boot, then seed in-process (sqlite :memory: is per-process)
  require('../server');
  await new Promise(r => setTimeout(r, 1500));
  const bcrypt = require('bcryptjs');
  const models = require('../models');
  await models.User.create({
    name: 'Admin', email: 'admin@test.org', phone: '0', role: 'admin', status: 'active',
    passwordHash: await bcrypt.hash('admin123', 10)
  });
  await models.FormConfig.findOrCreate({ where: { formKey: 'donation' }, defaults: { fields: [] } });

  const base = 'http://127.0.0.1:3999';
  let jar = {};
  async function call(method, path, body, useJar = 'member') {
    const headers = { cookie: jar[useJar] || '' };
    let opts = { method, headers, redirect: 'manual' };
    if (body) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      opts.body = new URLSearchParams(body).toString();
    }
    const res = await fetch(base + path, opts);
    const setc = res.headers.get('set-cookie');
    if (setc) jar[useJar] = setc.split(';')[0];
    return res;
  }
  const results = [];
  const check = (name, ok) => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) process.exitCode = 1; };

  // static site
  check('static / serves', (await fetch(base + '/')).status === 200);
  check('portal signin renders', (await fetch(base + '/portal/signin')).status === 200);

  // member signup → guest status
  let r = await call('POST', '/portal/signup', { name: 'Test Member', email: 'm@test.org', phone: '9999999999', password: 'secret1' });
  check('signup redirects to member', [302,303].includes(r.status) && r.headers.get('location') === '/portal/member');
  r = await call('GET', '/portal/member');
  check('member dashboard shows verify prompt', (await r.text()).includes('Please verify your membership'));

  // membership payment (mock)
  r = await call('POST', '/portal/pay/membership', { plan: 'annual' });
  const mockUrl = r.headers.get('location');
  check('membership initiates mock pay', /\/portal\/pay\/mock\?txnId=/.test(mockUrl));
  const txn1 = mockUrl.split('txnId=')[1];
  r = await call('GET', `/portal/pay/return?txnId=${txn1}`);
  check('membership return succeeds', (await r.text()).includes('Membership active'));
  r = await call('GET', '/portal/member/card');
  const cardHtml = await r.text();
  check('card shows QR + barcode + serial', cardHtml.includes('data:image/png;base64') && /TKF-M-\d{4}-/.test(cardHtml));
  r = await call('GET', '/portal/member/card/pdf');
  check('card PDF', r.headers.get('content-type') === 'application/pdf');

  // member donation
  r = await call('POST', '/portal/pay/donation', { category: 'Environment', amount: '250' });
  const txn2 = r.headers.get('location').split('txnId=')[1];
  r = await call('GET', `/portal/pay/return?txnId=${txn2}`);
  check('member donation paid', (await r.text()).includes('Donation received'));
  r = await call('GET', '/portal/member/donations');
  const dHtml = await r.text();
  check('donation list shows paid + receipt link', dHtml.includes('paid') && dHtml.includes('/portal/member/receipt/'));
  const recId = dHtml.match(/\/portal\/member\/receipt\/(\d+)/)[1];
  r = await call('GET', `/portal/member/receipt/${recId}/pdf`);
  check('receipt PDF', r.headers.get('content-type') === 'application/pdf');

  // guest donation with full details
  r = await call('POST', '/portal/pay/donation', {
    category: 'Health & Safety', amount: '500', name: 'Guest G', email: 'g@x.org',
    phone: '8888888888', address: 'Somewhere', city: 'Bhadrak', pan: 'ABCDE1234F',
    bankName: 'IOB', branchName: 'Nalanga'
  }, 'guest');
  const txn3 = r.headers.get('location').split('txnId=')[1];
  r = await call('GET', `/portal/pay/return?txnId=${txn3}`, null, 'guest');
  check('guest donation paid', (await r.text()).includes('Donation received'));
  r = await call('GET', `/portal/receipt/${txn3}/pdf`, null, 'guest');
  check('guest receipt PDF', r.headers.get('content-type') === 'application/pdf');

  // admin flows
  r = await call('POST', '/portal/signin', { email: 'admin@test.org', password: 'admin123' }, 'admin');
  check('admin signin', r.headers.get('location') === '/portal/admin');
  r = await call('GET', '/portal/admin', null, 'admin');
  check('admin dashboard counts', (await r.text()).includes('Active members'));
  r = await call('GET', '/portal/admin/members', null, 'admin');
  check('active member listed', (await r.text()).includes('Test Member'));
  r = await call('GET', '/portal/admin/donations?kind=guest', null, 'admin');
  check('guest donation listed', (await r.text()).includes('Guest G'));

  // certificate: create → issue → member sees it
  await call('POST', '/portal/admin/certificates', { title: 'Certificate of Appreciation', description: 'For support' }, 'admin');
  r = await call('GET', '/portal/admin/certificates', null, 'admin');
  const certId = (await r.text()).match(/certificates\/(\d+)/)[1];
  const member = await models.User.findOne({ where: { email: 'm@test.org' } });
  await call('POST', `/portal/admin/certificates/${certId}/issue`, { userId: String(member.id) }, 'admin');
  r = await call('GET', `/portal/admin/certificates/${certId}`, null, 'admin');
  const serialM = (await r.text()).match(/TKF-C-\d{4}-[A-F0-9]{6}/);
  check('certificate issued with serial', !!serialM);
  r = await call('GET', `/portal/member/certificate/${certId}/${serialM[0]}/pdf`);
  check('certificate PDF for member', r.headers.get('content-type') === 'application/pdf');

  // admin CMS + form config
  await call('POST', '/portal/admin/content/about', { heading: 'About', body: 'New body' }, 'admin');
  r = await fetch(base + '/api/content/about');
  check('content API returns saved data', (await r.json()).body === 'New body');
  await call('POST', '/portal/admin/form/add', { label: 'Occupation', type: 'text' }, 'admin');
  r = await call('GET', '/portal/member/donate');
  check('configured field appears on donation form', (await r.text()).includes('Occupation'));

  console.log(results.join('\n'));
  console.log(results.every(x => x.startsWith('PASS')) ? '\nALL PASS' : '\nFAILURES ABOVE');
  process.exit(process.exitCode || 0);
})().catch(e => { console.error('SMOKE CRASH', e); process.exit(1); });
