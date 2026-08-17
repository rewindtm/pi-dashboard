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
  initApp();
}

// --- Tema chiaro/scuro ---
function updateThemeIcon() {
  const isDark = document.documentElement.classList.contains('dark');
  document.getElementById('theme-icon-sun').classList.toggle('hidden', !isDark);
  document.getElementById('theme-icon-moon').classList.toggle('hidden', isDark);
}

function toggleTheme() {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('pi_dashboard_theme', isDark ? 'dark' : 'light');
  updateThemeIcon();
}

updateThemeIcon();

// --- Sidebar mobile ---
function toggleSidebar(open) {
  document.getElementById('sidebar').classList.toggle('-translate-x-full', !open);
  document.getElementById('sidebar-backdrop').classList.toggle('hidden', !open);
}

document.querySelectorAll('#sidebar .side-link').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#sidebar .side-link').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.view).classList.remove('hidden');
    toggleSidebar(false);
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

const STAT_ICONS = {
  cpu: { bg: 'bg-blue-500', svg: '<path stroke-linecap="round" stroke-linejoin="round" d="M8.25 3v2.25M15.75 3v2.25M8.25 18.75V21M15.75 18.75V21M3 8.25h2.25M3 15.75h2.25M18.75 8.25H21M18.75 15.75H21M5.25 6.75h13.5v10.5H5.25V6.75z" /><path stroke-linecap="round" stroke-linejoin="round" d="M9 9h6v6H9V9z" />' },
  load: { bg: 'bg-accent', svg: '<path stroke-linecap="round" stroke-linejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z" />' },
  temp: { bg: 'bg-amber-500', svg: '<path stroke-linecap="round" stroke-linejoin="round" d="M15.362 5.214A8.252 8.252 0 0112 21 8.25 8.25 0 016.038 7.048 8.287 8.287 0 009 9.6a8.983 8.983 0 013.361-6.867 8.21 8.21 0 003 2.48z" /><path stroke-linecap="round" stroke-linejoin="round" d="M12 18a3.75 3.75 0 00.495-7.468 5.99 5.99 0 00-1.925 3.547 5.975 5.975 0 01-2.133-1.001A3.75 3.75 0 0012 18z" />' },
  ram: { bg: 'bg-purple-500', svg: '<path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M6.75 3H4.5A2.25 2.25 0 002.25 5.25v13.5A2.25 2.25 0 004.5 21h15a2.25 2.25 0 002.25-2.25V5.25A2.25 2.25 0 0019.5 3h-2.25m-9 0h9m-9 0v2.25m9-2.25v2.25m-9 0h9M6.75 5.25v13.5h10.5V5.25" />' },
  uptime: { bg: 'bg-gray-500', svg: '<path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6l4 2" /><circle cx="12" cy="12" r="9" stroke-linecap="round" stroke-linejoin="round" fill="none" />' },
  os: { bg: 'bg-slate-500', svg: '<path stroke-linecap="round" stroke-linejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25" />' },
  disk: { bg: 'bg-indigo-500', svg: '<path stroke-linecap="round" stroke-linejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 5.625c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />' },
};

function statCard(key, label, value) {
  const icon = STAT_ICONS[key] || STAT_ICONS.os;
  return `<div class="stat-card">
    <span class="stat-icon ${icon.bg}"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="h-6 w-6">${icon.svg}</svg></span>
    <div class="min-w-0">
      <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">${label}</h3>
      <div class="truncate text-lg font-semibold text-gray-800 dark:text-gray-100">${value}</div>
    </div>
  </div>`;
}

async function loadSystem() {
  try {
    const res = await fetch('/api/system/stats', { headers: authHeaders() });
    if (!res.ok) throw new Error('errore ' + res.status);
    const d = await res.json();
    document.getElementById('hostname').textContent = 'Pi Dashboard — ' + (d.os.hostname || '');
    const temp = d.cpuTemp && d.cpuTemp.main ? d.cpuTemp.main.toFixed(1) + ' °C' : 'n/d';
    const uptimeH = (d.uptime / 3600).toFixed(1) + ' h';
    const ramPct = d.mem.total ? (d.mem.used / d.mem.total) * 100 : 0;
    const cards = [
      statCard('cpu', 'CPU', d.cpu.brand + ' (' + d.cpu.cores + ' core)'),
      statCard('load', 'Carico CPU', d.load.currentLoad.toFixed(1) + ' %'),
      statCard('temp', 'Temperatura', temp),
      statCard('ram', 'RAM', fmtBytes(d.mem.used) + ' / ' + fmtBytes(d.mem.total)),
      statCard('uptime', 'Uptime', uptimeH),
      statCard('os', 'OS', d.os.distro + ' (' + d.os.arch + ')'),
    ];
    d.fs.slice(0, 3).forEach((f) => cards.push(statCard('disk', 'Disco ' + f.mount, fmtBytes(f.used) + ' / ' + fmtBytes(f.size) + ' (' + f.use + '%)')));
    document.getElementById('system-cards').innerHTML = cards.join('');
    pushHistoryPoint(d.load.currentLoad, ramPct);
  } catch (err) {
    document.getElementById('system-cards').innerHTML = '<div class="card">Errore: ' + err.message + '</div>';
  }
}

// --- Grafico storico CPU/RAM ---
const history = { cpu: [], ram: [] };
const HISTORY_MAX = 60;

function pushHistoryPoint(cpu, ram) {
  history.cpu.push(cpu);
  history.ram.push(ram);
  if (history.cpu.length > HISTORY_MAX) { history.cpu.shift(); history.ram.shift(); }
  drawHistoryChart();
}

function drawHistoryChart() {
  const canvas = document.getElementById('history-chart');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0) return;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = rect.width;
  const h = rect.height;
  ctx.clearRect(0, 0, w, h);

  const isDark = document.documentElement.classList.contains('dark');
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = (h / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  function drawLine(data, color) {
    if (data.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / (HISTORY_MAX - 1)) * w;
      const y = h - (Math.min(100, Math.max(0, v)) / 100) * h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  drawLine(history.cpu, '#0ca678');
  drawLine(history.ram, '#3b82f6');
}

window.addEventListener('resize', drawHistoryChart);

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
