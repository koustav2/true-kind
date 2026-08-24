/* ==========================================================================
   Text slots.

   For text that has no visible default in the HTML — an element that starts
   empty and only appears once an admin fills it. The registry generator finds
   text by reading it, so an empty element is invisible to it; these are declared
   instead, exactly like the image and video slots.
   ========================================================================== */

const slots = [];

/* The homepage banner. Each of the ten slides carries a headline, a supporting
   line and one button, laid over its photograph. Ten because the client wanted
   room past five; a slide with no photograph never reaches the page, so the
   unused ones cost nothing but a row in this list.

   The slide used to be a bare photograph with an optional caption, and it did
   not work: at banner size a picture with a line of small text under it reads as
   a stray image, not a banner. A banner has something to say and somewhere to
   send you.

   `caption` KEEPS ITS ID rather than being renamed to something tidier like
   `.text`. Anything an admin has already typed into it lives in the database
   under that key, and renaming the slot would orphan it — the field would come
   back empty while the old value sat in the row forever, invisible. It is
   relabelled instead. The id is a database key, not a description. */
/* Group name: these are the WORDS that sit over each slide's photograph, not
   the photograph itself — that moved to its own Photographs tab (see
   image-slots.js / cms/index.js). They used to share the "Photographs" group
   with the picture they sit on, back when both were edited in the same place;
   now that the picture lives on a different screen, a group still labelled
   "Photographs" here would open onto four rows of text and nothing resembling
   a photograph — confusing in exactly the way this whole simplification pass
   was meant to fix. */
[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].forEach(n => {
  slots.push({
    id: `index.slide.${n}.title`,
    page: 'index',
    label: `Homepage banner — slide ${n} headline`,
    help: 'A few words, not a sentence. Leave empty and the slide shows the photograph alone.',
    selector: `[data-cms-slide-title="${n}"]`,
    group: 'Homepage banner text'
  });
  slots.push({
    id: `index.slide.${n}.caption`,
    page: 'index',
    label: `Homepage banner — slide ${n} supporting line`,
    help: 'One sentence under the headline. Optional.',
    selector: `[data-cms-slide-caption="${n}"]`,
    group: 'Homepage banner text'
  });
  slots.push({
    id: `index.slide.${n}.cta`,
    page: 'index',
    label: `Homepage banner — slide ${n} button text`,
    help: 'Leave empty for no button. The button appears only when this and the link below are both filled in.',
    selector: `[data-cms-slide-cta="${n}"]`,
    group: 'Homepage banner text'
  });
  slots.push({
    id: `index.slide.${n}.ctaHref`,
    page: 'index',
    label: `Homepage banner — slide ${n} button link`,
    help: 'Where the button goes: donate.html, work.html, /portal/donate, or a full https:// address.',
    selector: `[data-cms-slide-cta="${n}"]`,
    attr: 'href',
    group: 'Homepage banner text'
  });
});

/* Caption under the About-page photograph. Starts empty and hidden, so an
   uncaptioned picture leaves no blank line under itself. Same reasoning as
   above: the photograph itself is on the Photographs tab, so this one text
   row gets its own small, accurately-named group rather than reusing that
   label for a group with no photograph in it. */
slots.push({
  id: 'about.story.caption',
  page: 'about',
  label: 'About Us photograph — caption',
  help: 'Optional. Names the place, the programme or the date. Leave empty for no caption.',
  selector: '[data-cms-figcaption="about.story"]',
  group: 'Photo caption'
});

module.exports = slots;
