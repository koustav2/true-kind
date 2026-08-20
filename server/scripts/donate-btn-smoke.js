/* ==========================================================================
   Header donate button smoke test.     Run with:  npm run donate:smoke

   Checks the button on all 9 pages at three viewport widths, that the attention
   pulse is FINITE (a looping one would fail WCAG 2.2.2), that it is suppressed
   under prefers-reduced-motion and on the donate page itself, and that clicking
   it carries a visitor all the way to a completed donation.

   Requires playwright. Skips cleanly if it is not installed.
   ========================================================================== */
'use strict';

process.env.SESSION_SECRET = 'donate-btn-smoke';
process.env.PORT = process.env.PORT || '5860';   // NB: avoid 6000, Chrome blocks it
process.env.APP_BASE_URL = `http://127.0.0.1:${process.env.PORT}`;

let PW_PATH;
try { PW_PATH = require.resolve('playwright'); }
catch (e) {
  console.log('playwright not installed — skipping the donate button smoke test.');
  console.log('  npm i -D playwright && npx playwright install chromium');
  process.exit(0);
}

(async () => {
  process.env.DB_DIALECT = 'sqlite';
  require('../server');
  await new Promise(r => setTimeout(r, 1900));
  const m = require('../models');
  await m.FormConfig.findOrCreate({ where: { formKey: 'donation' }, defaults: { fields: [] } });

  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [require('path').join(__dirname, 'donate-btn-check.mjs')],
    { stdio: 'inherit', env: { ...process.env, BASE: process.env.APP_BASE_URL, PW_PATH } });
  child.on('exit', code => process.exit(code || 0));
})().catch(e => { console.error('DONATE BTN SMOKE CRASH', e); process.exit(1); });
