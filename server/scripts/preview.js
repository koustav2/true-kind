/* ==========================================================================
   Local preview.     Run:  npm run preview

   Starts the whole site and portal on this machine with a throwaway in-memory
   database, and creates one admin in the SAME process so you can sign in.

   Why this exists: `npm run seed` cannot help you here. With DB_DIALECT=sqlite
   the database is `:memory:` (see server/db.js), so a seed run writes its admin
   into a database that disappears when that command exits — you would start the
   server and have no account. Doing both in one process is the only way to get
   a working portal without installing Postgres or MySQL first.

   NOTHING IS KEPT. Every restart is an empty site: no members, no donations, no
   gallery photographs. It is for looking at the screens, not for real content.
   ========================================================================== */
process.env.DB_DIALECT = 'sqlite';
process.env.PORT = process.env.PORT || '3000';
process.env.APP_BASE_URL = `http://localhost:${process.env.PORT}`;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'local-preview-only';

const EMAIL = 'preview@local';
const PASSWORD = 'preview123';

require('../server');

(async () => {
  await new Promise(r => setTimeout(r, 1800));      // let sync() finish
  const bcrypt = require('bcryptjs');
  const { User } = require('../models');
  try {
    await User.create({
      name: 'Preview admin', email: EMAIL, phone: '0',
      role: 'admin', status: 'active',
      passwordHash: await bcrypt.hash(PASSWORD, 10)
    });
  } catch (e) {
    console.error('Could not create the preview admin:', e.message);
    return;
  }

  const url = `http://localhost:${process.env.PORT}`;
  console.log(`
  ────────────────────────────────────────────────────────────
   Public site      ${url}/
   Gallery          ${url}/gallery.html
   Admin sign-in    ${url}/portal/signin

   Email            ${EMAIL}
   Password         ${PASSWORD}

   Website content  ${url}/portal/admin/cms
   Gallery photos   ${url}/portal/admin/gallery

   In-memory database — everything resets when you stop this.
   Stop with Ctrl+C.
  ────────────────────────────────────────────────────────────
`);
})();
