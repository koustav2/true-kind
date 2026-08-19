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

### 3. Run both test suites

```bash
npm run smoke
npm run cms:smoke
```

**Check:** `ALL PASS` at the end of each. 30 assertions then 40.
If either fails, do not deploy — send me the output.

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

# Make sure APP_BASE_URL matches how people actually reach the site.
# While you are still on http:// (no certbot yet), it MUST say http://
grep -E '^(APP_BASE_URL|ALLOWED_ORIGINS|SESSION_SECRET|DB_PASS)=' .env
```

**Check:** the printout shows

- `ALLOWED_ORIGINS=` (empty)
- `APP_BASE_URL=http://truekind.truehr.co.in` — **`http`, not `https`, until
  certbot has run.** The session cookie's `secure` flag follows this value. Set
  it to `https` too early and the browser silently throws away the login
  cookie, which looks exactly like a wrong password.
- `SESSION_SECRET=` something long and random, **not** `change-me-...`
- `DB_PASS=` non-empty

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

You may also see:

```
⚠ Session cookie is NOT marked secure — APP_BASE_URL is not https.
```

That is expected and correct while you are on plain HTTP. It goes away in
step 14.

### 10. Update nginx — video upload does not work without this

This part lives outside Docker, so `docker compose up` does not touch it. At the
old `client_max_body_size 5m`, nginx rejects any video with its own 413 before
Node sees a single byte.

```bash
cp deploy/nginx-truekind.conf /etc/nginx/sites-available/truekind
nginx -t
systemctl reload nginx
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

In a browser: `http://truekind.truehr.co.in/portal/signin`

**Check:** you can sign in. If the page just bounces you back to the sign-in
form, the cookie is being dropped — go back to step 7 and make sure
`APP_BASE_URL` starts with `http://`.

Then go to **Website** in the top nav (`/portal/admin/cms`).

**Check:** a page picker on the left — "Header & footer (all pages)" first, then
the 9 pages, each with a field count. Homepage should show around 129.

### 13. Make one test edit end to end

1. Click **Homepage**, open the first group, change any heading.
2. Press **Save changes**. You should see "Saved 1 change".
3. Open `http://truekind.truehr.co.in/` and **hard-refresh** — Cmd/Ctrl +
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

**`.vercelignore` is dead** and can be deleted — Vercel is no longer a target.

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
