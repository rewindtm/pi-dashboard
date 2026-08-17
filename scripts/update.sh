#!/usr/bin/env bash
# Aggiorna il codice da git e le dipendenze npm. Eseguito da systemd (ExecStartPre)
# prima di ogni avvio/riavvio del servizio: se fallisce (es. nessuna connessione),
# il servizio parte comunque con il codice già presente (vedi il prefisso "-" in ExecStartPre).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

if [ -d .git ]; then
  git pull --ff-only
  npm install
fi
