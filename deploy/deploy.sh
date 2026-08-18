#!/usr/bin/env bash
# One-time setup on the truehr.co.in VPS (Ubuntu 22). Run as a sudo-capable user.
set -euo pipefail

REPO_URL="${1:-https://github.com/koustav2/true-kind.git}"
APP_DIR=/var/www/truekind

echo "== 1. Node 20 (skips if present) =="
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

echo "== 2. pm2 + nginx + certbot (skip any you already run for TRUE HRMS) =="
sudo npm i -g pm2 >/dev/null
sudo apt-get install -y nginx certbot python3-certbot-nginx >/dev/null

echo "== 3. App =="
sudo mkdir -p "$APP_DIR" && sudo chown "$USER" "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull; else git clone "$REPO_URL" "$APP_DIR"; fi
cd "$APP_DIR"
npm ci --omit=dev || npm install --omit=dev

echo "== 4. Environment =="
if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s/SESSION_SECRET=.*/SESSION_SECRET=$(openssl rand -hex 32)/" .env
  echo '>>> EDIT .env NOW: DB_* (Postgres creds from /opt/truehr/.env.production),'
  echo '>>>                ADMIN_EMAIL/ADMIN_PASSWORD, APP_BASE_URL'
  echo '>>> then re-run this script.'
  exit 0
fi

echo "== 5. Seed admin + create truekind DB (does not touch the TRUE HRMS database) ==" 
npm run seed

echo "== 6. Start under pm2 =="
pm2 start deploy/ecosystem.config.js
pm2 save
pm2 startup -u "$USER" --hp "$HOME" | tail -1 || true

echo "== 7. Nginx =="
sudo cp deploy/nginx-truekind.conf /etc/nginx/sites-available/truekind
sudo ln -sf /etc/nginx/sites-available/truekind /etc/nginx/sites-enabled/truekind
sudo nginx -t && sudo systemctl reload nginx

echo "Done. Point DNS (A record) at this box, then: sudo certbot --nginx -d <domain>"
