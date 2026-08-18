const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { User } = require('../models');

router.get('/signup', (req, res) => res.render('auth/signup', { title: 'Sign up', error: null }));
router.post('/signup', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !email || !phone || !password || password.length < 6)
      return res.render('auth/signup', { title: 'Sign up', error: 'All fields are required; password at least 6 characters.' });
    if (await User.findOne({ where: { email: email.toLowerCase() } }))
      return res.render('auth/signup', { title: 'Sign up', error: 'An account with this email already exists.' });
    const user = await User.create({ name, email, phone, passwordHash: await bcrypt.hash(password, 10) });
    req.session.userId = user.id; req.session.role = user.role;
    res.redirect('/portal/member');
  } catch (e) {
    res.render('auth/signup', { title: 'Sign up', error: 'Could not create the account. Try again.' });
  }
});

router.get('/signin', (req, res) => res.render('auth/signin', { title: 'Sign in', error: null }));
router.post('/signin', async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ where: { email: (email || '').toLowerCase() } });
  if (!user || !(await bcrypt.compare(password || '', user.passwordHash)))
    return res.render('auth/signin', { title: 'Sign in', error: 'Wrong email or password.' });
  req.session.userId = user.id; req.session.role = user.role;
  res.redirect(user.role === 'admin' ? '/portal/admin' : '/portal/member');
});

router.post('/signout', (req, res) => req.session.destroy(() => res.redirect('/portal/signin')));
module.exports = router;
