/* ==========================================================================
   Text slots.

   For text that has no visible default in the HTML — an element that starts
   empty and only appears once an admin fills it. The registry generator finds
   text by reading it, so an empty element is invisible to it; these are declared
   instead, exactly like the image and video slots.
   ========================================================================== */

const slots = [];

/* Optional caption under each homepage slider photograph. */
[1, 2, 3, 4, 5].forEach(n => {
  slots.push({
    id: `index.slide.${n}.caption`,
    page: 'index',
    label: `Homepage slider — slide ${n} caption`,
    help: 'Optional. Leave empty for a photograph with no caption.',
    selector: `[data-cms-slide-caption="${n}"]`,
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
