# Pi Dashboard

Dashboard web per gestire un Raspberry Pi via Tailscale (o rete locale): terminale interattivo nel browser, stato di sistema, WiFi, aggiornamenti pacchetti, gestione servizi systemd, file manager, integrazione GitHub (clona ed avvia le tue repo con un click) e un'API REST per comandi remoti.

Frontend: Node.js + Express, viste server-side in **EJS**, stile con **Tailwind CSS** (via CDN — richiede che il browser che apre la dashboard abbia accesso a Internet per caricare `cdn.tailwindcss.com`).

## Funzionalità

- **Terminale**: shell interattiva completa nel browser (via WebSocket + `node-pty`).
- **Sistema**: CPU, temperatura, RAM, dischi, uptime, rete, in tempo reale.
- **WiFi**: stato connessione, scansione reti, connessione/disconnessione, gestione reti salvate (via `nmcli`).
- **Aggiornamenti**: verifica pacchetti apt aggiornabili e avvia `apt-get upgrade`.
- **Riavvio/Spegnimento**: pulsanti per riavviare o spegnere il Raspberry Pi.
- **Servizi**: elenco unit systemd con start/stop/restart.
- **File**: sfoglia, apri, modifica, elimina file (root configurabile).
- **GitHub**: connetti un Personal Access Token, sfoglia le tue repository, clonale sul Pi, imposta un comando di avvio per ciascuna e avviala/fermala con un click (log in tempo reale, pull per aggiornarla, eliminazione).
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
- La gestione servizi usa `sudo systemctl`, gli aggiornamenti usano `sudo apt-get`, riavvio/spegnimento usano `sudo reboot`/`sudo shutdown`: tutte protette da regole `sudoers` `NOPASSWD` dedicate (vedi `setup-pi.sh`), non da `sudo` generico.
- La gestione WiFi usa `nmcli` (richiede NetworkManager, predefinito su Raspberry Pi OS Bookworm+); l'utente viene aggiunto al gruppo `netdev`.
- Il token GitHub e l'elenco delle app clonate sono salvati solo localmente in `data/` (esclusa da git, permessi `600`), mai inviati altrove se non alle API ufficiali di GitHub.
- Il comando di avvio di ogni app GitHub viene eseguito così come inserito (stessa fiducia dell'utente che ha già accesso al terminale e a `/api/exec`): non condividere l'accesso alla dashboard con chi non deve poter eseguire comandi sul Pi.

## Aggiornare la dashboard sul Pi

Il servizio esegue automaticamente `git pull` + `npm install` (script [scripts/update.sh](scripts/update.sh)) ad ogni avvio/riavvio, quindi basta:

```bash
sudo systemctl restart pi-dashboard
```

(o un riavvio del Pi). Se non c'è connessione o il pull fallisce, il servizio parte comunque con il codice già presente sul disco.

Per aggiornare ed avviare manualmente senza passare da systemd:

```bash
cd pi-dashboard
./scripts/update.sh
sudo systemctl restart pi-dashboard
```
