let TOKEN = localStorage.getItem('pi_dashboard_token') || '';

function authHeaders() {
  return { Authorization: 'Bearer ' + TOKEN };
}

async function login() {
  const input = document.getElementById('token-input').value.trim();
  const res = await fetch('/api/login?token=' + encodeURIComponent(input));
  const data = await res.json();
  if (data.ok) {
    TOKEN = input;
    localStorage.setItem('pi_dashboard_token', TOKEN);
    showApp();
  } else {
    document.getElementById('login-error').textContent = 'Token non valido';
  }
}

function logout() {
  localStorage.removeItem('pi_dashboard_token');
  location.reload();
}

function showApp() {
  document.getElementById('login').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('app').classList.add('flex');
  initApp();
}

document.querySelectorAll('nav .tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav .tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.view).classList.remove('hidden');
    if (btn.dataset.view === 'system-view') loadSystem();
    if (btn.dataset.view === 'services-view') loadServices();
    if (btn.dataset.view === 'files-view') loadFiles('');
    if (btn.dataset.view === 'wifi-view') loadWifi();
    if (btn.dataset.view === 'updates-view') resetUpdatesView();
    if (btn.dataset.view === 'terminal-view' && window.fitAddon) setTimeout(() => window.fitAddon.fit(), 50);
  });
});

let initialized = false;
function initApp() {
  if (initialized) return;
  initialized = true;
  initTerminal();
  loadSystem();
  setInterval(() => {
    if (!document.getElementById('system-view').classList.contains('hidden')) loadSystem();
  }, 5000);
}

function initTerminal() {
  const term = new Terminal({ theme: { background: '#000000' }, fontSize: 14 });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById('terminal'));
  fitAddon.fit();
  window.fitAddon = fitAddon;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(proto + '://' + location.host + '/ws/terminal?token=' + encodeURIComponent(TOKEN));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'data') term.write(msg.data);
    if (msg.type === 'exit') term.write('\r\n[processo terminato]\r\n');
  };
  term.onData((data) => ws.send(JSON.stringify({ type: 'input', data })));
  const sendResize = () => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  ws.onopen = sendResize;
  window.addEventListener('resize', () => { fitAddon.fit(); sendResize(); });
}

function fmtBytes(n) {
  if (!n && n !== 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(1) + ' ' + units[i];
}

async function loadSystem() {
  try {
    const res = await fetch('/api/system/stats', { headers: authHeaders() });
    if (!res.ok) throw new Error('errore ' + res.status);
    const d = await res.json();
    document.getElementById('hostname').textContent = 'Pi Dashboard — ' + (d.os.hostname || '');
    const temp = d.cpuTemp && d.cpuTemp.main ? d.cpuTemp.main.toFixed(1) + ' °C' : 'n/d';
    const uptimeH = (d.uptime / 3600).toFixed(1) + ' h';
    const cards = [
      ['CPU', d.cpu.brand + ' (' + d.cpu.cores + ' core)'],
      ['Carico CPU', d.load.currentLoad.toFixed(1) + ' %'],
      ['Temperatura', temp],
      ['RAM', fmtBytes(d.mem.used) + ' / ' + fmtBytes(d.mem.total)],
      ['Uptime', uptimeH],
      ['OS', d.os.distro + ' (' + d.os.arch + ')'],
    ];
    d.fs.slice(0, 3).forEach((f) => cards.push(['Disco ' + f.mount, fmtBytes(f.used) + ' / ' + fmtBytes(f.size) + ' (' + f.use + '%)']));
    document.getElementById('system-cards').innerHTML = cards
      .map(([k, v]) => `<div class="card"><h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">${k}</h3><div class="text-xl font-semibold text-gray-100">${v}</div></div>`)
      .join('');
  } catch (err) {
    document.getElementById('system-cards').innerHTML = '<div class="card">Errore: ' + err.message + '</div>';
  }
}

async function loadServices() {
  const tbody = document.querySelector('#services-table tbody');
  tbody.innerHTML = '<tr><td colspan="5">Caricamento...</td></tr>';
  try {
    const res = await fetch('/api/services', { headers: authHeaders() });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'errore');
    tbody.innerHTML = d.services
      .map(
        (s) => `<tr>
          <td>${s.unit}</td><td>${s.load}</td><td>${s.active}</td><td>${s.sub}</td>
          <td class="space-x-1">
            <button class="btn-secondary !px-2 !py-1 text-xs" onclick="serviceAction('${s.unit}','start')">start</button>
            <button class="btn-secondary !px-2 !py-1 text-xs" onclick="serviceAction('${s.unit}','stop')">stop</button>
            <button class="btn-secondary !px-2 !py-1 text-xs" onclick="serviceAction('${s.unit}','restart')">restart</button>
          </td>
        </tr>`
      )
      .join('');
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="5">Errore: ' + err.message + '</td></tr>';
  }
}

async function serviceAction(name, action) {
  await fetch('/api/services/' + encodeURIComponent(name) + '/' + action, { method: 'POST', headers: authHeaders() });
  loadServices();
}

let currentDir = '';
async function loadFiles(dir) {
  currentDir = dir;
  const res = await fetch('/api/files/list?path=' + encodeURIComponent(dir), { headers: authHeaders() });
  const d = await res.json();
  document.getElementById('files-path').textContent = '/' + d.path;
  const tbody = document.querySelector('#files-list tbody');
  const rows = [];
  if (dir) rows.push(`<tr><td><button class="text-gray-200 hover:text-white" onclick="loadFiles('${dir.split('/').slice(0, -1).join('/')}')">..</button></td><td></td><td></td></tr>`);
  d.items
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
    .forEach((it) => {
      const p = (dir ? dir + '/' : '') + it.name;
      if (it.isDir) {
        rows.push(`<tr><td><button class="text-gray-200 hover:text-white" onclick="loadFiles('${p}')">📁 ${it.name}</button></td><td></td>
          <td><button class="btn-danger !px-2 !py-1 text-xs" onclick="deleteEntry('${p}')">elimina</button></td></tr>`);
      } else {
        rows.push(`<tr><td><button class="text-gray-200 hover:text-white" onclick="openFile('${p}')">📄 ${it.name}</button></td><td>${fmtBytes(it.size)}</td>
          <td><button class="btn-danger !px-2 !py-1 text-xs" onclick="deleteEntry('${p}')">elimina</button></td></tr>`);
      }
    });
  tbody.innerHTML = rows.join('');
}

let currentFile = null;
async function openFile(p) {
  const res = await fetch('/api/files/read?path=' + encodeURIComponent(p), { headers: authHeaders() });
  const d = await res.json();
  if (!res.ok) return alert(d.error);
  currentFile = p;
  document.getElementById('editor-path').textContent = p;
  document.getElementById('file-editor').value = d.content;
}

async function saveFile() {
  if (!currentFile) return alert('Nessun file aperto');
  const content = document.getElementById('file-editor').value;
  const res = await fetch('/api/files/write', {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: currentFile, content }),
  });
  const d = await res.json();
  if (!res.ok) alert(d.error); else alert('Salvato');
}

async function deleteEntry(p) {
  if (!confirm('Eliminare ' + p + '?')) return;
  const res = await fetch('/api/files/delete?path=' + encodeURIComponent(p), { method: 'DELETE', headers: authHeaders() });
  const d = await res.json();
  if (!res.ok) alert(d.error);
  loadFiles(currentDir);
}

async function runExec() {
  const command = document.getElementById('exec-cmd').value;
  const out = document.getElementById('exec-out');
  out.textContent = 'Esecuzione...';
  const res = await fetch('/api/exec', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ command }),
  });
  const d = await res.json();
  out.textContent = (d.stdout || '') + (d.stderr ? '\n[stderr]\n' + d.stderr : '') + (d.error ? 'Errore: ' + d.error : '');
}

// --- WiFi ---
async function loadWifi() {
  const statusEl = document.getElementById('wifi-status');
  statusEl.textContent = 'Caricamento...';
  try {
    const res = await fetch('/api/wifi/status', { headers: authHeaders() });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'errore');
    statusEl.innerHTML = `Interfaccia <b>${d.device}</b> — stato <b>${d.state}</b>` +
      (d.connection ? ` — connesso a <b>${d.connection}</b>` : ' — non connesso') +
      (d.ip ? ` — IP <b>${d.ip}</b>` : '');
  } catch (err) {
    statusEl.textContent = 'Errore: ' + err.message;
  }
  scanWifi();
}

async function scanWifi() {
  const tbody = document.querySelector('#wifi-table tbody');
  tbody.innerHTML = '<tr><td colspan="4">Scansione in corso...</td></tr>';
  try {
    const res = await fetch('/api/wifi/scan', { headers: authHeaders() });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'errore');
    tbody.innerHTML = d.networks
      .map(
        (n) => `<tr>
          <td>${n.inUse ? '✅ ' : ''}${n.ssid}</td>
          <td>${n.signal}%</td>
          <td>${n.security || 'aperta'}</td>
          <td><button class="btn-secondary !px-2 !py-1 text-xs" onclick="promptConnect('${n.ssid.replace(/'/g, "\\'")}')">connetti</button></td>
        </tr>`
      )
      .join('') || '<tr><td colspan="4">Nessuna rete trovata</td></tr>';
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="4">Errore: ' + err.message + '</td></tr>';
  }
}

function promptConnect(ssid) {
  document.getElementById('wifi-connect-ssid').value = ssid;
  document.getElementById('wifi-connect-password').value = '';
  document.getElementById('wifi-connect-password').focus();
}

async function connectWifi() {
  const ssid = document.getElementById('wifi-connect-ssid').value.trim();
  const password = document.getElementById('wifi-connect-password').value;
  const out = document.getElementById('wifi-connect-out');
  if (!ssid) return;
  out.textContent = 'Connessione a ' + ssid + '...';
  const res = await fetch('/api/wifi/connect', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ssid, password }),
  });
  const d = await res.json();
  out.textContent = d.ok ? 'Connesso a ' + ssid : 'Errore: ' + (d.stderr || d.error || 'connessione fallita');
  loadWifi();
}

// --- Updates ---
function resetUpdatesView() {
  document.getElementById('updates-out').textContent = '';
  document.getElementById('updates-table').querySelector('tbody').innerHTML = '';
  document.getElementById('updates-summary').textContent = 'Premi "Controlla aggiornamenti" per verificare i pacchetti disponibili.';
}

async function checkUpdates() {
  const summary = document.getElementById('updates-summary');
  const tbody = document.querySelector('#updates-table tbody');
  summary.textContent = 'Controllo in corso (apt-get update)...';
  tbody.innerHTML = '';
  try {
    const res = await fetch('/api/updates/check', { headers: authHeaders() });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'errore');
    summary.textContent = d.count > 0
      ? `${d.count} pacchetti aggiornabili`
      : 'Sistema aggiornato, nessun pacchetto da aggiornare';
    document.getElementById('upgrade-btn').classList.toggle('hidden', d.count === 0);
    tbody.innerHTML = d.packages
      .map((p) => `<tr><td>${p.package}</td><td>${p.currentVersion}</td><td>${p.newVersion}</td><td>${p.repo}</td></tr>`)
      .join('');
  } catch (err) {
    summary.textContent = 'Errore: ' + err.message;
  }
}

async function upgradeAll() {
  if (!confirm('Avviare apt-get upgrade -y? Potrebbe richiedere alcuni minuti.')) return;
  const out = document.getElementById('updates-out');
  out.textContent = 'Aggiornamento in corso, attendere...';
  const res = await fetch('/api/updates/upgrade', { method: 'POST', headers: authHeaders() });
  const d = await res.json();
  out.textContent = (d.stdout || '') + (d.stderr ? '\n[stderr]\n' + d.stderr : '');
  checkUpdates();
}

// --- Power ---
async function powerAction(action) {
  const label = action === 'reboot' ? 'riavviare' : 'spegnere';
  if (!confirm('Confermi di voler ' + label + ' il Raspberry Pi?')) return;
  await fetch('/api/power/' + action, { method: 'POST', headers: authHeaders() });
  alert('Comando inviato. La dashboard potrebbe diventare irraggiungibile.');
}

if (TOKEN) {
  fetch('/api/login?token=' + encodeURIComponent(TOKEN)).then((r) => r.json()).then((d) => {
    if (d.ok) showApp();
  });
}
