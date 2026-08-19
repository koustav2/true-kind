/* ==========================================================================
   CMS runtime.

   Loads the generated registry and mediates every read and write of site
   content. Both the admin form UI and the public hydration API go through here,
   so validation lives in exactly one place.

   Storage note: everything lives in EXISTING tables. The app runs a bare
   `sequelize.sync()` with no migration tool, which creates new tables but will
   NOT add a column to an existing one — a new column would be defined in the
   model, absent from the database, and blow up at query time on the live
   deployment. So content goes into `SiteContent.data` (already a JSON column)
   keyed by page, and the media library gets a brand-new table, which sync
   creates safely.
   ========================================================================== */
'use strict';

const path = require('path');
const fs = require('fs');

const REGISTRY_PATH = path.join(__dirname, 'registry.json');

let registry = { pages: [], fields: [] };
try {
  registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
} catch (e) {
  console.error('✗ CMS registry missing or unreadable. Run `npm run cms:build`.', e.message);
}

const FIELDS = registry.fields || [];
const BY_ID = new Map(FIELDS.map(f => [f.id, f]));

/* One SiteContent row per page, plus one for the shared header/footer. Keeping
   it to ~10 rows instead of 545 means a page edit is a single row write and the
   public bundle is a single row read. */
const PAGE_KEYS = (registry.pages || []).map(p => p.name);
const rowKeyFor = field => (field.page === 'global' ? 'cms:global' : `cms:${field.page}`);
const ALL_ROW_KEYS = ['cms:global', ...PAGE_KEYS.map(p => `cms:${p}`)];

/* ---- shaping for the admin UI -------------------------------------------- */

/* Fields for one page, arranged into the groups the generator derived, with
   `href` companions folded into their parent so the admin sees "Button label"
   and "Button destination" side by side rather than 55 orphan URL rows. */
function groupsForPage(pageName) {
  const own = FIELDS.filter(f => f.page === pageName);
  const hrefIds = new Set(own.filter(f => f.role === 'href').map(f => f.id));
  const order = [];
  const groups = new Map();
  for (const f of own) {
    if (hrefIds.has(f.id)) continue;                 // attached to its parent below
    const g = f.group || 'Page';
    if (!groups.has(g)) { groups.set(g, []); order.push(g); }
    const item = { ...f };
    const companion = own.find(x => x.id === f.id + '.href');
    if (companion) item.hrefField = companion;
    groups.get(g).push(item);
  }
  // Video slots last: they are additive, not corrections to existing copy.
  const idx = order.indexOf('Video');
  if (idx > -1) { order.splice(idx, 1); order.push('Video'); }
  return order.map(name => ({
    name,
    // Headings make honest group names but some run long in a sidebar.
    short: name.length > 38 ? name.slice(0, 37).trimEnd() + '…' : name,
    fields: groups.get(name)
  }));
}

function pageList() {
  const pages = [{ name: 'global', label: 'Header & footer (all pages)', file: null }];
  for (const p of (registry.pages || [])) pages.push({ ...p });
  return pages.map(p => ({ ...p, count: FIELDS.filter(f => f.page === p.name && f.role !== 'href').length }));
}

/* ---- validation ---------------------------------------------------------- */

/* Inline markup the client may keep in a richtext field. Anything else is
   stripped, so a paste from Word cannot smuggle a <script>, an onclick, or a
   javascript: href onto the public site. The CMS is admin-only, but an admin
   pasting from an untrusted source should not be able to XSS their own visitors.
*/
const ALLOWED_INLINE = /^(a|em|strong|b|i|span|br|small|sup|sub|code|abbr|u|s|mark|time)$/i;

function sanitizeRichtext(html) {
  let out = String(html == null ? '' : html);
  // Drop anything that is not on the inline allowlist, keeping inner text.
  out = out.replace(/<\/?([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (m, tag, attrs) => {
    if (!ALLOWED_INLINE.test(tag)) return '';
    if (m[1] === '/') return `</${tag.toLowerCase()}>`;
    const kept = [];
    const re = /([a-zA-Z-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g;
    let a;
    while ((a = re.exec(attrs))) {
      const name = a[1].toLowerCase();
      let val = a[2].replace(/^["']|["']$/g, '');
      if (name.startsWith('on')) continue;                       // no event handlers
      if (name === 'style') continue;                            // no inline CSS
      if (name === 'href') {
        // Relative, http(s), mailto and tel only. Blocks javascript:/data:.
        const safe = /^(https?:\/\/|mailto:|tel:|\/|#|[\w.-]+\.html)/i.test(val.trim());
        if (!safe) continue;
        kept.push(`href="${escapeAttr(val)}"`);
        continue;
      }
      if (['class', 'title', 'target', 'rel', 'datetime', 'aria-label', 'data-year', 'aria-hidden'].includes(name)) {
        kept.push(`${name}="${escapeAttr(val)}"`);
      }
    }
    return `<${tag.toLowerCase()}${kept.length ? ' ' + kept.join(' ') : ''}>`;
  });
  return out.trim();
}
const escapeAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function safeUrl(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (/^(https?:\/\/|mailto:|tel:|\/|#)/i.test(s)) return s;
  if (/^[\w.\-/]+(\.html)?(#[\w-]+)?$/i.test(s)) return s;      // relative page link
  return '';                                                     // reject the rest
}

const MAX = { text: 400, textarea: 8000, richtext: 12000, url: 500 };

/* Validate one submitted value against its registry entry.
   Returns { value } or { error }. */
function coerce(field, raw) {
  switch (field.type) {
    case 'text': {
      const v = String(raw == null ? '' : raw).replace(/[\r\n]+/g, ' ').trim();
      if (v.length > MAX.text) return { error: `Too long — keep this under ${MAX.text} characters.` };
      return { value: v };
    }
    case 'textarea': {
      const v = String(raw == null ? '' : raw).replace(/\r\n/g, '\n').trim();
      if (v.length > MAX.textarea) return { error: `Too long — keep this under ${MAX.textarea} characters.` };
      return { value: v };
    }
    case 'richtext': {
      const v = sanitizeRichtext(raw);
      if (v.length > MAX.richtext) return { error: `Too long — keep this under ${MAX.richtext} characters.` };
      return { value: v };
    }
    case 'url': {
      const v = safeUrl(raw);
      if (raw && !v) return { error: 'That link is not allowed. Use a page name, a full https:// address, mailto: or tel:.' };
      return { value: v };
    }
    case 'image': {
      const o = raw && typeof raw === 'object' ? raw : {};
      return { value: { src: safeMediaPath(o.src), alt: String(o.alt || '').trim().slice(0, 300) } };
    }
    case 'video': {
      const o = raw && typeof raw === 'object' ? raw : {};
      const mode = o.mode === 'upload' || o.mode === 'embed' ? o.mode : '';
      return { value: {
        mode,
        src:      mode === 'upload' ? safeMediaPath(o.src) : '',
        embedUrl: mode === 'embed'  ? safeEmbedUrl(o.embedUrl) : '',
        provider: mode === 'embed'  ? String(o.provider || '').slice(0, 20) : '',
        poster:   safeMediaPath(o.poster),
        caption:  String(o.caption || '').trim().slice(0, 300)
      } };
    }
    default:
      return { error: `Unknown field type "${field.type}".` };
  }
}

/* Media must be something we served: an /uploads path or a bundled asset. */
function safeMediaPath(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (/^\/uploads\/[\w.-]+$/.test(s)) return s;
  if (/^assets\/img\/[\w.-]+$/.test(s)) return s;
  if (/^\/assets\/img\/[\w.-]+$/.test(s)) return s;
  return '';
}
function safeEmbedUrl(v) {
  const s = String(v == null ? '' : v).trim();
  if (/^https:\/\/www\.youtube-nocookie\.com\/embed\/[\w-]{6,20}$/.test(s)) return s;
  if (/^https:\/\/player\.vimeo\.com\/video\/\d{6,12}$/.test(s)) return s;
  return '';
}

/* ---- read / write -------------------------------------------------------- */

async function readRow(SiteContent, key) {
  const row = await SiteContent.findOne({ where: { key } });
  return (row && row.data) || {};
}

/* Values for one page, merged over the registry defaults so the admin form is
   always populated with what the visitor currently sees — whether that came
   from the database or from the original HTML. */
async function valuesForPage(SiteContent, pageName) {
  const stored = await readRow(SiteContent, pageName === 'global' ? 'cms:global' : `cms:${pageName}`);
  const out = {};
  for (const f of FIELDS.filter(f => f.page === pageName)) {
    out[f.id] = Object.prototype.hasOwnProperty.call(stored, f.id) ? stored[f.id] : f.default;
  }
  return { values: out, stored };
}

/* Apply a patch of {fieldId: value}. Only ids present in the registry are
   accepted, and each is validated by its own declared type. Returns which ids
   changed and any per-field errors, so the form can redisplay them in place. */
async function savePatch(SiteContent, pageName, patch) {
  const key = pageName === 'global' ? 'cms:global' : `cms:${pageName}`;
  const errors = {};
  const accepted = {};

  for (const [id, raw] of Object.entries(patch || {})) {
    const field = BY_ID.get(id);
    if (!field) continue;                                  // unknown id: ignore silently
    if (field.page !== pageName) continue;                 // cross-page write: refuse
    const res = coerce(field, raw);
    if (res.error) { errors[id] = res.error; continue; }
    accepted[id] = res.value;
  }

  const [row] = await SiteContent.findOrCreate({ where: { key }, defaults: { data: {} } });
  const before = row.data || {};
  const changed = Object.keys(accepted).filter(id => JSON.stringify(before[id]) !== JSON.stringify(accepted[id]));

  // Whole-object reassignment: Sequelize does not mark an in-place mutation of a
  // JSON column as dirty, so `row.data[id] = v` would not persist.
  row.data = { ...before, ...accepted };
  await row.save();

  return { changed, errors, saved: Object.keys(accepted).length };
}

/* Reset fields back to the original HTML by deleting the stored override. */
async function resetFields(SiteContent, pageName, ids) {
  const key = pageName === 'global' ? 'cms:global' : `cms:${pageName}`;
  const row = await SiteContent.findOne({ where: { key } });
  if (!row) return { cleared: 0 };
  const data = { ...(row.data || {}) };
  let cleared = 0;
  for (const id of ids) if (Object.prototype.hasOwnProperty.call(data, id)) { delete data[id]; cleared++; }
  row.data = data;
  await row.save();
  return { cleared };
}

/* ---- the public bundle --------------------------------------------------- */

/* Everything one page needs, in a single request: only the fields the admin has
   actually overridden. Defaults are already in the HTML, so shipping them again
   would double the payload and risk overwriting good markup with a stale copy. */
async function bundleForPage(SiteContent, pageName) {
  const [globalData, pageData] = await Promise.all([
    readRow(SiteContent, 'cms:global'),
    readRow(SiteContent, `cms:${pageName}`)
  ]);
  const pick = (data, page) => {
    const out = {};
    for (const [id, value] of Object.entries(data)) {
      const f = BY_ID.get(id);
      if (!f || f.page !== page) continue;
      out[id] = { t: f.type, v: value, a: (f.target && f.target.attr) || null, s: (f.target && f.target.selector) || null };
    }
    return out;
  };
  return { page: pageName, fields: { ...pick(globalData, 'global'), ...pick(pageData, pageName) } };
}

module.exports = {
  registry, FIELDS, BY_ID, PAGE_KEYS, ALL_ROW_KEYS, rowKeyFor,
  groupsForPage, pageList, valuesForPage, savePatch, resetFields, bundleForPage,
  sanitizeRichtext, safeUrl, safeMediaPath, safeEmbedUrl, coerce
};
