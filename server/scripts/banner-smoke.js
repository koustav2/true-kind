/* ==========================================================================
   Homepage banner rendering smoke test.       Run with:  npm run banner:render

   The banner is the one part of the site nobody scrolls to reach, and it is
   built out of three layers stacked on each other — photograph, scrim, text —
   which is exactly the arrangement that breaks silently. It already did once:
   `.slide-media` is also a `.cms-photo-slot`, and that rule sits further down
   style.css with the same specificity, so it won `position:relative`, the media
   box collapsed to 0px tall, and the homepage shipped a blank grey panel with a
   headline floating on it. Nothing threw. Nothing failed a test. It just looked
   broken.

   So the checks below are geometric, not textual: is the photograph actually
   filling the frame, is the scrim on top of it, is the text on top of that, is
   the frame a band rather than a screenful. A string test cannot see any of it.

   Requires playwright. Skips cleanly if it is not installed.
   ========================================================================== */
'use strict';

process.env.SESSION_SECRET = 'banner-smoke';
process.env.PORT = process.env.PORT || '5863';
process.env.APP_BASE_URL = `http://127.0.0.1:${process.env.PORT}`;

let PW_PATH;
try { PW_PATH = require.resolve('playwright'); }
catch (e) {
  console.log('playwright not installed — skipping the homepage banner smoke test.');
  console.log('  npm i -D playwright && npx playwright install chromium');
  process.exit(0);
}

(async () => {
  process.env.DB_DIALECT = 'sqlite';
  require('../server');
  await new Promise(r => setTimeout(r, 1900));

  /* No seeding. The banner's defaults live in index.html, not in the database —
     that is the whole point of the declared-slot pattern — so an empty database
     is the state this test wants: it proves a fresh install shows a finished
     banner rather than a hidden section or three broken images. */

  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [require('path').join(__dirname, 'banner-check.mjs')],
    { stdio: 'inherit', env: { ...process.env, BASE: process.env.APP_BASE_URL, PW_PATH } });
  child.on('exit', code => process.exit(code || 0));
})().catch(e => { console.error('BANNER SMOKE CRASH', e); process.exit(1); });
