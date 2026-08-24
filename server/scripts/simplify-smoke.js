/* ==========================================================================
   Admin simplification smoke test.     Run with:  npm run simplify:smoke

   Covers the "make the whole CMS simple" pass: the retired dual-editor bug,
   the new Photographs tab, and the Pages editor no longer showing images.

   The one check that matters most is not about anything visible — it is that
   every field the registry knows about still shows up SOMEWHERE in the admin,
   after images were pulled out of one screen and given another. A field that
   silently stopped appearing on either screen would still save and still
   render on the public site; nobody would notice until a client asked "where
   did the field for X go" months later. That is checked directly, in-process,
   against the registry rather than by scraping HTML for it.

   Requires no browser — everything here is server-rendered HTML and JSON.
   ========================================================================== */
'use strict';

process.env.SESSION_SECRET = 'simplify-smoke-secret';
process.env.PORT = process.env.PORT || '4318';
process.env.APP_BASE_URL = `http://127.0.0.1:${process.env.PORT}`;
process.env.ADMIN_EMAIL = 'admin@test.org';
process.env.ADMIN_PASSWORD = 'admin123';

(async () => {
  process.env.DB_DIALECT = 'sqlite';
  const BASE = `http://127.0.0.1:${process.env.PORT}`;

  require('../server');
  await new Promise(r => setTimeout(r, 1800));

  const fs = require('fs');
  const path = require('path');
  const bcrypt = require('bcryptjs');
  const models = require('../models');
  const cms = require('../cms');

  await models.User.create({
    name: 'Admin', email: 'admin@test.org', phone: '0', role: 'admin', status: 'active',
    passwordHash: await bcrypt.hash('admin123', 10)
  });

  /* ---- harness (same shape as cms-smoke.js) ----------------------------- */
  let jar = '';
  async function call(method, p, opts = {}) {
    const headers = Object.assign({ cookie: jar }, opts.headers || {});
    const init = { method, headers, redirect: 'manual' };
    if (opts.json) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(opts.json); }
    else if (opts.body) { headers['content-type'] = 'application/x-www-form-urlencoded'; init.body = new URLSearchParams(opts.body).toString(); }
    const res = await fetch(BASE + p, init);
    const sc = res.headers.get('set-cookie');
    if (sc) jar = sc.split(';')[0];
    return res;
  }
  const anon = (p, init) => fetch(BASE + p, init);
  async function csrf(p) {
    const html = await (await call('GET', p)).text();
    const m = html.match(/name="_csrf" value="([^"]+)"/);
    return m && m[1];
  }
  const bundle = page => anon(`/api/cms/${page}`).then(r => r.json());

  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ ok: !!ok, name, detail });
    if (!ok) process.exitCode = 1;
  };
  let r, t, b;

  /* ---- 0. sign in as admin — everything below needs the session --------- */

  t = await csrf('/portal/signin');
  r = await call('POST', '/portal/signin', { body: { email: 'admin@test.org', password: 'admin123', _csrf: t } });
  check('admin sign-in redirects into the portal', r.status === 302 && r.headers.get('location') === '/portal/admin',
    `${r.status} ${r.headers.get('location')}`);

  /* ---- 1. the retired dual editor is gone, not just hidden -------------- */

  const REPO = path.join(__dirname, '..', '..');
  const PAGES = ['index.html', 'about.html', 'work.html', 'impact.html', 'donate.html',
                 'volunteer.html', 'contact.html', 'press-release.html', 'chairperson-message.html'];
  const LEGACY_MARKERS = [
    'assets/js/content.js', 'data-cms-banner-headline', 'data-cms-banner-subtext',
    'data-cms-about-heading', 'data-cms-about-body', 'data-cms-team', 'data-cms-works', 'data-cms-press'
  ];
  const stillPresent = [];
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(REPO, page), 'utf8');
    for (const marker of LEGACY_MARKERS) if (html.includes(marker)) stillPresent.push(`${page}: ${marker}`);
  }
  check('no page still loads the retired content.js or its data hooks',
    stillPresent.length === 0, stillPresent.join(' | '));

  r = await call('GET', '/portal/admin/content');
  check('the retired editor redirects an admin to the real one',
    r.status === 302 && (r.headers.get('location') || '').includes('/portal/admin/cms'),
    `${r.status} ${r.headers.get('location')}`);

  t = await csrf('/portal/admin/cms/page/about');
  r = await call('POST', '/portal/admin/content/about', { body: { _csrf: t, heading: 'Should not save' } });
  check('POSTing to the retired save endpoint also redirects', r.status === 302, `status ${r.status}`);
  const legacyRow = await models.SiteContent.findOne({ where: { key: 'about' } });
  check('and writes nothing — the five legacy rows stay absent', !legacyRow);

  /* ---- 2. nav: Photographs in, Text content out ------------------------- */

  // '/portal/admin/cms' itself redirects to the first page (global) — follow
  // it to an actually-rendered screen rather than reading the redirect body.
  r = await call('GET', '/portal/admin/cms/page/global');
  let html = await r.text();
  check('nav offers Photographs', />Photographs</.test(html));
  check('nav no longer offers Text content', !/>Text content</.test(html));

  /* ---- 3. images pulled OUT of the Pages editor -------------------------- */

  r = await call('GET', '/portal/admin/cms/page/about');
  html = await r.text();
  check('About\'s text editor renders', r.status === 200);
  check('...and no longer shows any image field (hero photo)', !html.includes('about.photo.hero'));
  // Scoped to the accordion heading, not the nav — the nav's own "Photographs"
  // link to the Images tab is on every admin page and is not what this checks.
  check('...or a "Photographs" group heading (the nav link to the Images tab is not this)',
    !/<summary>Photographs</.test(html));
  const sidebarMatch = html.match(/About Us<\/span><span class="n">(\d+)</);
  const expectedCount = cms.textFieldCount('about');
  check('the sidebar count matches what this screen actually shows (not the old inflated total)',
    sidebarMatch && Number(sidebarMatch[1]) === expectedCount,
    `sidebar says ${sidebarMatch && sidebarMatch[1]}, editor shows ${expectedCount}`);

  /* ---- 4. images ARE on the new tab, organised by real page -------------- */

  r = await call('GET', '/portal/admin/cms/images');
  html = await r.text();
  check('the Photographs tab renders', r.status === 200);
  check('...lists the About hero photograph', html.includes('About Us — hero photograph'));
  check('...lists a homepage banner slide', html.includes('Homepage slider — slide 1 photograph'));
  check('...sectioned under the page\'s own name, not a heading fragment',
    /<h2>\s*Homepage\s*<\/h2>/.test(html) && /<h2>\s*About Us\s*<\/h2>/.test(html));
  check('...carries the technical id for support use, even if hidden by CSS',
    html.includes('about.photo.hero'));
  check('...but hides it by default', html.includes('cms-ids-off'));

  /* ---- 5. saving a photograph from the new tab works end to end --------- */

  r = await call('GET', '/portal/admin/cms/session', { headers: { Accept: 'application/json' } });
  const sess = await r.json();

  r = await call('POST', '/portal/admin/cms/inline/about', {
    json: { id: 'about.photo.hero', value: { src: '/uploads/hero-test.jpg', alt: 'Trainees at the centre' } },
    headers: { 'X-CSRF-Token': sess.csrfToken, 'X-Requested-With': 'fetch' }
  });
  const saveResult = await r.json();
  check('saving a photograph from the Photographs tab is accepted', r.status === 200 && saveResult.ok === true, JSON.stringify(saveResult));

  r = await call('GET', '/portal/admin/cms/images');
  html = await r.text();
  check('...and its preview reflects the new file', html.includes('/uploads/hero-test.jpg'));
  check('...and its alt text is preserved in the field', html.includes('Trainees at the centre'));

  b = await bundle('about');
  check('...and the public bundle picks it up',
    b.fields['about.photo.hero'] && b.fields['about.photo.hero'].v.src === '/uploads/hero-test.jpg',
    JSON.stringify(b.fields['about.photo.hero'] || null));

  /* ---- 6. resetting a photograph from the new tab clears the override --- */

  t = sess.csrfToken;
  await call('POST', '/portal/admin/cms/reset/about', { body: { _csrf: t, id: 'about.photo.hero' } });
  b = await bundle('about');
  check('reset removes the override', !b.fields['about.photo.hero']);

  /* ---- 7. truncated group names stay whole words ------------------------ */

  // A short 1-2 letter trailing word ("a", "to", "of") is not evidence of a
  // mid-word cut — those are real, complete English words. The actual
  // contract is structural: truncateGroup only cuts at a space (or, for one
  // very long word with no early space, at a hard character limit). So the
  // content just before the ellipsis must either be the whole name, or be
  // immediately followed by a space in the untruncated name.
  const longGroups = [];
  for (const p of cms.PAGE_KEYS) {
    for (const g of cms.groupsForPage(p)) {
      if (!g.short.endsWith('…')) continue;
      const kept = g.short.slice(0, -1);           // short minus the ellipsis
      if (kept === g.name) continue;                // no real truncation happened
      const nextChar = g.name.charAt(kept.length);
      const hardCutFallback = !kept.includes(' ');  // one very long word — allowed
      if (nextChar !== ' ' && !hardCutFallback) longGroups.push(`${p}: "${g.short}" (full: "${g.name}")`);
    }
  }
  check('no truncated section name is cut off mid-word',
    longGroups.length === 0, longGroups.join(' | '));

  /* ---- 8. completeness: every non-href field lives on SOME admin screen - */

  const onPages = new Set();
  const onImages = new Set();
  for (const p of cms.PAGE_KEYS.concat('global')) {
    for (const g of cms.groupsForPage(p)) {
      for (const f of g.fields) { onPages.add(f.id); if (f.hrefField) onPages.add(f.hrefField.id); }
    }
    for (const f of cms.imageFieldsForPage(p)) onImages.add(f.id);
  }
  const orphaned = cms.FIELDS.filter(f => f.role !== 'href' && !onPages.has(f.id) && !onImages.has(f.id));
  check('every editable field still appears on the Pages editor or the Photographs tab',
    orphaned.length === 0, orphaned.map(f => f.id).join(', '));

  /* ---- 9. field count is pinned as a regression guard -------------------- */
  // 616 is the verified count after this pass (`npm run cms:build`'s own
  // report: text 438, textarea 37, image 32, url 69, richtext 32, video 8),
  // confirmed stable by diffing the full sorted id list before and after the
  // group-renaming fix in text-slots.js — zero ids added or removed, only
  // group labels changed. This is not a number that should need updating for
  // unrelated content work — if it does, something about a field's identity
  // changed, which is the one thing this whole exercise was built to never do
  // silently.
  check('total field count matches the verified count after the simplification (616)',
    cms.FIELDS.length === 616, `now ${cms.FIELDS.length}`);

  /* ---- report ------------------------------------------------------------ */
  for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok ? '' : '   << ' + x.detail}`);
  const pass = results.filter(x => x.ok).length;
  console.log(`\n${pass}/${results.length} passed`);
  console.log(pass === results.length ? 'ALL PASS' : 'FAILURES ABOVE');
  process.exit(process.exitCode || 0);
})().catch(e => { console.error('SIMPLIFY SMOKE CRASH', e); process.exit(1); });
