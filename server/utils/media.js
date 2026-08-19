/* ==========================================================================
   Upload handling for the CMS media library.

   Replaces the ad-hoc multer instance that lived in routes/admin.js, which had
   no fileFilter, no mimetype check and no extension allowlist. Because
   /uploads is served from the same origin as the portal session cookie, an
   uploaded .html or .svg was first-party executable script — stored XSS with
   full portal privileges. Everything here exists to close that.

   Two instances, because image and video want very different size ceilings:
     uploadImage  — 6 MB
     uploadVideo  — 200 MB   (also needs nginx client_max_body_size raising)
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');

// multer's diskStorage does not mkdir. The repo ships uploads/.gitkeep so this
// normally exists, but a fresh clone that skipped it, or a host bind-mount
// pointing somewhere new, would throw ENOENT on the first upload.
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* Extension -> allowed mimetypes. Both must agree, so renaming evil.html to
   evil.png does not get through (multer reports the browser's mimetype) and
   neither does a real PNG served under a .html name. */
const IMAGE_TYPES = {
  '.jpg':  ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.png':  ['image/png'],
  '.webp': ['image/webp'],
  '.gif':  ['image/gif'],
  '.avif': ['image/avif']
};
// .svg is deliberately absent: SVG is an XML document that can carry <script>,
// and it renders as a document when opened directly. If the client ever needs
// SVG logos, sanitise server-side first or serve uploads from another host.
const VIDEO_TYPES = {
  '.mp4':  ['video/mp4'],
  '.webm': ['video/webm'],
  '.mov':  ['video/quicktime'],
  '.m4v':  ['video/x-m4v', 'video/mp4']
};

function makeFilter(table, label) {
  return function (req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const allowed = table[ext];
    if (!allowed) {
      return cb(Object.assign(new Error(
        `${label} must be one of: ${Object.keys(table).join(', ')} — got "${ext || 'no extension'}".`
      ), { status: 400, code: 'BAD_EXT' }));
    }
    if (!allowed.includes(file.mimetype)) {
      return cb(Object.assign(new Error(
        `That file says it is ${file.mimetype}, which does not match its ${ext} extension.`
      ), { status: 400, code: 'BAD_MIME' }));
    }
    cb(null, true);
  };
}

/* Random name + validated extension. The old scheme was Date.now() + the
   original filename, which could collide within a millisecond and leaked
   upload timing. The original name is kept separately in the DB for display. */
function storage() {
  return multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) =>
      cb(null, crypto.randomUUID() + path.extname(file.originalname || '').toLowerCase())
  });
}

const uploadImage = multer({
  storage: storage(),
  fileFilter: makeFilter(IMAGE_TYPES, 'Images'),
  limits: { fileSize: 6 * 1024 * 1024, files: 1, fields: 60, parts: 70 }
});

const uploadVideo = multer({
  storage: storage(),
  fileFilter: makeFilter(VIDEO_TYPES, 'Videos'),
  limits: { fileSize: 200 * 1024 * 1024, files: 1, fields: 60, parts: 70 }
});

/* Certificate files — an image OR a PDF. PDFs are not in the media library
   because MediaAsset.kind is ENUM('image','video') and that table is already
   live; a bare sequelize.sync() cannot extend an enum, so documents live in
   their own CertificateFile table instead. */
const DOC_TYPES = Object.assign({ '.pdf': ['application/pdf'] }, IMAGE_TYPES);

const uploadDoc = multer({
  storage: storage(),
  fileFilter: makeFilter(DOC_TYPES, 'Certificates'),
  limits: { fileSize: 12 * 1024 * 1024, files: 1, fields: 40, parts: 50 }
});

/* Accepts either field name, so one endpoint can take an image or a video. */
const uploadMedia = multer({
  storage: storage(),
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (IMAGE_TYPES[ext]) return makeFilter(IMAGE_TYPES, 'Images')(req, file, cb);
    if (VIDEO_TYPES[ext]) return makeFilter(VIDEO_TYPES, 'Videos')(req, file, cb);
    cb(Object.assign(new Error(
      `Unsupported file type "${ext || 'none'}". Allowed: ${Object.keys(IMAGE_TYPES).concat(Object.keys(VIDEO_TYPES)).join(', ')}.`
    ), { status: 400, code: 'BAD_EXT' }));
  },
  limits: { fileSize: 200 * 1024 * 1024, files: 1, fields: 60, parts: 70 }
});

/* ---- embed URLs -----------------------------------------------------------
   The client can paste a YouTube or Vimeo link instead of uploading. Parse it
   into a canonical embed URL rather than trusting the string into an iframe
   src, so a javascript: or data: URL can never reach the page. */
function parseEmbed(raw) {
  const url = String(raw || '').trim();
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.replace(/^www\./, '').toLowerCase();

  // YouTube: watch?v=, youtu.be/<id>, /embed/<id>, /shorts/<id>
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com' || host === 'youtu.be') {
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = u.pathname.match(/^\/(?:embed|shorts|v)\/([^/?#]+)/);
      if (m) id = m[1];
    }
    if (!id || !/^[\w-]{6,20}$/.test(id)) return null;
    // nocookie host: no tracking cookie until the visitor actually plays it
    return { provider: 'youtube', id, embedUrl: `https://www.youtube-nocookie.com/embed/${id}`,
             thumbUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` };
  }

  // Vimeo: /<id>, /video/<id>, player.vimeo.com/video/<id>
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = u.pathname.match(/(?:^|\/)(\d{6,12})(?:$|[/?#])/);
    if (!m) return null;
    return { provider: 'vimeo', id: m[1], embedUrl: `https://player.vimeo.com/video/${m[1]}`, thumbUrl: null };
  }

  return null;
}

/* Turn a multer error into a message worth showing a non-technical admin. */
function uploadErrorMessage(err) {
  if (!err) return null;
  if (err.code === 'LIMIT_FILE_SIZE') return 'That file is too large. Images must be under 6 MB, certificates under 12 MB, videos under 200 MB.';
  if (err.code === 'BAD_EXT' || err.code === 'BAD_MIME') return err.message;
  if (err.code === 'LIMIT_UNEXPECTED_FILE') return 'Unexpected upload field.';
  return 'Upload failed: ' + (err.message || 'unknown error');
}

module.exports = {
  UPLOAD_DIR, IMAGE_TYPES, VIDEO_TYPES, DOC_TYPES,
  uploadImage, uploadVideo, uploadMedia, uploadDoc,
  parseEmbed, uploadErrorMessage
};
