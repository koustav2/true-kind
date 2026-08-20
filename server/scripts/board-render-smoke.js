/* ==========================================================================
   Board rendering smoke test.       Run with:  npm run board:render

   board:smoke covers the data: the admin forms, the validation, the API. This
   one covers the part only a browser can answer — that about.html actually
   swaps its four placeholder cards for the admin's real trustees, and that it
   does NOT do so when the list is empty or the request fails.

   Requires playwright. Skips cleanly if it is not installed.
   ========================================================================== */
'use strict';

process.env.SESSION_SECRET = 'board-render-smoke';
process.env.PORT = process.env.PORT || '5861';
process.env.APP_BASE_URL = `http://127.0.0.1:${process.env.PORT}`;

let PW_PATH;
try { PW_PATH = require.resolve('playwright'); }
catch (e) {
  console.log('playwright not installed — skipping the board rendering smoke test.');
  console.log('  npm i -D playwright && npx playwright install chromium');
  process.exit(0);
}

(async () => {
  process.env.DB_DIALECT = 'sqlite';
  require('../server');
  await new Promise(r => setTimeout(r, 1900));

  /* Seeded HERE, not in the child: sqlite :memory: belongs to this process, so
     the browser subprocess can only reach it over HTTP. The child covers the
     empty-list and request-failed states by intercepting /api/board instead. */
  const { BoardMember } = require('../models');
  await BoardMember.bulkCreate([
    {
      name: 'Asha Mohanty', designation: 'Chairperson',
      email: 'asha@truekindfoundation.org',
      bio: 'Chairs the board and represents the Foundation publicly.',
      photoUrl: '/assets/img/logo.png',      // any real, servable image
      facebook: 'https://www.facebook.com/ashamohanty',
      linkedin: 'https://www.linkedin.com/in/asha-mohanty/',
      twitter: 'https://x.com/asham',
      sortOrder: 10, visible: true
    },
    {
      name: 'Rakesh Behera', designation: 'Treasurer',
      email: 'rakesh@truekindfoundation.org',
      sortOrder: 20, visible: true
    },
    /* Deliberately hostile. The admin is trusted; the admin's paste is not.
       Every one of these has to arrive on the page as visible text. */
    {
      name: '<img src=x onerror=alert(1)>Mallory "Quote" Singh',
      designation: '<script>window.__pwned=1</script>Secretary',
      email: 'm@test.org',
      bio: '</p><svg onload=alert(2)>',
      sortOrder: 30, visible: true
    },
    { name: 'Hidden Person', designation: 'Former trustee', sortOrder: 5, visible: false }
  ]);

  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [require('path').join(__dirname, 'board-render-check.mjs')],
    { stdio: 'inherit', env: { ...process.env, BASE: process.env.APP_BASE_URL, PW_PATH } });
  child.on('exit', code => process.exit(code || 0));
})().catch(e => { console.error('BOARD RENDER SMOKE CRASH', e); process.exit(1); });
