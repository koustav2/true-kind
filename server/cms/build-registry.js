#!/usr/bin/env node
/* ==========================================================================
   CMS registry builder.        Run with:  npm run cms:build

   The site has ~300 editable blocks across 9 static HTML pages. Hand-writing a
   field list that big guarantees drift: someone edits a heading in the HTML, the
   registry still names the old one, and the admin form silently stops matching
   the page. So the registry is GENERATED from the pages themselves.

   What this does, per page:
     1. parses the HTML
     2. finds every editable thing — text blocks, images, links, meta tags
     3. stamps each one with a stable `data-cms="<id>"` attribute, writing the
        HTML back in place
     4. injects the declared video-slot containers from ./video-slots.js
     5. emits registry.json — the single source of truth that both the admin
        form builder and the public hydration script read

   IDEMPOTENT BY DESIGN. An element that already carries a data-cms id keeps it,
   so re-running after an HTML edit assigns ids only to genuinely new elements
   and never renumbers existing ones. That is what stops saved content from
   detaching from its field when the markup shifts. Run it as often as you like.

   Header and footer are identical on all 9 pages, so they are walked in the
   same deterministic order and land under `global.*` ids — the client edits the
   footer once and it changes everywhere.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const VIDEO_SLOTS = require('./video-slots');
const IMAGE_SLOTS = require('./image-slots');
const TEXT_SLOTS  = require('./text-slots');

const ROOT = path.join(__dirname, '..', '..');
const PAGES = [
  { file: 'index.html',               name: 'index',               label: 'Homepage' },
  { file: 'about.html',               name: 'about',               label: 'About Us' },
  { file: 'work.html',                name: 'work',                label: 'Our Work' },
  { file: 'impact.html',              name: 'impact',              label: 'Our Impact' },
  { file: 'donate.html',              name: 'donate',              label: 'Donate' },
  { file: 'volunteer.html',           name: 'volunteer',           label: 'Volunteer' },
  { file: 'contact.html',             name: 'contact',             label: 'Contact' },
  { file: 'press-release.html',       name: 'press-release',       label: 'Press' },
  { file: 'chairperson-message.html', name: 'chairperson-message', label: "Chairperson's Message" }
];

/* Inline tags that may live INSIDE an editable text block without splitting it.
   A block containing any of these is `richtext`, and the admin edits the markup
   so the <em> in "it's <em>organized</em>" survives a save. */
const INLINE = new Set(['a', 'em', 'strong', 'b', 'i', 'span', 'br', 'small',
                        'sup', 'sub', 'code', 'abbr', 'u', 's', 'mark', 'time', 'wbr']);

/* Never editable: structural, scripted or decorative. */
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'path', 'circle',
                           'rect', 'line', 'polyline', 'polygon', 'g', 'defs',
                           'lineargradient', 'stop', 'use', 'symbol', 'title',
                           'template', 'iframe', 'video', 'source', 'track']);

const slug = s => String(s || '').toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
const squash = s => String(s || '').replace(/\s+/g, ' ').trim();

/* ----------------------------------------------------------------------------
   Per-scope id allocator. Ids look like `index.h1.1`, `global.footer.p.3`.
   Counters are seeded from ids ALREADY present in the file, so a re-run cannot
   hand out an id that is already in use elsewhere on the page.
   -------------------------------------------------------------------------- */
function allocator(existingIds) {
  const used = new Set(existingIds);
  const counters = new Map();
  return function next(scope, kind) {
    const stem = `${scope}.${kind}`;
    let n = counters.get(stem) || 0;
    let id;
    do { n += 1; id = `${stem}.${n}`; } while (used.has(id));
    counters.set(stem, n);
    used.add(id);
    return id;
  };
}

/* Is this element an editable text block?
   Yes when it has at least one non-empty direct text node and every child
   element is inline. That yields the smallest unit that still keeps its inline
   markup intact — a <p> with an <em> inside is one field, not three. */
function textBlockKind($, el) {
  const $el = $(el);
  let hasOwnText = false;
  let hasInline = false;
  for (const node of el.children || []) {
    if (node.type === 'text') {
      if (squash(node.data)) hasOwnText = true;
    } else if (node.type === 'tag') {
      const tag = node.name.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      if (!INLINE.has(tag)) return null;      // block-level child -> descend instead
      hasInline = true;
    }
  }
  // A genuine direct text node is required. Without this check, a wrapper whose
  // children are all inline but which has no text of its own — the stat pattern
  // <div><b>11,400+</b><span>People trained</span></div>, or
  // <li><a>About Us</a></li> — was captured as ONE richtext field, forcing the
  // client to edit raw HTML just to change a number. Returning null here makes
  // the walker descend, so the <b> and the <span> become two plain text fields
  // and the <a> becomes a label plus a separate destination.
  if (!hasOwnText) return null;
  const html = $el.html() || '';
  const plain = squash($el.text());
  if (!plain) return null;
  if (hasInline && /<(a|em|strong|b|i|span|br|small|sup|sub|code)\b/i.test(html)) return 'richtext';
  return plain.length > 160 || /\n/.test(($el.text() || '').trim()) ? 'textarea' : 'text';
}

/* A human label for the admin form: nearest enclosing landmark + the element's
   own role, e.g. "Hero — heading", "Our work · card 3 — body text". */
function describe($, el) {
  const $el = $(el);
  const tag = el.name.toLowerCase();
  const role =
      /^h[1-6]$/.test(tag) ? `heading (${tag.toUpperCase()})`
    : $el.hasClass('eyebrow') ? 'section label'
    : $el.hasClass('lede') ? 'intro paragraph'
    : $el.hasClass('pending') ? 'placeholder notice'
    : $el.hasClass('btn') ? 'button label'
    : $el.hasClass('textlink') ? 'link text'
    : tag === 'a' ? 'link'
    : tag === 'li' ? 'list item'
    : tag === 'blockquote' ? 'quote'
    : tag === 'b' || tag === 'strong' ? 'bold value'
    : tag === 'button' ? 'button label'
    : tag === 'label' ? 'form label'
    : tag === 'th' ? 'table heading'
    : tag === 'td' ? 'table cell'
    : tag === 'figcaption' ? 'caption'
    : 'text';

  // Walk up for the closest identifiable region.
  let group = 'Page';
  const $section = $el.closest('section, header, footer, article, .card, .work-card, .voice-card, .ring-card, .board-card');
  if ($section.length) {
    const $sec = $section.first();
    const secTag = ($sec.get(0).name || '').toLowerCase();
    if (secTag === 'header') group = 'Header / navigation';
    else if (secTag === 'footer') group = 'Footer';
    else {
      // Heading first, eyebrow only as a fallback. The other way round produced
      // groups like "Registered non-profit · Bhadrak, Odisha" for the hero,
      // because that section's eyebrow is a registration notice rather than a
      // section name.
      const heading = squash($sec.find('h1,h2,h3').first().text());
      const eyebrow = squash($sec.find('.eyebrow').first().text());
      const secId = $sec.attr('id');
      group = heading || eyebrow || (secId ? secId.replace(/[-_]/g, ' ') : 'Page');
      group = group.slice(0, 48);
    }
  }
  return { group, role, label: `${group} — ${role}` };
}

/* -------------------------------------------------------------------------- */
function processPage(page, entries) {
  const file = path.join(ROOT, page.file);
  let html = fs.readFileSync(file, 'utf8');
  const $ = cheerio.load(html, { decodeEntities: false });

  const existing = [];
  $('[data-cms]').each((i, el) => existing.push($(el).attr('data-cms')));
  const nextId = allocator(existing);

  /* ---- head: title + description + og/twitter -------------------------- */
  const metaFields = [
    { sel: 'title',                          id: `${page.name}.meta.title`,       attr: null,      label: 'Browser tab / search title' },
    { sel: 'meta[name="description"]',       id: `${page.name}.meta.description`, attr: 'content', label: 'Search-result description' },
    { sel: 'meta[property="og:title"]',      id: `${page.name}.meta.ogTitle`,     attr: 'content', label: 'Share title (WhatsApp, Facebook)' },
    { sel: 'meta[property="og:description"]',id: `${page.name}.meta.ogDesc`,      attr: 'content', label: 'Share description' }
  ];
  for (const m of metaFields) {
    const $n = $(m.sel).first();
    if (!$n.length) continue;
    const value = m.attr ? ($n.attr(m.attr) || '') : squash($n.text());
    entries.push({
      id: m.id, page: page.name, scope: page.name, group: 'Search & sharing',
      label: m.label, role: 'meta', type: value.length > 90 ? 'textarea' : 'text',
      target: { selector: m.sel, attr: m.attr }, default: value
    });
  }

  /* ---- body ------------------------------------------------------------- */
  // Header and footer are byte-identical across all 9 pages, so their fields are
  // global: walked in the same order they get the same ids everywhere, and the
  // registry only records them once (from the first page that sees them).
  const regions = [
    { root: 'header.site', scope: 'global.header', shared: true },
    { root: 'main',        scope: page.name,       shared: false },
    { root: 'footer.site', scope: 'global.footer', shared: true }
  ];

  for (const region of regions) {
    const $root = $(region.root).first();
    if (!$root.length) continue;
    // Region-local allocator so global.* ids are identical on every page
    // regardless of what the page's own <main> contains.
    const regionExisting = [];
    $root.find('[data-cms]').addBack('[data-cms]').each((i, el) => regionExisting.push($(el).attr('data-cms')));
    const regionNext = region.shared ? allocator(regionExisting) : nextId;

    walk($root.get(0));

    function walk(el) {
      for (const node of (el.children || [])) {
        if (node.type !== 'tag') continue;
        const tag = node.name.toLowerCase();
        if (SKIP_TAGS.has(tag)) continue;
        const $node = $(node);

        // Slot-managed elements belong to image-slots.js / video-slots.js, which
        // register their own registry entries. Without this guard the generator
        // was NOT idempotent: the first run appended the photo <img> AFTER this
        // walk, so the walk never saw it — but every run after that found it and
        // stamped a second data-cms id on the same element, producing a duplicate
        // "— image" field per slot (21 image fields became 40 on the second run).
        if ($node.attr('data-cms-image') !== undefined || $node.attr('data-cms-video') !== undefined) continue;

        // images
        if (tag === 'img') {
          const id = $node.attr('data-cms') || regionNext(region.scope, 'img');
          $node.attr('data-cms', id);
          if (!seen(id)) {
            const d = describe($, node);
            entries.push({
              id, page: region.shared ? 'global' : page.name, scope: region.scope,
              group: d.group, label: `${d.group} — image`, role: 'image', type: 'image',
              target: { self: true },
              default: { src: $node.attr('src') || '', alt: $node.attr('alt') || '' }
            });
          }
          continue;
        }

        const kind = textBlockKind($, node);
        if (kind) {
          const id = $node.attr('data-cms') || regionNext(region.scope, tag);
          $node.attr('data-cms', id);
          if (!seen(id)) {
            const d = describe($, node);
            const entry = {
              id, page: region.shared ? 'global' : page.name, scope: region.scope,
              group: d.group, label: d.label, role: d.role, type: kind,
              target: { self: true },
              default: kind === 'richtext' ? ($node.html() || '').trim() : squash($node.text())
            };
            // An <a> carries a destination as well as a label.
            if (tag === 'a' && $node.attr('href')) {
              entry.href = { id: id + '.href', default: $node.attr('href') };
              entries.push({
                id: entry.href.id, page: region.shared ? 'global' : page.name, scope: region.scope,
                group: d.group, label: `${d.group} — link destination`, role: 'href', type: 'url',
                target: { selector: `[data-cms="${id}"]`, attr: 'href' },
                default: $node.attr('href')
              });
            }
            entries.push(entry);
          }
          continue;
        }

        walk(node);   // block-level container: descend
      }
    }
  }

  /* ---- photo slots ------------------------------------------------------
     Turn an illustration container into a replaceable photograph. The <img> is
     injected hidden; assets/js/cms.js reveals it and flags the container once a
     file is chosen, and the CSS then stands the line drawing down. */
  for (const slot of IMAGE_SLOTS.filter(s => s.page === page.name)) {
    if (!$(`[data-cms-image="${slot.id}"]`).length) {
      const $c = $(slot.container).first();
      if (!$c.length) {
        console.warn(`  ! photo slot ${slot.id}: container "${slot.container}" not found — skipped`);
        continue;
      }
      $c.addClass('cms-photo-slot');
      if (slot.round) $c.addClass('cms-photo-round');
      $c.append(`<img class="cms-photo" data-cms-image="${slot.id}" alt="" hidden>`);
    }
    entries.push({
      id: slot.id, page: page.name, scope: page.name, group: 'Photographs',
      label: slot.label, help: slot.help, role: 'photograph', type: 'image',
      target: { selector: `[data-cms-image="${slot.id}"]` },
      default: { src: '', alt: '' }
    });
  }

  /* ---- text slots -------------------------------------------------------
     Elements that start EMPTY. The walker finds text by reading it, so an empty
     element is invisible to it — these are declared instead. */
  for (const slot of TEXT_SLOTS.filter(s => s.page === page.name)) {
    const $t = $(slot.selector).first();
    if (!$t.length) {
      console.warn(`  ! text slot ${slot.id}: selector "${slot.selector}" not found — skipped`);
      continue;
    }
    entries.push({
      id: slot.id, page: page.name, scope: page.name, group: slot.group || 'Page',
      label: slot.label, help: slot.help, role: 'optional text', type: 'text',
      target: { selector: slot.selector },
      default: ''
    });
  }

  /* ---- video slots ------------------------------------------------------ */
  for (const slot of VIDEO_SLOTS.filter(s => s.page === page.name)) {
    if ($(`[data-cms-video="${slot.id}"]`).length) {
      // already injected on a previous run
    } else {
      const $anchor = $(slot.anchor).first();
      if (!$anchor.length) {
        console.warn(`  ! video slot ${slot.id}: anchor "${slot.anchor}" not found — skipped`);
        continue;
      }
      const holder = `<div class="cms-video" data-cms-video="${slot.id}" data-aspect="${slot.aspect || '16/9'}" hidden></div>`;
      if (slot.position === 'before') $anchor.before(holder);
      else $anchor.after(holder);
    }
    entries.push({
      id: slot.id, page: page.name, scope: page.name, group: 'Video',
      label: slot.label, help: slot.help, role: 'video', type: 'video',
      target: { selector: `[data-cms-video="${slot.id}"]` },
      default: { mode: '', src: '', embedUrl: '', provider: '', poster: '', caption: '' }
    });
  }

  fs.writeFileSync(file, $.html());
  return;

  function seen(id) { return entries.some(e => e.id === id); }
}

/* -------------------------------------------------------------------------- */
function main() {
  const entries = [];
  for (const page of PAGES) {
    process.stdout.write(`  ${page.file} … `);
    const before = entries.length;
    processPage(page, entries);
    console.log(`${entries.length - before} fields`);
  }

  const registry = {
    generatedBy: 'server/cms/build-registry.js',
    pages: PAGES.map(p => ({ name: p.name, file: p.file, label: p.label })),
    // Global groups first — they change every page at once, so the admin sees
    // them as their own section rather than buried under "Homepage".
    fields: entries
  };
  const out = path.join(__dirname, 'registry.json');
  fs.writeFileSync(out, JSON.stringify(registry, null, 1));

  const byType = {};
  for (const e of entries) byType[e.type] = (byType[e.type] || 0) + 1;
  console.log(`\n  total ${entries.length} fields  ->  ${path.relative(ROOT, out)}`);
  console.log('  by type:', Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(', '));
  const globals = entries.filter(e => e.page === 'global').length;
  console.log(`  shared header/footer fields (edit once, change all 9 pages): ${globals}`);
}

if (require.main === module) main();
module.exports = { PAGES };
