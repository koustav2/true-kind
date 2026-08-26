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
const sections = require('./sections');   // plain section names, moves, hides

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
const rowKeyForPage = page => (page === 'global' ? 'cms:global' : `cms:${page}`);
const rowKeyFor = field => rowKeyForPage(field.page);
const ALL_ROW_KEYS = ['cms:global', ...PAGE_KEYS.map(p => `cms:${p}`)];

/* ---- shaping for the admin UI -------------------------------------------- */

/* Cut a long group name at a WORD boundary, not a character count.
   Group names for anything the generator could not name from a declared slot
   are the page's own heading text, verbatim — "Kindness works better when
   it's organized." — and the flat `slice(0, 37) + '…'` this replaced cut
   straight through the middle of a word ("…organ…"). That reads as garbled
   text, not as a shortened one; a plain reader has no way to tell truncation
   from a typo. Cutting back to the last space before the limit keeps every
   group name a run of whole words, at the cost of sometimes landing a few
   characters short of the max — a trade worth making for something that has
   to be scanned, not measured. */
function truncateGroup(name, max) {
  if (name.length <= max) return name;
  const cut = name.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  // Only back off to the last space if that still leaves a reasonable amount
  // of text — a name with no early space (one very long word) falls back to
  // the hard cut rather than truncating to almost nothing.
  const safe = sp > max * 0.55 ? cut.slice(0, sp) : cut;
  return safe.trimEnd() + '…';
}

/* Rows inside a section are in the order they appear on the page — the same
   rule the sections themselves follow, using the position build-registry.js
   stamped on each field.

   This replaced a cleverer scheme that grouped fields by a shared id prefix and
   pulled photographs to the front of their section. It read well on a programme
   card and badly everywhere else: merging the header and footer into one
   section put the footer logo second, above the menu links, because both logos
   were "photographs" and photographs went first. One rule that matches what the
   editor is looking at beats two rules that argue.

   Fields with no position are the <head> ones — the browser tab title and the
   share text. They keep the order they were declared in. */
function orderGroupFields(fields) {
  return fields
    .map((f, i) => ({ f, i }))
    .sort((a, b) => {
      const pa = typeof a.f.pos === 'number' ? a.f.pos : Infinity;
      const pb = typeof b.f.pos === 'number' ? b.f.pos : Infinity;
      return pa - pb || a.i - b.i;
    })
    .map(x => x.f);
}

/* Fields for one page, arranged into the groups the generator derived, with
   `href` companions folded into their parent so the admin sees "Button label"
   and "Button destination" side by side rather than 55 orphan URL rows.

   IMAGES ARE INCLUDED, in the section they belong to. They used to be excluded
   here and given a screen of their own — every photograph on the site in one
   flat list, one menu away from the text it sits beside. That made the two
   halves of a single section impossible to edit together and, in practice,
   made the photo controls hard to find at all: somebody looking for the Get
   Involved picture opened Get Involved and there was no picture on it.
   A photograph is now edited exactly where its words are, and only there. */
/* `storedIds` — the ids this page already has a saved value for. Only hidden
   fields need it: one that has been written to before must still be visible,
   or an edit somebody made is trapped where nobody can see or undo it. Pass
   nothing and hidden fields are simply absent, which is what the counts and
   the tests want. */
function groupsForPage(pageName, storedIds) {
  const stored = storedIds instanceof Set ? storedIds : new Set(storedIds || []);
  /* The parent's own fields, then any merged child's — with their positions
     pushed past the parent's so the child's sections land at the bottom rather
     than interleaving with a page they are not on. */
  const own = FIELDS.filter(f => f.page === pageName).concat(
    ...mergedChildren(pageName).map((child, i) =>
      FIELDS.filter(f => f.page === child).map(f => ({
        ...f,
        pos: (typeof f.pos === 'number' ? f.pos : 0) + 1e6 * (i + 1),
        fromPage: child
      }))));
  const hrefIds = new Set(own.filter(f => f.role === 'href').map(f => f.id));
  const rename = sections.renameFor(pageName);
  const order = [];
  const groups = new Map();
  const add = (name, item) => {
    if (!groups.has(name)) { groups.set(name, []); order.push(name); }
    groups.get(name).push(item);
  };

  for (const f of own) {
    if (hrefIds.has(f.id)) continue;                 // attached to its parent below
    const hidden = sections.hiddenReason(f.id);
    if (hidden && !stored.has(f.id)) continue;       // see sections.js for why each one

    const item = { ...f };
    const companion = own.find(x => x.id === f.id + '.href');
    if (companion) item.hrefField = companion;

    if (hidden) { item.strandedReason = hidden; add(sections.STRANDED, item); continue; }
    const generated = f.group || 'Page';
    const map = f.fromPage ? sections.renameFor(f.fromPage) : rename;
    let name = sections.sectionFor(f.id) || map[generated] || sections.PLAIN[generated] || generated;
    /* A merged child's sections carry the page name, so it is obvious which
       page they belong to — except the one already named after the page. */
    if (f.fromPage) {
      const label = pageLabel(f.fromPage);
      name = name === label ? label : `${label} — ${name.charAt(0).toLowerCase()}${name.slice(1)}`;
    }
    add(name, item);
  }

  /* Sections come out in the order they appear ON THE PAGE, using the position
     build-registry.js stamped on each field. A section sits where its earliest
     field sits. Head fields (the browser tab title and the share text) carry no
     position and sort to the top, ahead of the page body.

     'Video' used to be pinned last on every page. It is a real block in a real
     place, so it now sorts like everything else. */
  const at = name => {
    const ps = groups.get(name).map(f => f.pos).filter(p => typeof p === 'number');
    return ps.length ? Math.min(...ps) : -1;         // -1 = <head>, sorts first
  };
  order.sort((a, b) => at(a) - at(b));

  /* Except the stranded duplicates, which are cleanup rather than content and
     belong out of the way at the bottom. */
  const s = order.indexOf(sections.STRANDED);
  if (s > -1) { order.splice(s, 1); order.push(sections.STRANDED); }

  const notes = (sections.SECTION_NOTES || {})[pageName] || {};
  return order.map(name => ({
    name,
    /* 64, not 44. The old limit was sized for section names lifted straight
       off the page — whole sentences. Names are written by hand now, and the
       longest ("Chairperson's Message — page title & share text") is 47. */
    short: truncateGroup(name, 64),
    note: notes[name] || null,
    fields: orderGroupFields(groups.get(name))
  }));
}

/* How many rows the Pages editor will actually draw for this page — used for
   the sidebar count. Deliberately NOT "every field with this page name": href
   companions are folded into their parent field rather than getting a row of
   their own, so the raw total reads as a typo the moment somebody counts what
   is on screen. Photographs ARE counted, because they are now on screen. */
function editorFieldCount(pageName, storedIds) {
  return groupsForPage(pageName, storedIds).reduce((n, g) => n + g.fields.length, 0);
}

/* A page whose fields are edited INSIDE another page's editor.

   Chairperson's Message is its own HTML file with its own web address, so the
   registry keeps it as its own page — but nobody using the admin thinks of it
   that way. It is reached from About Us, its own breadcrumb reads
   "Home / About Us / Chairperson's Message", and it is not in the top menu.
   So it gets no row in the sidebar: its sections are listed at the bottom of
   the About Us editor, each prefixed with the page name, and every value still
   saves into that page's own database row and reaches its own web address.

   This is the only mechanism in here that lets one editor write to two pages,
   so it is deliberately a short, explicit list rather than something inferred. */
const MERGED_INTO = { 'chairperson-message': 'about' };

const mergedChildren = parent =>
  Object.keys(MERGED_INTO).filter(c => MERGED_INTO[c] === parent);

const pageLabel = name => {
  const p = (registry.pages || []).find(x => x.name === name);
  return (p && p.label) || name;
};

function pageList() {
  const pages = [{ name: 'global', label: 'Header & footer (all pages)', file: null }];
  for (const p of (registry.pages || [])) pages.push({ ...p });

  // A merged child has no row of its own — it is edited inside its parent.
  const merged = new Set(Object.keys(MERGED_INTO));
  return pages
    .filter(p => !merged.has(p.name))
    .map(p => ({ ...p, count: FIELDS.filter(f => f.page === p.name && f.role !== 'href').length }));
}

/* The Photographs tab that used to live here is gone. Its two helpers
   (imagePages / imageFieldsForPage) went with it — every photograph is now a
   field in its own section of the Pages editor, so there is nothing left that
   needs the "all images, flat, by page" view they existed to build. */

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
  const pages = [pageName, ...mergedChildren(pageName)];
  const rows = await Promise.all(pages.map(p => readRow(SiteContent, rowKeyForPage(p))));
  const stored = Object.assign({}, ...rows);
  const out = {};
  for (const p of pages) {
    for (const f of FIELDS.filter(f => f.page === p)) {
      out[f.id] = Object.prototype.hasOwnProperty.call(stored, f.id) ? stored[f.id] : f.default;
    }
  }
  return { values: out, stored };
}

/* Apply a patch of {fieldId: value}. Only ids present in the registry are
   accepted, and each is validated by its own declared type. Returns which ids
   changed and any per-field errors, so the form can redisplay them in place. */
async function savePatch(SiteContent, pageName, patch) {
  /* One editor may cover more than one page (see MERGED_INTO), so a field is
     written to ITS OWN page's row, never to the row of the screen it was typed
     on. Anything outside that set is still refused. */
  const allowed = new Set([pageName, ...mergedChildren(pageName)]);
  const errors = {};
  const byPage = new Map();                                // page -> {id: value}

  for (const [id, raw] of Object.entries(patch || {})) {
    const field = BY_ID.get(id);
    if (!field) continue;                                  // unknown id: ignore silently
    if (!allowed.has(field.page)) continue;                // cross-page write: refuse
    const res = coerce(field, raw);
    if (res.error) { errors[id] = res.error; continue; }
    if (!byPage.has(field.page)) byPage.set(field.page, {});
    byPage.get(field.page)[id] = res.value;
  }

  const changed = [];
  let saved = 0;
  for (const [page, accepted] of byPage) {
    const [row] = await SiteContent.findOrCreate({
      where: { key: rowKeyForPage(page) }, defaults: { data: {} }
    });
    const before = row.data || {};
    for (const id of Object.keys(accepted)) {
      if (JSON.stringify(before[id]) !== JSON.stringify(accepted[id])) changed.push(id);
    }
    // Whole-object reassignment: Sequelize does not mark an in-place mutation of
    // a JSON column as dirty, so `row.data[id] = v` would not persist.
    row.data = { ...before, ...accepted };
    await row.save();
    saved += Object.keys(accepted).length;
  }

  return { changed, errors, saved };
}

/* Reset fields back to the original HTML by deleting the stored override. */
async function resetFields(SiteContent, pageName, ids) {
  // Same routing as savePatch: an id belongs to its own page's row.
  const allowed = new Set([pageName, ...mergedChildren(pageName)]);
  const byPage = new Map();
  for (const id of ids) {
    const field = BY_ID.get(id);
    const page = field && allowed.has(field.page) ? field.page : null;
    if (!page) continue;
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push(id);
  }
  let cleared = 0;
  for (const [page, list] of byPage) {
    const row = await SiteContent.findOne({ where: { key: rowKeyForPage(page) } });
    if (!row) continue;
    const data = { ...(row.data || {}) };
    for (const id of list) if (Object.prototype.hasOwnProperty.call(data, id)) { delete data[id]; cleared++; }
    row.data = data;
    await row.save();
  }
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
  registry, FIELDS, BY_ID, PAGE_KEYS, ALL_ROW_KEYS, rowKeyFor, rowKeyForPage, sections,
  MERGED_INTO, mergedChildren,
  groupsForPage, editorFieldCount, pageList,
  valuesForPage, savePatch, resetFields, bundleForPage,
  sanitizeRichtext, safeUrl, safeMediaPath, safeEmbedUrl, coerce
};
