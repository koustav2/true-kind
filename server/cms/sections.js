/* ==========================================================================
   What the admin's Pages editor is allowed to look like.

   THE PROBLEM THIS SOLVES
   -----------------------
   Sections in the editor are named by build-registry.js, which takes whatever
   heading it finds nearest the field. That is a reasonable way to GROUP things
   and a terrible way to NAME them: the homepage's first section was called
   "Kindness works better when it's organized." and the donate page's was
   "Every rupee is tracked to a program, not a fundr" — a sentence, cut off
   mid-word. Nothing about that list can be scanned. Worse, three separate
   buckets ended up called "Page", which is the generator's fallback when it
   finds no heading at all.

   So this file is the one place that says, in plain words, what the sections
   of each page are. Four levers, in the order they are applied:

     RENAME   generated section name -> a plain name
     MOVE     a field -> the section it actually belongs in
     HIDE     a field that must not be edited at all, with the reason
     (order)  sections keep the order they appear on the page

   WHAT IS DELIBERATELY NOT HERE
   -----------------------------
   Sections whose generated name is already plain — "Why we exist", "Our Board",
   "Bank account details", "Program completion" — are not listed. Renaming
   something to itself adds a line to maintain and changes nothing. If a section
   is not mentioned below, the generator's name is already good enough.

   NOTHING HERE CHANGES THE PUBLIC SITE. These are admin-side labels and
   groupings only; field ids, stored values and the public bundle are untouched.
   ========================================================================== */
'use strict';

/* Section names come from the page's own EYEBROW labels — the small caps line
   above each block ("Our story", "What guides us", "Governance"). Those are
   what the page itself calls its sections, so they are what the admin calls
   them too.

   The generator could not do this on its own: build-registry.js deliberately
   prefers the heading over the eyebrow, because one hero eyebrow is a
   registration notice ("Registered non-profit · Bhadrak, Odisha") rather than
   a name. Preferring the eyebrow everywhere would have made that the homepage's
   first section name. So the choice is made here, per section, by hand — the
   eyebrow where it reads as a name, the heading where it does not. */
const RENAME = {
  index: {
    /* The homepage eyebrow is the registration notice, so this one keeps a
       written name rather than the page's label. */
    "Kindness works better when it's organized.": 'Top of the page',
    'The four numbers our board actually reviews': 'Where the effort goes',
    'Five programs, one thread':                   'Our work',
    "Three commitments we don't compromise on":    'How we work',
    'From people in the programs':                 'Voices',
    'Every rupee is tracked to a program, not a fundr': 'Donate box',
    'Homepage banner':                             'Photo slider'
  },
  about: {
    'Kindness, run like an institution.':   'About Us',
    'Why we exist':                         'Our story',
    'Mission, vision & how we earn trust':  'What guides us',
    'Our Board':                            'Governance',
    'Hear from our Chairperson':            'Leadership'
  },
  work: {
    'Five programs, chosen for how they compound.': 'Our Work',
    'What a True Kind program has to have':         'Every program, same rules',
    'Pick the program you want to back.':           'Donate box'
  },
  impact: {
    'What the work has actually moved.': 'Our Impact',
    'Reach across our five programs':    'By program',
    'Since we began tracking':           'Headline numbers',
    'Where we work across India':        'Our footprint',
    'How we measure this':               'Methodology',
    'Request our latest impact report':  'Want the detail'
  },
  donate: {
    'Every rupee is tracked to a program, not a fundr': 'Donate',
    'Where a contribution goes':                        'What it funds',
    'Bank account details':                             'Direct transfer',
    'Not everything useful arrives as money':           'Other ways to give',
    "What we'll tell you, unprompted":                  'Before you give',
    'Questions before you give? Ask them.':             'Questions before you give'
  },
  volunteer: {
    'Join the people doing the work.': 'Be a Volunteer'
  },
  contact: {
    'Talk to us.':                                'Contact Us',
    'We usually reply within a few working days': 'Send a message'
  },
  'press-release': {
    'News & coverage.': 'Press & Media',
    'Page':             'News list',
    'Media enquiries':  'For journalists'
  },
  gallery: {
    'From the field.': 'Gallery',
    'Page':            'Photo grid'
  },
  'chairperson-message': {
    'A note from our Chairperson.': "Chairperson's Message",
    'Page':                         'The message',
    'Two ways to be part of this':  'Take the next step'
  }
};

/* ---- MOVE: field id -> the section it belongs in ------------------------
   Target names are the PLAIN ones above. A target that does not exist yet is
   created, positioned where its first field falls on the page. */
const MOVE = {};

/* The four participant quotes, their initials and their captions landed in
   "Page" — the generator's no-heading fallback — while the four photographs
   that go with them sat in the Voices section. Same four people, two sections,
   for no reason a person could see. */
[1, 2, 3, 4].forEach(n => {
  MOVE[`index.blockquote.${n}`] = 'Voices';
  MOVE[`index.b.${n + 7}`]      = 'Voices';
  MOVE[`index.span.${n + 15}`]  = 'Voices';
});

/* Get Involved had ONE section of 30 rows called "For individuals" — the name
   of the first of three cards, applied to those cards AND the whole volunteer
   registration form beneath them. Two unrelated things; two sections. */
['h3.1', 'h3.2', 'h3.3', 'p.3', 'p.4', 'p.5'].forEach(k => {
  MOVE[`volunteer.${k}`] = 'Ways to help';
});

[
  'p.6', 'h2.1', 'legend.1', 'button.1', 'span.1',
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(n => `label.${n}`),
  ...Array.from({ length: 11 }, (_, i) => `option.${i + 1}`)
].forEach(k => { MOVE[`volunteer.${k}`] = 'Sign up'; });

/* ---- HIDE: field id -> why it must not be edited ------------------------
   A hidden field still exists, still saves if something already wrote to it,
   and still renders on the site. It is simply not offered as a row. If one has
   a stored value it reappears under "Older duplicate fields" so the value can
   be seen and cleared — hiding a field must never trap an edit somebody made
   before it was hidden. */
const HIDE = {};

/* Slides 1-3 ship with real text in index.html, so the generator stamped the
   headline, caption and link of each with ids of its own — at the same time as
   text-slots.js declared index.slide.N.title / .caption / .cta for the very
   same elements. Two rows, two names, one <h2>, and which one wins is decided
   by whichever was saved first. The declared slots are the ones that cover all
   ten slides, so they are the ones that stay. */
[[6, 3, 11, 1], [7, 13, 12, 2], [8, 21, 13, 3]].forEach(([h2, p, a, slide]) => {
  const why = `edits the same element as index.slide.${slide}.* — use the Photo slider section`;
  HIDE[`index.h2.${h2}`] = why;
  HIDE[`index.p.${p}`]   = why;
  HIDE[`index.a.${a}`]   = why;
});

/* The ‹ and › on the slider. Punctuation the browser draws, not copy — and
   replacing either with a word breaks the round buttons they sit in. */
/* The four board cards in about.html — Chairperson, Vice Chairperson,
   Secretary, Treasurer — are a PLACEHOLDER for a list that has no fixed length.
   The board is admin-managed data now: it is added on the Board screen, one
   member at a time, and assets/js/main.js rebuilds the whole grid from
   /api/board the moment there is one. Offering four fixed name-shaped rows here
   suggests the board is exactly four people with exactly those titles, and
   anything typed into them is thrown away as soon as a real trustee exists.

   So the rows go, and SECTION_NOTES points at the Board screen instead. The
   text above the cards — the "Governance" label, the "Our Board" heading and
   its description — stays, because that is real copy on the page whatever the
   board looks like. */
[['div.1', 'h3.5', 'p.15'],   // Chairperson
 ['div.2', 'h3.6', 'p.17'],   // Vice Chairperson
 ['div.3', 'h3.7', 'p.19'],   // Secretary
 ['div.4', 'h3.8', 'p.21']    // Treasurer
].forEach(ids => ids.forEach(k => {
  HIDE[`about.${k}`] = 'a placeholder board card — board members are added on the Board screen';
}));

HIDE['index.button.1'] = 'the slider’s ‹ arrow — punctuation, not copy';
HIDE['index.button.2'] = 'the slider’s › arrow — punctuation, not copy';

/* Names the generator produces that a person would not use.
   "Search & sharing" is four fields nobody can see on the page — the browser
   tab title, and the text WhatsApp and Facebook show when the page is shared —
   so the name has to say that, or it reads as a search box. Unlike RENAME
   these are not page-specific; they mean the same thing everywhere. */
const PLAIN = {
  'Search & sharing':  'Page title & share text',
  /* Header and footer are one thing to whoever edits them: the parts that are
     on every page. They were two sections only because the generator names a
     section after the region it found the field in. Merged, they read top of
     page then bottom of page, in that order, because sections sort by where
     they sit in the document. */
  'Header / navigation': 'On every page — menu & footer',
  'Footer':              'On every page — menu & footer',
  'Story photograph':    'Photo in the story'
};

/* A line shown at the top of a section, where the rows alone do not tell the
   whole story — usually because the real content is managed on another screen. */
const SECTION_NOTES = {
  about: {
    'Governance': {
      text: 'The board itself is a list with no fixed length, so it is not edited here. Add, reorder and remove trustees — photograph, role and bio included — and this block on the site is built from that. The rows below are only the heading and intro above the cards.',
      link: { href: '/portal/admin/board', label: 'Add or edit board members' }
    }
  },
  gallery: {
    'Photo grid': {
      text: 'The photographs are a list with no fixed length, so they are not edited here. Add each one — picture and title — and the grid on the page builds itself from that. The row below is only the note shown while the gallery is empty.',
      link: { href: '/portal/admin/gallery', label: 'Add or edit gallery photos' }
    }
  },
  'press-release': {
    'News list': {
      text: 'Press coverage is a list with no fixed length, so it is not edited here. Add each item — headline, publication, date, link and photograph — and the page builds itself from that. The row below is only the note shown while the list is empty.',
      link: { href: '/portal/admin/press', label: 'Add or edit press coverage' }
    }
  }
};

const STRANDED = 'Older duplicate fields';

module.exports = {
  RENAME, MOVE, HIDE, PLAIN, SECTION_NOTES, STRANDED,
  renameFor: page => RENAME[page] || {},
  sectionFor: id => MOVE[id] || null,
  hiddenReason: id => HIDE[id] || null
};
