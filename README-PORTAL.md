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

## Next steps
- Wire the static pages to `/api/content/*` so admin edits show on the site
- Forgot-password flow (needs an email provider)
- Real PhonePe merchant onboarding + the three policy pages

## Test
`node server/scripts/smoke.js` — boots in-memory SQLite and runs the whole
journey (signup → membership pay → donations → certificate → PDFs → admin CMS).
