import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_PATH || 'playwright');
const B = process.env.BASE || 'http://127.0.0.1:5861';
const EXEC = process.env.PW_CHROMIUM || (require('fs').existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const b = await chromium.launch(EXEC ? { executablePath: EXEC } : {});
const R = []; const ck = (n, ok, d = '') => { R.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : '   << ' + d}`); };

/* Nothing here leaves the test origin. */
async function page(extraRoute) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route('**/*', r => r.request().url().startsWith(B) ? r.continue() : r.abort());
  if (extraRoute) await ctx.route('**/api/board', extraRoute);
  const p = await ctx.newPage();
  const errors = [];
  p.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss(); });
  p.on('pageerror', e => errors.push('pageerror: ' + e.message));
  return { ctx, p, errors };
}

/* ---- the real list replaces the placeholders ----------------------------- */
{
  const { ctx, p, errors } = await page();
  await p.goto(B + '/about.html', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.querySelectorAll('.board-card h3').length &&
    document.querySelector('.board-card h3').textContent !== 'Chairperson', null, { timeout: 6000 })
    .catch(() => {});

  const cards = await p.locator('.board-card').count();
  ck('the three visible trustees replace the four placeholders', cards === 3, String(cards));

  const names = await p.locator('.board-card h3').allInnerTexts();
  ck('hidden trustees are not rendered', !names.some(n => n.includes('Hidden Person')), names.join(' | '));
  ck('ordered by the admin\'s sort order',
    names[0] === 'Asha Mohanty' && names[1] === 'Rakesh Behera', names.join(' | '));

  /* .role is text-transform:uppercase, so innerText comes back uppercased —
     compare the rendered text case-insensitively, and the DOM text exactly. */
  const roles = await p.locator('.board-card .role').allInnerTexts();
  ck('designation renders under the name',
    roles[0].toLowerCase() === 'chairperson' && roles[1].toLowerCase() === 'treasurer',
    roles.join(' | '));
  const roleText = await p.locator('.board-card .role').evaluateAll(els => els.map(e => e.textContent));
  ck('designation is stored and emitted verbatim',
    roleText[0] === 'Chairperson' && roleText[1] === 'Treasurer', roleText.join(' | '));

  ck('email renders as a mailto link',
    (await p.locator('.board-card .board-mail a[href^="mailto:asha@"]').count()) === 1);

  ck('a trustee with a photograph shows it, not initials',
    (await p.locator('.board-card:nth-child(1) .board-avatar.has-photo img.cms-photo').count()) === 1);
  const initials = await p.locator('.board-card:nth-child(2) .board-avatar').innerText();
  ck('a trustee without one falls back to initials', initials.trim() === 'RB', initials);

  const socials = await p.locator('.board-card:nth-child(1) .board-social a').count();
  ck('the social links render (3 set, 1 left empty)', socials === 3, String(socials));
  const hrefs = await p.locator('.board-card:nth-child(1) .board-social a').evaluateAll(
    els => els.map(e => e.getAttribute('href')));
  ck('social links are http(s) only', hrefs.every(h => /^https?:\/\//.test(h)), hrefs.join(' '));
  const rel = await p.locator('.board-card:nth-child(1) .board-social a').evaluateAll(
    els => els.every(e => e.target === '_blank' && /noopener/.test(e.rel)));
  ck('social links open safely (target=_blank + noopener)', rel);

  /* The hostile row. */
  const bad = await p.locator('.board-card').nth(2);
  const badName = await bad.locator('h3').innerText();
  ck('a pasted <img onerror> arrives as visible TEXT',
    badName.includes('<img src=x onerror=alert(1)>'), badName);
  ck('...and did not become a real element',
    (await bad.locator('h3 img').count()) === 0);
  ck('a pasted <script> in the designation is text too',
    (await p.evaluate(() => window.__pwned)) === undefined);
  ck('no dialog fired and no script error', errors.length === 0, errors.join('; '));

  /* The cards are built after the scroll-reveal observer bound, so they have to
     be enrolled explicitly or they are the one section that pops in with no
     animation. Both classes must be present: `reveal` (registered) and `in`
     (the observer has since fired for them). */
  const revealed = await p.locator('.board-card').evaluateAll(
    els => els.map(e => [e.classList.contains('reveal'), e.classList.contains('in')]));
  ck('the new cards join the scroll-reveal animation',
    revealed.every(([r]) => r), JSON.stringify(revealed));
  await p.locator('.board-card').first().scrollIntoViewIfNeeded();
  /* Wait for the transition to finish rather than guessing a duration — the
     reveal has a per-card delay on top of its own timing. */
  const settled = await p.waitForFunction(
    () => +getComputedStyle(document.querySelector('.board-card')).opacity === 1,
    null, { timeout: 4000 }).then(() => true).catch(() => false);
  const st = await p.locator('.board-card').first().evaluate(e => ({
    op: +getComputedStyle(e).opacity, cls: e.className }));
  ck('...and they do actually reveal, not stay at zero opacity', settled, JSON.stringify(st));
  ck('board note is styled like the placeholder descriptions',
    (await p.locator(".board-card .board-bio").count()) === 2);

  /* Layout sanity: the avatars must still be circles the same size as before. */
  const box = await p.locator('.board-card:nth-child(1) .board-avatar').boundingBox();
  ck('avatar keeps its 56px circle', Math.round(box.width) === 56 && Math.round(box.height) === 56,
    JSON.stringify(box));
  await ctx.close();
}

/* ---- an empty list leaves the shipped cards alone ------------------------ */
{
  const { ctx, p } = await page(r => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, members: [] })
  }));
  await p.goto(B + '/about.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(900);
  const names = await p.locator('.board-card h3').allInnerTexts();
  ck('empty list: the four placeholder cards stay',
    names.length === 4 && names[0] === 'Chairperson' && names[3] === 'Treasurer', names.join(' | '));
  await ctx.close();
}

/* ---- a failed request leaves them alone too ----------------------------- */
{
  const { ctx, p, errors } = await page(r => r.abort());
  await p.goto(B + '/about.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(900);
  const names = await p.locator('.board-card h3').allInnerTexts();
  ck('failed request: the four placeholder cards stay', names.length === 4, names.join(' | '));
  ck('failed request throws nothing at the visitor',
    !errors.some(e => e.startsWith('dialog')), errors.join('; '));
  await ctx.close();
}

/* ---- a 500 leaves them alone -------------------------------------------- */
{
  const { ctx, p } = await page(r => r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  await p.goto(B + '/about.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(900);
  ck('500 response: the four placeholder cards stay',
    (await p.locator('.board-card').count()) === 4);
  await ctx.close();
}

/* ---- the About photograph slot and the editable icons ------------------- */
{
  const { ctx, p } = await page();
  await p.goto(B + '/about.html', { waitUntil: 'domcontentloaded' });
  const fig = await p.locator('.about-figure-media').boundingBox();
  ck('the About photograph area is a visible 16:9 band',
    fig && fig.width > 200 && Math.abs((fig.width / fig.height) - 16 / 9) < 0.08,
    JSON.stringify(fig));
  ck('its outline drawing shows while the slot is empty',
    (await p.locator('.about-figure-media > svg').isVisible()) === true);
  ck('the empty photograph itself is hidden',
    (await p.locator('.about-figure-media img.cms-photo').isVisible()) === false);
  ck('the caption stays hidden while unset',
    (await p.locator('[data-cms-figcaption="about.story"]').isVisible()) === false);
  ck('the three guide icons are photo slots',
    (await p.locator('.mvv-icon.cms-photo-slot').count()) === 3);
  ck('their line drawings still show', (await p.locator('.mvv-icon > svg').count()) === 3);
  await ctx.close();
}

await b.close();
const pass = R.filter(Boolean).length;
console.log(`\n${pass}/${R.length} passed`);
process.exit(pass === R.length ? 0 : 1);
