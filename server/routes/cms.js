/* ==========================================================================
   CMS admin routes.  Mounted at /portal/admin/cms

   A separate router rather than more handlers appended to routes/admin.js:
   that file gates on `router.use(requireAdmin)` at line 17, so anything added
   above it is silently public. A new file with its own explicit guard cannot
   be got wrong by a later edit.
   ========================================================================== */
'use strict';

const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const { requireAdmin } = require('../middleware/auth');
const { SiteContent, MediaAsset, User } = require('../models');
const cms = require('../cms');
const { uploadMedia, parseEmbed, uploadErrorMessage, UPLOAD_DIR, IMAGE_TYPES } = require('../utils/media');

router.use(requireAdmin);
router.use(async (req, res, next) => {
  try { res.locals.user = await User.findByPk(req.session.userId); } catch (e) {}
  next();
});

/* Admin fetch() calls want JSON on failure, not an HTML redirect. */
function wantsJson(req) {
  return req.get('X-Requested-With') === 'fetch' || (req.get('accept') || '').includes('application/json');
}

/* ---- editor -------------------------------------------------------------- */

router.get('/', (req, res) => res.redirect('/portal/admin/cms/page/global'));

/* The Pages sidebar shows a TEXT count, not the raw field count — pageList()'s
   count still includes images (their own tab now) and href companions (folded
   into their parent row), and showing "178" next to a page whose editor no
   longer has a Photographs group at all is the first thing anyone would
   notice was wrong. */
function sidebarPages() {
  return cms.pageList().map(p => ({ ...p, count: cms.textFieldCount(p.name) }));
}

/* Stored overrides restricted to ids the Pages editor actually renders on this
   page — i.e. not images. Without this, editing five photographs and two
   paragraphs on About would show "2 fields" worth of "edited" pills on screen
   but a "Reset all 7 edited fields" button at the bottom, five of which are
   nowhere on the page to look at first. */
function textEditedIds(pageName, stored) {
  const shown = new Set();
  for (const g of cms.groupsForPage(pageName)) {
    for (const f of g.fields) {
      shown.add(f.id);
      if (f.hrefField) shown.add(f.hrefField.id);
    }
  }
  return Object.keys(stored).filter(id => shown.has(id));
}

router.get('/page/:page', async (req, res) => {
  const pages = sidebarPages();
  const page = pages.find(p => p.name === req.params.page);
  if (!page) return res.status(404).render('error', { title: 'Not found', message: 'No such page in the CMS.' });

  const { values, stored } = await cms.valuesForPage(SiteContent, page.name);
  const media = await MediaAsset.findAll({ order: [['createdAt', 'DESC']], limit: 200 });

  res.render('admin/cms-page', {
    title: 'Website content',
    pages, page,
    groups: cms.groupsForPage(page.name),
    values,
    editedIds: textEditedIds(page.name, stored),
    media: media.map(m => ({ id: m.id, kind: m.kind, url: m.url, original: m.original, alt: m.alt, bytes: m.bytes })),
    saved: req.query.saved, errors: {}
  });
});

router.post('/page/:page', async (req, res) => {
  const pages = sidebarPages();
  const page = pages.find(p => p.name === req.params.page);
  if (!page) return res.status(404).send('Unknown page');

  const patch = {};
  for (const [k, v] of Object.entries(req.body || {})) {
    if (k === '_csrf') continue;
    // image/video arrive as f[<id>][src] style keys via express urlencoded
    patch[k] = v;
  }
  const result = await cms.savePatch(SiteContent, page.name, patch);

  if (wantsJson(req)) return res.json({ ok: true, ...result });
  if (Object.keys(result.errors).length) {
    const { values, stored } = await cms.valuesForPage(SiteContent, page.name);
    const media = await MediaAsset.findAll({ order: [['createdAt', 'DESC']], limit: 200 });
    return res.status(400).render('admin/cms-page', {
      title: 'Website content', pages, page,
      groups: cms.groupsForPage(page.name), values,
      editedIds: textEditedIds(page.name, stored),
      media: media.map(m => ({ id: m.id, kind: m.kind, url: m.url, original: m.original, alt: m.alt, bytes: m.bytes })),
      saved: null, errors: result.errors
    });
  }
  res.redirect(`/portal/admin/cms/page/${page.name}?saved=${result.changed.length}`);
});

/* ---- images -------------------------------------------------------------- */

/* Every photograph on the site, grouped by the real page it lives on — not the
   heading-derived groups the Pages editor uses. One screen, no accordions:
   32 fields across the whole site is short enough to just scroll. */
router.get('/images', async (req, res) => {
  const pages = cms.imagePages();
  const perPage = await Promise.all(pages.map(async p => {
    const { values } = await cms.valuesForPage(SiteContent, p.name);
    return { ...p, fields: cms.imageFieldsForPage(p.name).map(f => ({ ...f, value: values[f.id] || {} })) };
  }));
  const media = await MediaAsset.findAll({ where: { kind: 'image' }, order: [['createdAt', 'DESC']], limit: 200 });

  res.render('admin/cms-images', {
    title: 'Photographs',
    pages: perPage,
    media: media.map(m => ({ id: m.id, kind: m.kind, url: m.url, original: m.original, alt: m.alt, bytes: m.bytes })),
    saved: req.query.saved
  });
});

/* Put a field back to whatever the original HTML says. */
router.post('/reset/:page', async (req, res) => {
  const ids = [].concat(req.body.id || []);
  const out = await cms.resetFields(SiteContent, req.params.page, ids);
  if (wantsJson(req)) return res.json({ ok: true, ...out });
  res.redirect(`/portal/admin/cms/page/${req.params.page}?saved=0`);
});

/* ---- click-to-edit support ---------------------------------------------- */

/* The public pages ask this whether to show the editing toolbar. Deliberately
   cheap and side-effect free. Returns the CSRF token so the overlay can save
   without scraping a form. */
router.get('/session', (req, res) => {
  res.json({
    ok: true, admin: true,
    name: res.locals.user ? res.locals.user.name : null,
    csrfToken: res.locals.csrfToken
  });
});

/* The overlay needs to know which elements are editable and how. */
router.get('/schema/:page', (req, res) => {
  const wanted = req.params.page;
  const fields = cms.FIELDS
    .filter(f => f.page === wanted || f.page === 'global')
    .map(f => ({ id: f.id, type: f.type, label: f.label, group: f.group, role: f.role,
                 attr: (f.target && f.target.attr) || null, selector: (f.target && f.target.selector) || null }));
  res.json({ ok: true, page: wanted, fields });
});

/* Single-field save from the overlay. */
router.post('/inline/:page', async (req, res) => {
  const { id, value } = req.body || {};
  const field = cms.BY_ID.get(id);
  if (!field) return res.status(400).json({ ok: false, error: 'unknown_field' });
  if (field.page !== req.params.page && field.page !== 'global')
    return res.status(400).json({ ok: false, error: 'wrong_page' });
  const target = field.page === 'global' ? 'global' : field.page;
  const out = await cms.savePatch(SiteContent, target, { [id]: value });
  if (out.errors[id]) return res.status(400).json({ ok: false, error: 'invalid', message: out.errors[id] });
  res.json({ ok: true, changed: out.changed.length > 0, global: field.page === 'global' });
});

/* ---- media library ------------------------------------------------------ */

router.get('/media', async (req, res) => {
  const media = await MediaAsset.findAll({ order: [['createdAt', 'DESC']], limit: 500 });
  res.render('admin/cms-media', {
    title: 'Media library', pages: cms.pageList(),
    media, saved: req.query.saved, error: req.query.error
  });
});

router.post('/media', (req, res, next) => {
  uploadMedia.single('file')(req, res, err => {
    if (err) {
      const msg = uploadErrorMessage(err);
      if (wantsJson(req)) return res.status(400).json({ ok: false, error: 'upload', message: msg });
      return res.status(400).render('error', { title: 'Upload failed', message: msg });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) {
    if (wantsJson(req)) return res.status(400).json({ ok: false, message: 'No file received.' });
    return res.redirect('/portal/admin/cms/media?error=nofile');
  }
  const ext = path.extname(req.file.filename).toLowerCase();
  const asset = await MediaAsset.create({
    kind: IMAGE_TYPES[ext] ? 'image' : 'video',
    filename: req.file.filename,
    original: req.file.originalname,
    url: '/uploads/' + req.file.filename,
    mimetype: req.file.mimetype,
    bytes: req.file.size,
    alt: String((req.body && req.body.alt) || '').slice(0, 300),
    uploadedBy: req.session.userId
  });
  if (wantsJson(req)) return res.json({ ok: true, asset: { id: asset.id, kind: asset.kind, url: asset.url, original: asset.original } });
  res.redirect('/portal/admin/cms/media?saved=1');
});

/* Turn a pasted YouTube/Vimeo link into a canonical embed, so the raw string
   never reaches an iframe src. */
router.post('/media/embed', (req, res) => {
  const parsed = parseEmbed(req.body && req.body.url);
  if (!parsed) return res.status(400).json({ ok: false, message: 'That does not look like a YouTube or Vimeo link.' });
  res.json({ ok: true, ...parsed });
});

router.post('/media/:id/delete', async (req, res) => {
  const asset = await MediaAsset.findByPk(req.params.id);
  if (asset) {
    // Remove the row first: a dangling file is harmless, a row pointing at a
    // missing file shows the admin a broken thumbnail.
    const file = path.join(UPLOAD_DIR, asset.filename);
    await asset.destroy();
    fs.promises.unlink(file).catch(() => {});
  }
  if (wantsJson(req)) return res.json({ ok: true });
  res.redirect('/portal/admin/cms/media?saved=1');
});

module.exports = router;
