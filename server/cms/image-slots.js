/* ==========================================================================
   Photo slots.

   The site's visuals are almost all inline <svg> line drawings — 68 of them
   against just 2 real <img> tags (the two logos). The registry generator skips
   <svg> subtrees on purpose, so none of that artwork was ever editable: the
   client could not replace a programme illustration with a real photograph, or
   put a face on a board member, without coming back to us. That is what the
   "send us real programme photos" note on the old build was really about.

   This file closes the gap. Each entry below turns an illustration container
   into a photo slot: the generator injects a hidden <img> into it, and the
   moment an admin picks a file in the CMS the photograph renders and the line
   drawing steps aside. Leave a slot empty and the illustration stays — nothing
   on the public page looks unfinished either way.

   `container` is a CSS selector in the target page. `fit` picks the CSS
   object-fit. `round` marks the circular ones (avatars) so they crop correctly.
   ========================================================================== */

const PROGRAMMES = [
  ['skilling',    'Skill Development & Employment'],
  ['livelihoods', "Women's Empowerment"],
  ['education',   'Digital Education Access'],
  ['health',      'Health & Safety Camps'],
  ['environment', 'Environmental Sustainability']
];

const slots = [];

/* The five programme cards, on both pages that show them. Same photograph is
   usually wanted in both places, but they are separate slots so the homepage
   can carry a different crop if you want one. */
for (const page of ['index', 'work']) {
  PROGRAMMES.forEach(([key, name], i) => {
    slots.push({
      id: `${page}.photo.${key}`,
      page,
      label: `${name} — photograph`,
      help: 'Replaces the line illustration on this card. Landscape crops work best.',
      container: `.work-card:nth-child(${i + 1}) .work-media`,
      fit: 'cover'
    });
  });
}

/* NOTE — the board used to have four fixed photo slots here, keyed to
   .board-card:nth-child(n). They are gone on purpose.

   The board is now a real admin-managed list (the BoardMember table, edited at
   /portal/admin/board) so the client can add and remove people rather than
   filling four permanent boxes. A fixed-field registry cannot express "add
   another person", and leaving both mechanisms in place would have given the
   client two different screens that each half-edit the same four cards. The
   photograph is uploaded with the rest of that person's details instead. */

/* The About page HERO photograph — beside the headline, at the top of the page.
   This is the most-seen image on the site after the homepage banner, so it is
   the one worth putting a real photograph in first. 4:3 on desktop and 16:9 on
   a phone, so a picture with its subject near the centre survives both crops. */
slots.push({
  id: 'about.photo.hero',
  page: 'about',
  label: 'About Us — hero photograph',
  help: 'Beside the headline at the top of About Us. Landscape, 1600x1200 or wider. '
      + 'The crop changes between desktop and phone, so keep the subject near the middle. '
      + 'A real photograph of your own work — a camp, a training batch, the team — is worth '
      + 'far more here than a bought one.',
  container: '.hero-split-media',
  fit: 'cover'
});

/* The About page photograph — a wide picture under the "Why we exist" story.
   Empty by default: the outline drawing in the HTML stands in until a real
   photograph is uploaded, so the page never shows a hole. */
slots.push({
  id: 'about.photo.story',
  page: 'about',
  label: 'About Us — photograph',
  help: 'Landscape, ideally 1600x900 or wider. Replaces the outline drawing under the story.',
  container: '.about-figure-media',
  fit: 'cover'
});

/* The three "what guides us" marks — Mission, Vision, How We Earn Trust.
   The client asked to be able to change these, so each is a slot. Fitted with
   object-fit:contain rather than cover (see style.css): a logo that gets
   cropped to a square is a broken logo. */
[
  ['mission', 'Our Mission'],
  ['vision',  'Our Vision'],
  ['trust',   'How We Earn Trust']
].forEach(([key, name], i) => {
  slots.push({
    id: `about.icon.${key}`,
    page: 'about',
    label: `${name} — icon / logo`,
    help: 'Square PNG with a transparent background works best. Shown at 46px, so keep it simple. Leave empty for the current line drawing.',
    container: `.mvv-card:nth-child(${i + 1}) .mvv-icon`,
    fit: 'contain'
  });
});

/* The Chairperson's own page has a dedicated portrait area. */
slots.push({
  id: 'chairperson.photo.portrait',
  page: 'chairperson-message',
  label: "Chairperson — portrait photograph",
  help: 'Portrait orientation. Appears beside the message.',
  container: '.cp-portrait',
  fit: 'cover'
});

/* Participant photographs for the Voices quotes. Only worth filling in where
   you hold written consent from the person — otherwise leave the initials. */
[1, 2, 3, 4].forEach(n => {
  slots.push({
    id: `index.photo.voice${n}`,
    page: 'index',
    label: `Voices quote ${n} — participant photograph`,
    help: 'Only add this where you have the person\'s written consent. Leave empty to keep initials.',
    container: `.voice-card:nth-child(${n}) .avatar`,
    fit: 'cover',
    round: true
  });
});

/* Homepage slider. Five declared slides; only the ones with a photograph
   appear, and with none set the whole section stays hidden — so the page is
   never short of content while the client fills it in. */
[1, 2, 3, 4, 5].forEach(n => {
  slots.push({
    id: `index.slide.${n}.image`,
    page: 'index',
    label: `Homepage slider — slide ${n} photograph`,
    /* Slide 1 SHIPS WITH A PICTURE — assets/img/banner-brand.jpg, the logo on
       the site's ripple motif — so the banner is present on a fresh install
       instead of the section hiding itself and the homepage looking unfinished.
       That default lives in index.html, not in the database, which is why the
       preview box below is empty until somebody uploads something: the box shows
       stored overrides only. Hence spelling it out here. */
    help: n === 1
      ? 'Landscape, ideally 1600x900 or wider (16:7 is the exact frame). '
        + 'This slide currently shows the built-in brand plate — the preview box '
        + 'to the right is empty because nothing has been uploaded yet. Choose a '
        + 'file to replace it. Clearing every slide hides the banner entirely.'
      : 'Landscape, 16:7. Leave empty to use fewer slides — the banner shows only '
        + 'the slides that have a photograph, and the arrows and dots appear only '
        + 'once there are two or more.',
    container: `.slide[data-slide="${n}"] .slide-media`,
    fit: 'cover',
    preset: true            // container already carries the slot classes
  });
});

module.exports = slots;
