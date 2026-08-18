require('dotenv').config();
const bcrypt = require('bcryptjs');
const { sequelize, ensureDatabase } = require('../db');
const { User, FormConfig } = require('../models');

(async () => {
  await ensureDatabase();
  await sequelize.sync();
  const email = (process.env.ADMIN_EMAIL || 'admin@truekindfoundation.org').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'change-me';
  let admin = await User.findOne({ where: { email } });
  if (!admin) {
    await User.create({
      name: process.env.ADMIN_NAME || 'True Kind Admin',
      email, phone: '0000000000', role: 'admin', status: 'active',
      passwordHash: await bcrypt.hash(password, 10)
    });
    console.log('✓ Admin created:', email);
  } else console.log('Admin already exists:', email);
  await FormConfig.findOrCreate({ where: { formKey: 'donation' }, defaults: { fields: [] } });
  console.log('✓ Donation form config ready (add Debasish\'s fields in /portal/admin/form)');
  await sequelize.close();
})();
