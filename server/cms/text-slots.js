/* ==========================================================================
   Text slots.

   For text that has no visible default in the HTML — an element that starts
   empty and only appears once an admin fills it. The registry generator finds
   text by reading it, so an empty element is invisible to it; these are declared
   instead, exactly like the image and video slots.
   ========================================================================== */

const slots = [];

/* The homepage banner. Each of the five slides carries a headline, a supporting
   line and one button, laid over its photograph.

   The slide used to be a bare photograph with an optional caption, and it did
   not work: at banner size a picture with a line of small text under it reads as
   a stray image, not a banner. A banner has something to say and somewhere to
   send you.

   `caption` KEEPS ITS ID rather than being renamed to something tidier like
   `.text`. Anything an admin has already typed into it lives in the database
   under that key, and renaming the slot would orphan it — the field would come
   back empty while the old value sat in the row forever, invisible. It is
   relabelled instead. The id is a database key, not a description. */
[1, 2, 3, 4, 5].forEach(n => {
  slots.push({
    id: `index.slide.${n}.title`,
    page: 'index',
    label: `Homepage banner — slide ${n} headline`,
    help: 'A few words, not a sentence. Leave empty and the slide shows the photograph alone.',
    selector: `[data-cms-slide-title="${n}"]`,
    group: 'Photographs'
  });
  slots.push({
    id: `index.slide.${n}.caption`,
    page: 'index',
    label: `Homepage banner — slide ${n} supporting line`,
    help: 'One sentence under the headline. Optional.',
    selector: `[data-cms-slide-caption="${n}"]`,
    group: 'Photographs'
  });
  slots.push({
    id: `index.slide.${n}.cta`,
    page: 'index',
    label: `Homepage banner — slide ${n} button text`,
    help: 'Leave empty for no button. The button appears only when this and the link below are both filled in.',
    selector: `[data-cms-slide-cta="${n}"]`,
    group: 'Photographs'
  });
  slots.push({
    id: `index.slide.${n}.ctaHref`,
    page: 'index',
    label: `Homepage banner — slide ${n} button link`,
    help: 'Where the button goes: donate.html, work.html, /portal/donate, or a full https:// address.',
    selector: `[data-cms-slide-cta="${n}"]`,
    attr: 'href',
    group: 'Photographs'
  });
});

/* Caption under the About-page photograph. Starts empty and hidden, so an
   uncaptioned picture leaves no blank line under itself. */
slots.push({
  id: 'about.story.caption',
  page: 'about',
  label: 'About Us photograph — caption',
  help: 'Optional. Names the place, the programme or the date. Leave empty for no caption.',
  selector: '[data-cms-figcaption="about.story"]',
  group: 'Photographs'
});

module.exports = slots;
