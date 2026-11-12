const fs = require('fs');
const path = require('path');

// Analizza una repo clonata e propone Dockerfile / docker-compose.yml / .dockerignore.
// Non esegue nulla e non legge i valori segreti del .env: usa solo i nomi delle variabili,
// la porta e gli host degli URL (per capire se puntano a servizi su localhost).

const SERVER_DEPS = ['express', 'fastify', 'koa', '@hapi/hapi', '@nestjs/core', 'restify', 'hono', 'socket.io', 'ws', 'next', 'nuxt', 'ejs'];
const BOT_DEPS = ['discord.js', 'telegraf', 'node-telegram-bot-api', 'grammy', '@whiskeysockets/baileys'];
const STATIC_DEPS = ['vite', 'react-scripts', '@vue/cli-service', 'parcel', '@angular/cli', 'astro'];
// Moduli che compilano codice nativo: nell'immagine "slim" servono python3, make e g++.
const NATIVE_DEPS = ['node-pty', 'bcrypt', 'canvas', 'better-sqlite3', 'sqlite3', '@discordjs/opus', 'serialport', 'sodium-native', 'argon2', 'node-gyp', 'usb', 'bufferutil', 'utf-8-validate'];
// Cartelle che di solito contengono dati da non perdere a ogni ricostruzione dell'immagine.
const DATA_DIRS = ['data', 'uploads', 'uploads_imprese', 'storage', 'database', 'db', 'logs', 'backups'];
const READONLY_DIRS = ['secrets'];

const exists = (dir, ...p) => fs.existsSync(path.join(dir, ...p));

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function parseEnv(file) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function nodeMajor(pkg) {
  const eng = pkg && pkg.engines && pkg.engines.node;
  const m = eng && String(eng).match(/(\d{2})/);
  const major = m ? Number(m[1]) : null;
  return major && [18, 20, 22, 24].includes(major) ? major : 22;
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/;

// Variabili del .env che sono URL verso localhost (database, redis...): in un container isolato
// "localhost" è il container stesso, quindi vanno riscritte verso l'host.
function localhostVars(env) {
  const found = [];
  for (const [k, v] of Object.entries(env)) {
    try {
      const u = new URL(v);
      if (u.hostname && LOCAL_HOST.test(u.hostname)) found.push(k);
    } catch {}
  }
  return found;
}

function detectPort(dir, env, pkg, kind) {
  if (env.PORT && /^\d{2,5}$/.test(env.PORT)) return Number(env.PORT);
  const candidates = [pkg && pkg.main, 'server.js', 'index.js', 'app.js', 'src/index.js', 'src/server.js', 'server/index.js', 'src/index.ts', 'server/src/index.ts', 'server/src/index.js', 'server/index.ts', 'backend/src/index.ts', 'backend/src/index.js'].filter(Boolean);
  for (const c of candidates) {
    try {
      const text = fs.readFileSync(path.join(dir, c), 'utf8');
      const m = text.match(/\.listen\(\s*(?:process\.env\.PORT\s*(?:\|\||\?\?)\s*)?(\d{2,5})/) || text.match(/PORT\s*(?:\|\||\?\?)\s*(\d{2,5})/);
      if (m) return Number(m[1]);
    } catch {}
  }
  if (kind === 'static') return 8080;
  if (kind === 'next') return 3000;
  return null;
}

function startCommand(dir, pkg, warnings) {
  const s = (pkg && pkg.scripts) || {};
  if (s.start) return ['npm', 'start'];
  const entry = [pkg && pkg.main, 'server.js', 'index.js', 'app.js', 'src/index.js', 'src/server.js', 'server/index.js'].find((f) => f && exists(dir, f));
  if (entry) {
    if (s.dev) warnings.push('Manca lo script "start": uso "node ' + entry + '". Verifica che sia l\'avvio di produzione (non quello di "npm run dev").');
    return ['node', entry];
  }
  warnings.push('Non trovo come si avvia l\'app (nessuno script "start" né un file principale): controlla la riga CMD del Dockerfile.');
  return ['npm', 'start'];
}

function installCommand(dir) {
  if (exists(dir, 'pnpm-lock.yaml')) return { run: 'corepack enable && pnpm install --frozen-lockfile', pm: 'pnpm' };
  if (exists(dir, 'yarn.lock')) return { run: 'corepack enable && yarn install --frozen-lockfile', pm: 'yarn' };
  if (exists(dir, 'package-lock.json')) return { run: 'npm ci', pm: 'npm' };
  return { run: 'npm install', pm: 'npm', noLock: true };
}


// Programmi di sistema che il codice lancia (child_process): nell'immagine node slim non ci sono.
const SYSTEM_TOOLS = [
  { name: 'LibreOffice', re: /['"` \/](soffice|libreoffice)['"` .]/i, pkgs: ['libreoffice-writer', 'fonts-liberation', 'fonts-dejavu-core', 'fonts-crosextra-carlito', 'fonts-crosextra-caladea'] },
  { name: 'ffmpeg', re: /['"` \/]ffmpeg['"` .]/i, pkgs: ['ffmpeg'] },
  { name: 'poppler', re: /['"` \/](pdftoppm|pdftotext|pdfimages)['"` .]/i, pkgs: ['poppler-utils'] },
];

function detectSystemTools(dir) {
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'data', 'public', 'uploads', 'coverage']);
  const found = new Map();
  let files = 0;
  const walk = (d, depth) => {
    if (depth > 4 || files > 400) return;
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (e.isDirectory()) { if (!skip.has(e.name) && !e.name.startsWith('.')) walk(path.join(d, e.name), depth + 1); continue; }
      if (!/\.(js|cjs|mjs|ts)$/.test(e.name) || /^(test|jest)/i.test(e.name) || /\.(test|spec)\./.test(e.name)) continue;
      files++;
      let txt;
      try { if (fs.statSync(path.join(d, e.name)).size > 400000) continue; txt = fs.readFileSync(path.join(d, e.name), 'utf8'); } catch { continue; }
      if (!/child_process|exec|spawn/.test(txt)) continue;
      for (const t of SYSTEM_TOOLS) if (!found.has(t.name) && t.re.test(txt)) found.set(t.name, t);
    }
  };
  walk(dir, 0);
  return [...found.values()];
}

function dockerfileNode(a) {
  const lines = ['# Generato dalla Pi Dashboard: controlla e adatta prima dell\'uso.', `FROM node:${a.nodeVersion}-bookworm-slim`, 'WORKDIR /app', ''];
  if (a.nativeDeps.length) {
    lines.push(`# Moduli nativi rilevati (${a.nativeDeps.join(', ')}): servono gli strumenti di compilazione.`);
    lines.push('RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*', '');
  }
  if (a.systemTools && a.systemTools.length) {
    const pk = [...new Set(a.systemTools.flatMap((t) => t.pkgs))];
    lines.push(`# Programmi di sistema usati dal codice (${a.systemTools.map((t) => t.name).join(', ')}).`);
    lines.push(`RUN apt-get update && apt-get install -y --no-install-recommends ${pk.join(' ')} && rm -rf /var/lib/apt/lists/*`, '');
  }
  if (a.installNeedsSources) {
    lines.push('# Lo script "postinstall" lavora su sottocartelle: servono i sorgenti già copiati prima dell\'install.', 'COPY . .', `RUN ${a.install.run}`, '');
  } else {
    lines.push('COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* ./', `RUN ${a.install.run}`, '', 'COPY . .', '');
  }
  if (a.build) {
    lines.push(`RUN ${a.install.pm === 'npm' ? 'npm run build' : a.install.pm + ' run build'}`);
    if (a.install.pm === 'npm') lines.push('RUN npm prune --omit=dev');
    lines.push('');
  }
  lines.push('ENV NODE_ENV=production');
  if (a.port) lines.push(`ENV PORT=${a.port}`, `EXPOSE ${a.port}`);
  lines.push(`CMD ${JSON.stringify(a.start)}`);
  return lines.join('\n') + '\n';
}

function dockerfileStatic(a) {
  const out = a.staticOut;
  return [
    '# Generato dalla Pi Dashboard: sito statico compilato e servito da nginx.',
    `FROM node:${a.nodeVersion}-bookworm-slim AS build`,
    'WORKDIR /app',
    'COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* ./',
    `RUN ${a.install.run}`,
    'COPY . .',
    `RUN ${a.install.pm === 'npm' ? 'npm run build' : a.install.pm + ' run build'}`,
    '',
    'FROM nginx:alpine',
    `COPY --from=build /app/${out} /usr/share/nginx/html`,
    'EXPOSE 80',
    '',
  ].join('\n');
}

function dockerfilePython(a) {
  const lines = ['# Generato dalla Pi Dashboard: controlla e adatta prima dell\'uso.', 'FROM python:3.12-slim', 'WORKDIR /app', ''];
  if (a.pyDeps === 'requirements') lines.push('COPY requirements.txt ./', 'RUN pip install --no-cache-dir -r requirements.txt', '');
  lines.push('COPY . .', '');
  if (a.pyDeps === 'pyproject') lines.push('RUN pip install --no-cache-dir .', '');
  lines.push('ENV PYTHONUNBUFFERED=1');
  if (a.port) lines.push(`ENV PORT=${a.port}`, `EXPOSE ${a.port}`);
  lines.push(`CMD ${JSON.stringify(a.start)}`);
  return lines.join('\n') + '\n';
}

function dockerignore(a) {
  const base = ['node_modules', '.git', '.gitignore', '.env', '.env.*', '!.env.example', 'npm-debug.log', '*.log', 'Dockerfile', 'docker-compose.yml', '.dockerignore', '.vscode', '.idea'];
  return base.concat(a.dataDirs.map((d) => d), a.readonlyDirs.map((d) => d)).join('\n') + '\n';
}

// Processi accessori (worker, cron, code) lanciati a parte con "node file.js": ognuno diventa un servizio.
const WORKER_FILE = /(worker|cron|queue|consumer|scheduler)/i;
function detectWorkers(dir, pkg, mainCmd) {
  const found = new Map();
  const main = mainCmd && mainCmd[0] === 'node' ? mainCmd[1] : null;
  const scripts = (pkg && pkg.scripts) || {};
  for (const [name, cmd] of Object.entries(scripts)) {
    if (/^(start|dev|build|test|lint)/.test(name)) continue;
    const m = String(cmd).match(/^node\s+(?:--\S+\s+)*(\S+\.m?js)\s*$/);
    if (m && m[1] !== main && exists(dir, m[1]) && !/(^|\/)(test|jest)/i.test(m[1])) found.set(m[1], m[1]);
  }
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/\.m?js$/.test(f) && f !== main && WORKER_FILE.test(f) && !/^(test|jest)/i.test(f) && fs.statSync(path.join(dir, f)).isFile()) found.set(f, f);
    }
  } catch {}
  return [...found.keys()].sort();
}

function serviceName(file) {
  return file.replace(/\.m?js$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function compose(a) {
  const vols = a.dataDirs.map((d) => `      - ./${d}:/app/${d}`).concat(a.readonlyDirs.map((d) => `      - ./${d}:/app/${d}:ro`));
  const service = (name, isMain, file) => {
    const L = [`  ${name}:`, '    build: .', '    restart: unless-stopped'];
    if (!isMain) L.push(`    command: ${JSON.stringify(['node', file])}`);
    if (a.hasEnv || a.envDocker.length) {
      L.push('    env_file:');
      if (a.hasEnv) L.push('      - path: .env', '        required: false');
      if (a.mode === 'bridge' && a.envDocker.length) L.push('      - path: .env.docker', '        required: false');
    }
    if (a.mode === 'host') {
      L.push('    network_mode: host');
    } else {
      if (isMain && a.port) L.push('    ports:', `      - "127.0.0.1:${a.port}:${a.kind === 'static' ? 80 : a.port}"`);
      if (a.envDocker.length) L.push('    extra_hosts:', '      - "host.docker.internal:host-gateway"');
    }
    if (vols.length && a.kind !== 'static') L.push('    volumes:', ...vols);
    return L;
  };
  const L = ['# Generato dalla Pi Dashboard: controlla e adatta prima dell\'uso.', 'services:', ...service('app', true)];
  for (const w of a.workers || []) L.push('', ...service(serviceName(w), false, w));
  return L.join('\n') + '\n';
}

function analyze(dir, mode) {
  const warnings = [];
  const pkg = readJson(path.join(dir, 'package.json'));
  const env = { ...parseEnv(path.join(dir, '.env.example')), ...parseEnv(path.join(dir, '.env')) };
  const hasEnv = exists(dir, '.env');
  const a = { warnings, hasEnv, dataDirs: [], readonlyDirs: [], nativeDeps: [], envDocker: [] };

  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const has = (list) => list.some((d) => deps[d]);
    const scripts = pkg.scripts || {};
    if (deps.next) a.kind = 'next';
    else if (has(STATIC_DEPS) && scripts.build && !has(SERVER_DEPS.filter((d) => !['ejs', 'ws'].includes(d)))) a.kind = 'static';
    else a.kind = 'node';
    a.label = { next: 'Next.js', static: 'Sito statico (build + nginx)', node: has(BOT_DEPS) && !has(SERVER_DEPS) ? 'Bot / servizio Node' : 'Server Node.js' }[a.kind];
    a.nodeVersion = nodeMajor(pkg);
    a.install = installCommand(dir);
    const post = String(scripts.postinstall || '');
    a.installNeedsSources = /--prefix|\bcd\s|\bworkspaces?\b|\bbuild\b/.test(post) || !!pkg.workspaces;
    if (a.installNeedsSources) warnings.push('Lo script "postinstall" (o i workspaces) usa le sottocartelle: nel Dockerfile i sorgenti vengono copiati prima di "npm ci", quindi ogni modifica reinstalla le dipendenze.');
    if (a.install.noLock) warnings.push('Nessun file di lock (package-lock.json): le versioni delle dipendenze non sono fissate.');
    a.build = !!scripts.build && a.kind !== 'static';
    if (a.kind === 'next') a.build = true;
    // Con il postinstall che compila già i sottoprogetti il build è fatto; e senza prune: tsx/ts-node servono a runtime.
    if (a.installNeedsSources && a.kind !== 'next') a.build = false;
    a.nativeDeps = NATIVE_DEPS.filter((d) => deps[d]);
    a.systemTools = detectSystemTools(dir);
    if (a.systemTools.length) warnings.push(`Il codice usa programmi di sistema (${a.systemTools.map((t) => t.name).join(', ')}): vengono installati nell'immagine con apt, che diventa più pesante (LibreOffice ~400 MB).`);
    a.staticOut = exists(dir, 'build') && !exists(dir, 'dist') ? 'build' : 'dist';
    a.port = detectPort(dir, env, pkg, a.kind);
    if (a.kind === 'static') {
      a.start = null;
      warnings.push('Per le app a pagina singola (React Router, Vue Router) serve la configurazione nginx per le rotte: se vedi 404 ricaricando una pagina, aggiungila.');
    } else {
      a.start = startCommand(dir, pkg, warnings);
      if (a.kind === 'next') a.start = ['npm', 'start'];
      if (!a.port && has(SERVER_DEPS)) {
        a.port = 3000;
        warnings.push('Non ho trovato la porta: ho supposto 3000. Impostala con PORT nel .env.');
      }
    }
    a.dockerfile = a.kind === 'static' ? dockerfileStatic(a) : dockerfileNode(a);
  } else if (exists(dir, 'requirements.txt') || exists(dir, 'pyproject.toml')) {
    a.kind = 'python';
    a.label = 'Python';
    a.pyDeps = exists(dir, 'requirements.txt') ? 'requirements' : 'pyproject';
    const entry = ['main.py', 'app.py', 'bot.py', 'run.py', 'server.py'].find((f) => exists(dir, f));
    a.start = ['python', entry || 'main.py'];
    if (!entry) warnings.push('Non trovo il file principale (main.py, app.py, bot.py...): controlla la riga CMD del Dockerfile.');
    a.port = env.PORT && /^\d+$/.test(env.PORT) ? Number(env.PORT) : null;
    a.dockerfile = dockerfilePython(a);
  } else {
    a.kind = 'unknown';
    a.label = 'Non riconosciuto';
    a.port = null;
    warnings.push('Non riconosco il tipo di progetto (nessun package.json né requirements.txt): scrivi il Dockerfile a mano.');
    a.dockerfile = '# Tipo di progetto non riconosciuto: scrivi qui il Dockerfile.\nFROM debian:bookworm-slim\nWORKDIR /app\nCOPY . .\nCMD ["sleep", "infinity"]\n';
  }

  a.dataDirs = DATA_DIRS.filter((d) => exists(dir, d) && fs.statSync(path.join(dir, d)).isDirectory());
  a.readonlyDirs = READONLY_DIRS.filter((d) => exists(dir, d) && fs.statSync(path.join(dir, d)).isDirectory());
  a.localVars = localhostVars(env);
  a.workers = a.kind === 'node' ? detectWorkers(dir, pkg, a.start) : [];
  // Con più servizi serve almeno una cartella condivisa (il worker legge ciò che l'app scrive): i container hanno
  // filesystem separati. "data" è la convenzione; la cartella può non esistere nel clone perché vuota.
  if (a.workers.length && !a.dataDirs.includes('data')) a.dataDirs.unshift('data');
  if (a.workers.length) warnings.push(`Processi accessori rilevati: ${a.workers.join(', ')}. Ognuno diventa un servizio separato nel docker-compose.yml (stessa immagine, stesso .env).`);

  // Modalità di rete: "host" se l'app parla con servizi su localhost (database sul Pi) o con i propri worker
  // via 127.0.0.1, altrimenti isolata.
  a.mode = mode === 'host' || mode === 'bridge' ? mode : a.localVars.length || a.workers.length ? 'host' : 'bridge';
  if (a.mode === 'bridge' && a.workers.length) warnings.push('In modalità isolata ogni servizio ha la sua rete: se l\'app chiama i worker su 127.0.0.1 non li raggiungerà. Usa "host".');
  if (a.mode === 'bridge' && a.localVars.length) {
    a.envDocker = a.localVars;
    warnings.push(
      `In modalità isolata ${a.localVars.join(', ')} verrà riscritto verso host.docker.internal: PostgreSQL deve ascoltare anche sulla rete di Docker (listen_addresses e pg_hba.conf). Se non vuoi toccarlo usa la modalità "host".`
    );
  }
  if (a.mode === 'host') warnings.push('Modalità "host": il container usa direttamente le porte e la rete del Pi, quindi non possono girare insieme il processo normale e il container sulla stessa porta.');
  if (!hasEnv) warnings.push('Manca il file .env: l\'app potrebbe non avere configurazione/segreti. Crealo dalla sezione .env prima di avviare.');
  if (a.workers.length) warnings.push(`App e worker sono container separati: condividono i file solo tramite le cartelle montate (${a.dataDirs.join(', ')}). Se l'app scrive file altrove, aggiungi un volume.`);
  if (a.readonlyDirs.length) warnings.push(`La cartella ${a.readonlyDirs.join(', ')} (di solito credenziali) viene montata in sola lettura e non entra nell'immagine.`);

  a.files = {
    Dockerfile: a.dockerfile,
    'docker-compose.yml': compose(a),
    '.dockerignore': dockerignore(a),
  };
  a.existing = Object.keys(a.files).filter((f) => exists(dir, f));
  delete a.dockerfile;
  return a;
}

// Contenuto di .env.docker: solo le variabili riscritte (host -> host.docker.internal). Contiene segreti,
// quindi non viene mai mostrato nell'anteprima: si genera sul server al momento di scrivere i file.
function buildEnvDocker(dir, vars) {
  const env = parseEnv(path.join(dir, '.env'));
  const lines = [];
  for (const k of vars) {
    if (!env[k]) continue;
    try {
      const u = new URL(env[k]);
      u.hostname = 'host.docker.internal';
      lines.push(`${k}=${u.toString().replace(/\/$/, env[k].endsWith('/') ? '/' : '')}`);
    } catch {}
  }
  return lines.length ? '# Generato dalla Pi Dashboard: variabili riscritte per il container.\n' + lines.join('\n') + '\n' : '';
}

module.exports = { analyze, buildEnvDocker };
