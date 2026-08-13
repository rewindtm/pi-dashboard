#!/usr/bin/env bash
# Installa e avvia la Pi Dashboard come servizio systemd.
# Uso: ./setup-pi.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_USER="$(whoami)"

echo "== Installazione dipendenze di sistema =="
sudo apt-get update -y
sudo apt-get install -y build-essential python3 curl

if ! command -v node >/dev/null 2>&1; then
  echo "== Installazione Node.js LTS =="
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "== Installazione dipendenze npm =="
cd "$DIR"
npm install

if [ ! -f .env ]; then
  TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
  cat > .env <<EOF
DASHBOARD_TOKEN=$TOKEN
PORT=7890
EOF
  echo "Creato .env con un token generato automaticamente."
fi

echo "== Configurazione permesso systemctl senza password (per la gestione servizi dalla dashboard) =="
SUDOERS_FILE="/etc/sudoers.d/pi-dashboard-systemctl"
if [ ! -f "$SUDOERS_FILE" ]; then
  echo "$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/systemctl" | sudo tee "$SUDOERS_FILE" > /dev/null
  sudo chmod 440 "$SUDOERS_FILE"
fi

echo "== Creazione servizio systemd =="
SERVICE_FILE="/etc/systemd/system/pi-dashboard.service"
sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=Pi Dashboard
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$DIR
ExecStart=$(command -v node) $DIR/server/index.js
Restart=on-failure
EnvironmentFile=$DIR/.env

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable pi-dashboard
sudo systemctl restart pi-dashboard

echo ""
echo "== Fatto =="
echo "Token di accesso (in .env): $(grep DASHBOARD_TOKEN .env | cut -d= -f2)"
echo "Dashboard raggiungibile su: http://$(hostname -I | awk '{print $1}'):7890"
echo "Stato servizio: sudo systemctl status pi-dashboard"
