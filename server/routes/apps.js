const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { readJson, writeJson, DATA_DIR } = require('../store');

const router = express.Router();

const APPS_ROOT = path.resolve(process.env.APPS_ROOT || path.join(os.homedir(), 'pi-dashboard-apps'));
fs.mkdirSync(APPS_ROOT, { recursive: true });

const LOG_DIR = path.join(DATA_DIR, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_MAX_BYTES = 200 * 1024;
const logPath = (id) => path.join(LOG_DIR, id + '.log');

const getApps = () => readJson('apps.json', []);
const saveApps = (apps) => writeJson('apps.json', apps);
const safeDirName = (name) => name.replace(/[^a-zA-Z0-9_.-]/g, '_');

// Il processo è avviato con detached:true (pid == pgid del gruppo), quindi resta vivo
// anche se la dashboard viene riavviata (systemd è configurato con KillMode=process).
// Lo stato "in esecuzione" si ricava sempre controllando se quel pid esiste ancora,
// non da uno stato interno della dashboard che andrebbe perso al riavvio.
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function status(app) {
  if (app.pid && !isAlive(app.pid)) {
    const apps = getApps();
    const cur = apps.find((a) => a.id === app.id);
    if (cur && cur.pid === app.pid) {
      cur.pid = null;
      saveApps(apps);
    }
    app.pid = null;
  }
  return app.pid ? 'running' : 'stopped';
}

// Variabili impostate nel .env della dashboard che non devono trapelare nel processo
// figlio: se l'app usa dotenv, questo di default non sovrascrive variabili già presenti
// nell'ambiente, quindi ad es. il PORT della dashboard vincerebbe su quello del suo .env.
const DASHBOARD_ENV_KEYS = ['PORT', 'DASHBOARD_TOKEN', 'APPS_ROOT', 'CLOUDFLARED_CONFIG', 'FILES_ROOT'];

function childEnv() {
  const env = { ...process.env };
  for (const key of DASHBOARD_ENV_KEYS) delete env[key];
  return env;
}

function run(cmd, args, cwd, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: stderr || (err ? err.message : '') });
    });
  });
}

async function getGitInfo(cwd) {
  const branchRes = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const branch = branchRes.ok ? branchRes.stdout : null;

  const logRes = await run('git', ['log', '-1', '--format=%h%x1f%s%x1f%cI'], cwd);
  let commit = null;
  if (logRes.ok && logRes.stdout) {
    const [short, message, date] = logRes.stdout.split('\x1f');
    commit = { short, message, date };
  }

  const upstreamRes = await run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd);
  const hasUpstream = upstreamRes.ok;

  let ahead = null;
  let behind = null;
  if (hasUpstream) {
    const countRes = await run('git', ['rev-list', '--left-right', '--count', 'HEAD...@{u}'], cwd);
    if (countRes.ok) {
      const [a, b] = countRes.stdout.split(/\s+/).map(Number);
      ahead = a;
      behind = b;
    }
  }

  return { branch, commit, hasUpstream, ahead, behind };
}

router.get('/', (req, res) => {
  res.json({ apps: getApps().map((a) => ({ ...a, status: status(a) })), root: APPS_ROOT });
});

router.post('/clone', express.json(), (req, res) => {
  const { fullName, cloneUrl } = req.body || {};
  if (!fullName || !cloneUrl) return res.status(400).json({ error: 'fullName e cloneUrl sono richiesti' });

  const apps = getApps();
  if (apps.some((a) => a.fullName === fullName)) return res.status(409).json({ error: 'repo già clonata' });

  const dirName = safeDirName(fullName);
  const target = path.join(APPS_ROOT, dirName);
  if (fs.existsSync(target)) return res.status(409).json({ error: 'cartella già esistente: ' + dirName });

  const tokenData = readJson('github-token.json', null);
  const authUrl = tokenData && tokenData.token && cloneUrl.startsWith('https://')
    ? cloneUrl.replace('https://', `https://x-access-token:${tokenData.token}@`)
    : cloneUrl;

  execFile('git', ['clone', authUrl, target], { timeout: 120000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: 'clone fallito', detail: stderr || err.message });

    // Se il repo fornisce un template di .env, copialo come punto di partenza:
    // .env è quasi sempre gitignorato, quindi non arriva mai col clone.
    let envSeeded = null;
    for (const candidate of ['.env.example', '.env.sample']) {
      const src = path.join(target, candidate);
      const dst = path.join(target, '.env');
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        try {
          fs.copyFileSync(src, dst);
          envSeeded = candidate;
        } catch {}
        break;
      }
    }

    const app = { id: dirName, fullName, dir: dirName, cloneUrl, startCommand: '', pid: null, createdAt: new Date().toISOString() };
    apps.push(app);
    saveApps(apps);
    res.json({ ok: true, app, envSeeded });
  });
});

router.put('/:id', express.json(), (req, res) => {
  const apps = getApps();
  const app = apps.find((a) => a.id === req.params.id);
  if (!app) return res.status(404).json({ error: 'non trovata' });
  if (typeof req.body?.startCommand === 'string') app.startCommand = req.body.startCommand;
  saveApps(apps);
  res.json({ ok: true, app });
});

function startProcess(id) {
  const apps = getApps();
  const app = apps.find((a) => a.id === id);
  if (!app) return { ok: false, status: 404, error: 'non trovata' };
  if (isAlive(app.pid)) return { ok: false, status: 409, error: 'già in esecuzione' };
  if (!app.startCommand) return { ok: false, status: 400, error: 'imposta prima un comando di avvio' };

  const cwd = path.join(APPS_ROOT, app.dir);
  const fd = fs.openSync(logPath(app.id), 'w');
  const proc = spawn(app.startCommand, {
    shell: true,
    cwd,
    detached: true,
    env: childEnv(),
    stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  proc.unref();

  app.pid = proc.pid;
  app.startedAt = Date.now();
  saveApps(apps);

  return { ok: true };
}

function stopProcess(id) {
  const apps = getApps();
  const app = apps.find((a) => a.id === id);
  if (!app || !isAlive(app.pid)) return { ok: false, status: 404, error: 'non in esecuzione' };
  try {
    process.kill(-app.pid, 'SIGTERM');
  } catch {
    try {
      process.kill(app.pid, 'SIGTERM');
    } catch {}
  }
  return { ok: true };
}

async function waitUntilStopped(id, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const apps = getApps();
    const app = apps.find((a) => a.id === id);
    if (!app || !isAlive(app.pid)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const apps = getApps();
  const app = apps.find((a) => a.id === id);
  if (app && !isAlive(app.pid) && app.pid) {
    app.pid = null;
    saveApps(apps);
  }
}

router.post('/:id/start', (req, res) => {
  const result = startProcess(req.params.id);
  res.status(result.ok ? 200 : result.status).json(result);
});

router.post('/:id/stop', (req, res) => {
  const result = stopProcess(req.params.id);
  res.status(result.ok ? 200 : result.status).json(result);
});

router.post('/:id/restart', async (req, res) => {
  const apps = getApps();
  if (!apps.find((a) => a.id === req.params.id)) return res.status(404).json({ error: 'non trovata' });
  stopProcess(req.params.id);
  await waitUntilStopped(req.params.id);
  const result = startProcess(req.params.id);
  res.status(result.ok ? 200 : result.status).json(result);
});

router.post('/:id/install', (req, res) => {
  const apps = getApps();
  const app = apps.find((a) => a.id === req.params.id);
  if (!app) return res.status(404).json({ error: 'non trovata' });
  const cwd = path.join(APPS_ROOT, app.dir);
  execFile('npm', ['install'], { cwd, shell: true, timeout: 300000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
    res.status(err ? 500 : 200).json({ ok: !err, stdout, stderr: stderr || (err ? err.message : '') });
  });
});

router.get('/:id/resources', async (req, res) => {
  const apps = getApps();
  const app = apps.find((a) => a.id === req.params.id);
  if (!app) return res.status(404).json({ error: 'non trovata' });
  if (status(app) !== 'running') return res.json({ running: false });

  // Somma CPU/RAM di tutto l'albero di processi del gruppo (pid == pgid, essendo
  // stato avviato con detached:true).
  const psRes = await run('ps', ['-e', '-o', 'pid=,pgid=,pcpu=,rss='], null, 5000);
  if (!psRes.ok) return res.status(500).json({ error: 'ps non disponibile', detail: psRes.stderr });

  const pgid = app.pid;
  let cpu = 0;
  let memKb = 0;
  let procCount = 0;
  for (const line of psRes.stdout.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const [, rowPgid, rowCpu, rowRss] = parts;
    if (Number(rowPgid) === pgid) {
      cpu += Number(rowCpu) || 0;
      memKb += Number(rowRss) || 0;
      procCount++;
    }
  }

  res.json({ running: true, pid: pgid, processCount: procCount, cpu, memBytes: memKb * 1024 });
});

router.get('/:id/logs', (req, res) => {
  const apps = getApps();
  const app = apps.find((a) => a.id === req.params.id);
  if (!app) return res.status(404).json({ error: 'non trovata' });
  let logs = '';
  try {
    const buf = fs.readFileSync(logPath(app.id));
    logs = buf.length > LOG_MAX_BYTES ? buf.subarray(buf.length - LOG_MAX_BYTES).toString('utf8') : buf.toString('utf8');
  } catch {}
  res.json({ running: status(app) === 'running', logs });
});

router.get('/:id/git', async (req, res) => {
  const apps = getApps();
  const app = apps.find((a) => a.id === req.params.id);
  if (!app) return res.status(404).json({ error: 'non trovata' });
  res.json(await getGitInfo(path.join(APPS_ROOT, app.dir)));
});

router.post('/:id/fetch', async (req, res) => {
  const apps = getApps();
  const app = apps.find((a) => a.id === req.params.id);
  if (!app) return res.status(404).json({ error: 'non trovata' });
  const cwd = path.join(APPS_ROOT, app.dir);
  const fetchRes = await run('git', ['fetch', '--quiet'], cwd, 60000);
  if (!fetchRes.ok) return res.status(500).json({ error: 'fetch fallito', detail: fetchRes.stderr });
  res.json(await getGitInfo(cwd));
});

router.post('/:id/pull', (req, res) => {
  const apps = getApps();
  const app = apps.find((a) => a.id === req.params.id);
  if (!app) return res.status(404).json({ error: 'non trovata' });
  const cwd = path.join(APPS_ROOT, app.dir);
  execFile('git', ['pull', '--ff-only'], { cwd, timeout: 60000 }, (err, stdout, stderr) => {
    res.status(err ? 500 : 200).json({ ok: !err, stdout, stderr: stderr || (err ? err.message : '') });
  });
});

router.get('/:id/env', async (req, res) => {
  const apps = getApps();
  const app = apps.find((a) => a.id === req.params.id);
  if (!app) return res.status(404).json({ error: 'non trovata' });
  try {
    const content = await fs.promises.readFile(path.join(APPS_ROOT, app.dir, '.env'), 'utf8');
    res.json({ content });
  } catch (err) {
    if (err.code === 'ENOENT') return res.json({ content: '' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id/env', express.json({ limit: '256kb' }), async (req, res) => {
  const apps = getApps();
  const app = apps.find((a) => a.id === req.params.id);
  if (!app) return res.status(404).json({ error: 'non trovata' });
  try {
    await fs.promises.writeFile(path.join(APPS_ROOT, app.dir, '.env'), req.body.content ?? '', 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  const apps = getApps();
  const idx = apps.findIndex((a) => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'non trovata' });

  stopProcess(req.params.id);
  await waitUntilStopped(req.params.id);

  try {
    await fs.promises.rm(path.join(APPS_ROOT, apps[idx].dir), { recursive: true, force: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  await fs.promises.rm(logPath(req.params.id), { force: true }).catch(() => {});

  const remaining = getApps().filter((a) => a.id !== req.params.id);
  saveApps(remaining);
  res.json({ ok: true });
});

module.exports = router;
