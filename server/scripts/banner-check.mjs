import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_PATH || 'playwright');
const B = process.env.BASE || 'http://127.0.0.1:5863';
const EXEC = process.env.PW_CHROMIUM || (require('fs').existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const b = await chromium.launch(EXEC ? { executablePath: EXEC } : {});
const R = []; const ck = (n, ok, d = '') => { R.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : '   << ' + d}`); };

/* Nothing here leaves the test origin — the page asks Google for fonts and we
   are not going to let a test depend on that. */
async function page(w = 1300, h = 900) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  await ctx.route('**/*', r => r.request().url().startsWith(B) ? r.continue() : r.abort());
  const p = await ctx.newPage();
  const errors = [];
  p.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss(); });
  p.on('pageerror', e => errors.push('pageerror: ' + e.message));
  p.on('response', r => { if (r.url().startsWith(B) && r.status() >= 400 && /\.(jpg|jpeg|png|webp|css|js)$/.test(new URL(r.url()).pathname)) errors.push(r.status() + ' ' + r.url()); });
  return { ctx, p, errors };
}
/* main.js builds the banner on cms:hydrated, with a 1200ms fallback for the case
   where cms.js never resolves. Wait past the fallback, not for it. */
const settle = p => p.waitForTimeout(1700);

/* ---- a fresh install shows a finished banner ---------------------------- */
{
  const { ctx, p, errors } = await page();
  await p.goto(B + '/index.html', { waitUntil: 'load' });
  await settle(p);

  ck('the banner section reveals itself', (await p.locator('.hero-slider').isVisible()) === true);
  const shown = await p.locator('.slide:not([hidden])').count();
  ck('three demo slides ship, not one and not ten', shown === 3, String(shown));
  const slots = await p.locator('.slide').count();
  ck('ten slots are declared in the markup', slots === 10, String(slots));
  ck('no asset 404s and no page errors', errors.length === 0, errors.join(' | '));

  /* THE REGRESSION. Every one of these was true while the banner was visibly
     broken, except the media box's height. */
  const g = await p.evaluate(() => {
    const li = document.querySelector('.slide[data-slide="1"]');
    const m = li.querySelector('.slide-media');
    const img = m.querySelector('img.cms-photo');
    const body = li.querySelector('.slide-body');
    const r = el => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
    const af = getComputedStyle(m, '::after');
    return {
      slide: r(li), media: r(m), img: r(img), body: r(body),
      mediaPos: getComputedStyle(m).position,
      imgNatural: img.naturalWidth,
      scrim: af.backgroundImage, scrimPos: af.position
    };
  });
  ck('the media box fills the slide, not 0px',
    Math.abs(g.media.h - g.slide.h) < 1 && g.media.h > 200, JSON.stringify(g.media));
  ck('the media box is the positioned background layer', g.mediaPos === 'absolute', g.mediaPos);
  ck('the photograph is loaded and fills the box',
    g.imgNatural > 0 && Math.abs(g.img.h - g.slide.h) < 1 && Math.abs(g.img.w - g.slide.w) < 1,
    JSON.stringify({ nat: g.imgNatural, img: g.img }));
  ck('a scrim is painted over the photograph',
    g.scrimPos === 'absolute' && /linear-gradient/.test(g.scrim), g.scrimPos + ' ' + g.scrim.slice(0, 40));
  ck('the text sits inside the frame, left-aligned',
    g.body.x - g.slide.x < g.slide.w * 0.12 && g.body.h <= g.slide.h + 1,
    JSON.stringify({ slide: g.slide, body: g.body }));

  /* IT IS THE HERO'S RIGHT-HAND PANEL, and the ripple plate it replaced is gone
     from the markup rather than just hidden. */
  const place = await p.evaluate(() => {
    const pan = document.querySelector('.hero-slider').getBoundingClientRect();
    const txt = document.querySelector('.hero-grid > div').getBoundingClientRect();
    return {
      inHeroGrid: document.querySelector('.hero-grid > .hero-slider') !== null,
      ripples: document.querySelectorAll('.ripple-wrap, .ripple-ring').length,
      beside: pan.left >= txt.right - 1,
      footMismatch: Math.abs(pan.bottom - txt.bottom)
    };
  });
  ck('it is a child of the hero grid, not a section below it', place.inHeroGrid);
  ck('the ripple plate is gone from the page entirely', place.ripples === 0, String(place.ripples));
  ck('it sits beside the headline, not under it', place.beside === true);
  /* The 4:5 ratio exists to make this true — a square left an 87px shortfall
     against the text column, which read as a misalignment rather than a choice. */
  ck('its bottom edge finishes level with the buttons',
    place.footMismatch <= 40, String(Math.round(place.footMismatch)));

  /* BOUNDED. This is what the first two attempts got wrong in opposite
     directions: 16/7 across the full page was a 525px band taller than the
     viewport had left, and an uncapped portrait ratio on a wide monitor is 725px
     that pushes the stats strip off the screen. */
  ck('the panel is bounded, not screen height',
    g.slide.h >= 360 && g.slide.h <= 560 && g.slide.h < 900 * 0.72, String(g.slide.h));
  ck('and it is portrait in the hero column',
    g.slide.h > g.slide.w, JSON.stringify(g.slide));

  /* Headline, supporting line and button all present and visible. */
  for (const [sel, what] of [['.slide-title', 'headline'], ['.slide-caption', 'supporting line'], ['.slide-cta', 'button']]) {
    const n = await p.locator('.slide:not([hidden]) ' + sel + ':visible').count();
    ck(`every visible slide carries a ${what}`, n === 3, String(n));
  }
  const hrefs = await p.locator('.slide:not([hidden]) .slide-cta').evaluateAll(a => a.map(x => x.getAttribute('href')));
  ck('every button has a destination', hrefs.every(h => h && h !== '#'), hrefs.join(' | '));

  /* Controls, and the thing they must not do: sit on the words. Measured against
     the text ELEMENTS, not the .slide-body box — the body is a full-height flex
     container, so testing its rectangle reports an overlap with anything in the
     panel and would pass or fail for the wrong reason. */
  const clash = await p.evaluate(() => {
    const hit = (a, c) => a && c && !(a.right < c.left || c.right < a.left || a.bottom < c.top || c.bottom < a.top);
    const box = s => { const el = document.querySelector(s); if (!el || el.hidden) return null; return el.getBoundingClientRect(); };
    const words = [...document.querySelectorAll('.slide[data-slide="1"] .slide-body > *')]
      .filter(el => !el.hidden).map(el => el.getBoundingClientRect());
    const any = sel => words.some(w => hit(w, box(sel)));
    return { prev: any('[data-slider-prev]'), next: any('[data-slider-next]'), dots: any('[data-slider-dots]') };
  });
  ck('the arrows do not overlap the copy', clash.prev === false && clash.next === false, JSON.stringify(clash));
  ck('the dots do not overlap the copy', clash.dots === false, JSON.stringify(clash));

  const labels = await p.locator('[data-slider-dots] button').evaluateAll(bs => bs.map(x => x.getAttribute('aria-label')));
  ck('three dots, one per slide', labels.length === 3, String(labels.length));
  ck('each dot is named after its own headline',
    /^Skill Development \(slide 1 of 3\)$/.test(labels[0]) && /slide 3 of 3/.test(labels[2]), labels.join(' | '));

  /* A focusable link inside an aria-hidden slide is the bug where tabbing past
     the banner scrolls the track sideways to a focus ring you cannot see. */
  const tabs = await p.evaluate(() => [...document.querySelectorAll('.slide:not([hidden])')]
    .map(li => [li.getAttribute('aria-hidden'), (li.querySelector('.slide-cta') || {}).tabIndex]));
  ck('only the on-screen slide is exposed to assistive tech',
    tabs.map(t => t[0]).join() === 'false,true,true', JSON.stringify(tabs));
  ck('off-screen buttons are out of the tab order',
    tabs[0][1] === 0 && tabs[1][1] === -1 && tabs[2][1] === -1, JSON.stringify(tabs));

  /* The next arrow moves the track and the state follows it. */
  await p.click('[data-slider-next]');
  await p.waitForTimeout(800);
  const after = await p.evaluate(() => ({
    sel: [...document.querySelectorAll('[data-slider-dots] button')].map(d => d.getAttribute('aria-selected')),
    aria: [...document.querySelectorAll('.slide:not([hidden])')].map(li => li.getAttribute('aria-hidden')),
    tab: [...document.querySelectorAll('.slide:not([hidden]) .slide-cta')].map(c => c.tabIndex)
  }));
  ck('the next arrow advances the active dot', after.sel.join() === 'false,true,false', after.sel.join());
  ck('and the exposed slide moves with it', after.aria.join() === 'true,false,true', after.aria.join());
  ck('and so does the tab order', after.tab.join() === '-1,0,-1', after.tab.join());
  await ctx.close();
}

/* ---- half-filled and empty states -------------------------------------- */
{
  const { ctx, p } = await page();
  await p.goto(B + '/index.html', { waitUntil: 'load' });
  await settle(p);

  /* A button label and its link are two separate CMS fields. Filling one and
     not the other must not ship a button that goes nowhere. */
  const half = await p.evaluate(() => {
    const li = document.querySelector('.slide[data-slide="4"]');
    li.hidden = false;
    const img = li.querySelector('img.cms-photo');
    img.hidden = false; img.setAttribute('src', 'assets/img/banner-women.jpg');
    const c = li.querySelector('.slide-cta');
    c.hidden = false; c.textContent = 'Donate now';        // text, deliberately no href
    document.dispatchEvent(new CustomEvent('cms:hydrated', { detail: {} }));
    return new Promise(r => setTimeout(() => r({
      cta: li.querySelector('.slide-cta').hidden,
      dots: document.querySelectorAll('[data-slider-dots] button').length
    }), 250));
  });
  ck('a fourth uploaded photograph joins the rotation', half.dots === 4, String(half.dots));
  ck('a button with a label but no link stays hidden', half.cta === true, String(half.cta));

  /* And with every photograph cleared the whole section goes away rather than
     leaving a band of empty colour at the top of the homepage. */
  const empty = await p.evaluate(() => {
    document.querySelectorAll('.slide img.cms-photo').forEach(i => { i.removeAttribute('src'); i.hidden = true; });
    document.dispatchEvent(new CustomEvent('cms:hydrated', { detail: {} }));
    return new Promise(r => setTimeout(() => r(document.querySelector('.hero-slider').hidden), 250));
  });
  ck('clearing every photograph hides the whole section', empty === true, String(empty));
  await ctx.close();
}

/* ---- phone ------------------------------------------------------------- */
{
  const { ctx, p, errors } = await page(390, 844);
  await p.goto(B + '/index.html', { waitUntil: 'load' });
  await settle(p);

  const m = await p.evaluate(() => {
    const li = document.querySelector('.slide:not([hidden])');
    const s = li.getBoundingClientRect();
    const body = li.querySelector('.slide-body');
    const kids = [...body.children].filter(e => !e.hidden).map(e => e.getBoundingClientRect());
    const dots = document.querySelector('[data-slider-dots]').getBoundingClientRect();
    return {
      h: s.h || s.height,
      overflowTop: +(s.top - Math.min(...kids.map(k => k.top))).toFixed(1),
      overflowBottom: +(Math.max(...kids.map(k => k.bottom)) - s.bottom).toFixed(1),
      ctaHitsDots: !(kids[kids.length - 1].right < dots.left || dots.right < kids[kids.length - 1].left
        || kids[kids.length - 1].bottom < dots.top || dots.bottom < kids[kids.length - 1].top),
      arrowsGone: getComputedStyle(document.querySelector('[data-slider-next]')).display === 'none',
      pageScrollsSideways: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  });
  ck('the panel becomes a band once the hero stacks', m.h >= 340 && m.h <= 440, String(m.h));
  ck('nothing overflows the frame on a phone',
    m.overflowTop <= 0.5 && m.overflowBottom <= 0.5, JSON.stringify(m));
  ck('the button clears the dot row', m.ctaHitsDots === false);
  ck('the arrows step aside on a phone', m.arrowsGone === true);
  ck('the page does not scroll sideways', m.pageScrollsSideways === false);
  ck('no asset 404s and no page errors on a phone', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/* ---- a lot of slides --------------------------------------------------- */
{
  /* Ten dots is 224px of row inside a ~455px panel that has already spent 96 on
     the arrows, so past six the row becomes a counter. This fills every slot and
     checks the cluster stays inside the frame. */
  const { ctx, p } = await page();
  await p.goto(B + '/index.html', { waitUntil: 'load' });
  await settle(p);
  const m = await p.evaluate(() => {
    document.querySelectorAll('.slide').forEach((li, i) => {
      const img = li.querySelector('img.cms-photo');
      if (img.getAttribute('src')) return;
      img.hidden = false;
      img.setAttribute('src', 'assets/img/banner-' + ['skilling', 'women', 'environment'][i % 3] + '.jpg');
    });
    document.dispatchEvent(new CustomEvent('cms:hydrated', { detail: {} }));
    return new Promise(r => setTimeout(() => {
      const frame = document.querySelector('.slider-frame').getBoundingClientRect();
      const box = document.querySelector('[data-slider-dots]');
      const c = box.querySelector('.slider-count');
      const cr = box.getBoundingClientRect();
      const prev = document.querySelector('[data-slider-prev]').getBoundingClientRect();
      r({
        slides: document.querySelectorAll('.slide:not([hidden])').length,
        dots: box.querySelectorAll('button').length,
        counter: c ? c.textContent : null,
        live: c ? c.getAttribute('aria-live') : null,
        role: box.getAttribute('role'),
        insideFrame: cr.left >= frame.left - 0.5 && cr.right <= frame.right + 0.5,
        clearsArrows: cr.right <= prev.left + 0.5
      });
    }, 300));
  });
  ck('all ten slots run once every one has a photograph', m.slides === 10, String(m.slides));
  ck('past six slides the dot row becomes a counter',
    m.dots === 0 && m.counter === '1 / 10', JSON.stringify(m));
  ck('the counter is announced rather than silently changing', m.live === 'polite', String(m.live));
  ck('and the box drops its tablist role, having no tabs', m.role === null, String(m.role));
  ck('the counter stays inside the frame and clear of the arrows',
    m.insideFrame === true && m.clearsArrows === true, JSON.stringify(m));

  await p.click('[data-slider-next]');
  await p.waitForTimeout(700);
  const t = await p.evaluate(() => document.querySelector('.slider-count').textContent);
  ck('the counter follows the arrows', t === '2 / 10', t);
  await ctx.close();
}

/* ---- the stacking point ------------------------------------------------ */
{
  /* 920 is where .hero-grid collapses to one column. The panel goes full width
     there, and 4:5 at 828px would be a 1035px-tall photograph — so the ratio has
     to be dropped, not merely capped. */
  const { ctx, p } = await page(900, 900);
  await p.goto(B + '/index.html', { waitUntil: 'load' });
  await settle(p);
  const m = await p.evaluate(() => {
    const pan = document.querySelector('.hero-slider').getBoundingClientRect();
    const txt = document.querySelector('.hero-grid > div').getBoundingClientRect();
    const li = document.querySelector('.slide:not([hidden])').getBoundingClientRect();
    const kids = [...document.querySelector('.slide:not([hidden]) .slide-body').children]
      .filter(e => !e.hidden).map(e => e.getBoundingClientRect());
    return {
      w: Math.round(li.width), h: Math.round(li.height),
      stacked: pan.top > txt.bottom - 1,
      sameWidth: Math.abs(pan.width - txt.width) < 2,
      overflow: Math.max(+(li.top - Math.min(...kids.map(k => k.top))).toFixed(1),
                         +(Math.max(...kids.map(k => k.bottom)) - li.bottom).toFixed(1)),
      arrows: getComputedStyle(document.querySelector('[data-slider-next]')).display !== 'none'
    };
  });
  ck('under 920 the panel drops below the headline', m.stacked === true);
  ck('and takes the full content width', m.sameWidth === true, JSON.stringify(m));
  ck('and stops being portrait', m.h < m.w && m.h >= 340 && m.h <= 440, JSON.stringify(m));
  ck('nothing overflows the frame at the stacking point', m.overflow <= 0.5, String(m.overflow));
  ck('the arrows are still there at tablet width', m.arrows === true);
  await ctx.close();
}

/* ---- reduced motion ---------------------------------------------------- */
{
  const ctx = await b.newContext({ viewport: { width: 1300, height: 900 }, reducedMotion: 'reduce' });
  await ctx.route('**/*', r => r.request().url().startsWith(B) ? r.continue() : r.abort());
  const p = await ctx.newPage();
  await p.goto(B + '/index.html', { waitUntil: 'load' });
  await settle(p);
  const first = await p.evaluate(() => document.querySelector('[data-slider-dots] button[aria-selected="true"]')
    && [...document.querySelectorAll('[data-slider-dots] button')].findIndex(d => d.getAttribute('aria-selected') === 'true'));
  await p.waitForTimeout(7000);   // one auto-advance interval is 6s
  const later = await p.evaluate(() => [...document.querySelectorAll('[data-slider-dots] button')]
    .findIndex(d => d.getAttribute('aria-selected') === 'true'));
  ck('prefers-reduced-motion stops the auto-advance', first === later, `${first} -> ${later}`);
  await ctx.close();
}

await b.close();
const pass = R.filter(Boolean).length;
console.log(`\n${pass}/${R.length} passed`);
process.exit(pass === R.length ? 0 : 1);
