const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { readJson, writeJson } = require('../store');

const router = express.Router();

const APPS_ROOT = path.resolve(process.env.APPS_ROOT || path.join(os.homedir(), 'pi-dashboard-apps'));
fs.mkdirSync(APPS_ROOT, { recursive: true });

const running = new Map(); // id -> { proc, logs: string[], startedAt }
const LOG_MAX = 300;

const getApps = () => readJson('apps.json', []);
const saveApps = (apps) => writeJson('apps.json', apps);
const safeDirName = (name) => name.replace(/[^a-zA-Z0-9_.-]/g, '_');
const status = (app) => (running.has(app.id) ? 'running' : 'stopped');

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
    const app = { id: dirName, fullName, dir: dirName, cloneUrl, startCommand: '', createdAt: new Date().toISOString() };
    apps.push(app);
    saveApps(apps);
    res.json({ ok: true, app });
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

router.post('/:id/start', (req, res) => {
  const apps = getApps();
  const app = apps.find((a) => a.id === req.params.id);
  if (!app) return res.status(404).json({ error: 'non trovata' });
  if (!app.startCommand) return res.status(400).json({ error: 'imposta prima un comando di avvio' });
  if (running.has(app.id)) return res.status(409).json({ error: 'già in esecuzione' });

  const cwd = path.join(APPS_ROOT, app.dir);
  const proc = spawn(app.startCommand, { shell: true, cwd, detached: true });
  const entry = { proc, logs: [], startedAt: Date.now() };
  running.set(app.id, entry);

  const pushLog = (chunk) => {
    entry.logs.push(chunk.toString());
    if (entry.logs.length > LOG_MAX) entry.logs.shift();
  };
  proc.stdout.on('data', pushLog);
  proc.stderr.on('data', pushLog);
  proc.on('error', (err) => pushLog(`\n[errore avvio: ${err.message}]\n`));
  proc.on('exit', (code) => {
    entry.logs.push(`\n[processo terminato con codice ${code}]\n`);
    running.delete(app.id);
  });
  proc.unref();

  res.json({ ok: true });
});

router.post('/:id/stop', (req, res) => {
  const entry = running.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'non in esecuzione' });
  try {
    process.kill(-entry.proc.pid, 'SIGTERM');
  } catch {
    try { entry.proc.kill('SIGTERM'); } catch {}
  }
  res.json({ ok: true });
});

router.get('/:id/logs', (req, res) => {
  const entry = running.get(req.params.id);
  res.json({ running: !!entry, logs: entry ? entry.logs.join('') : '' });
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

  const entry = running.get(req.params.id);
  if (entry) {
    try { process.kill(-entry.proc.pid, 'SIGTERM'); } catch {}
    running.delete(req.params.id);
  }
  try {
    await fs.promises.rm(path.join(APPS_ROOT, apps[idx].dir), { recursive: true, force: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  apps.splice(idx, 1);
  saveApps(apps);
  res.json({ ok: true });
});

module.exports = router;
