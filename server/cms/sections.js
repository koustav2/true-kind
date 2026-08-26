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

/* Every hero is "the big thing at the top of the page", and every one of them
   was named after its own headline. One name, used consistently, means an
   admin who has learned one page has learned all nine. */
const HERO = 'Hero — top of the page';

/* ---- RENAME: generated section name -> plain name ----------------------- */
const RENAME = {
  global: {
    'Header / navigation': 'Header & menu'
  },
  index: {
    "Kindness works better when it's organized.": HERO,
    'The four numbers our board actually reviews': 'Impact numbers — intro',
    'Five programs, one thread':                   'Programmes — intro',
    "Three commitments we don't compromise on":    'Our commitments',
    'From people in the programs':                 'Voices — quotes from participants',
    'Every rupee is tracked to a program, not a fundr': 'Donate strip',
    'Homepage banner':                             'Photo banner — slides'
  },
  about: {
    'Kindness, run like an institution.': HERO
  },
  work: {
    'Five programs, chosen for how they compound.': HERO,
    'Pick the program you want to back.':           'Donate strip'
  },
  impact: {
    'What the work has actually moved.': HERO
  },
  donate: {
    'Every rupee is tracked to a program, not a fundr': HERO,
    'Questions before you give? Ask them.':             'Contact prompt'
  },
  volunteer: {
    'Join the people doing the work.': HERO
  },
  contact: {
    'Talk to us.':                                 HERO,
    'We usually reply within a few working days':  'Contact details & form'
  },
  'press-release': {
    'News & coverage.': HERO,
    'Page':             'Coverage list'
  },
  'chairperson-message': {
    'A note from our Chairperson.': HERO,
    'Page':                         'The message'
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
  MOVE[`index.blockquote.${n}`] = 'Voices — quotes from participants';
  MOVE[`index.b.${n + 7}`]      = 'Voices — quotes from participants';
  MOVE[`index.span.${n + 15}`]  = 'Voices — quotes from participants';
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
].forEach(k => { MOVE[`volunteer.${k}`] = 'Registration form'; });

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
  const why = `edits the same element as index.slide.${slide}.* — use the Photo banner section`;
  HIDE[`index.h2.${h2}`] = why;
  HIDE[`index.p.${p}`]   = why;
  HIDE[`index.a.${a}`]   = why;
});

/* The ‹ and › on the slider. Punctuation the browser draws, not copy — and
   replacing either with a word breaks the round buttons they sit in. */
HIDE['index.button.1'] = 'the slider’s ‹ arrow — punctuation, not copy';
HIDE['index.button.2'] = 'the slider’s › arrow — punctuation, not copy';

const STRANDED = 'Older duplicate fields';

module.exports = {
  HERO, RENAME, MOVE, HIDE, STRANDED,
  renameFor: page => RENAME[page] || {},
  sectionFor: id => MOVE[id] || null,
  hiddenReason: id => HIDE[id] || null
};
