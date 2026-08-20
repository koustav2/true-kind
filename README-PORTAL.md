# True Kind Foundation — Member & Admin Portal

Public site at `/`, portal at `/portal`. Node + Express + **MySQL (Sequelize)** + EJS —
same database engine as TRUE HRMS; uses its own `truekind` database on the same
server (created automatically, never touches HRMS data).

## Run locally
```bash
cp .env.example .env        # edit: DB_USER/DB_PASS (your MySQL), ADMIN_*, SESSION_SECRET
npm install
npm run seed                # creates truekind DB + admin
npm start                   # http://localhost:3000
```

## Deploy on the truehr.co.in VPS — Docker (recommended, HRMS compose untouched)
```bash
git clone <repo-url> /opt/truekind && cd /opt/truekind
cp .env.example .env && nano .env      # DB_PASS from /opt/truehr/.env.production; ADMIN_*
docker network ls | grep truehr        # if not truehr_default, set TRUEHR_NETWORK in .env
docker compose up -d --build
docker compose exec truekind npm run seed
docker logs truekind --tail 20         # expect "schema synced"
cp deploy/nginx-truekind.conf /etc/nginx/sites-available/truekind
ln -sf /etc/nginx/sites-available/truekind /etc/nginx/sites-enabled/truekind
nginx -t && systemctl reload nginx
certbot --nginx -d truekind.truehr.co.in   # once DNS resolves
```
Updates later: `cd /opt/truekind && git pull && docker compose up -d --build`.

Alternative (no Docker): `deploy/deploy.sh` runs it on the host under pm2 —
that route needs Postgres published on 127.0.0.1:5432.

## Payments — PhonePe
Leave `PHONEPE_MERCHANT_ID` empty and every payment runs through a **mock
gateway page** (auto-success, nothing charged) so the whole flow works in dev.
For real payments fill `PHONEPE_MERCHANT_ID`, `PHONEPE_SALT_KEY`,
`PHONEPE_SALT_INDEX`, and switch `PHONEPE_BASE_URL` from the preprod sandbox
to `https://api.phonepe.com/apis/hermes`. PhonePe approval requires
Terms & Conditions, Refund Policy and Privacy Policy pages live on the domain.

## What's implemented
**Member** — signup/signin · "verify your membership" → pay ₹100/month or
₹1,000/year (annual recommended) → member ID + card with QR + barcode + serial
(HTML + PDF) · add donation → pay · donation list → per-donation certificate ·
receipts with QR/barcode/serial (HTML + PDF) · edit profile.

**Admin** (same signin) — dashboard counts · member list (Active / Guest tabs) ·
certificates: create, open one to see holders, issue to a member (unique serial)
· donation lists (Member / Guest tabs) + CSV export · website content editor
(About, banner upload, Team, Works, Press — served at `/api/content/<key>`) ·
donation-form field builder (for Debasish's fields).

**Guest** — `/portal/donate`: full details + tax section (PAN/bank/branch),
pays, gets a receipt at `/portal/receipt/<txnId>`.

## The CMS — every word, image and video on all 9 pages

Admin → **Website**. Two ways to edit, same data underneath:

1. **`/portal/admin/cms`** — the full editor. A page picker down the left, fields
   grouped by the section they belong to. "Header & footer" is one entry because
   those are shared: edit the phone number once, it changes on all nine pages.
2. **Click-to-edit** — open any public page while signed in as admin and a small
   toolbar appears bottom-centre. Hit *Edit this page*, click any heading,
   paragraph or link, change it, save. Visitors never see any of this: the
   toolbar only renders after `/portal/admin/cms/session` confirms an admin.

### How it works

`server/cms/registry.json` is the single source of truth — **545 fields**, each
with an id, a type and a label. It is GENERATED, not hand-written:

```bash
npm run cms:build      # re-run after ANY edit to the 9 HTML files
```

That script parses each page, stamps every editable element with a stable
`data-cms="<id>"` attribute, injects the declared video containers, and writes
the registry. It is idempotent — an element that already has an id keeps it, so
re-running only assigns ids to genuinely new elements and saved content never
detaches from its field.

**If you edit the HTML and forget to re-run it**, the new block simply is not
editable yet; nothing breaks. Click-to-edit will say so when you click it.

Storage: one `SiteContent` row per page (`cms:index`, `cms:global`, …) holding
only the fields an admin has actually **changed**. Defaults stay in the HTML, so
`GET /api/cms/<page>` is small and the site renders correctly with the backend
down, mid-deploy, or on a cold database. `assets/js/cms.js` applies the overrides
after load; there is no layout shift and no loading state.

Field types: `text`, `textarea`, `richtext` (inline markup preserved and
sanitised on save), `url` (relative / https / mailto / tel only), `image`,
`video`.

### Video

Eight slots, declared in `server/cms/video-slots.js` — homepage, about, work,
impact, donate, volunteer, chairperson, press. Each takes **either**:

- **an uploaded file** — mp4/webm/mov/m4v up to 200 MB, served from this box.
  Your bandwidth, every play.
- **a YouTube or Vimeo link** — pasted, parsed server-side into a canonical
  `youtube-nocookie.com/embed/<id>` or `player.vimeo.com/video/<id>` URL. Costs
  nothing to serve. The raw string never reaches an iframe.

A slot with no video set stays `hidden` — nothing shifts on the public page.

Video upload needs the nginx limit in `deploy/nginx-truekind.conf`
(`client_max_body_size 210m`). At the old 5m, nginx rejected uploads with its own
413 before Node saw a byte.

### Media library

`/portal/admin/cms/media`. Upload, preview, delete. Extension **and** mimetype
must agree, filenames become UUIDs, and `.svg` is refused on purpose — SVG is an
XML document that can carry `<script>`, and `/uploads` is the same origin as the
admin session cookie.

## Security work done alongside the CMS

Fixed because write endpoints could not safely be added without it:

- **`express.static` was serving the repo root.** `GET /server/routes/admin.js`
  returned the source of every route; `/server/config.js`, `/package.json` and
  `/docker-compose.yml` too. Now denied, including encoded and traversal forms.
- **No CSRF anywhere.** Added `server/middleware/csrf.js` — a session-bound
  token, `timingSafeEqual` comparison, on all 18 existing forms plus the new
  ones. Multipart forms carry it in the action URL, because the global guard runs
  before multer and cannot see a multipart body.
- **Uploads were stored XSS.** No fileFilter, no mimetype check, served from the
  session origin. Now allowlisted, with `nosniff` and a locked CSP on `/uploads`.
- **`POST /content/:key` replaced instead of merging** — editing the banner
  headline silently deleted the banner image. Now merges.
- Session cookie gained `secure` + `sameSite`; production refuses to boot on the
  fallback `dev-only-secret`; body limits raised for CMS-sized saves.

## Deployment

**Our own server. One Express app, one domain.** The nine static pages, the
`/api` content endpoints and the whole `/portal` admin are served by the same
process, so every path in the front-end is relative and everything is
same-origin.

That is not a detail — it is what makes click-to-edit work at all. A
cross-origin `fetch` never receives the session cookie, so a split deployment
(static pages on one host, API on another) cannot authenticate an editor no
matter how the CORS headers are set. Which is why there is no second host, no
external API gateway, and no third-party static host in this project. CORS
defaults to an empty allowlist for the same reason.

Deploy is `git pull` + `docker compose up -d --build` on the VPS, behind nginx
with certbot. See `DEPLOY-CMS.md`.

## Test
```bash
npm run smoke        # 30 assertions — signup → pay → donations → certificate → PDFs
npm run cms:smoke    # 40 assertions — CMS save → bundle, sanitising, CSRF, uploads, video
```
Both boot the real app in-process on in-memory SQLite. `cms:smoke` deliberately
asserts the negative cases too: hostile richtext, `javascript:` links,
cross-page writes, missing tokens, `.html`/`.svg` uploads, anonymous access.
