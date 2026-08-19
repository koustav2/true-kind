/* ==========================================================================
   CMS smoke test.     Run with:  npm run cms:smoke

   Boots the real app in-process against in-memory SQLite (same approach as
   scripts/smoke.js — sqlite ':memory:' is per-process, so the seeding has to
   happen inside this process rather than through scripts/seed.js), signs in as
   an admin, and drives the whole content pipeline over HTTP:

     admin form save -> database -> public /api/cms bundle

   It deliberately also asserts the NEGATIVE cases, because those are the ones
   that quietly rot: hostile richtext, javascript: links, cross-page writes,
   missing CSRF tokens, and anonymous access.
   ========================================================================== */
'use strict';

process.env.SESSION_SECRET = 'cms-smoke-secret';
process.env.PORT = process.env.PORT || '4310';
process.env.APP_BASE_URL = `http://127.0.0.1:${process.env.PORT}`;
process.env.ADMIN_EMAIL = 'admin@test.org';
process.env.ADMIN_PASSWORD = 'admin123';

(async () => {
  process.env.DB_DIALECT = 'sqlite';           // must precede the require: db.js reads it at load
  const BASE = `http://127.0.0.1:${process.env.PORT}`;

  require('../server');
  await new Promise(r => setTimeout(r, 1800));  // let sequelize.sync() finish

  const bcrypt = require('bcryptjs');
  const models = require('../models');
  await models.User.create({
    name: 'Admin', email: 'admin@test.org', phone: '0', role: 'admin', status: 'active',
    passwordHash: await bcrypt.hash('admin123', 10)
  });

  /* ---- harness --------------------------------------------------------- */
  let jar = '';
  async function call(method, path, opts = {}) {
    const headers = Object.assign({ cookie: jar }, opts.headers || {});
    const init = { method, headers, redirect: 'manual' };
    if (opts.json) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(opts.json); }
    else if (opts.body) { headers['content-type'] = 'application/x-www-form-urlencoded'; init.body = new URLSearchParams(opts.body).toString(); }
    const res = await fetch(BASE + path, init);
    const sc = res.headers.get('set-cookie');
    if (sc) jar = sc.split(';')[0];
    return res;
  }
  const anon = (path, init) => fetch(BASE + path, init);
  async function csrf(path) {
    const html = await (await call('GET', path)).text();
    const m = html.match(/name="_csrf" value="([^"]+)"/);
    return m && m[1];
  }
  const bundle = page => anon(`/api/cms/${page}`).then(r => r.json());

  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ ok: !!ok, name, detail });
    if (!ok) process.exitCode = 1;
  };

  /* ---- 1. sign in ------------------------------------------------------ */
  let t = await csrf('/portal/signin');
  let r = await call('POST', '/portal/signin', { body: { email: 'admin@test.org', password: 'admin123', _csrf: t } });
  check('admin signin', r.headers.get('location') === '/portal/admin', `${r.status} ${r.headers.get('location')}`);

  /* ---- 2. editor renders ---------------------------------------------- */
  r = await call('GET', '/portal/admin/cms/page/index');
  let html = await r.text();
  check('editor renders', r.status === 200 && html.includes('Edit Homepage'), `status ${r.status}`);
  check('editor lists generated field ids', html.includes('index.h1.1'));
  check('editor offers the video slot', html.includes('index.video.hero'));

  r = await call('GET', '/portal/admin/cms/page/global');
  html = await r.text();
  check('global editor renders', r.status === 200 && html.includes('all nine pages'), `status ${r.status}`);

  /* ---- 3. click-to-edit support -------------------------------------- */
  r = await call('GET', '/portal/admin/cms/session', { headers: { Accept: 'application/json' } });
  const sess = await r.json();
  check('session probe reports admin', sess.ok === true && sess.admin === true);
  check('session probe returns csrf token', typeof sess.csrfToken === 'string' && sess.csrfToken.length === 64);

  r = await call('GET', '/portal/admin/cms/schema/index', { headers: { Accept: 'application/json' } });
  const schema = await r.json();
  check('schema covers page + global fields',
    schema.fields.length > 100 && schema.fields.some(f => f.id.startsWith('global.')),
    `${schema.fields.length} fields`);

  /* ---- 4. save -> bundle --------------------------------------------- */
  t = await csrf('/portal/admin/cms/page/index');
  r = await call('POST', '/portal/admin/cms/page/index', { body: { _csrf: t, 'index.h1.1': 'Kindness, <em>organised</em>.' } });
  check('page save redirects', r.status === 302, `status ${r.status}`);

  let b = await bundle('index');
  check('public bundle carries the save',
    b.fields['index.h1.1'] && b.fields['index.h1.1'].v.includes('organised'),
    JSON.stringify(b.fields['index.h1.1'] || null));
  check('bundle carries ONLY overridden fields', Object.keys(b.fields).length === 1, `${Object.keys(b.fields).length} keys`);

  /* ---- 5. richtext sanitising ---------------------------------------- */
  t = await csrf('/portal/admin/cms/page/index');
  await call('POST', '/portal/admin/cms/page/index', {
    body: { _csrf: t, 'index.h1.1': 'Hi <em>there</em><script>alert(1)</script><a href="javascript:alert(2)">x</a><b onclick="evil()">y</b>' }
  });
  let v = (await bundle('index')).fields['index.h1.1'].v;
  check('<script> stripped', !/script/i.test(v), v);
  check('javascript: href stripped', !/javascript:/i.test(v), v);
  check('onclick stripped', !/onclick/i.test(v), v);
  check('allowed <em> preserved', /<em>there<\/em>/.test(v), v);

  /* ---- 6. global row ------------------------------------------------- */
  t = await csrf('/portal/admin/cms/page/global');
  await call('POST', '/portal/admin/cms/page/global', { body: { _csrf: t, 'global.footer.h4.1': 'Who we are' } });
  let g = await bundle('global');
  check('global save lands in the global bundle',
    g.fields['global.footer.h4.1'] && g.fields['global.footer.h4.1'].v === 'Who we are',
    JSON.stringify(g.fields));

  /* ---- 7. refusals --------------------------------------------------- */
  t = await csrf('/portal/admin/cms/page/about');
  await call('POST', '/portal/admin/cms/page/about', { body: { _csrf: t, 'index.h1.1': 'HIJACKED' } });
  check('cross-page write refused', !/HIJACKED/.test(JSON.stringify(await bundle('index'))));

  t = await csrf('/portal/admin/cms/page/index');
  r = await call('POST', '/portal/admin/cms/page/index', { body: { _csrf: t, 'not.a.real.field': 'x' } });
  check('unknown field id ignored without erroring', r.status === 302, `status ${r.status}`);

  t = await csrf('/portal/admin/cms/page/global');
  r = await call('POST', '/portal/admin/cms/page/global', { body: { _csrf: t, 'global.header.a.1.href': 'javascript:alert(1)' } });
  check('hostile url rejected as a field error', r.status === 400, `status ${r.status}`);
  g = await bundle('global');
  check('hostile url not stored', !g.fields['global.header.a.1.href']);

  /* ---- 8. inline (click-to-edit) save -------------------------------- */
  r = await call('POST', '/portal/admin/cms/inline/index', {
    json: { id: 'index.h1.1', value: 'Inline edit works' },
    headers: { 'X-CSRF-Token': sess.csrfToken, 'X-Requested-With': 'fetch', Accept: 'application/json' }
  });
  const inl = await r.json();
  check('inline save accepted', r.status === 200 && inl.ok === true, JSON.stringify(inl));
  check('inline value persisted', (await bundle('index')).fields['index.h1.1'].v === 'Inline edit works');

  r = await call('POST', '/portal/admin/cms/inline/index', {
    json: { id: 'index.h1.1', value: 'NOPE' },
    headers: { 'X-Requested-With': 'fetch', Accept: 'application/json' }
  });
  check('inline save without a CSRF token -> 403', r.status === 403, `status ${r.status}`);
  check('CSRF-refused value not stored', (await bundle('index')).fields['index.h1.1'].v !== 'NOPE');

  /* ---- 9. video --------------------------------------------------------- */
  r = await call('POST', '/portal/admin/cms/media/embed', {
    json: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    headers: { 'X-CSRF-Token': sess.csrfToken, 'X-Requested-With': 'fetch' }
  });
  let emb = await r.json();
  check('youtube link -> nocookie embed',
    emb.ok && emb.embedUrl === 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', JSON.stringify(emb));

  r = await call('POST', '/portal/admin/cms/media/embed', {
    json: { url: 'https://vimeo.com/123456789' },
    headers: { 'X-CSRF-Token': sess.csrfToken, 'X-Requested-With': 'fetch' }
  });
  emb = await r.json();
  check('vimeo link parsed', emb.ok && emb.embedUrl === 'https://player.vimeo.com/video/123456789', JSON.stringify(emb));

  r = await call('POST', '/portal/admin/cms/media/embed', {
    json: { url: 'javascript:alert(1)' },
    headers: { 'X-CSRF-Token': sess.csrfToken, 'X-Requested-With': 'fetch' }
  });
  check('hostile embed url rejected', r.status === 400, `status ${r.status}`);

  t = await csrf('/portal/admin/cms/page/index');
  await call('POST', '/portal/admin/cms/page/index', {
    body: {
      _csrf: t,
      'index.video.hero[mode]': 'embed',
      'index.video.hero[embedUrl]': 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      'index.video.hero[provider]': 'youtube',
      'index.video.hero[caption]': 'Who we are'
    }
  });
  b = await bundle('index');
  check('video slot saved as an embed',
    b.fields['index.video.hero'] && b.fields['index.video.hero'].v.mode === 'embed' &&
    b.fields['index.video.hero'].v.embedUrl.includes('youtube-nocookie'),
    JSON.stringify(b.fields['index.video.hero'] || null));

  t = await csrf('/portal/admin/cms/page/index');
  await call('POST', '/portal/admin/cms/page/index', {
    body: { _csrf: t, 'index.video.hero[mode]': 'embed', 'index.video.hero[embedUrl]': 'https://evil.example.com/x' }
  });
  b = await bundle('index');
  check('non-whitelisted embed host dropped', b.fields['index.video.hero'].v.embedUrl === '',
    JSON.stringify(b.fields['index.video.hero'].v));

  /* ---- 10. media upload guards --------------------------------------- */
  async function upload(name, type, bytes) {
    // Token goes in the query, matching what the real multipart form does —
    // the global CSRF guard runs before multer and cannot see a multipart body.
    const token = await csrf('/portal/admin/cms/media');
    const fd = new FormData();
    fd.append('file', new Blob([bytes || 'x'], { type }), name);
    return fetch(BASE + '/portal/admin/cms/media?_csrf=' + encodeURIComponent(token),
      { method: 'POST', headers: { cookie: jar }, body: fd, redirect: 'manual' });
  }
  r = await upload('evil.html', 'text/html');
  check('.html upload rejected', r.status === 400, `status ${r.status}`);
  r = await upload('evil.svg', 'image/svg+xml');
  check('.svg upload rejected', r.status === 400, `status ${r.status}`);
  r = await upload('fake.png', 'text/html');
  check('extension/mimetype mismatch rejected', r.status === 400, `status ${r.status}`);

  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  r = await upload('real.png', 'image/png', png);
  check('genuine .png accepted', r.status === 302, `status ${r.status}`);
  const assets = await models.MediaAsset.findAll();
  check('accepted upload recorded in the media library', assets.length === 1 && assets[0].kind === 'image', `${assets.length} rows`);
  check('stored filename is a uuid, not the original',
    assets.length > 0 && /^[0-9a-f-]{36}\.png$/.test(assets[0].filename),
    assets.length ? assets[0].filename : 'no asset row');

  /* ---- 11. reset ------------------------------------------------------ */
  t = await csrf('/portal/admin/cms/page/index');
  await call('POST', '/portal/admin/cms/reset/index', { body: { _csrf: t, id: 'index.h1.1' } });
  check('reset removes the override', !(await bundle('index')).fields['index.h1.1']);

  /* ---- 12. anonymous -------------------------------------------------- */
  jar = '';
  r = await call('GET', '/portal/admin/cms/page/index');
  check('anonymous editor access redirected to signin',
    r.status === 302 && (r.headers.get('location') || '').includes('signin'), `${r.status}`);
  r = await call('GET', '/portal/admin/cms/session', { headers: { Accept: 'application/json' } });
  check('anonymous session probe is not admin-json',
    r.status !== 200 || !(r.headers.get('content-type') || '').includes('json'), `status ${r.status}`);
  r = await call('POST', '/portal/admin/cms/inline/index', {
    json: { id: 'index.h1.1', value: 'anon' }, headers: { 'X-Requested-With': 'fetch' }
  });
  check('anonymous inline save blocked', r.status === 403 || r.status === 302, `status ${r.status}`);
  r = await anon('/api/cms/index');
  check('public bundle stays readable without a login', r.status === 200, `status ${r.status}`);

  /* ---- report -------------------------------------------------------- */
  for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok ? '' : '   << ' + x.detail}`);
  const pass = results.filter(x => x.ok).length;
  console.log(`\n${pass}/${results.length} passed`);
  console.log(pass === results.length ? 'ALL PASS' : 'FAILURES ABOVE');
  process.exit(process.exitCode || 0);
})().catch(e => { console.error('CMS SMOKE CRASH', e); process.exit(1); });
