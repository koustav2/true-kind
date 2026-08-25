/* ==========================================================================
   Press & media smoke test.

   Same shape as board-smoke.js: admin CRUD including a genuine multipart
   photograph upload, ordering, the hide/show flag, and the public /api/press
   contract — plus the Get Involved hero photo slot added alongside it.

   Run: npm run press:smoke
   ========================================================================== */
process.env.SESSION_SECRET = 'press-smoke';
process.env.APP_BASE_URL = 'http://127.0.0.1:3998';
process.env.PORT = '3998';
process.env.DB_DIALECT = 'sqlite';

const base = 'http://127.0.0.1:3998';

(async () => {
  require('../server');
  await new Promise(r => setTimeout(r, 1500));

  const bcrypt = require('bcryptjs');
  const models = require('../models');
  await models.User.create({
    name: 'Admin', email: 'admin@test.org', phone: '0', role: 'admin', status: 'active',
    passwordHash: await bcrypt.hash('admin123', 10)
  });

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

  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );

  /* ---- Get Involved hero photo slot (registry) ------------------------- */

  let html = await (await get('/volunteer.html')).text();
  check('volunteer.html carries the new hero photo slot',
    html.includes('data-cms-image="volunteer.photo.hero"'));

  /* ---- press: empty state ------------------------------------------------ */

  let api = await (await get('/api/press')).json();
  check('/api/press is an empty list before anything is added',
    api.ok === true && Array.isArray(api.items) && api.items.length === 0);

  html = await (await get('/press-release.html')).text();
  check('press-release.html keeps its placeholder note when the list is empty',
    html.includes('Coverage and releases will be listed here'));

  /* ---- press: admin CRUD ------------------------------------------------- */

  await grabToken('/portal/signin');
  let r = await post('/portal/signin', { email: 'admin@test.org', password: 'admin123' });
  check('admin signs in', [302, 303].includes(r.status));
  await grabToken('/portal/admin/press');

  html = await (await get('/portal/admin/press')).text();
  check('press admin page renders', html.includes('Add a press item'));
  check('press link is in the admin nav', html.includes('href="/portal/admin/press"'));
  check('multipart form carries the token in its action',
    /action="\/portal\/admin\/press\?_csrf=[^"]+"/.test(html));

  r = await postMultipart('/portal/admin/press', { title: '', source: 'Nobody' });
  check('a press item with no title is refused', /error=title/.test(r.headers.get('location') || ''));

  r = await postMultipart('/portal/admin/press', {
    title: 'Foundation opens new skilling centre', source: 'The Daily Herald',
    url: 'thedailyherald.example/coverage', date: '2026-01-15',
    excerpt: 'Coverage of the new skilling centre launch.',
    visible: 'on'
  }, { field: 'photo', name: 'clip.png', type: 'image/png', bytes: PNG });
  check('press item created with a photograph', [302, 303].includes(r.status), String(r.status));

  let row = await models.PressItem.findOne({ where: { title: 'Foundation opens new skilling centre' } });
  check('photograph stored under /uploads', !!row && /^\/uploads\/.+\.png$/.test(row.photoUrl || ''), row && row.photoUrl);
  check('a bare domain becomes a full https:// URL',
    row && row.url === 'https://thedailyherald.example/coverage', row && row.url);
  check('first item is ordered at 10', row && row.sortOrder === 10, row && String(row.sortOrder));

  r = await postMultipart('/portal/admin/press', {
    title: 'Older mention', source: 'Local Paper', sortOrder: '5', url: 'javascript:alert(1)'
    // no `visible` — hidden
  });
  check('second item created', [302, 303].includes(r.status));
  const hidden = await models.PressItem.findOne({ where: { title: 'Older mention' } });
  check('an unticked "show on the website" stores visible=false', hidden && hidden.visible === false);
  check('a javascript: URL is dropped, not stored', hidden && !hidden.url, hidden && hidden.url);

  api = await (await get('/api/press')).json();
  check('the public API hides the hidden item', api.items.length === 1, JSON.stringify(api.items.map(m => m.title)));
  check('the public API exposes no internal ids',
    api.items.every(m => m.id === undefined && m.photoFile === undefined && m.visible === undefined));
  check('the public API shape is what main.js reads',
    api.items[0].title === 'Foundation opens new skilling centre' &&
    api.items[0].source === 'The Daily Herald' &&
    typeof api.items[0].photo === 'string');

  r = await postMultipart(`/portal/admin/press/${hidden.id}`, {
    title: 'Older mention', source: 'Local Paper', sortOrder: '5', visible: 'on'
  });
  check('item updated', [302, 303].includes(r.status));
  api = await (await get('/api/press')).json();
  check('both items now listed', api.items.length === 2);
  check('sortOrder decides the order',
    api.items[0].title === 'Older mention' && api.items[1].title === 'Foundation opens new skilling centre',
    api.items.map(m => m.title).join(' | '));

  /* Replacing a photograph must not leave the old file behind. */
  const fs = require('fs');
  const pathmod = require('path');
  const { UPLOAD_DIR } = require('../utils/media');
  const oldFile = (await models.PressItem.findByPk(row.id)).photoFile;
  r = await postMultipart(`/portal/admin/press/${row.id}`, {
    title: 'Foundation opens new skilling centre', visible: 'on', sortOrder: '10'
  }, { field: 'photo', name: 'clip2.png', type: 'image/png', bytes: PNG });
  const after = await models.PressItem.findByPk(row.id);
  check('replacing the photograph swaps the file', after.photoFile && after.photoFile !== oldFile);
  await new Promise(res => setTimeout(res, 250));
  check('the replaced file is removed from disk', !fs.existsSync(pathmod.join(UPLOAD_DIR, oldFile)));

  /* Removing the photograph without uploading a new one. */
  r = await postMultipart(`/portal/admin/press/${row.id}`, {
    title: 'Foundation opens new skilling centre', visible: 'on', sortOrder: '10',
    removePhoto: 'on'
  });
  const bare = await models.PressItem.findByPk(row.id);
  check('photograph can be removed', !bare.photoUrl && !bare.photoFile);

  /* Delete. */
  await grabToken('/portal/admin/press');
  r = await post(`/portal/admin/press/${hidden.id}/delete`, {});
  check('item deleted', [302, 303].includes(r.status));
  check('row is gone', !(await models.PressItem.findByPk(hidden.id)));

  /* A CSRF-less POST must still be refused. */
  const noToken = await fetch(base + '/portal/admin/press', {
    method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'title=Intruder'
  });
  check('a press POST without a CSRF token is refused', noToken.status === 403, String(noToken.status));
  check('no row was created by it', !(await models.PressItem.findOne({ where: { title: 'Intruder' } })));

  console.log('\n' + results.join('\n'));
  console.log(process.exitCode ? '\nFAILURES' : '\nALL PASS');
  process.exit(process.exitCode || 0);
})().catch(e => { console.error(e); process.exit(1); });
