# Deploying the CMS — step by step

Every step has a **check** with the output you should see. If a check fails,
stop there rather than continuing — the later steps assume the earlier ones
worked.

Two machines are involved:

- **Mac** — `~/dev/Freelencing-june-kp/True-HR/true-kind-site` (where the new code is)
- **VPS** — `/opt/truekind` (a separate clone of `github.com/koustav2/true-kind.git`)

The code is currently only on the Mac. The container running on the VPS is the
old build.

---

## Part A — on your Mac

### 1. Confirm which branch you are on

```bash
cd ~/dev/Freelencing-june-kp/True-HR/true-kind-site
git branch --show-current
git status --short
```

**Check:** note the branch name. The repo has both `main` and `admin-user`.
Whatever you push must be the branch the VPS pulls — find that out in step 6
before you push, if you are not sure.

`git status --short` should list the CMS files as modified/new. Roughly 30
entries, including `server/cms/`, `server/routes/cms.js`,
`assets/js/cms.js`, `assets/js/cms-edit.js`, and all 9 `.html` files.

### 2. Install the one new build-time dependency

```bash
npm install
```

**Check:** no errors. This adds `cheerio` (devDependency — used only by the
registry generator, never at runtime).

### 3. Run the test suites

```bash
npm run smoke          # 30 — portal end to end
npm run cms:smoke      # 40 — the content editor
npm run board:smoke    # 50 — board CRUD + the donation form's server-side checks
npm run member:smoke   # 87 — unpaid to active, receipts, certificates, ID cards
npm run verify:smoke   # 59 — QR verification, revocation, the printed card
npm run sections:smoke # 78 — every admin section + the manager permission sweep
npm run ui:smoke       # 27 — admin screens, real browser
npm run donate:smoke   # 23 — the header Donate button on all 9 pages
npm run board:render   # 29 — the About page's board section, real browser
```

**Check:** `ALL PASS` or `n/n passed` at the end of each. If any of them fails,
do not deploy — send me the output.

The last three drive a real browser. If Chromium is not installed yet:

```bash
npm i -D playwright && npx playwright install chromium
```

They skip cleanly (exit 0, with a note) when playwright is absent, so a missing
browser will not block a deploy — but those 79 assertions then simply do not
run.

### 4. Commit and push

```bash
git add -A
git commit -m "CMS: 545 editable fields, click-to-edit, video slots, CSRF, upload hardening"
git push
```

**Check:** `git log --oneline -1` shows your commit.

If `git push` is rejected because the branch has no upstream, it will print the
exact command to use — run that.

---

## Part B — on the VPS

```bash
ssh root@66.116.242.17     # or however you normally get in
cd /opt/truekind
```

### 5. Back up the database first

The CMS only adds a table, and nothing here alters existing data — but you are
about to change the app that owns your members and donations, so take the
backup anyway. It costs 5 seconds.

```bash
docker exec truehr-db pg_dump -U truehr truekind > ~/truekind-$(date +%F-%H%M).sql
ls -lh ~/truekind-*.sql
```

**Check:** the file exists and is not 0 bytes.

### 6. Pull the new code

```bash
git branch --show-current      # <- this is the branch you must have pushed to
git pull
```

**Check:** `git log --oneline -1` shows the same commit hash you pushed in
step 4. If it shows something older, you pushed a different branch — go back
to step 4 and push this one.

### 7. Fix two values in `.env`

```bash
# ALLOWED_ORIGINS must be EMPTY. This server serves the site, so /api is
# same-origin and needs no CORS grant at all. Anything listed here is a
# cross-origin read grant on the public content API — don't hand one out.
sed -i 's|^ALLOWED_ORIGINS=.*|ALLOWED_ORIGINS=|' .env

# APP_BASE_URL must match the scheme people actually reach the site on.
grep -cE '^(APP_BASE_URL|ALLOWED_ORIGINS|SESSION_SECRET|DB_PASS)=' .env
sed -n 's|^APP_BASE_URL=|APP_BASE_URL is |p' .env
grep -q ssl_certificate /etc/nginx/sites-enabled/truekind && echo "TLS: LIVE" || echo "TLS: not yet"
```

**Check:** `APP_BASE_URL`'s scheme must match the TLS line:

| TLS | APP_BASE_URL must be |
|---|---|
| LIVE | `https://truekind.truehr.co.in` |
| not yet | `http://truekind.truehr.co.in` |

This drives the session cookie's `secure` flag. A `secure` cookie is only ever
sent over HTTPS, so `https` while the site is still plain HTTP means the browser
silently discards the login cookie — the sign-in form just bounces you back with
no error anywhere. `COOKIE_SECURE=true|false` overrides if you ever need it.

Also check `ALLOWED_ORIGINS=` is empty, and that `SESSION_SECRET` is genuinely
random — `openssl rand -hex 32`, not a hand-typed pattern. Anyone who can guess
it can forge an admin session cookie. Changing it signs everyone out, which is
cheap to do now and expensive later.

Print secrets with `grep -c` or the `sed` form above rather than dumping values,
so they stay out of terminal scrollback and chat logs.

### 8. Rebuild and restart

```bash
docker compose up -d --build
docker compose ps
```

**Check:** `CREATED` now says **seconds ago**, not "About an hour ago". If it
still says an hour, the image did not change — re-check step 6.

### 9. Read the logs

```bash
docker logs truekind --tail 30
```

**Check:** you want to see

```
✓ Database connected (postgres), schema synced
True Kind portal → http://localhost:3000  (site at /, portal at /portal)
```

`schema synced` is `sequelize.sync()` creating the new `MediaAssets` table.
Nothing to migrate — the CMS text lives in the existing `SiteContent` JSON
column, and the media library is a brand-new table, precisely so that a bare
`sync()` is enough.

If TLS is not up yet you will also see:

```
⚠ Session cookie is NOT marked secure — APP_BASE_URL is not https.
```

That is correct while you are on plain HTTP, and disappears once APP_BASE_URL is
an https URL. If you see it *after* TLS is live, APP_BASE_URL still says http —
fix it and restart.

### 10. Update nginx — video upload does not work without this

This part lives outside Docker, so `docker compose up` does not touch it. At the
old `client_max_body_size 5m`, nginx rejects any video with its own 413 before
Node sees a single byte.

**Check whether certbot has already rewritten the live config first:**

```bash
grep -n ssl_certificate /etc/nginx/sites-enabled/truekind
```

**If that prints nothing** (no TLS yet), copying the repo file is safe:

```bash
cp deploy/nginx-truekind.conf /etc/nginx/sites-available/truekind
nginx -t && systemctl reload nginx
```

**If it prints certificate paths, DO NOT COPY.** `deploy/nginx-truekind.conf` is
the pre-TLS version — port 80 only, no SSL block. Copying it over a
certbot-managed config deletes the `listen 443 ssl` lines, HTTPS stops working,
and since `APP_BASE_URL` is https by then the session cookie is `secure` so
nobody can sign in either. Two outages at once.

Patch the live file in place instead:

```bash
cp /etc/nginx/sites-available/truekind ~/nginx-truekind.bak
sed -i 's|^\( *\)client_max_body_size .*|\1client_max_body_size 210m;|' /etc/nginx/sites-available/truekind
grep -n client_max_body_size /etc/nginx/sites-available/truekind
nginx -t && systemctl reload nginx
```

Large video uploads also want these, inside the `location /` block that has
`proxy_pass`, or they buffer to disk and time out at nginx's default 60s:

```
proxy_request_buffering off;
proxy_read_timeout   300s;
proxy_send_timeout   300s;
client_body_timeout  300s;
```

**Check:** `nginx -t` prints `syntax is ok` and `test is successful`. If it
errors, do **not** reload — paste me the error.

---

## Part C — verify it actually works

### 11. Confirm the source-code leak is closed

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/server/config.js
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/package.json
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/
```

**Check:** `404`, `404`, `200` — in that order. Before this deploy the first two
returned 200 and handed out your route source.

### 12. Sign in and open the editor

In a browser: `https://truekind.truehr.co.in/portal/signin` (http if TLS is not up yet)

**Check:** you can sign in. If the page just bounces you back to the sign-in
form, the cookie is being dropped — go back to step 7 and make sure
`APP_BASE_URL`'s scheme matches whether TLS is actually live.

Then go to **Website** in the top nav (`/portal/admin/cms`).

**Check:** a page picker on the left — "Header & footer (all pages)" first, then
the 9 pages, each with a field count. Homepage should show around 129.

### 13. Make one test edit end to end

1. Click **Homepage**, open the first group, change any heading.
2. Press **Save changes**. You should see "Saved 1 change".
3. Open `https://truekind.truehr.co.in/` and **hard-refresh** — Cmd/Ctrl +
   Shift + R. A normal reload serves the cached page and looks unchanged, which
   is the single most common reason to think this is broken.

**Check:** your new wording is on the live page.

Now try click-to-edit: still signed in, on the homepage, look for the dark pill
at the bottom of the screen. Click **Edit this page**, click any paragraph,
change it, **Save**.

**Check:** the text updates in place. Open the page in a private window — no
toolbar, no dashed outlines, and your edit is there.

### 14. Once certbot is done

```bash
certbot --nginx -d truekind.truehr.co.in
# then
cd /opt/truekind
sed -i 's|^APP_BASE_URL=.*|APP_BASE_URL=https://truekind.truehr.co.in|' .env
docker compose up -d
docker logs truekind --tail 10
```

**Check:** the "cookie is NOT marked secure" warning is gone. Sign in again to
confirm login still works over HTTPS.

---

## Things worth knowing afterwards

**If you edit the HTML by hand**, re-run the generator on your Mac and commit
the result:

```bash
npm run cms:build
```

New blocks are not editable until you do. Nothing breaks in the meantime — the
page just shows the hardcoded text, and click-to-edit will tell you the block
is not in the registry. The generator is idempotent: existing field ids are
preserved, so saved content never detaches from its field.

It cannot run inside the container — `cheerio` is a devDependency and the
Dockerfile installs with `--omit=dev`. `registry.json` is committed, so runtime
is unaffected.

**Uploads survive rebuilds** — `docker-compose.yml` bind-mounts `./uploads`.
They are *not* in git and *not* in your database backup. Back them up
separately if the client uploads anything they cannot re-upload:

```bash
tar czf ~/truekind-uploads-$(date +%F).tar.gz -C /opt/truekind uploads
```

**Videos:** uploaded files are served by your VPS, so you pay the bandwidth on
every play. A pasted YouTube/Vimeo link costs you nothing. For anything longer
than about a minute, or anything you expect real traffic on, use the link.

**There is one host, and it is this VPS.** The static pages, `/api`, `/uploads`
and the whole `/portal` admin are one Express process behind nginx. No
third-party static host, no separate API gateway, no second deployment target.

This is a design requirement, not a preference. Click-to-edit authenticates with
the session cookie, and a cross-origin `fetch` never receives it — so splitting
the static pages onto another host cannot work regardless of CORS settings. That
is why nothing in the front-end hardcodes a domain: every path is relative, so
moving the site is a DNS change and nothing else.

If an old link on some other host is still reaching people, the fix is at that
host: delete the deployment or point its DNS here. Nothing in this repo
configures it, and nothing here depends on it.

**The board is data now, not markup.** "Our Board" on the About page is edited
at **Website → Board** in the admin: photo upload, name, designation, email, four
social links, an order number and a show/hide tick per person. Add as many people
as you like.

The four cards in `about.html` (Chairperson / Vice Chairperson / Secretary /
Treasurer) are the fallback: they stay on the page until the first real trustee
is added, and they come back if `/api/board` ever fails. So the section is never
empty and never broken.

This added one table, `BoardMembers`. Like the others it is created by
`sequelize.sync()` on the next start — nothing to run by hand.

**Rollback**, if something is wrong:

```bash
cd /opt/truekind
git log --oneline -5          # find the commit before the CMS one
git checkout <that-hash>
docker compose up -d --build
```

The CMS only *adds* rows and a table, so rolling the code back leaves your
members, donations and certificates untouched. Saved CMS text stays in the
database and reappears if you roll forward again.


---

## Membership, ID cards and QR verification

Three things landed together here. All of them add tables and none of them touch
an existing column, so `sequelize.sync()` creates what it needs on the next start
and there is nothing to run by hand.

### Registered but not paid

A signup is a **guest** until the membership fee arrives. That was already true;
what was missing was any way to record a fee that did not come through PhonePe.

**Members → New memberships** now shows every unpaid registration with an
**Unpaid** pill and a **Record payment** panel: plan, how it was paid (cash, bank
transfer, UPI or cheque), the amount actually collected, the date, a reference
and a note. Saving it assigns a Member ID, sets the validity, issues a numbered
receipt and moves the row to **Active members**.

Two deliberate refusals in that form:

- **"Online" is not offered.** That mode is only ever set by the gateway. If an
  admin could label a cash payment as online, a hand-entered fee would be
  indistinguishable from a real transaction in the accounts.
- **Every by-hand entry is stamped** with the name of the admin who entered it,
  and shows as `by hand` against the gateway's `gateway` in the receipts list.
  Reconciling those two columns is the whole job.

**Members → Membership receipts** lists every fee ever received, with a PDF each
and a CSV export. Online payments appear there automatically — including the
gateway ones, which previously left no receipt at all.

Renewing now **extends from the current expiry** rather than resetting to today.
The old code always set validity to "today + plan", so anyone renewing a month
early silently forfeited the month they had left.

### ID cards

**Members → any member → ID card.** Card type (member / staff / volunteer),
employee code, designation, department, blood group, joining date, validity and a
photograph. **Print ID card** produces a two-page PDF — front and back — at true
CR80 card size (54 × 85.6 mm), so it feeds a card printer without scaling.

Every field is optional. With nothing filled in the card still prints and still
looks deliberate: the photo box shows the holder's initials, empty fields show a
dash. The one thing it will not do is print without an ID number, because the
QR would then verify as "not recognised".

The card uses `assets/img/logo.png`. If you drop higher-resolution variants in as
`assets/img/logo-lockup.png` or `logo-lockup@2x.png` they are picked up
automatically — no code change, and nothing breaks if they are absent.

### The QR codes now verify

**This is the change worth understanding.** Every card, certificate and receipt
already carried a QR code, and it encoded the bare serial — so scanning one with
a phone produced a line of text and nothing else. The printed caption said
"verify this document by quoting the serial", which meant telephoning the office.

The QR now encodes a URL. Scanning it opens **`/verify/<serial>`**, a public page
that says in words whether the document is **valid**, **genuine but expired**,
**withdrawn**, or **not recognised** — resolved live against the database. It
works for all four document types (membership cards, certificates, donation
receipts, membership fee receipts). There is a typed-in form at `/verify` and a
JSON endpoint at `/api/verify/<serial>` for a gate scanner.

The barcode still carries the bare serial, on purpose: a Code128 scanner is a
keyboard, and it should type the serial into your spreadsheet, not a URL.

**Withdrawing** replaced deleting. Withdrawing a certificate used to delete the
issue row, which meant the certificate still in somebody's hand started verifying
as "not recognised" — indistinguishable from a forgery, and the record that we
ever made the award was gone. Now the record survives and the serial reports
*withdrawn*, with a date and a reason, and it can be undone. A membership card can
be withdrawn the same way when it is reported lost; that does not touch the
person's membership or their sign-in.

**Verification** in the admin nav shows every scan — what was checked, what answer
was given, and whether the link was one of ours. A run of *not recognised* from
one connection is what somebody trying serials at random looks like. No addresses
are stored, only a salted hash, so repetition is visible without keeping a record
of who looked at what.

**One optional setting.** `VERIFY_SECRET` signs the verification links. Leave it
unset and it is derived from `SESSION_SECRET`, which is fine. If you do set it,
**do not change it later without reading `server/utils/verify.js` first** — the
signature is deliberately advisory rather than a gate, precisely so that rotating
a key cannot turn thousands of printed documents into failures. Changing it makes
old links report a signature mismatch (a warning on the page); it does not stop
them verifying.

### After deploying this

1. Sign in and open **Members → New memberships**. Confirm the unpaid
   registrations are listed with the payment panel.
2. Record a test payment for one of them. Check they move to **Active members**
   with a Member ID, and that the receipt appears under **Membership receipts**.
3. Open that member, fill in the ID card panel, and print the card.
4. **Scan the QR on the printed card with your phone.** It should open the
   verification page and say *Valid*. That single test proves the whole chain —
   `APP_BASE_URL`, the QR, the route and the database lookup.
5. Withdraw the card, scan it again, confirm it now says *Withdrawn*, then
   restore it.

If step 4 opens a page on the wrong domain, `APP_BASE_URL` in `.env` is wrong —
it is what gets printed into the QR, so fix it **before** printing any real cards.


---

## The rest of the admin

The sections from the reference admin, in the order they appear in the navigation.

### Certificates — four screens instead of one

- **Certificate types** — the title and wording. Created once, issued many times.
  Each type now also has a **printed design**: navy & gold, purple, or green. The
  choice applies to every certificate of that type, including ones already
  issued, because the PDF is generated fresh each time it is downloaded.
- **Generate** — starts from the list of active members, one click per person.
  This is the screen you want when a training batch finishes. Certificates
  somebody already holds are shown as held rather than offered again, so a click
  cannot fail.
- **Issued register** — every certificate that exists, member and visitor
  together, sorted by date, with its verification status. One list on purpose:
  somebody looking up a serial off a piece of paper does not know which table it
  came from.
- **Visitor certificates** — for a camp attendee, a visiting speaker, a school
  student. Name, father's or guardian's name, mobile, email, programme, template.
  **No login is created**, which is the whole reason this is separate: the member
  certificate table requires a user id, and issuing through it would mean making
  an account for somebody who never asked for one, with a password nobody knows.
  Visitor serials start `TKF-VC` and verify at `/verify` like everything else.

### Donations and receipts

**Record a donation taken offline** on the donations page: cash at an event, a
bank transfer, UPI or a cheque. It becomes an ordinary donation — counted in
every total, given a receipt number — with a row beside it saying how it arrived
and who keyed it in. The **How** column is that distinction, and it is the column
you reconcile against the cash book. As with membership fees, "online" cannot be
entered by hand.

**All receipts** is one hub over four lists: membership fees, member donations,
visitor donations, and cash & offline. That last one is *not* a fifth kind of
money — it is the subset of donations a person entered rather than the gateway
confirming, so those rows also appear in one of the lists above it. The page says
so, because a total that appears twice is confusing unless you know why.

### People

- **All users** — every account, whatever its state, searchable by name, email,
  phone or Member ID. The member tabs answer "who has paid"; this answers "who
  exists", which is the question you have when somebody rings up and you cannot
  find them.
- **Blocked** — deactivated accounts, with a Reinstate button. Deactivation is
  enforced per request, so it takes effect on that person's very next click even
  if they are already signed in.

### Notices

**Read this before using it.** Notices appear *inside the portal*, on the
member's dashboard when they sign in. They are **not emailed and not sent by
SMS** — this application has no mail sender and no SMS gateway connected. The
screen states that plainly at the top, deliberately: a "Send Notice" button that
quietly only posts to a dashboard, while letting you believe 508 members just got
an email, is worse than no feature at all. Connecting a mail provider is separate
work and we can quote for it.

You can target everyone, paid members only, or unpaid registrations only, pin a
notice to the top, and give it a date to stop showing.

### Managers

A manager works the queues — records payments, issues certificates, answers
enquiries — **without full administrator rights**. Tick only the sections they
need.

`User.role` is `ENUM('member','admin')` on a live table and `sequelize.sync()`
cannot extend an ENUM, so a manager is a member account with a grant rather than
a third role. Practical consequence: a manager signs in at the normal sign-in
page and lands in the admin area automatically.

**The permission check is default-deny.** A route reaches a manager only if it is
explicitly listed in `server/middleware/staff.js`. Anything unlisted is
administrator-only — including every route added in future. That direction is
deliberate: forgetting to think about permissions fails closed and produces a
"no access" page somebody asks about, rather than a data leak nobody notices.

**A manager can never**, at any section level, deactivate an account, issue a
password or a volunteer login, edit the website, the media library or the board,
delete anything, or reach the Managers page. Those stay with administrators. The
test suite enumerates every admin route and asserts a manager with no sections is
denied all of them, then asserts a manager holding *every* section still cannot
reach any of the above.

Suspending a grant (untick "access is active") locks them out on their next
click.

### Reports

Every CSV export in one place, properly escaped — a name like `Nayak, Priya`
stays in one column. Members, certificates (members and visitors, with status),
membership fees, donations, volunteers, enquiries.

### Nav counts

The navigation carries live counts, like the reference. They come from one
middleware and are wrapped in a try/catch that defaults to no badge: the
navigation is decoration, and a failed count must never be able to break the page
it decorates.

### New tables from this batch

`CertificateStyles`, `VisitorCertificates`, `OfflineDonations`, `Notices`,
`ManagerAccesses`. All created by `sequelize.sync()` on the next start. Nothing to
run by hand, and no existing table is altered.
