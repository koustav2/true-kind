/* ==========================================================================
   Verification + ID card smoke test.      Run with:  npm run verify:smoke

   The QR codes used to encode a bare serial that resolved to nothing. This
   proves the whole loop now closes:

     serial -> signed URL -> public page -> valid / expired / withdrawn / unknown

   and that the printed card carries that URL rather than a string.

   Also covers the things that make it a verification system rather than a
   lookup: revocation survives (a withdrawn certificate says "withdrawn", it
   does not vanish), every scan is logged, the log stores no addresses, the
   page leaks nothing that is not already printed on the document, and the
   signature is reported without ever being allowed to decide the verdict.
   ========================================================================== */
process.env.SESSION_SECRET = 'verify-smoke';
process.env.APP_BASE_URL = 'http://127.0.0.1:3994';
process.env.PORT = '3994';
process.env.DB_DIALECT = 'sqlite';

const base = 'http://127.0.0.1:3994';

(async () => {
  require('../server');
  await new Promise(r => setTimeout(r, 1500));

  const bcrypt = require('bcryptjs');
  const models = require('../models');
  const membership = require('../utils/membership');
  const verify = require('../utils/verify');

  const admin = await models.User.create({
    name: 'Admin', email: 'admin@test.org', phone: '0', role: 'admin', status: 'active',
    passwordHash: await bcrypt.hash('admin123', 10)
  });
  await models.FormConfig.findOrCreate({ where: { formKey: 'donation' }, defaults: { fields: [] } });
  const certType = await models.Certificate.create({ title: 'Volunteer of the Year' });

  /* A current member. */
  const live = await models.User.create({
    name: 'Rahul Kumar', email: 'rk@test.org', phone: '9876543210',
    role: 'member', status: 'guest', passwordHash: 'x'
  });
  const livePay = await membership.activate({
    user: live, MembershipPayment: models.MembershipPayment,
    plan: 'annual', mode: 'cash', recordedBy: admin.id
  });
  await live.reload();

  /* A member whose cover has run out — set directly, since the point is the
     expired state and not how it got there. */
  const lapsed = await models.User.create({
    name: 'Lapsed Person', email: 'lp@test.org', phone: '9000000002',
    role: 'member', status: 'active', passwordHash: 'x',
    memberId: 'TKF-M-2020-AAAAAA', membershipPlan: 'annual',
    membershipPaidAt: new Date('2020-01-01'), membershipValidTill: new Date('2021-01-01')
  });

  const issue = await models.CertificateIssue.create({
    certificateId: certType.id, userId: live.id, serial: 'TKF-C-2026-CCCCCC'
  });

  let ck = '', tok = '';
  const keep = r => { const s = r.headers.get('set-cookie'); if (s) ck = s.split(';')[0]; return r; };
  const get = async (p, headers = {}) =>
    keep(await fetch(base + p, { headers: { cookie: ck, ...headers }, redirect: 'manual' }));
  const post = async (p, fields) => keep(await fetch(base + p, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: ck, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...fields, _csrf: tok }).toString()
  }));
  async function grabToken(p) {
    const html = await (await get(p)).text();
    const m = html.match(/name="_csrf" value="([^"]+)"/);
    tok = m ? m[1] : '';
    return html;
  }

  const results = [];
  const check = (name, ok, detail) => {
    results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : '  -> ' + detail}`);
    if (!ok) process.exitCode = 1;
  };

  /* ---- the URL itself -------------------------------------------------- */

  const url = verify.verifyUrl(live.memberId);
  check('a code becomes an absolute https/http verification URL',
    url.startsWith(base + '/verify/' + live.memberId + '?k='), url);
  check('the signature is a fixed-length opaque tag',
    verify.tag(live.memberId).length === 10 && /^[A-Za-z0-9]+$/.test(verify.tag(live.memberId)));
  check('the same code always signs the same', verify.tag('TKF-M-1') === verify.tag('TKF-M-1'));
  check('a different code signs differently', verify.tag('TKF-M-1') !== verify.tag('TKF-M-2'));
  check('signature check reports ok / missing / mismatch',
    verify.checkTag(live.memberId, verify.tag(live.memberId)) === 'ok' &&
    verify.checkTag(live.memberId, null) === 'missing' &&
    verify.checkTag(live.memberId, 'AAAAAAAAAA') === 'mismatch');
  check('prefixes map to the right document kinds',
    verify.kindOf('TKF-M-2026-A').kind === 'member' &&
    verify.kindOf('TKF-MR-2026-A').kind === 'membership' &&   // longest prefix wins
    verify.kindOf('TKF-C-2026-A').kind === 'certificate' &&
    verify.kindOf('TKF-R-2026-A').kind === 'receipt' &&
    verify.kindOf('HELLO') === null);
  check('codes normalise case and stray spaces',
    verify.normalise('  tkf-m-2026-abcdef ') === 'TKF-M-2026-ABCDEF');

  /* ---- the public page ------------------------------------------------- */

  let r = await get('/verify');
  let html = await r.text();
  check('the verify form is public and needs no login', r.status === 200 && html.includes('Serial number'));
  check('the page asks robots not to index it', /noindex/.test(html));

  r = await get('/verify?code=' + live.memberId.toLowerCase());
  check('a typed serial redirects to its canonical URL',
    [301, 302, 303].includes(r.status) && (r.headers.get('location') || '').includes(live.memberId),
    r.status + ' ' + r.headers.get('location'));

  r = await get('/verify?code=NOT-OURS-123');
  html = await r.text();
  check('an unrecognised prefix is refused without a lookup',
    r.status === 404 && html.includes('does not look like one of ours'));

  /* Valid member card. */
  r = await get(`/verify/${live.memberId}?k=${verify.tag(live.memberId)}`);
  html = await r.text();
  check('a current membership card verifies as valid', r.status === 200 && html.includes('>Valid<'));
  check('...naming the holder', html.includes('Rahul Kumar'));
  check('...and the card type', html.includes('Membership card'));
  check('...with no-store, so a withdrawal takes effect at once',
    /no-store/.test(r.headers.get('cache-control') || ''), r.headers.get('cache-control'));
  /* Privacy: only what is already printed on the card. */
  check('the page does NOT leak the email address', !html.includes('rk@test.org'));
  check('the page does not leak the internal user id',
    !new RegExp(`user[^a-z]{0,3}id[^0-9]{0,4}${live.id}\\b`, 'i').test(html));

  /* Expired. */
  r = await get(`/verify/${lapsed.memberId}`);
  html = await r.text();
  check('an out-of-date card verifies as genuine but expired',
    r.status === 200 && html.includes('expired') && html.includes('Lapsed Person'));

  /* Not found — a well-formed code that was never issued. */
  r = await get('/verify/TKF-M-2026-ZZZZZZ');
  html = await r.text();
  check('a well-formed but unissued serial is Not recognised',
    r.status === 404 && html.includes('Not recognised'));

  /* Certificate. */
  r = await get(`/verify/${issue.serial}`);
  html = await r.text();
  check('a certificate serial verifies', r.status === 200 && html.includes('>Valid<'));
  check('...showing its title', html.includes('Volunteer of the Year'));

  /* Membership fee receipt. */
  r = await get(`/verify/${livePay.receiptNo}`);
  html = await r.text();
  check('a membership receipt verifies', r.status === 200 && html.includes('>Valid<'));
  check('...and shows the amount, which is the point of checking a receipt',
    html.includes('₹1,000'));

  /* Signature is reported, NEVER a gate. This is the important one: a valid
     document with a broken link must still verify. */
  r = await get(`/verify/${live.memberId}?k=WRONGWRONG`);
  html = await r.text();
  check('a valid code with a BAD signature still verifies as valid',
    r.status === 200 && html.includes('>Valid<'));
  check('...but the mismatch is surfaced for a human to check',
    html.includes("security code did not match"));

  /* ---- the JSON API --------------------------------------------------- */

  r = await get(`/api/verify/${live.memberId}?k=${verify.tag(live.memberId)}`);
  let json = await r.json();
  check('the JSON API resolves a card', r.status === 200 && json.ok && json.status === 'valid');
  check('...reports the signature state', json.signature === 'ok');
  check('...and exposes no contact details',
    !JSON.stringify(json).includes('rk@test.org') && !JSON.stringify(json).includes('9876543210'));
  r = await get('/api/verify/TKF-C-2026-NOPEEE');
  check('the JSON API 404s an unknown serial', r.status === 404);

  /* ---- scan log ------------------------------------------------------- */

  await new Promise(res => setTimeout(res, 250));   // logging is fire-and-forget
  const scans = await models.VerificationScan.findAll();
  check('every lookup is logged', scans.length >= 8, String(scans.length));
  check('the log records the answer given',
    scans.some(s => s.result === 'valid') && scans.some(s => s.result === 'not_found'));
  check('the log records the signature state',
    scans.some(s => s.signature === 'ok') && scans.some(s => s.signature === 'mismatch'));
  check('the log stores a hash, never an address',
    scans.every(s => !s.ipHash || (/^[0-9a-f]{32}$/.test(s.ipHash) && !s.ipHash.includes('.'))));

  /* ---- revocation ----------------------------------------------------- */

  await grabToken('/portal/signin');
  r = await post('/portal/signin', { email: 'admin@test.org', password: 'admin123' });
  check('admin signs in', [302, 303].includes(r.status));

  await grabToken(`/portal/admin/members/${live.id}`);
  r = await post(`/portal/admin/members/${live.id}/certificate/${issue.id}/revoke`, { reason: 'Awarded in error' });
  check('a certificate can be withdrawn', [302, 303].includes(r.status));
  check('...and the issue row SURVIVES rather than being deleted',
    !!(await models.CertificateIssue.findByPk(issue.id)));

  r = await get(`/verify/${issue.serial}`);
  html = await r.text();
  check('the withdrawn certificate verifies as Withdrawn, not "not found"',
    r.status === 200 && html.includes('Withdrawn') && !html.includes('Not recognised'));
  check('...giving the reason', html.includes('Awarded in error'));

  await grabToken(`/portal/admin/members/${live.id}`);
  r = await post(`/portal/admin/members/${live.id}/certificate/${issue.id}/restore`, {});
  check('a withdrawal can be undone', [302, 303].includes(r.status));
  html = await (await get(`/verify/${issue.serial}`)).text();
  check('...and the serial is valid again', html.includes('>Valid<'));

  /* A lost card. */
  await grabToken(`/portal/admin/members/${live.id}`);
  r = await post(`/portal/admin/members/${live.id}/card/revoke`, { reason: 'Reported lost' });
  check('a membership card can be reported lost', [302, 303].includes(r.status));
  html = await (await get(`/verify/${live.memberId}`)).text();
  check('...and a scan of it says Withdrawn', html.includes('Withdrawn') && html.includes('Reported lost'));
  await live.reload();
  check('...without touching their membership', live.status === 'active' && live.membershipValid === true);

  await grabToken(`/portal/admin/members/${live.id}`);
  await post(`/portal/admin/members/${live.id}/card/restore`, {});
  html = await (await get(`/verify/${live.memberId}`)).text();
  check('a replacement card restores the code', html.includes('>Valid<'));

  /* ---- ID card -------------------------------------------------------- */

  await grabToken(`/portal/admin/members/${live.id}`);
  r = await post(`/portal/admin/members/${live.id}/idcard`, {
    cardType: 'staff', employeeCode: 'TKF2026-0157',
    designation: 'Programme Coordinator', department: 'Community Development',
    bloodGroup: 'O+', joinedOn: '2025-05-12', validUntil: '2028-05-11'
  });
  check('ID card details save', [302, 303].includes(r.status) &&
    /saved=card/.test(r.headers.get('location') || ''), r.headers.get('location'));

  const profile = await models.IdCardProfile.findOne({ where: { userId: live.id } });
  check('the card profile is stored', !!profile && profile.designation === 'Programme Coordinator');
  check('...with the issue date defaulted to today', !!profile.issuedOn);

  await grabToken(`/portal/admin/members/${live.id}`);
  r = await post(`/portal/admin/members/${live.id}/idcard`, {
    cardType: 'staff', bloodGroup: 'Type O maybe', designation: 'Programme Coordinator'
  });
  await profile.reload();
  check('a made-up blood group is refused rather than printed on the card',
    profile.bloodGroup === null, String(profile.bloodGroup));

  r = await get(`/portal/admin/members/${live.id}/idcard.pdf`);
  const pdf = Buffer.from(await r.arrayBuffer());
  check('the ID card PDF is served',
    r.status === 200 && r.headers.get('content-type') === 'application/pdf', String(r.status));
  check('...as a real PDF', pdf.slice(0, 5).toString() === '%PDF-');
  check('...with two pages, front and back',
    (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length === 2,
    String((pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length));
  check('...at true CR80 card size',
    /\/MediaBox\s*\[0 0 153\.07 242\.65\]/.test(pdf.toString('latin1')));

  /* Somebody with no ID number at all cannot produce a card whose QR would
     resolve to "not recognised". */
  const nobody = await models.User.create({
    name: 'No Id', email: 'ni@test.org', phone: '9000000003',
    role: 'member', status: 'guest', passwordHash: 'x'
  });
  r = await get(`/portal/admin/members/${nobody.id}/idcard.pdf`);
  check('a card is refused when there is no code for the QR to verify',
    r.status === 400, String(r.status));

  /* ---- admin log page ------------------------------------------------- */

  html = await (await get('/portal/admin/verification-log')).text();
  check('the verification log page renders', html.includes('Verification log'));
  check('...counting the answers given', /valid<\/span>/.test(html));
  check('...and listing withdrawals when there are any', html.includes('Withdrawn documents'));
  check('the log is in the admin nav', html.includes('/portal/admin/verification-log'));

  r = await fetch(base + '/portal/admin/verification-log', { redirect: 'manual' });
  check('the log is not public', [302, 303, 403].includes(r.status), String(r.status));

  /* ---- rate limit ----------------------------------------------------- */

  let limited = false;
  for (let i = 0; i < 40; i++) {
    const rr = await fetch(base + '/verify/TKF-M-2026-' + String(i).padStart(6, '0'));
    if (rr.status === 429) { limited = true; break; }
  }
  check('guessing serials in bulk gets rate limited', limited);

  console.log('\n' + results.join('\n'));
  console.log(process.exitCode ? '\nFAILURES' : '\nALL PASS');
  process.exit(process.exitCode || 0);
})().catch(e => { console.error(e); process.exit(1); });
