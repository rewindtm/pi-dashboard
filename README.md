# Pi Dashboard

Dashboard web per gestire un Raspberry Pi via Tailscale (o rete locale): terminale interattivo nel browser, stato di sistema, gestione servizi systemd, file manager e un'API REST per comandi remoti.

## Funzionalità

- **Terminale**: shell interattiva completa nel browser (via WebSocket + `node-pty`).
- **Sistema**: CPU, temperatura, RAM, dischi, uptime, rete, in tempo reale.
- **Servizi**: elenco unit systemd con start/stop/restart.
- **File**: sfoglia, apri, modifica, elimina file (root configurabile).
- **API**: `POST /api/exec` per eseguire comandi da remoto (usabile anche in modo programmatico).

Tutto è protetto da un token condiviso (`DASHBOARD_TOKEN`).

## Installazione sul Raspberry Pi

```bash
git clone <URL_DEL_REPO> pi-dashboard
cd pi-dashboard
chmod +x setup-pi.sh
./setup-pi.sh
```

Lo script installa Node.js se manca, le dipendenze, genera un token casuale in `.env`, configura il permesso per gestire i servizi (`sudoers`) e crea/avvia il servizio systemd `pi-dashboard`.

Al termine mostra l'URL (`http://<ip-tailscale>:7890`) e il token da usare per accedere.

## Sviluppo/test locale

```bash
npm install
cp .env.example .env   # imposta un token
npm start
```

## Sicurezza

- Cambia il token in `.env` con uno lungo e casuale; non condividerlo.
- La dashboard è pensata per reti private/Tailscale: non esporla su Internet senza HTTPS/reverse proxy e ulteriori protezioni.
- Il file manager è limitato alla cartella impostata in `FILES_ROOT` (default: home dell'utente).
- La gestione servizi usa `sudo systemctl` con una regola `NOPASSWD` dedicata solo a `systemctl`.

## Aggiornare la dashboard sul Pi

```bash
cd pi-dashboard
git pull
npm install
sudo systemctl restart pi-dashboard
```
