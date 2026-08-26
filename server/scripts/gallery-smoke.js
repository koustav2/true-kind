/* ==========================================================================
   Gallery smoke test.

   Same shape as board-smoke.js and press-smoke.js: admin CRUD including a
   genuine multipart photograph upload, ordering, the hide/show flag, and the
   public /api/gallery contract — plus the two things that are specific to a
   gallery, where the picture IS the content:

     * an item cannot be added without a photograph;
     * a row that somehow has no photograph never reaches the public list.

   Run: npm run gallery:smoke
   ========================================================================== */
process.env.SESSION_SECRET = 'gallery-smoke';
process.env.APP_BASE_URL = 'http://127.0.0.1:3994';
process.env.PORT = '3994';
process.env.DB_DIALECT = 'sqlite';

const base = 'http://127.0.0.1:3994';

(async () => {
  require('../server');
  await new Promise(r => setTimeout(r, 1500));

  const bcrypt = require('bcryptjs');
  const models = require('../models');
  await models.User.create({
    name: 'Admin', email: 'admin@test.org', phone: '0', role: 'admin', status: 'active',
    passwordHash: await bcrypt.hash('admin123', 10)
  });

  let cookie = '', token = '';
  const keep = res => {
    const setc = res.headers.get('set-cookie');
    if (setc) cookie = setc.split(';')[0];
    return res;
  };
  const get = async p => keep(await fetch(base + p, { headers: { cookie }, redirect: 'manual' }));
  async function grabToken(p) {
    const html = await (await get(p)).text();
    const m = html.match(/name="_csrf" value="([^"]+)"/);
    token = m ? m[1] : '';
    return html;
  }
  async function post(p, fields) {
    return keep(await fetch(base + p, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...fields, _csrf: token }).toString()
    }));
  }
  async function postMultipart(p, fields, file) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    fd.append('_csrf', token);
    if (file) fd.append(file.field, new Blob([file.bytes], { type: file.type }), file.name);
    const sep = p.includes('?') ? '&' : '?';
    return keep(await fetch(base + p + sep + '_csrf=' + encodeURIComponent(token), {
      method: 'POST', redirect: 'manual', headers: { cookie }, body: fd
    }));
  }

  const results = [];
  const check = (name, ok, detail) => {
    results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : '  -> ' + detail}`);
    if (!ok) process.exitCode = 1;
  };

  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );

  /* ---- the page exists and is wired up ---------------------------------- */

  let html = await (await get('/gallery.html')).text();
  // Not the literal tag: cms:build stamps a data-cms attribute onto every
  // heading, so matching '<h1>' would break the moment the registry is rebuilt.
  check('gallery.html is served', /<h1[^>]*>From the field\.<\/h1>/.test(html));
  check('...and carries the grid the script fills', html.includes('class="gallery-grid"'));
  check('...and its placeholder note', html.includes('Photographs from our events will appear here'));
  check('...and the menu links to it from the homepage',
    (await (await get('/index.html')).text()).includes('href="gallery.html"'));

  let api = await (await get('/api/gallery')).json();
  check('/api/gallery is an empty list before anything is added',
    api.ok === true && Array.isArray(api.items) && api.items.length === 0);

  /* ---- sign in ----------------------------------------------------------- */

  await grabToken('/portal/signin');
  await post('/portal/signin', { email: 'admin@test.org', password: 'admin123' });
  html = await grabToken('/portal/admin/gallery');
  check('the Gallery screen renders for an admin', html.includes('Add a photograph'));

  /* ---- a photograph is required ----------------------------------------- */

  let r = await postMultipart('/portal/admin/gallery', { title: 'No picture', visible: 'on' }, null);
  check('adding without a photograph is refused',
    r.status === 302 && String(r.headers.get('location')).includes('error=photo'),
    `${r.status} ${r.headers.get('location')}`);
  check('...and nothing was created', (await models.GalleryItem.count()) === 0);

  await grabToken('/portal/admin/gallery');
  r = await postMultipart('/portal/admin/gallery', { title: '', visible: 'on' },
    { field: 'photo', name: 'a.png', type: 'image/png', bytes: PNG });
  check('adding without a title is refused',
    r.status === 302 && String(r.headers.get('location')).includes('error=title'));

  /* ---- add two, ordered -------------------------------------------------- */

  await grabToken('/portal/admin/gallery');
  await postMultipart('/portal/admin/gallery',
    { title: 'Health camp at Gelpur', sortOrder: '20', visible: 'on' },
    { field: 'photo', name: 'camp.png', type: 'image/png', bytes: PNG });

  await grabToken('/portal/admin/gallery');
  await postMultipart('/portal/admin/gallery',
    { title: 'Plantation drive', sortOrder: '10', visible: 'on' },
    { field: 'photo', name: 'trees.png', type: 'image/png', bytes: PNG });

  check('both items were created', (await models.GalleryItem.count()) === 2);

  api = await (await get('/api/gallery')).json();
  check('/api/gallery lists them lowest order first',
    api.items.length === 2 && api.items[0].title === 'Plantation drive'
      && api.items[1].title === 'Health camp at Gelpur',
    JSON.stringify(api.items.map(i => i.title)));
  check('...and each carries a photograph', api.items.every(i => /^\/uploads\//.test(i.photo)));
  check('...and nothing else — no ids, no on-disk filenames',
    api.items.every(i => Object.keys(i).sort().join(',') === 'photo,title'),
    JSON.stringify(Object.keys(api.items[0])));

  /* ---- hide one ---------------------------------------------------------- */

  const first = await models.GalleryItem.findOne({ where: { title: 'Plantation drive' } });
  await grabToken('/portal/admin/gallery');
  await postMultipart(`/portal/admin/gallery/${first.id}`,
    { title: 'Plantation drive', sortOrder: '10' }, null);   // visible unchecked
  api = await (await get('/api/gallery')).json();
  check('unticking "Show on the website" takes it off the public list',
    api.items.length === 1 && api.items[0].title === 'Health camp at Gelpur');
  check('...but the row is still there', (await models.GalleryItem.count()) === 2);

  /* ---- a row with no photograph never reaches the page ------------------- */

  await models.GalleryItem.create({ title: 'Broken row', visible: true, sortOrder: 1 });
  api = await (await get('/api/gallery')).json();
  check('a row with no photograph is left out of the public list',
    !api.items.some(i => i.title === 'Broken row'), JSON.stringify(api.items.map(i => i.title)));

  /* ---- rename, then delete ---------------------------------------------- */

  const second = await models.GalleryItem.findOne({ where: { title: 'Health camp at Gelpur' } });
  await grabToken('/portal/admin/gallery');
  await postMultipart(`/portal/admin/gallery/${second.id}`,
    { title: 'Health camp, March 2026', sortOrder: '20', visible: 'on' }, null);
  api = await (await get('/api/gallery')).json();
  check('renaming an item shows through to the page',
    api.items.some(i => i.title === 'Health camp, March 2026'));

  await grabToken('/portal/admin/gallery');
  await post(`/portal/admin/gallery/${second.id}/delete`, {});
  api = await (await get('/api/gallery')).json();
  check('deleting removes it from the public list', !api.items.some(i => /Health camp/.test(i.title)));

  /* ---- an ordinary member cannot reach any of it ------------------------- */

  cookie = '';
  r = await get('/portal/admin/gallery');
  check('signed out, the Gallery screen redirects to sign-in',
    r.status === 302 && String(r.headers.get('location')).includes('/portal/signin'),
    `${r.status} ${r.headers.get('location')}`);

  for (const line of results) console.log(line);
  const pass = results.filter(l => l.startsWith('PASS')).length;
  console.log(`\n${pass}/${results.length} passed`);
  console.log(pass === results.length ? 'ALL PASS' : 'FAILURES ABOVE');
  process.exit(process.exitCode || 0);
})().catch(e => { console.error('GALLERY SMOKE CRASH', e); process.exit(1); });
