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
npm run ui:smoke       # 27 — admin screens, real browser
npm run donate:smoke   # 23 — the header Donate button on all 9 pages
npm run board:render   # 26 — the About page's board section, real browser
```

**Check:** `ALL PASS` or `n/n passed` at the end of each. If any of them fails,
do not deploy — send me the output.

The last three drive a real browser. If Chromium is not installed yet:

```bash
npm i -D playwright && npx playwright install chromium
```

They skip cleanly (exit 0, with a note) when playwright is absent, so a missing
browser will not block a deploy — but those 76 assertions then simply do not
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
# The Vercel CORS grant is dead — the site is served by this server now
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

**The Vercel deployment now redirects here.** `.vercelignore` excluded
`server/`, so that host could only ever serve the static HTML — `/portal/*`,
`/api/*` and `/uploads/*` all returned Vercel's 404 page. That is what the
header Donate button hit: `true-kind-psi.vercel.app/portal/donate` 404'd while
the same button worked on this domain.

`vercel.json` now redirects **every** path on that host to
`https://truekind.truehr.co.in/<same path>` with a temporary (307) redirect, so
anyone holding an old link lands in the right place. Temporary, not permanent,
so browsers do not cache it forever if you ever want that project back.

If you would rather be rid of it entirely, delete the project in the Vercel
dashboard. Nothing here depends on it. `assets/js/main.js` also rewrites
`/portal/*` links to this domain on any host that is not this one — belt to the
redirect's braces, and it covers a `file://` copy too.

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
