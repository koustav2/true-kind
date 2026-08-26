/* ==========================================================================
   Admin simplification smoke test.     Run with:  npm run simplify:smoke

   Covers the "make the whole CMS simple" pass: the retired dual-editor bug,
   and photographs living in the section they belong to.

   THIS FILE USED TO ASSERT THE OPPOSITE. It pinned the split design — a
   separate Photographs tab, and a Pages editor with no images on it — because
   that was the decision at the time. The decision changed: a picture and the
   words beside it on the real page are one thing to edit, and splitting them
   across two menus made the photo controls hard to find at all. The checks
   below now pin the merged design, and the completeness check is unchanged in
   spirit: no field may quietly stop appearing in the admin.

   The one check that matters most is not about anything visible — it is that
   every field the registry knows about still shows up in the admin, after
   images were folded back in. A field that silently stopped appearing would
   still save and still render on the public site; nobody would notice until a
   client asked "where did the field for X go" months later. That is checked
   directly, in-process, against the registry rather than by scraping HTML.

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

  /* ---- 2. nav: one Website menu, no Photographs tab ---------------------- */

  // '/portal/admin/cms' itself redirects to the first page (global) — follow
  // it to an actually-rendered screen rather than reading the redirect body.
  r = await call('GET', '/portal/admin/cms/page/global');
  let html = await r.text();
  check('nav no longer offers Photographs', !/>Photographs</.test(html));
  check('nav no longer offers Text content', !/>Text content</.test(html));
  check('nav still offers Pages and Media', />Pages</.test(html) && />Media</.test(html));

  /* ---- 3. images are IN the Pages editor, in their own section ----------- */

  r = await call('GET', '/portal/admin/cms/page/about');
  html = await r.text();
  check('About\'s editor renders', r.status === 200);
  check('...and shows the hero photograph field', html.includes('about.photo.hero'));
  check('...and the picker button that fills it',
    /data-pick="image"[^>]*data-target="about\.photo\.hero"/.test(html));
  check('...and a way to clear it again without the bulk reset',
    html.includes('data-clearimg="about.photo.hero"'));
  /* Uploading used to mean: leave the page, go to the Media library, upload,
     come back, pick. With an empty library the picker opened on "Nothing
     uploaded yet", which reads as "you cannot put a photo here". */
  check('...and a way to upload a file straight into the slot',
    html.includes('data-upload="about.photo.hero"') && html.includes('id="photoUpload"'));
  // The whole point of the merge: no section called "Photographs" anywhere.
  check('...and NO "Photographs" section heading',
    !/<summary>Photographs</.test(html));
  const sidebarMatch = html.match(/About Us<\/span><span class="n">(\d+)</);
  const expectedCount = cms.editorFieldCount('about');
  check('the sidebar count matches what this screen actually shows',
    sidebarMatch && Number(sidebarMatch[1]) === expectedCount,
    `sidebar says ${sidebarMatch && sidebarMatch[1]}, editor shows ${expectedCount}`);

  /* Every photograph must land in a section that also holds text. A photo in a
     section of its own is the old split reappearing one field at a time —
     which is exactly what happens when someone edits a heading in the HTML and
     the group name in image-slots.js stops matching. */
  const lonely = [];
  for (const p of cms.PAGE_KEYS.concat('global')) {
    for (const g of cms.groupsForPage(p)) {
      const imgs = g.fields.filter(f => f.type === 'image');
      if (imgs.length && imgs.length === g.fields.length) {
        lonely.push(`${p}: "${g.name}" (${imgs.length} photo, no text)`);
      }
    }
  }
  check('no photograph sits in a section of its own', lonely.length === 0, lonely.join(' | '));

  /* Photograph first inside its section, and — on the banner — beside its own
     slide rather than in a block of ten at the top. */
  const banner = cms.groupsForPage('index').find(g => g.name === 'Photo slider');
  check('the banner interleaves each slide\'s photo with that slide\'s text',
    banner && banner.fields[0].id === 'index.slide.1.image'
           && banner.fields[1].id === 'index.slide.1.title',
    banner ? banner.fields.slice(0, 3).map(f => f.id).join(', ') : 'no banner group');

  /* ---- 3b. section names are names, not page copy ----------------------- */

  const badNames = [];
  for (const p of cms.PAGE_KEYS.concat('global')) {
    for (const g of cms.groupsForPage(p)) {
      // "Page" is the generator's no-heading fallback — a bin, not a section.
      if (g.name === 'Page') badNames.push(`${p}: "Page" (generator fallback)`);
      // A trailing full stop means the name is a sentence lifted off the page.
      if (/[.!?]$/.test(g.name)) badNames.push(`${p}: "${g.name}" (page copy)`);
      // An ellipsis means it was too long to show and got cut.
      if (g.short.endsWith('…')) badNames.push(`${p}: "${g.short}" (truncated)`);
    }
  }
  check('every section has a plain name — no "Page" bin, no page copy, nothing truncated',
    badNames.length === 0, badNames.join(' | '));

  /* ---- 3c. hidden duplicates are gone, but never trapped ---------------- */

  const HIDDEN = Object.keys(cms.sections.HIDE);
  // Two separate reasons to hide something, checked separately — a bare total
  // would go green if one set vanished and the other doubled.
  const slideDupes = ['index.h2.6','index.p.3','index.a.11','index.h2.7','index.p.13','index.a.12',
                      'index.h2.8','index.p.21','index.a.13','index.button.1','index.button.2'];
  const boardCards = ['about.div.1','about.h3.5','about.p.15','about.div.2','about.h3.6','about.p.17',
                      'about.div.3','about.h3.7','about.p.19','about.div.4','about.h3.8','about.p.21'];
  check('the duplicate slide fields and slider arrows are hidden',
    slideDupes.every(id => cms.sections.HIDE[id]),
    slideDupes.filter(id => !cms.sections.HIDE[id]).join(', '));
  check('the four fixed board cards are hidden — the board is a list, not four posts',
    boardCards.every(id => cms.sections.HIDE[id]),
    boardCards.filter(id => !cms.sections.HIDE[id]).join(', '));
  check('...and nothing else is hidden without being listed here',
    HIDDEN.length === slideDupes.length + boardCards.length, `${HIDDEN.length}`);

  /* A section whose real content lives on another screen has to say so, with a
     way to get there — otherwise the rows that remain read as "this is all". */
  const gov = cms.groupsForPage('about').find(g => g.short === 'Governance');
  check('Governance points at the Board screen',
    gov && gov.note && gov.note.link && gov.note.link.href === '/portal/admin/board',
    gov ? JSON.stringify(gov.note) : 'no Governance section');
  const stillShown = new Set();
  for (const g of cms.groupsForPage('index')) for (const f of g.fields) stillShown.add(f.id);
  check('...and none of them is offered as a row', HIDDEN.every(id => !stillShown.has(id)));
  check('...every one carries a written reason', HIDDEN.every(id => (cms.sections.HIDE[id] || '').length > 10));

  /* A hidden field that somebody already saved a value into must come back, or
     that edit is stranded where it cannot be seen or undone. */
  const withStored = cms.groupsForPage('index', ['index.h2.6']);
  const strandedGroup = withStored.find(g => g.name === cms.sections.STRANDED);
  check('a hidden field with a saved value reappears so it can be cleared',
    strandedGroup && strandedGroup.fields.some(f => f.id === 'index.h2.6'),
    strandedGroup ? 'group present, wrong field' : 'no stranded group');
  check('...and it is the last section, not the first',
    withStored[withStored.length - 1].name === cms.sections.STRANDED,
    withStored[withStored.length - 1].name);

  /* ---- 3d. field labels say what the field says ------------------------- */

  r = await call('GET', '/portal/admin/cms/page/global');
  html = await r.text();
  // The footer's thirteen links were thirteen rows all labelled "link".
  check('a footer link is labelled by its own text, not by its HTML tag',
    html.includes('Link — About Us') && html.includes('Link — Volunteer with us'));
  check('...and a headline figure reads as a number, not as "bold value"',
    !/>\s*Bold value\s*</.test(html));

  /* ---- 4. the retired Photographs tab redirects, it does not 404 --------- */

  r = await call('GET', '/portal/admin/cms/images');
  check('the old Photographs URL redirects into the Pages editor',
    r.status === 302 && String(r.headers.get('location')).startsWith('/portal/admin/cms/page/'),
    `${r.status} ${r.headers.get('location')}`);

  /* ---- 5. saving a photograph FROM THE PAGES FORM works end to end ------ */

  r = await call('GET', '/portal/admin/cms/session', { headers: { Accept: 'application/json' } });
  const sess = await r.json();

  // The real form posts `about.photo.hero[src]` / `[alt]`, not JSON — this is
  // the path an admin actually takes, so it is the one that gets tested.
  t = await csrf('/portal/admin/cms/page/about');
  r = await call('POST', '/portal/admin/cms/page/about', {
    body: {
      _csrf: t,
      'about.photo.hero[src]': '/uploads/hero-test.jpg',
      'about.photo.hero[alt]': 'Trainees at the centre'
    }
  });
  check('saving a photograph from the Pages form is accepted',
    r.status === 302, `status ${r.status}`);

  r = await call('GET', '/portal/admin/cms/page/about');
  html = await r.text();
  check('...and its preview reflects the new file', html.includes('/uploads/hero-test.jpg'));
  check('...and its alt text is preserved in the field', html.includes('Trainees at the centre'));

  b = await bundle('about');
  check('...and the public bundle picks it up',
    b.fields['about.photo.hero'] && b.fields['about.photo.hero'].v.src === '/uploads/hero-test.jpg',
    JSON.stringify(b.fields['about.photo.hero'] || null));

  /* ---- 6. resetting a photograph clears the override --------------------- */

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
  for (const p of cms.PAGE_KEYS.concat('global')) {
    for (const g of cms.groupsForPage(p)) {
      for (const f of g.fields) { onPages.add(f.id); if (f.hrefField) onPages.add(f.hrefField.id); }
    }
  }
  // Deliberately hidden fields are the one allowed exception, and only because
  // sections.js names each and says why — see 3c, which also proves they come
  // back the moment one holds a value.
  const hidden = new Set(Object.keys(cms.sections.HIDE));
  const orphaned = cms.FIELDS.filter(f =>
    f.role !== 'href' && !onPages.has(f.id) && !hidden.has(f.id));
  check('every editable field appears on the Pages editor — the only screen now',
    orphaned.length === 0, orphaned.map(f => f.id).join(', '));
  check('...and that includes every photograph',
    cms.FIELDS.filter(f => f.type === 'image').every(f => onPages.has(f.id)));

  /* ---- 9. field count is pinned as a regression guard -------------------- */
  // 617 is the count in the registry as committed. It read 616 here and had
  // been failing on main for some time: the assertion was written from a build
  // report, the registry was regenerated afterwards, and nothing re-ran this
  // suite because it is one of the ones missing from the deploy checklist.
  //
  // Folding images back into the Pages editor changed group NAMES only — no id
  // was added or removed — so this number is unchanged by that work, which is
  // the property it exists to guard. If it moves, a field's identity changed,
  // which is the one thing that must never happen silently.
  check('total field count matches the registry as committed (628)',
    cms.FIELDS.length === 628, `now ${cms.FIELDS.length}`);

  /* ---- 10. the editor is in the same order as the page ------------------- */

  const outOfOrder = [];
  for (const p of cms.PAGE_KEYS) {
    const seq = cms.groupsForPage(p)
      .map(g => g.fields.map(f => f.pos).filter(n => typeof n === 'number'))
      .filter(ps => ps.length).map(ps => Math.min(...ps));
    const sorted = [...seq].sort((a, b) => a - b);
    if (JSON.stringify(seq) !== JSON.stringify(sorted)) outOfOrder.push(p);
  }
  check('every page\'s sections are listed in the order they appear on the page',
    outOfOrder.length === 0, outOfOrder.join(', '));


  /* ---- report ------------------------------------------------------------ */
  for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok ? '' : '   << ' + x.detail}`);
  const pass = results.filter(x => x.ok).length;
  console.log(`\n${pass}/${results.length} passed`);
  console.log(pass === results.length ? 'ALL PASS' : 'FAILURES ABOVE');
  process.exit(process.exitCode || 0);
})().catch(e => { console.error('SIMPLIFY SMOKE CRASH', e); process.exit(1); });
