#!/usr/bin/env bash
# GammaTerminal — one-shot provisioning for an Oracle Cloud (OCI) Ubuntu 22.04/24.04 instance.
# Run as the default 'ubuntu' user:   bash deploy/setup.sh
# Re-runnable: safe to run again after a `git pull` to rebuild + restart.
set -euo pipefail

APP_DIR=/opt/gammaterminal
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> 1/7  System packages"
sudo apt-get update -y
sudo apt-get install -y python3 python3-venv python3-pip nginx git curl rsync apache2-utils unzip

echo "==> 2/7  Node.js 20 (for the frontend build)"
NODE_MAJOR=0
command -v node >/dev/null && NODE_MAJOR=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "==> 3/7  Place code at $APP_DIR"
sudo mkdir -p "$APP_DIR"
sudo chown -R "$USER":"$USER" "$APP_DIR"
if [ "$REPO_DIR" != "$APP_DIR" ]; then
  rsync -a --delete \
    --exclude backend/.venv --exclude frontend/node_modules --exclude frontend/dist \
    --exclude data --exclude backend/.env \
    "$REPO_DIR"/ "$APP_DIR"/
fi
cd "$APP_DIR"

echo "==> 4/7  Backend venv + deps"
python3 -m venv backend/.venv
backend/.venv/bin/pip install --upgrade pip
backend/.venv/bin/pip install -r backend/requirements.txt

if [ ! -f backend/.env ]; then
  cp backend/.env.example backend/.env
  PUBIP=$(curl -fsS https://api.ipify.org || echo YOUR_PUBLIC_IP)
  {
    echo ""
    echo "# set for this server:"
    echo "FLATTRADE_REDIRECT_URL=http://${PUBIP}/api/broker/callback"
  } >> backend/.env
  echo "    -> wrote backend/.env  (edit it now: add FLATTRADE_API_KEY / SECRET / CLIENT_ID)"
fi
mkdir -p data data/history

echo "==> 5/7  Frontend build"
cd frontend
npm ci || npm install
npm run build
cd ..

echo "==> 6/7  systemd + nginx"
sudo cp deploy/gammaterminal-backend.service /etc/systemd/system/gammaterminal-backend.service
sudo sed -i "s#/opt/gammaterminal#${APP_DIR}#g; s/^User=.*/User=${USER}/" \
  /etc/systemd/system/gammaterminal-backend.service
sudo systemctl daemon-reload
sudo systemctl enable --now gammaterminal-backend
sudo systemctl restart gammaterminal-backend

sudo cp deploy/nginx-gammaterminal.conf /etc/nginx/sites-available/gammaterminal
sudo sed -i "s#/opt/gammaterminal#${APP_DIR}#g" /etc/nginx/sites-available/gammaterminal
sudo ln -sf /etc/nginx/sites-available/gammaterminal /etc/nginx/sites-enabled/gammaterminal
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl restart nginx

echo "==> 7/7  Firewall (instance-level)"
# OCI Ubuntu images ship iptables rules that block everything except SSH.
sudo iptables -I INPUT 5 -p tcp --dport 80 -j ACCEPT || true
sudo iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT || true
if command -v netfilter-persistent >/dev/null; then
  sudo netfilter-persistent save || true
else
  sudo apt-get install -y iptables-persistent && sudo netfilter-persistent save || true
fi

PUBIP=$(curl -fsS https://api.ipify.org || echo '<public-ip>')
cat <<EOF

============================================================
  GammaTerminal is up:   http://${PUBIP}/
  Backend logs:          journalctl -u gammaterminal-backend -f
  Restart backend:       sudo systemctl restart gammaterminal-backend
  Rebuild after changes: git pull && bash deploy/setup.sh

  STILL TO DO:
   1. OCI console -> VCN -> Security List: add Ingress rule
      Source 0.0.0.0/0  TCP  dest port 80  (and 443 if you add TLS)
   2. Reserve the public IP so it never changes
      (OCI console -> Instance -> attached VNIC -> IPv4 -> "Edit" -> Reserved)
   3. Whitelist ${PUBIP} in the Flattrade API portal, and set that app's
      Redirect URL to exactly:  http://${PUBIP}/api/broker/callback
   4. Put your Flattrade key/secret/client id in $APP_DIR/backend/.env, then
      sudo systemctl restart gammaterminal-backend
   5. Add a password gate: sudo htpasswd -c /etc/nginx/.htpasswd you
      then uncomment auth_basic in /etc/nginx/sites-available/gammaterminal
      and: sudo systemctl reload nginx
============================================================
EOF
