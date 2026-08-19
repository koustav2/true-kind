/* ==========================================================================
   Video slots.

   The site shipped with no video anywhere — no <video>, no <iframe>. So unlike
   text and images, video slots cannot be discovered by parsing; they have to be
   declared. Each entry below becomes an empty placeholder container in the page,
   which stays invisible until an admin fills it. Nothing shifts on the public
   site until then.

   Each slot renders EITHER an uploaded file (<video controls>) OR a YouTube /
   Vimeo embed (<iframe>), decided per slot by the admin.

   To add a slot: add an entry here and re-run `npm run cms:build`. `anchor` is a
   CSS selector in the target page; `position` is where the container goes
   relative to it.
   ========================================================================== */

module.exports = [
  {
    id: 'index.video.hero',
    page: 'index',
    label: 'Homepage — main video',
    help: 'Sits under the opening headline. The best place for a 60–90 second "who we are" film.',
    anchor: '.hero .hero-stats-strip',
    position: 'before',
    aspect: '16/9'
  },
  {
    id: 'about.video.story',
    page: 'about',
    label: 'About — our story video',
    help: 'Appears after the "Who we are" text.',
    anchor: '[data-cms-about-body]',
    position: 'after',
    aspect: '16/9'
  },
  {
    id: 'work.video.programmes',
    page: 'work',
    label: 'Our Work — programmes video',
    help: 'Sits above the five programme cards.',
    anchor: '[data-cms-works]',
    position: 'before',
    aspect: '16/9'
  },
  {
    id: 'impact.video.report',
    page: 'impact',
    label: 'Our Impact — impact film',
    help: 'Good spot for a field video or an annual-report walkthrough.',
    anchor: 'main > section:nth-of-type(2)',
    position: 'after',
    aspect: '16/9'
  },
  {
    id: 'donate.video.appeal',
    page: 'donate',
    label: 'Donate — appeal video',
    help: 'A short appeal shown above the bank details.',
    anchor: '#bank',
    position: 'before',
    aspect: '16/9'
  },
  {
    id: 'volunteer.video.invite',
    page: 'volunteer',
    label: 'Volunteer — invitation video',
    help: 'Volunteers hearing from a current volunteer converts better than copy.',
    anchor: 'main > section:nth-of-type(2)',
    position: 'before',
    aspect: '16/9'
  },
  {
    id: 'chairperson.video.message',
    page: 'chairperson-message',
    label: 'Chairperson — video message',
    help: 'A filmed version of the written message.',
    anchor: 'main > section:nth-of-type(1)',
    position: 'after',
    aspect: '16/9'
  },
  {
    id: 'press.video.reel',
    page: 'press-release',
    label: 'Press — coverage reel',
    help: 'Broadcast clips or a montage of coverage.',
    anchor: '[data-cms-press]',
    position: 'before',
    aspect: '16/9'
  }
];
