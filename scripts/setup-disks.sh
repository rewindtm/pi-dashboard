#!/bin/bash
# Una tantum, da eseguire con sudo sul Pi: abilita la sezione "Dischi" della dashboard.
#   sudo bash ~/pi-dashboard/scripts/setup-disks.sh
# Installa l'helper /usr/local/bin/pi-disk e permette all'utente di eseguire SOLO quello
# senza password (nessun altro accesso root viene concesso).
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "Esegui con sudo: sudo bash $0"; exit 1; }

USER_NAME=${SUDO_USER:-rewi}
DIR=$(cd "$(dirname "$0")" && pwd)

install -o root -g root -m 755 "$DIR/pi-disk.sh" /usr/local/bin/pi-disk
mkdir -p /mnt/disks

tmp=$(mktemp)
echo "$USER_NAME ALL=(root) NOPASSWD: /usr/local/bin/pi-disk *" > "$tmp"
visudo -cf "$tmp" >/dev/null
install -o root -g root -m 440 "$tmp" /etc/sudoers.d/pi-dashboard-disks
rm -f "$tmp"

echo "Fatto: la sezione Dischi della dashboard è abilitata per l'utente $USER_NAME."
