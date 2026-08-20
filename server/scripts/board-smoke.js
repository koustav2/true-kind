/* ==========================================================================
   Board + donation-page smoke test.

   Covers the two things added last, end to end against a real running server on
   sqlite :memory: —

     Board:   admin CRUD including a genuine multipart photograph upload, the
              handle-to-URL expansion, the javascript: rejection, the hide/show
              flag, ordering, and the public /api/board contract.
     Donate:  the rebuilt /portal/donate page renders its programme cards and
              amount cards, has NO add-on band, and still submits — plus the new
              server-side guest validation.

   Run: npm run board:smoke
   ========================================================================== */
process.env.SESSION_SECRET = 'board-smoke';
process.env.APP_BASE_URL = 'http://127.0.0.1:3997';
process.env.PORT = '3997';
process.env.DB_DIALECT = 'sqlite';

const base = 'http://127.0.0.1:3997';

(async () => {
  require('../server');
  await new Promise(r => setTimeout(r, 1500));

  const bcrypt = require('bcryptjs');
  const models = require('../models');
  await models.User.create({
    name: 'Admin', email: 'admin@test.org', phone: '0', role: 'admin', status: 'active',
    passwordHash: await bcrypt.hash('admin123', 10)
  });
  await models.FormConfig.findOrCreate({ where: { formKey: 'donation' }, defaults: { fields: [] } });

  let cookie = '';
  let token = '';

  function keep(res) {
    const setc = res.headers.get('set-cookie');
    if (setc) cookie = setc.split(';')[0];
    return res;
  }

  async function get(path) {
    return keep(await fetch(base + path, { headers: { cookie }, redirect: 'manual' }));
  }

  /* The CSRF token is the session's own secret, so one scrape serves the whole
     run. The GET also establishes the session the POSTs will carry. */
  async function grabToken(path) {
    const html = await (await get(path)).text();
    const m = html.match(/name="_csrf" value="([^"]+)"/);
    token = m ? m[1] : '';
    return html;
  }

  async function post(path, fields) {
    return keep(await fetch(base + path, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...fields, _csrf: token }).toString()
    }));
  }

  /* Real multipart, because that is the path the CSRF guard has to survive: it
     runs before multer, so the token is read off the query string. Posting a
     hand-built urlencoded body here would test nothing. */
  async function postMultipart(path, fields, file) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    fd.append('_csrf', token);
    if (file) fd.append(file.field, new Blob([file.bytes], { type: file.type }), file.name);
    const sep = path.includes('?') ? '&' : '?';
    return keep(await fetch(base + path + sep + '_csrf=' + encodeURIComponent(token), {
      method: 'POST', redirect: 'manual', headers: { cookie }, body: fd
    }));
  }

  const results = [];
  const check = (name, ok, detail) => {
    results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : '  -> ' + detail}`);
    if (!ok) process.exitCode = 1;
  };

  /* The smallest valid PNG: 1x1, transparent. Enough for multer's extension and
     mimetype allowlist to accept it as a real image. */
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );

  /* ---- donation page (public) ------------------------------------------ */

  let html = await grabToken('/portal/donate');
  check('donate page renders', html.includes('Choose a programme'));
  /* Count the radios specifically — a bare /name="category"/ also matches the
     querySelector string in the page's own script. */
  check('donate page shows all 6 programme cards',
    (html.match(/type="radio" name="category"/g) || []).length === 6,
    String((html.match(/type="radio" name="category"/g) || []).length));
  check('donate page shows the 5 amount cards',
    (html.match(/class="amt-card"/g) || []).length === 5);
  check('amount cards carry their impact line', html.includes('One full community health camp'));
  check('registration numbers in the hero', html.includes('40232603192') && html.includes('OR/2026/1126881'));
  check('running summary present', html.includes('data-sum="amount"'));
  check('no monthly/one-time toggle', !/name="frequency"/i.test(html));
  /* The client asked for the Akshaya Patra layout WITHOUT their optional add-on
     band. This is the assertion that keeps it out if the page is ever rebuilt. */
  check('no pre-ticked add-on band',
    !/name="addon"/i.test(html) && !/checkbox"[^>]*checked/i.test(html));
  check('receipt promise does not claim an email is sent', !/receipt[^.]{0,40}email/i.test(html));

  /* Preset arriving from a donate.html cost tier. */
  html = await (await get('/portal/donate?amount=6000&category=Health%20%26%20Safety')).text();
  check('?amount= prefills the box', /id="amount"[^>]*value="6000"/.test(html));
  check('?category= preselects the card',
    /value="Health &amp; Safety" checked/.test(html) || /value="Health & Safety" checked/.test(html));

  /* Server-side validation of a guest donation. */
  let r = await post('/portal/pay/donation', { category: 'Environment', amount: '500', name: '', email: '', phone: '' });
  check('guest donation without details is rejected',
    [302, 303].includes(r.status) && /\/portal\/donate\?error=invalid/.test(r.headers.get('location') || ''),
    r.status + ' ' + r.headers.get('location'));

  r = await post('/portal/pay/donation', { category: 'Environment', amount: '500', name: 'A Donor', email: 'not-an-email', phone: '9999999999' });
  check('guest donation with a bad email is rejected',
    /error=invalid/.test(r.headers.get('location') || ''));

  r = await post('/portal/pay/donation', { category: 'Environment', amount: '0', name: 'A Donor', email: 'a@b.co', phone: '9999999999' });
  check('zero amount is rejected', /error=invalid/.test(r.headers.get('location') || ''));

  r = await post('/portal/pay/donation', { category: '<script>x</script>', amount: '500', name: 'A Donor', email: 'a@b.co', phone: '9999999999' });
  check('unknown category falls back instead of being stored',
    /\/portal\/pay\/mock\?txnId=/.test(r.headers.get('location') || ''));
  const stored = await models.Donation.findOne({ order: [['id', 'DESC']] });
  check('stored category is one of ours', stored && stored.category === 'Where it is needed most',
    stored && stored.category);

  r = await post('/portal/pay/donation', { category: 'Environment', amount: '500', name: 'A Donor', email: 'a@b.co', phone: '9999999999' });
  check('a complete guest donation reaches the gateway',
    /\/portal\/pay\/mock\?txnId=/.test(r.headers.get('location') || ''));

  /* ---- board: empty state --------------------------------------------- */

  let api = await (await get('/api/board')).json();
  check('/api/board is an empty list before anything is added',
    api.ok === true && Array.isArray(api.members) && api.members.length === 0);

  /* ---- board: admin CRUD ---------------------------------------------- */

  await grabToken('/portal/signin');
  r = await post('/portal/signin', { email: 'admin@test.org', password: 'admin123' });
  check('admin signs in', [302, 303].includes(r.status));
  await grabToken('/portal/admin/board');

  html = await (await get('/portal/admin/board')).text();
  check('board admin page renders', html.includes('Add a board member'));
  check('board link is in the admin nav', html.includes('href="/portal/admin/board"'));
  check('multipart form carries the token in its action',
    /action="\/portal\/admin\/board\?_csrf=[^"]+"/.test(html));

  /* A name is the only required field. */
  r = await postMultipart('/portal/admin/board', { name: '', designation: 'Nobody' });
  check('a board member with no name is refused', /error=name/.test(r.headers.get('location') || ''));

  r = await postMultipart('/portal/admin/board', {
    name: 'Asha Mohanty', designation: 'Chairperson', email: 'asha@truekindfoundation.org',
    bio: 'Chairs the board and represents the Foundation publicly.',
    facebook: 'ashamohanty',
    linkedin: 'https://www.linkedin.com/in/asha-mohanty/',
    twitter: '@asham',
    instagram: 'javascript:alert(1)',
    visible: 'on'
  }, { field: 'photo', name: 'asha.png', type: 'image/png', bytes: PNG });
  check('board member created with a photograph', [302, 303].includes(r.status), String(r.status));

  let row = await models.BoardMember.findOne({ where: { name: 'Asha Mohanty' } });
  check('photograph stored under /uploads', !!row && /^\/uploads\/.+\.png$/.test(row.photoUrl || ''), row && row.photoUrl);
  check('a bare handle becomes a full Facebook URL',
    row && row.facebook === 'https://www.facebook.com/ashamohanty', row && row.facebook);
  check('a full LinkedIn URL is kept as given',
    row && row.linkedin === 'https://www.linkedin.com/in/asha-mohanty/', row && row.linkedin);
  check('an @handle loses the @ and becomes an X URL',
    row && row.twitter === 'https://x.com/asham', row && row.twitter);
  check('a javascript: URL is dropped, not stored', row && !row.instagram, row && row.instagram);
  check('first member is ordered at 10', row && row.sortOrder === 10, row && String(row.sortOrder));

  /* A second person, hidden, ordered first. */
  r = await postMultipart('/portal/admin/board', {
    name: 'Rakesh Behera', designation: 'Treasurer', email: 'rakesh@truekindfoundation.org',
    sortOrder: '5'
    // no `visible` — an unticked checkbox sends nothing, which must mean hidden
  });
  check('second member created', [302, 303].includes(r.status));
  const hidden = await models.BoardMember.findOne({ where: { name: 'Rakesh Behera' } });
  check('an unticked "show on the website" stores visible=false', hidden && hidden.visible === false);

  api = await (await get('/api/board')).json();
  check('the public API hides the hidden member', api.members.length === 1, JSON.stringify(api.members.map(m => m.name)));
  check('the public API exposes no internal ids',
    api.members.every(m => m.id === undefined && m.photoFile === undefined && m.visible === undefined));
  check('the public API shape is what main.js reads',
    api.members[0].name === 'Asha Mohanty' &&
    api.members[0].designation === 'Chairperson' &&
    typeof api.members[0].photo === 'string' &&
    api.members[0].social.facebook === 'https://www.facebook.com/ashamohanty');

  /* Make the hidden one visible and confirm the ordering. */
  r = await postMultipart(`/portal/admin/board/${hidden.id}`, {
    name: 'Rakesh Behera', designation: 'Treasurer', email: 'rakesh@truekindfoundation.org',
    sortOrder: '5', visible: 'on'
  });
  check('member updated', [302, 303].includes(r.status));
  api = await (await get('/api/board')).json();
  check('both members now listed', api.members.length === 2);
  check('sortOrder decides the order',
    api.members[0].name === 'Rakesh Behera' && api.members[1].name === 'Asha Mohanty',
    api.members.map(m => m.name).join(' | '));

  /* Replacing a photograph must not leave the old file behind. */
  const fs = require('fs');
  const pathmod = require('path');
  const { UPLOAD_DIR } = require('../utils/media');
  const oldFile = (await models.BoardMember.findByPk(row.id)).photoFile;
  r = await postMultipart(`/portal/admin/board/${row.id}`, {
    name: 'Asha Mohanty', designation: 'Chairperson', visible: 'on', sortOrder: '10'
  }, { field: 'photo', name: 'asha2.png', type: 'image/png', bytes: PNG });
  const after = await models.BoardMember.findByPk(row.id);
  check('replacing the photograph swaps the file', after.photoFile && after.photoFile !== oldFile);
  await new Promise(res => setTimeout(res, 250));   // the unlink is best-effort/async
  check('the replaced file is removed from disk', !fs.existsSync(pathmod.join(UPLOAD_DIR, oldFile)));

  /* Removing the photograph without uploading a new one. */
  r = await postMultipart(`/portal/admin/board/${row.id}`, {
    name: 'Asha Mohanty', designation: 'Chairperson', visible: 'on', sortOrder: '10',
    removePhoto: 'on'
  });
  const bare = await models.BoardMember.findByPk(row.id);
  check('photograph can be removed', !bare.photoUrl && !bare.photoFile);

  /* Delete. */
  await grabToken('/portal/admin/board');
  r = await post(`/portal/admin/board/${hidden.id}/delete`, {});
  check('member deleted', [302, 303].includes(r.status));
  check('row is gone', !(await models.BoardMember.findByPk(hidden.id)));

  /* A CSRF-less POST must still be refused. */
  const noToken = await fetch(base + '/portal/admin/board', {
    method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=Intruder'
  });
  check('a board POST without a CSRF token is refused', noToken.status === 403, String(noToken.status));
  check('no row was created by it', !(await models.BoardMember.findOne({ where: { name: 'Intruder' } })));

  /* ---- about.html fallback -------------------------------------------- */

  html = await (await get('/about.html')).text();
  check('about.html still ships four fallback board cards',
    (html.match(/class="board-card"/g) || []).length === 4);
  check('about.html no longer carries dead board photo slots',
    !html.includes('about.photo.board'));
  check('about.html has the new photograph slot', html.includes('data-cms-image="about.photo.story"'));
  check('about.html has the three editable icon slots',
    html.includes('data-cms-image="about.icon.mission"') &&
    html.includes('data-cms-image="about.icon.vision"') &&
    html.includes('data-cms-image="about.icon.trust"'));
  check('the About caption starts hidden', /data-cms-figcaption="about\.story" hidden/.test(html));

  console.log('\n' + results.join('\n'));
  console.log(process.exitCode ? '\nFAILURES' : '\nALL PASS');
  process.exit(process.exitCode || 0);
})().catch(e => { console.error(e); process.exit(1); });
