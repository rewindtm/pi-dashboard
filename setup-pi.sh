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

echo "== Configurazione permessi sudo senza password (systemctl, apt, reboot/shutdown, config tunnel Cloudflare, PostgreSQL) =="
SUDOERS_FILE="/etc/sudoers.d/pi-dashboard"
SUDOERS_TMP="$(mktemp)"
cat <<EOF > "$SUDOERS_TMP"
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/systemctl
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/apt-get update -qq
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/apt-get upgrade -y
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/apt-get install -y postgresql
$SERVICE_USER ALL=(root) NOPASSWD: /usr/sbin/reboot
$SERVICE_USER ALL=(root) NOPASSWD: /usr/sbin/shutdown now
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/tee /etc/cloudflared/config.yml
$SERVICE_USER ALL=(postgres) NOPASSWD: /usr/bin/psql
$SERVICE_USER ALL=(postgres) NOPASSWD: /usr/bin/tee
EOF
if sudo visudo -cf "$SUDOERS_TMP" > /dev/null; then
  sudo cp "$SUDOERS_TMP" "$SUDOERS_FILE"
  sudo chmod 440 "$SUDOERS_FILE"
else
  echo "ATTENZIONE: file sudoers generato non valido, permessi non aggiornati" >&2
fi
rm -f "$SUDOERS_TMP"

echo "== Permesso per gestire il WiFi tramite nmcli =="
sudo usermod -aG netdev "$SERVICE_USER" || true

chmod +x "$DIR/scripts/update.sh"

echo "== Creazione servizio systemd =="
SERVICE_FILE="/etc/systemd/system/pi-dashboard.service"
sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=Pi Dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$DIR
ExecStartPre=-$DIR/scripts/update.sh
ExecStart=$(command -v node) $DIR/server/index.js
Restart=on-failure
# Le app avviate dalla dashboard girano nel suo stesso cgroup: con KillMode=control-group
# (default) un riavvio del servizio le ucciderebbe tutte insieme alla dashboard.
# KillMode=process fa sì che systemd fermi solo il processo Node della dashboard.
KillMode=process
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
