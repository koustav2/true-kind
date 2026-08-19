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

/* Board members. The circles currently hold initials. */
['Chairperson', 'Vice Chairperson', 'Secretary', 'Treasurer'].forEach((role, i) => {
  slots.push({
    id: `about.photo.board${i + 1}`,
    page: 'about',
    label: `${role} — photograph`,
    help: 'A square headshot. Shown as a circle, so keep the face centred.',
    container: `.board-card:nth-child(${i + 1}) .board-avatar`,
    fit: 'cover',
    round: true
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

module.exports = slots;
