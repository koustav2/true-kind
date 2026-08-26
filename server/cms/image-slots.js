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

   `group` is the SECTION of the admin page editor this photograph belongs in —
   the same group name the surrounding text fields carry, so the picture and the
   words that sit next to it on the real page are edited together. It replaces
   the separate Photographs tab, where a picture was one menu away from its own
   caption.

   That name is a string match against groups the generator derives from the
   page's own headings, so editing a heading in the HTML can leave one of these
   pointing at a section that no longer exists. build-registry.js checks for
   exactly that and warns; it does not fail, because an orphaned group is a
   cosmetic problem (the photo gets its own small section) rather than a broken
   one. Check the build output when you change a heading.
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
      group: name,
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
  group: 'Kindness, run like an institution.',   // the About hero heading
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
  group: 'Story photograph',                     // shared with about.story.caption
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
    group: 'Mission, vision & how we earn trust',
    label: `${name} — icon / logo`,
    help: 'Square PNG with a transparent background works best. Shown at 46px, so keep it simple. Leave empty for the current line drawing.',
    container: `.mvv-card:nth-child(${i + 1}) .mvv-icon`,
    fit: 'contain'
  });
});

/* The Get Involved (volunteer) page HERO photograph — beside the headline,
   same arrangement as the About page hero above. */
slots.push({
  id: 'volunteer.photo.hero',
  page: 'volunteer',
  group: 'Join the people doing the work.',      // the Get Involved hero heading
  label: 'Get Involved — hero photograph',
  help: 'Beside the headline at the top of Get Involved. Landscape, 1600x1200 or wider. '
      + 'A real photograph of volunteers at work is worth far more here than a bought one.',
  container: '.hero-split-media',
  fit: 'cover'
});

/* The Donate page HERO photograph — beside the headline, same arrangement as
   About Us and Get Involved above. The page had no photo slot at all until now:
   its hero was a single column with nowhere for a picture to go, so donate.html
   was given the same split layout the other two already use.

   `group` is the name the GENERATOR derives from the page's own <h1>, not the
   plain name the admin shows — sections.js renames that to "Donate". Matching
   the generated string is what puts the photograph in the same section as the
   headline it sits beside. */
slots.push({
  id: 'donate.photo.hero',
  page: 'donate',
  group: 'Every rupee is tracked to a program, not a fundr',
  label: 'Donate — hero photograph',
  help: 'Beside the headline at the top of Donate. Landscape, 1600x1200 or wider. '
      + 'The crop changes between desktop and phone, so keep the subject near the middle. '
      + 'A photograph of the work a donation pays for does more here than a picture of money.',
  container: '.hero-split-media',
  fit: 'cover'
});

/* The three cost tiers on Donate — "Where a contribution goes". Each card is a
   figure, a name and a sentence; a photograph of the thing that figure pays for
   makes it concrete. Numbered rather than named after the amount, because the
   amount is itself editable: a slot called "the ₹1,500 tier" becomes a lie the
   first time somebody reprices it. */
[1, 2, 3].forEach(n => {
  slots.push({
    id: `donate.photo.tier${n}`,
    page: 'donate',
    group: 'Where a contribution goes',
    label: `Cost tier ${n} — photograph`,
    help: `The ${['first', 'second', 'third'][n - 1]} card under "Where a contribution goes". `
        + 'Landscape, 1200x675 or wider. Leave empty and the card shows no picture at all — '
        + 'it does not reserve a blank frame.',
    container: `.tier-card:nth-child(${n}) .tier-media`,
    fit: 'cover',
    preset: true            // the container already carries the slot classes
  });
});

/* The Chairperson's own page has a dedicated portrait area. */
slots.push({
  id: 'chairperson.photo.portrait',
  page: 'chairperson-message',
  group: 'A note from our Chairperson.',         // the page's own heading
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
    group: 'From people in the programs',
    label: `Voices quote ${n} — participant photograph`,
    help: 'Only add this where you have the person\'s written consent. Leave empty to keep initials.',
    container: `.voice-card:nth-child(${n}) .avatar`,
    fit: 'cover',
    round: true
  });
});

/* Homepage banner. TEN declared slides; only the ones with a photograph appear,
   and with none set the whole section stays hidden — so the page is never short
   of content while the client fills it in.

   Ten, not five, because the client asked for room to run more than five. An
   unused slot costs a hidden <li> in the markup and a row in the CMS list;
   nothing reaches the public page. Going past about ten would be worth doing
   properly instead — an admin-managed list with Add and Remove, the way the
   board page works — because a fixed field per slide stops scaling the moment
   somebody wants to reorder them. */
[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].forEach(n => {
  slots.push({
    id: `index.slide.${n}.image`,
    page: 'index',
    group: 'Homepage banner',                    // shared with the slide's text slots
    label: `Homepage slider — slide ${n} photograph`,
    /* Slides 1-3 SHIP WITH A PICTURE — the three generated backgrounds in
       assets/img/ (see tools/make-demo-banners.py) — so the banner is present and
       looks finished on a fresh install instead of the section hiding itself.
       Those defaults live in index.html, not in the database, which is why the
       preview box below is empty until somebody uploads something: the box shows
       stored overrides only. Hence spelling it out here. */
    help: n <= 3
      ? 'This slide currently shows a placeholder background in the brand colours '
        + '— the preview box to the right is empty because nothing has been '
        + 'uploaded yet. Choose a file to replace it with a real photograph. '
        + 'Portrait or square works best (1200x1500 or larger): beside the '
        + 'headline the frame is upright, and it is cropped to fill, so keep the '
        + 'subject in the upper half — the lower third carries the words.'
      : 'Portrait or square, 1200x1500 or larger, subject in the upper half. '
        + 'Leave empty to use fewer slides — the banner shows only the slides that '
        + 'have a photograph, and the controls appear only once there are two or '
        + 'more. Ten slots are available; there is no need to fill them all.',
    container: `.slide[data-slide="${n}"] .slide-media`,
    fit: 'cover',
    preset: true            // container already carries the slot classes
  });
});

module.exports = slots;
