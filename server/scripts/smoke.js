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
  let tok = {};   // CSRF token per identity, keyed the same way as `jar`

  /* Every unsafe request now needs a CSRF token (middleware/csrf.js). The token
     is the session's own secret, so it is stable for the life of a session and
     can be fetched once per identity: GET any page with this jar, scrape the
     hidden field, reuse it. The GET also establishes the session whose cookie
     the follow-up POST will carry. */
  async function ensureToken(useJar) {
    if (tok[useJar]) return tok[useJar];
    const res = await fetch(base + '/portal/signin', { headers: { cookie: jar[useJar] || '' }, redirect: 'manual' });
    const setc = res.headers.get('set-cookie');
    if (setc) jar[useJar] = setc.split(';')[0];
    const m = (await res.text()).match(/name="_csrf" value="([^"]+)"/);
    tok[useJar] = m ? m[1] : '';
    return tok[useJar];
  }

  async function call(method, path, body, useJar = 'member') {
    const headers = { cookie: jar[useJar] || '' };
    let opts = { method, headers, redirect: 'manual' };
    if (body) {
      const t = await ensureToken(useJar);
      headers.cookie = jar[useJar] || '';        // ensureToken may have set it
      headers['content-type'] = 'application/x-www-form-urlencoded';
      opts.body = new URLSearchParams({ ...body, _csrf: t }).toString();
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
  // The unpaid panel now names the actual state — "the fee has not reached us" —
  // rather than the vaguer "verify your membership", and says something
  // different again once a membership has lapsed. Assert on the state, not the
  // old wording.
  {
    const body = await r.text();
    check('member dashboard says the membership fee has not arrived',
      body.includes('Membership fee not received yet') && body.includes('Pay &amp; activate'));
  }

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

  /* The member's own download must be THE SAME CARD the office prints, not a
     simpler one. It was a different document for a while — this route was still
     calling the retired single-page generator — so a member's phone showed one
     card and their wallet held another. Two pages is the fingerprint of the
     real one. */
  const myCard = Buffer.from(await r.arrayBuffer()).toString('latin1');
  const myPages = (myCard.match(/\/Type\s*\/Page[^s]/g) || []).length;
  check('the member\'s own card PDF has both sides', myPages === 2, 'pages=' + myPages);

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

  // public volunteer + contact forms → portal DB → admin tabs
  async function postJson(path, body) {
    return fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  r = await postJson('/api/volunteer', {
    name: 'Vol Unteer', email: 'vol@x.org', phone: '7777777777', city: 'Bhadrak',
    type: 'Student', availability: 'Weekends', interest: 'Environment, Health & Safety', message: 'Happy to help'
  });
  check('volunteer form accepted', r.status === 200 && (await r.json()).ok === true);
  r = await postJson('/api/volunteer', { name: 'Bot', email: 'b@x.org', phone: '7777777777', _hp: 'spam' });
  check('volunteer honeypot silently dropped', (await r.json()).ok === true && (await models.Volunteer.count()) === 1);
  r = await postJson('/api/volunteer', { name: 'No Mail', email: 'bad', phone: '123' });
  check('volunteer validation rejects bad input', r.status === 400);
  r = await postJson('/api/contact', { name: 'Asker', email: 'ask@x.org', subject: 'Hello', message: 'A question about camps' });
  check('contact form accepted', r.status === 200 && (await r.json()).ok === true);
  r = await call('GET', '/portal/admin/volunteers', null, 'admin');
  check('admin volunteers list shows entry', (await r.text()).includes('Vol Unteer'));
  r = await call('GET', '/portal/admin/enquiries', null, 'admin');
  check('admin enquiries list shows entry', (await r.text()).includes('A question about camps'));
  const vol = await models.Volunteer.findOne({ where: { email: 'vol@x.org' } });
  await call('POST', `/portal/admin/volunteers/${vol.id}/status`, { status: 'contacted' }, 'admin');
  check('volunteer status updates', (await models.Volunteer.findByPk(vol.id)).status === 'contacted');
  r = await call('GET', '/portal/admin/volunteers.csv', null, 'admin');
  check('volunteers CSV', r.headers.get('content-type').includes('text/csv') && (await r.text()).includes('vol@x.org'));
  r = await call('GET', '/portal/admin/enquiries.csv', null, 'admin');
  check('enquiries CSV', r.headers.get('content-type').includes('text/csv') && (await r.text()).includes('ask@x.org'));

  console.log(results.join('\n'));
  console.log(results.every(x => x.startsWith('PASS')) ? '\nALL PASS' : '\nFAILURES ABOVE');
  process.exit(process.exitCode || 0);
})().catch(e => { console.error('SMOKE CRASH', e); process.exit(1); });
