import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_PATH || 'playwright');
const B = process.env.BASE || 'http://127.0.0.1:5860';
const EXEC = process.env.PW_CHROMIUM || (require('fs').existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const b=await chromium.launch(EXEC ? {executablePath:EXEC} : {});
const R=[];const ck=(n,ok,d='')=>{R.push(ok);console.log(`${ok?'PASS':'FAIL'}  ${n}${ok?'':'   << '+d}`)};
const PAGES=['index','about','work','impact','donate','volunteer','contact','press-release','chairperson-message'];

// ---- present and visible on every page, at desktop and phone widths --------
for (const w of [1440, 900, 390]) {
  const ctx=await b.newContext({viewport:{width:w,height:820}});
  await ctx.route('**/*',r=>r.request().url().startsWith(B)?r.continue():r.abort());
  const p=await ctx.newPage();
  let allOk=true, detail='';
  for (const n of PAGES) {
    await p.goto(`${B}/${n}.html`,{waitUntil:'domcontentloaded'});
    const st=await p.evaluate(()=>{
      const a=document.querySelector('[data-nav-donate]');
      if(!a) return {found:false};
      const r=a.getBoundingClientRect();
      const cs=getComputedStyle(a);
      const mid=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
      return {found:true, href:a.getAttribute('href'), w:Math.round(r.width), h:Math.round(r.height),
        visible: cs.display!=='none' && cs.visibility!=='hidden' && r.width>40 && r.height>24,
        inViewport: r.top>=0 && r.left>=0 && r.bottom<=innerHeight && r.right<=innerWidth,
        clickable: !!mid && (mid===a || a.contains(mid)),
        outsideNavList: !document.getElementById('navlinks').contains(a)};
    });
    if(!(st.found && st.visible && st.inViewport && st.clickable && st.outsideNavList && st.href==='/portal/donate')){
      allOk=false; detail=`${n}: ${JSON.stringify(st)}`; break;
    }
  }
  ck(`present, visible and clickable on all 9 pages @ ${w}px`, allOk, detail);
  await ctx.close();
}

// ---- mobile: still reachable with the nav menu CLOSED and OPEN -------------
{
  const ctx=await b.newContext({viewport:{width:390,height:820}});
  await ctx.route('**/*',r=>r.request().url().startsWith(B)?r.continue():r.abort());
  const p=await ctx.newPage();
  await p.goto(B+'/index.html',{waitUntil:'domcontentloaded'});
  ck('mobile: visible with the menu closed', await p.evaluate(()=>{
    const r=document.querySelector('[data-nav-donate]').getBoundingClientRect();
    return r.width>40 && r.top>=0 && r.right<=innerWidth;}));
  await p.click('#menubtn'); await p.waitForTimeout(400);
  ck('mobile: still visible with the menu open', await p.evaluate(()=>{
    const a=document.querySelector('[data-nav-donate]');
    const r=a.getBoundingClientRect();
    const mid=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
    return r.width>40 && !!mid;}));
  await ctx.close();
}

// ---- the pulse: happens, is FINITE, and never loops ------------------------
{
  const ctx=await b.newContext({viewport:{width:1440,height:820}});
  await ctx.route('**/*',r=>r.request().url().startsWith(B)?r.continue():r.abort());
  const p=await ctx.newPage();
  await p.goto(B+'/index.html',{waitUntil:'domcontentloaded'});
  await p.waitForTimeout(1700);
  const pulsing=await p.evaluate(()=>{
    const a=document.querySelector('[data-nav-donate]');
    return {cls:a.classList.contains('pulse'), count:getComputedStyle(a).animationIterationCount,
            dur:getComputedStyle(a).animationDuration};
  });
  ck('pulse starts after load', pulsing.cls===true);
  ck('pulse runs a FIXED 3 times, not infinite', pulsing.count==='3', 'iteration-count='+pulsing.count);
  ck('total pulse under the 5s WCAG ceiling',
     parseFloat(pulsing.dur)*3 < 5, `${pulsing.dur} x3`);
  await p.waitForTimeout(5200);
  ck('pulse class removed when finished', !(await p.evaluate(()=>document.querySelector('[data-nav-donate]').classList.contains('pulse'))));
  await ctx.close();
}

// ---- no pulse on the donate page, and none under reduced motion -----------
{
  const ctx=await b.newContext({viewport:{width:1440,height:820}});
  await ctx.route('**/*',r=>r.request().url().startsWith(B)?r.continue():r.abort());
  const p=await ctx.newPage();
  await p.goto(B+'/donate.html',{waitUntil:'domcontentloaded'});
  await p.waitForTimeout(1800);
  ck('no pulse on the donate page itself', !(await p.evaluate(()=>document.querySelector('[data-nav-donate]').classList.contains('pulse'))));
  await ctx.close();

  const rc=await b.newContext({viewport:{width:1440,height:820},reducedMotion:'reduce'});
  await rc.route('**/*',r=>r.request().url().startsWith(B)?r.continue():r.abort());
  const q=await rc.newPage();
  await q.goto(B+'/index.html',{waitUntil:'domcontentloaded'});
  await q.waitForTimeout(1800);
  ck('reduced motion: no pulse at all', !(await q.evaluate(()=>document.querySelector('[data-nav-donate]').classList.contains('pulse'))));
  ck('reduced motion: animation disabled in CSS too',
     (await q.evaluate(()=>getComputedStyle(document.querySelector('[data-nav-donate]')).animationName))==='none');
  await rc.close();
}

// ---- the reported bug: the button on a host that has no /portal ------------
//
// The client hit /portal/donate 404ing on true-kind-psi.vercel.app, where
// .vercelignore excludes server/ so nothing can serve it. vercel.json now
// redirects that whole host, and main.js rewrites portal links on ANY foreign
// origin as a second line of defence. This serves the real pages under the
// Vercel hostname to prove the rewrite fires there and NOT on the app itself.
{
  const FOREIGN='http://true-kind-psi.vercel.app';
  const ctx=await b.newContext({viewport:{width:1440,height:900}});
  await ctx.route('**/*', async r=>{
    const u=r.request().url();
    if(u.startsWith(FOREIGN)){
      // Serve the genuine file from the app, under the foreign hostname.
      const res=await fetch(B+u.slice(FOREIGN.length));
      return r.fulfill({status:res.status,
        contentType:res.headers.get('content-type')||'text/html',
        body:Buffer.from(await res.arrayBuffer())});
    }
    return u.startsWith(B)?r.continue():r.abort();
  });
  const p=await ctx.newPage();
  await p.goto(FOREIGN+'/index.html',{waitUntil:'domcontentloaded'});
  const href=await p.getAttribute('[data-nav-donate]','href');
  ck('on a foreign host the donate link becomes absolute',
     href==='https://truekind.truehr.co.in/portal/donate', String(href));
  await p.goto(FOREIGN+'/donate.html',{waitUntil:'domcontentloaded'});
  const tiers=await p.locator('a[href*="/portal/donate?"]').evaluateAll(
    els=>els.map(e=>e.getAttribute('href')));
  ck('cost-tier links are rewritten too, query string intact',
     tiers.length===3 && tiers.every(h=>h.startsWith('https://truekind.truehr.co.in/portal/donate?amount=')),
     tiers.join(' '));
  await ctx.close();
}
{
  const ctx=await b.newContext({viewport:{width:1440,height:900}});
  await ctx.route('**/*',r=>r.request().url().startsWith(B)?r.continue():r.abort());
  const p=await ctx.newPage();
  await p.goto(B+'/index.html',{waitUntil:'domcontentloaded'});
  ck('on the app itself the link is left relative',
     (await p.getAttribute('[data-nav-donate]','href'))==='/portal/donate');
  await ctx.close();
}

// ---- it actually works: click through to a completed donation -------------
{
  const ctx=await b.newContext({viewport:{width:1440,height:900}});
  await ctx.route('**/*',r=>r.request().url().startsWith(B)?r.continue():r.abort());
  const p=await ctx.newPage();
  await p.goto(B+'/index.html',{waitUntil:'domcontentloaded'});
  await p.click('[data-nav-donate]');
  await p.waitForLoadState('domcontentloaded');
  ck('clicking it lands on the donation form', p.url().endsWith('/portal/donate'), p.url());
  ck('form is open without a login', (await p.locator('input[name="amount"]').count())===1);
  await p.fill('input[name="name"]','Header Donor');
  await p.fill('input[name="email"]','hd@test.org');
  await p.fill('input[name="phone"]','9876543210');
  // The chips are amount CARDS now — the ₹ figure plus the line it is costed
  // against — so the selector follows the rebuilt page.
  await p.locator('.amt-card', {hasText:'₹1,500'}).click();
  ck('amount card fills the amount', (await p.inputValue('#amount'))==='1500');
  ck('amount card marks itself pressed',
     (await p.locator('.amt-card[aria-pressed="true"]').count())===1);
  ck('running summary follows the amount',
     (await p.locator('[data-sum="amount"]').innerText()).replace(/\s/g,'')==='₹1,500');
  ck('running summary follows the programme',
     (await p.locator('[data-sum="cause"]').innerText()).trim()==='Skill Development');
  await p.click('button[type="submit"]');
  await p.waitForLoadState('domcontentloaded');
  ck('reaches the payment step', /pay\/mock/.test(p.url()), p.url());
  await p.click('button, a.btn').catch(()=>{});
  await p.waitForTimeout(900);
  ck('donation completes end to end', /receipt|thank/i.test(await p.evaluate(()=>document.body.innerText)), p.url());
  await ctx.close();
}
await b.close();
const pass=R.filter(Boolean).length;
console.log(`\n${pass}/${R.length} passed`);
process.exit(pass===R.length?0:1);
