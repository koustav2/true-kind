/* ==========================================================================
   Admin UI smoke test.     Run with:  npm run ui:smoke

   Unlike the other two suites, this one drives the REAL FORMS IN A BROWSER
   rather than POSTing to routes directly. That distinction is the reason it
   exists: a bad CSRF-token insertion once landed a hidden <input> INSIDE a
   form's action attribute, breaking three admin forms completely — and every
   route-level test still passed, because they never rendered the form.

   Requires playwright. Skips cleanly if it is not installed.
   ========================================================================== */
'use strict';

process.env.SESSION_SECRET = 'admin-ui-smoke';
process.env.PORT = process.env.PORT || '5750';
process.env.APP_BASE_URL = `http://127.0.0.1:${process.env.PORT}`;

/* Resolve playwright HERE and hand the absolute path to the ESM child. A bare
   `import 'playwright'` in the child fails when playwright is installed globally
   rather than in this project, because ESM does not consult NODE_PATH. */
let PW_PATH;
try { PW_PATH = require.resolve('playwright'); }
catch (e) {
  console.log('playwright not installed — skipping the admin UI smoke test.');
  console.log('  npm i -D playwright && npx playwright install chromium');
  process.exit(0);
}

(async () => {
  process.env.DB_DIALECT = 'sqlite';
  require('../server');
  await new Promise(r => setTimeout(r, 1900));

  const bcrypt = require('bcryptjs');
  const m = require('../models');
  const hash = await bcrypt.hash('admin123', 10);
  await m.User.create({ name: 'Admin', email: 'admin@test.org', phone: '0', role: 'admin', status: 'active', passwordHash: hash });
  await m.User.create({ name: 'Second Admin', email: 'admin2@test.org', phone: '0', role: 'admin', status: 'active', passwordHash: hash });
  await m.User.create({ name: 'Paid Member', email: 'mem@test.org', phone: '9', role: 'member', status: 'active',
    memberId: 'TKF-1', passwordHash: await bcrypt.hash('member123', 10) });
  await m.Volunteer.create({ name: 'Rita K', email: 'rita@test.org', phone: '9111111111', city: 'Bhadrak', status: 'new' });
  await m.Enquiry.create({ name: 'Asha', email: 'asha@test.org', subject: 'Question', message: 'Hello there' });
  await m.Certificate.create({ title: 'Skilling completion', description: 'For finishers' });
  await m.FormConfig.findOrCreate({ where: { formKey: 'donation' }, defaults: { fields: [] } });

  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [require('path').join(__dirname, 'admin-ui-check.mjs')],
    { stdio: 'inherit', env: { ...process.env, BASE: process.env.APP_BASE_URL, PW_PATH } });
  child.on('exit', code => process.exit(code || 0));
})().catch(e => { console.error('ADMIN UI SMOKE CRASH', e); process.exit(1); });
