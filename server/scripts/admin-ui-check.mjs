import { createRequire } from 'module';
const require = createRequire(import.meta.url);
/* require(), not import(). Playwright is CommonJS, so `await import(path)`
   hands back { default: module } and a destructured { chromium } is undefined.
   createRequire also honours the resolved absolute path, which lets this run
   whether playwright is a project devDependency or installed globally. */
const { chromium } = require(process.env.PW_PATH || 'playwright');
const B = process.env.BASE || 'http://127.0.0.1:5750';
const EXEC = process.env.PW_CHROMIUM || (require('fs').existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const b=await chromium.launch(EXEC ? {executablePath:EXEC} : {});
const R=[];const ck=(n,ok,d='')=>{R.push(ok);console.log(`${ok?'PASS':'FAIL'}  ${n}${ok?'':'   << '+d}`)};
async function login(email,pw){
  const c=await b.newContext({viewport:{width:1440,height:960}});
  await c.route('**/*',r=>r.request().url().startsWith(B)?r.continue():r.abort());
  const p=await c.newPage();
  await p.goto(B+'/portal/signin');
  await p.fill('input[name="email"]',email); await p.fill('input[name="password"]',pw);
  await p.click('button[type="submit"]'); await p.waitForLoadState('domcontentloaded');
  return {c,p};
}
let {c:ac,p}=await login('admin@test.org','admin123');
ck('admin signed in', p.url().includes('/portal/admin'), p.url());

// ---- THE BUG CLASS THAT SLIPPED THROUGH: form tags must be well formed -----
for (const [path,sel] of [['/portal/admin/volunteers','form[action*="/status"]'],
                          ['/portal/admin/enquiries','form[action*="/status"]'],
                          ['/portal/admin/members','form[action*="/access"]']]){
  await p.goto(B+path,{waitUntil:'domcontentloaded'});
  const info=await p.evaluate(s=>{
    const f=document.querySelector(s);
    return f?{action:f.getAttribute('action'), hasTok:!!f.querySelector('input[name="_csrf"]')}:null;
  },sel);
  ck(`${path} form action parses correctly`, !!info && !/[<>]/.test(info.action||'x<'), info?info.action:'form not found');
  ck(`${path} form carries a token as a child`, !!info && info.hasTok);
}

// ---- volunteer status dropdown actually submits (the broken form's job) ----
await p.goto(B+'/portal/admin/volunteers',{waitUntil:'domcontentloaded'});
await p.selectOption('form[action*="/status"] select[name="status"]','contacted');
await p.waitForLoadState('domcontentloaded');
await p.waitForTimeout(400);
let val=await p.evaluate(()=>document.querySelector('select[name="status"]').value);
ck('volunteer status saved via the real form', val==='contacted', 'value='+val);

// ---- create a volunteer login, password shown once -------------------------
await p.click('form[action*="/login"] button');
await p.waitForLoadState('domcontentloaded');
const banner=await p.evaluate(()=>{const a=document.querySelector('.alert.ok');return a?a.innerText:''});
const pwm=banner.match(/([A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4})/);
ck('one-time password shown', !!pwm, banner.slice(0,90));
ck('sign-in ID shown', /rita@test\.org/.test(banner));
ck('warns it cannot be retrieved', /shown once/i.test(banner));
const tempPw = pwm?pwm[1]:null;
ck('volunteer now marked as having a login', (await p.locator('.pill.ok', {hasText:'Has login'}).count())>0);

// ---- the temp password works, and forces a change --------------------------
if (tempPw){
  const {c:vc,p:vp}=await login('rita@test.org',tempPw);
  ck('volunteer can sign in with the temp password', !vp.url().includes('signin'), vp.url());
  await vp.goto(B+'/portal/member',{waitUntil:'domcontentloaded'});
  ck('temp password forces the change-password page', vp.url().includes('/portal/member/password'), vp.url());
  // change it
  await vp.fill('input[name="current"]',tempPw);
  await vp.fill('input[name="next"]','realpassword123');
  await vp.click('form[action="/portal/member/password"] button[type="submit"]');
  await vp.waitForLoadState('domcontentloaded');
  { const t=await vp.evaluate(()=>document.body.innerText);
    ck('password change accepted', /changed/i.test(t), JSON.stringify(t.replace(/\s+/g,' ').slice(0,160))); }
  await vp.goto(B+'/portal/member',{waitUntil:'domcontentloaded'});
  ck('after changing, the member area opens', !vp.url().includes('/password'), vp.url());
  await vc.close();
}

// ---- deactivate a member, and it must bite an active session ---------------
const {c:mc,p:mp}=await login('mem@test.org','member123');
ck('member signed in', mp.url().includes('/portal/member'), mp.url());
await p.goto(B+'/portal/admin/members',{waitUntil:'domcontentloaded'});
p.on('dialog',d=>d.accept());
await p.click('form[action*="/access"] button');
await p.waitForLoadState('domcontentloaded');
ck('member shows as deactivated', (await p.locator('.pill.warn',{hasText:'Deactivated'}).count())>0);
await mp.goto(B+'/portal/member',{waitUntil:'domcontentloaded'});
const blocked=await mp.evaluate(()=>document.body.innerText);
ck('the ALREADY-LOGGED-IN member is now locked out', /deactivated/i.test(blocked), blocked.slice(0,80));
ck('and cannot sign in again', await (async()=>{const {c,p:x}=await login('mem@test.org','member123');
  const out=/deactivated/i.test(await x.evaluate(()=>document.body.innerText))||x.url().includes('signin');
  await c.close(); return out;})());
await mc.close();

// ---- self-deactivation and last-admin guards ------------------------------
let tok=await p.evaluate(()=>document.querySelector('input[name="_csrf"]').value);
const meId=await p.evaluate(async()=>1);
let r=await p.evaluate(async(t)=>{
  const res=await fetch('/portal/admin/members/1/access',{method:'POST',redirect:'manual',
    headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({_csrf:t,action:'block'}).toString()});
  const body=await res.text();
  const visible=body.replace(/<(style|script)[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]+>/g,' ');
  // Match against the WHOLE visible text, not a leading slice. This was
  // slice(0,200) and broke the moment a nav link was added: the page body got
  // pushed past the window and a passing behaviour started reporting as a
  // failure. Report a short excerpt, but assert on everything.
  const flat=visible.replace(/\s+/g,' ').trim();
  return {status:res.status, text:flat, excerpt:flat.slice(0,160)};
},tok);
ck('cannot deactivate your own account', r.status===400 && /your own account/i.test(r.text), r.status+' '+r.excerpt);

// ---- certificate file upload ---------------------------------------------
await p.goto(B+'/portal/admin/certificates',{waitUntil:'domcontentloaded'});
const certHref=await p.evaluate(()=>{const a=[...document.querySelectorAll('a')].find(x=>/certificates\/\d+$/.test(x.getAttribute('href')||''));return a?a.getAttribute('href'):null});
ck('certificate detail link found', !!certHref, String(certHref));
await p.goto(B+certHref,{waitUntil:'domcontentloaded'});
ck('upload form present', (await p.locator('input[type="file"][name="file"]').count())===1);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8z8DAwMDAxMDAwMAAAA4EAgHmAWmqAAAAAElFTkSuQmCC','base64');
await p.setInputFiles('input[type="file"][name="file"]',{name:'cert.png',mimeType:'image/png',buffer:png});
await p.click('form[enctype="multipart/form-data"] button[type="submit"]');
await p.waitForLoadState('domcontentloaded');
ck('image certificate uploaded', /File uploaded/i.test(await p.evaluate(()=>document.body.innerText)));
ck('preview rendered', (await p.locator('.codebox img').count())===1);
// pdf replaces it
const pdf=Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF','utf8');
await p.setInputFiles('input[type="file"][name="file"]',{name:'cert.pdf',mimeType:'application/pdf',buffer:pdf});
await p.click('form[enctype="multipart/form-data"] button[type="submit"]');
await p.waitForLoadState('domcontentloaded');
{ const t=await p.evaluate(()=>document.body.innerText.replace(/\s+/g,' '));
  const n=await p.locator('.codebox').count();
  ck('PDF accepted and replaces the image',
     (await p.locator('.codebox .serial',{hasText:'PDF'}).count())===1,
     `codeboxes=${n} text=${JSON.stringify(t.slice(0,200))}`); }
// a disallowed type is refused
await p.setInputFiles('input[type="file"][name="file"]',{name:'evil.html',mimeType:'text/html',buffer:Buffer.from('<script>x</script>')});
await p.click('form[enctype="multipart/form-data"] button[type="submit"]');
await p.waitForLoadState('domcontentloaded');
ck('.html certificate refused', /must be one of|Upload failed/i.test(await p.evaluate(()=>document.body.innerText)));

await ac.close(); await b.close();
const pass=R.filter(Boolean).length;
console.log(`\n${pass}/${R.length} passed`);
process.exit(pass===R.length?0:1);
