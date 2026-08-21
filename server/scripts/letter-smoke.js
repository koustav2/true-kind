/* ==========================================================================
   Appointment letters, end to end.        Run with:  npm run letter:smoke

   The three things most likely to be wrong, and why each has a check:

     1. THE SERIAL VERIFIES. A document with a QR that resolves to "not
        recognised" is worse than one with no QR — it invites a check and then
        fails it. This has already happened once in this codebase, to TKF-VC,
        and the only thing that caught it was a test like this one. So: issue a
        letter, then resolve its serial through the real verifier and through
        the real public /verify page.

     2. PREVIEW IS NOT A LETTER. Preview renders from the form without saving.
        If it ever came out unwatermarked, the natural workflow — preview, like
        it, save the PDF, email that — would put a letter into the world with no
        serial and nothing behind it. So preview must carry SPECIMEN and must
        write no row; the issued document must NOT carry it.

     3. THE PAY FIGURE IS NOT PUBLIC. /verify needs no login. A verification
        page that leaks somebody's salary is a worse problem than an unverifiable
        letter, so the public page is checked for the absence of the numbers.

   Plus the permission tier: letters are their own grant, because printing a
   training certificate and setting somebody's pay are not the same trust.
   ========================================================================== */
process.env.SESSION_SECRET = 'letter-smoke';
process.env.APP_BASE_URL = 'http://127.0.0.1:3995';
process.env.PORT = '3995';
process.env.DB_DIALECT = 'sqlite';

const base = 'http://127.0.0.1:3995';

(async () => {
  require('../server');
  await new Promise(r => setTimeout(r, 1500));

  const bcrypt = require('bcryptjs');
  const models = require('../models');
  const membership = require('../utils/membership');
  const verify = require('../utils/verify');
  const { SECTION_KEYS, managerMay } = require('../middleware/staff');

  const admin = await models.User.create({
    name: 'Admin', email: 'admin@test.org', phone: '0', role: 'admin', status: 'active',
    passwordHash: await bcrypt.hash('admin123', 10)
  });
  await models.FormConfig.findOrCreate({ where: { formKey: 'donation' }, defaults: { fields: [] } });

  /* An active, paid member — the only kind of person a letter can go to. */
  const paid = await models.User.create({
    name: 'Sujata Mohanty', email: 'sujata@test.org', phone: '9439120045',
    role: 'member', status: 'guest', city: 'Chandbali, Bhadrak',
    passwordHash: await bcrypt.hash('secret1', 10)
  });
  await membership.activate({
    user: paid, MembershipPayment: models.MembershipPayment,
    plan: 'annual', mode: 'cash', recordedBy: admin.id
  });
  await paid.reload();

  /* A registration whose fee has NOT arrived. Must not be offered a letter. */
  const unpaid = await models.User.create({
    name: 'Bikash Jena', email: 'bikash@test.org', phone: '9000000006',
    role: 'member', status: 'guest', passwordHash: await bcrypt.hash('secret1', 10)
  });

  /* Two managers: one holding letters, one holding certificates only. */
  const mgrL = await models.User.create({
    name: 'Letters Manager', email: 'mgrl@test.org', phone: '9000000011',
    role: 'member', status: 'active', passwordHash: await bcrypt.hash('secret1', 10)
  });
  await models.ManagerAccess.create({ userId: mgrL.id, sections: ['letters'] });
  const mgrC = await models.User.create({
    name: 'Certs Manager', email: 'mgrc@test.org', phone: '9000000012',
    role: 'member', status: 'active', passwordHash: await bcrypt.hash('secret1', 10)
  });
  await models.ManagerAccess.create({ userId: mgrC.id, sections: ['certificates'] });

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
    await grabToken(who, '/portal/signin');
    return r;
  }

  const results = [];
  const check = (name, ok, detail) => {
    results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : '  -> ' + detail}`);
    if (!ok) process.exitCode = 1;
  };
  const pages = (buf) =>
    (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;

  /* The watermark is checked via the PDF's INFO DICTIONARY, not its page text.
     PDFKit writes text as encoded glyph indices, so the ink saying SPECIMEN is
     genuinely on the page — a pixel diff shows fifteen thousand changed pixels —
     and yet no string search of the file can find it. The first version of this
     check searched the raw bytes and "passed" both ways round: absent from the
     document that had it, absent from the one that did not. Two passes, zero
     information, which is the worst kind of test.
     The generator therefore declares itself in its metadata, and that is what is
     asserted here.

     KEYWORDS specifically, not Title or Subject. Those two contain an em dash,
     which pushes PDFKit into writing them as UTF-16BE inside a literal string —
     so "SPECIMEN" appears in the file as S\0P\0E\0C\0... and a plain search
     misses it. Keywords is kept pure ASCII at the generator end for this
     reason. */
  const hasSpecimen = (buf) => buf.toString('latin1').includes('(SPECIMEN preview)');

  /* ---- the allow table, before any HTTP ------------------------------- */

  check('letters is a grantable section', SECTION_KEYS.includes('letters'));
  check('a letters grant opens the letters routes',
    managerMay(['letters'], 'GET', '/appointments') === true &&
    managerMay(['letters'], 'POST', '/appointments') === true &&
    managerMay(['letters'], 'GET', '/appointments/7.pdf') === true);
  /* The point of a separate grant: certificates must NOT carry it. Somebody
     trusted with training certificates is not thereby trusted with pay. */
  check('a certificates grant does NOT open letters',
    managerMay(['certificates'], 'GET', '/appointments') === false &&
    managerMay(['certificates'], 'POST', '/appointments') === false);
  check('no other single grant opens letters',
    SECTION_KEYS.filter(s => s !== 'letters')
      .every(s => managerMay([s], 'POST', '/appointments') === false));

  /* ---- the page ------------------------------------------------------- */

  await signIn('admin', 'admin@test.org', 'admin123');
  let html = await grabToken('admin', '/portal/admin/appointments');
  check('the appointment letters page renders', html.includes('Appointment letters'));
  check('...offering the active member', html.includes('Sujata Mohanty'));
  check('...but NOT the unpaid registration', !html.includes('Bikash Jena'));
  check('...and warning that the page-2 clauses are unreviewed',
    /not been checked by a lawyer/i.test(html));
  check('the register is empty to begin with', html.includes('No letters issued yet'));

  const FORM = {
    userId: String(paid.id),
    kind: 'staff',
    letterDate: '2026-08-21',
    joiningDate: '2026-09-01',
    designation: 'Programme Coordinator',
    department: 'Community Development',
    reportsTo: 'Programme Manager',
    location: 'Bhadrak, Odisha',
    employmentType: 'Full time',
    probation: 'Six months',
    notice: 'One month',
    grossMonthly: '28000',
    annualCtc: '336000',
    hours: '09:30 to 18:00, Mon-Sat',
    address: 'At/Po - Chandbali, Bhadrak, Odisha - 756133',
    signatoryName: 'Koustav Maity',
    signatoryRole: 'Secretary'
  };

  /* ---- preview: a document, but not a letter -------------------------- */

  let r = await post('/portal/admin/appointments/preview', FORM);
  check('preview returns a PDF', r.status === 200 && r.headers.get('content-type') === 'application/pdf',
    r.status + ' ' + r.headers.get('content-type'));
  const prev = Buffer.from(await r.arrayBuffer());
  check('...of two pages', pages(prev) === 2, 'pages=' + pages(prev));
  check('...watermarked SPECIMEN', hasSpecimen(prev));
  check('...and it saved NOTHING', (await models.AppointmentLetter.count()) === 0,
    String(await models.AppointmentLetter.count()));

  /* ---- issue ---------------------------------------------------------- */

  r = await post('/portal/admin/appointments', FORM);
  const loc = r.headers.get('location') || '';
  check('issuing redirects with the new reference', /\?saved=TKF-AL-\d{4}-/.test(loc), loc);

  const row = await models.AppointmentLetter.findOne({ where: { userId: paid.id } });
  check('a row was written', !!row);
  check('...with a TKF-AL serial', row && /^TKF-AL-\d{4}-[0-9A-F]+$/.test(row.serial), row && row.serial);
  check('...stamped with who issued it', row && row.issuedBy === admin.id);
  check('...snapshotting the terms', row && row.designation === 'Programme Coordinator'
    && row.grossMonthly === 28000 && row.notice === 'One month');
  check('...and the joining date as typed, not shifted a day',
    row && String(row.joiningDate).startsWith('2026-09-01'), row && String(row.joiningDate));

  /* ---- the document --------------------------------------------------- */

  r = await get(`/portal/admin/appointments/${row.id}.pdf`);
  check('the issued PDF is served', r.status === 200 && r.headers.get('content-type') === 'application/pdf',
    r.status + ' ' + r.headers.get('content-type'));
  const issued = Buffer.from(await r.arrayBuffer());
  check('...of two pages', pages(issued) === 2, 'pages=' + pages(issued));
  check('...and NOT watermarked', !hasSpecimen(issued));

  /* Per use, not stored: asking twice must give the same document, because it is
     re-rendered from the row rather than fetched from a file that could rot. */
  const again = Buffer.from(await (await get(`/portal/admin/appointments/${row.id}.pdf`)).arrayBuffer());
  check('re-rendering gives the same letter', again.length === issued.length,
    `${issued.length} vs ${again.length}`);

  /* ---- it verifies ---------------------------------------------------- */

  const res1 = await verify.resolve(models, row.serial);
  check('the verifier recognises TKF-AL', res1.kind === 'appointment', res1.kind);
  check('...as valid', res1.found === true && res1.status === 'valid', res1.status);
  check('...naming the holder', res1.holder === 'Sujata Mohanty', res1.holder);
  check('...and the designation', res1.title === 'Programme Coordinator', res1.title);

  r = await fetch(base + '/verify/' + row.serial, { redirect: 'manual' });
  const vhtml = await r.text();
  check('the PUBLIC page verifies it without a login', r.status === 200 && vhtml.includes('Sujata Mohanty'),
    String(r.status));
  check('...calling it an appointment letter', /appointment letter/i.test(vhtml));
  /* The whole reason resolve() publishes only holder + designation. */
  check('...and NEVER publishing the pay', !vhtml.includes('28000') && !vhtml.includes('28,000'));
  check('...nor the reporting line', !vhtml.includes('Programme Manager'));

  /* ---- withdrawal ----------------------------------------------------- */

  await grabToken('admin', '/portal/admin/appointments');
  r = await post(`/portal/admin/appointments/${row.id}/revoke`, { reason: 'offer retracted' });
  check('withdrawing redirects', [302, 303].includes(r.status), String(r.status));
  const res2 = await verify.resolve(models, row.serial);
  check('a withdrawn letter verifies as withdrawn, not missing',
    res2.found === true && res2.status === 'revoked', res2.status);
  check('the row survives withdrawal', !!(await models.AppointmentLetter.findByPk(row.id)));
  check('and the PDF still prints — the paper copy exists either way',
    (await get(`/portal/admin/appointments/${row.id}.pdf`)).status === 200);

  await grabToken('admin', '/portal/admin/appointments');
  r = await post(`/portal/admin/appointments/${row.id}/restore`, {});
  const res3 = await verify.resolve(models, row.serial);
  check('restoring makes it valid again', res3.status === 'valid', res3.status);

  /* ---- refusals ------------------------------------------------------- */

  await grabToken('admin', '/portal/admin/appointments');
  r = await post('/portal/admin/appointments', { ...FORM, userId: String(unpaid.id) });
  check('a letter cannot be issued to an unpaid registration',
    /error=member/.test(r.headers.get('location') || ''), r.headers.get('location'));
  await grabToken('admin', '/portal/admin/appointments');
  r = await post('/portal/admin/appointments', { ...FORM, designation: '' });
  check('a letter cannot be issued with no designation',
    /error=designation/.test(r.headers.get('location') || ''), r.headers.get('location'));
  check('neither attempt wrote a row', (await models.AppointmentLetter.count()) === 1,
    String(await models.AppointmentLetter.count()));

  const noToken = await fetch(base + '/portal/admin/appointments', {
    method: 'POST', redirect: 'manual',
    headers: { cookie: jar.admin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(FORM).toString()
  });
  check('issuing without a CSRF token is refused', noToken.status === 403, String(noToken.status));

  /* ---- the permission tier, over HTTP --------------------------------- */

  await signIn('mgrl', 'mgrl@test.org', 'secret1');
  check('a letters manager reaches the page',
    (await get('/portal/admin/appointments', 'mgrl')).status === 200);
  /* The nav bar carries SECTION names; page names only appear on the strip for
     the section you are in. So on the dashboard the thing to look for is the
     Documents section and a link into /appointments — not the page's own label,
     which is what the first version of this check wrongly looked for. */
  const mgrDash = await (await get('/portal/admin', 'mgrl')).text();
  check('...and the nav offers them the Documents section',
    mgrDash.includes('>Documents<') && mgrDash.includes('/portal/admin/appointments'));

  await signIn('mgrc', 'mgrc@test.org', 'secret1');
  r = await get('/portal/admin/appointments', 'mgrc');
  check('a certificates-only manager is denied the page',
    [302, 303, 403].includes(r.status), String(r.status));
  check('...and is not shown the link',
    !(await (await get('/portal/admin/certificates', 'mgrc')).text()).includes('Appointment letters'));
  r = await get(`/portal/admin/appointments/${row.id}.pdf`, 'mgrc');
  check('...nor can they pull the PDF', [302, 303, 403].includes(r.status), String(r.status));

  r = await fetch(base + `/portal/admin/appointments/${row.id}.pdf`, { redirect: 'manual' });
  check('a stranger cannot pull the PDF', [302, 303, 403].includes(r.status), String(r.status));

  console.log(results.join('\n'));
  const bad = results.filter(x => x.startsWith('FAIL')).length;
  console.log(`\n${results.length - bad}/${results.length} passed`);
  console.log(bad ? 'FAILURES' : 'ALL PASS');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('LETTER SMOKE CRASH', e); process.exit(1); });
