function requireLogin(req, res, next) {
  if (!req.session.userId) return res.redirect('/portal/signin');
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.redirect('/portal/signin');
  if (req.session.role !== 'admin') return res.status(403).render('error', { title: 'Forbidden', message: 'Admin access only.' });
  next();
}
module.exports = { requireLogin, requireAdmin };
