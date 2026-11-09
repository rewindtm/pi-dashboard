const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { readJson } = require('../store');

const router = express.Router();
router.use(express.json());

const APPS_ROOT = path.resolve(process.env.APPS_ROOT || path.join(os.homedir(), 'pi-dashboard-apps'));
const COMPOSE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const IMAGE_ID = /^(sha256:)?[a-f0-9]{6,64}$/;
const IMAGE_REF = /^[a-z0-9][a-z0-9._\-/:@]{0,200}$/i;
const PROJECT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OUTPUT_MAX = 200 * 1024;

// Come per le app avviate dalla dashboard: le variabili della dashboard (PORT, token...)
// non devono finire nel processo figlio, altrimenti Compose le userebbe per l'interpolazione
// del docker-compose.yml al posto di quelle del .env dell'app.
const DASHBOARD_ENV_KEYS = ['PORT', 'DASHBOARD_TOKEN', 'APPS_ROOT', 'CLOUDFLARED_CONFIG', 'FILES_ROOT'];
function childEnv() {
  const env = { ...process.env };
  for (const key of DASHBOARD_ENV_KEYS) delete env[key];
  return env;
}

function docker(args, { cwd, timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    execFile('docker', args, { cwd, timeout, env: childEnv(), maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        notInstalled: !!(err && err.code === 'ENOENT'),
        stdout: (stdout || '').trim(),
        stderr: (stderr || (err ? err.message : '')).trim(),
      });
    });
  });
}

const jsonLines = (s) => s.split('\n').filter(Boolean).map((l) => JSON.parse(l));

function fail(res, r, fallback) {
  if (r.notInstalled) return res.status(503).json({ error: 'Docker non è installato su questo Pi' });
  res.status(500).json({ error: r.stderr || fallback });
}

// --- Job in background (build, pull, up...): la richiesta torna subito, l'output si legge a pezzi ---
const jobs = new Map();

function startJob(label, args, cwd) {
  const id = crypto.randomBytes(6).toString('hex');
  const job = { id, label, output: '', running: true, code: null, startedAt: Date.now() };
  jobs.set(id, job);
  while (jobs.size > 20) jobs.delete(jobs.keys().next().value);

  const append = (d) => {
    job.output = (job.output + d.toString()).slice(-OUTPUT_MAX);
  };
  const child = spawn('docker', args, { cwd, env: childEnv() });
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', (err) => {
    append(err.code === 'ENOENT' ? 'Docker non è installato su questo Pi\n' : err.message + '\n');
    job.running = false;
    job.code = -1;
  });
  child.on('close', (code) => {
    job.running = false;
    job.code = code;
  });
  return job;
}

router.get('/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job non trovato' });
  res.json({ id: job.id, label: job.label, running: job.running, code: job.code, output: job.output });
});

// --- Stato generale ---
router.get('/status', async (req, res) => {
  const v = await docker(['info', '--format', '{{json .}}']);
  if (v.notInstalled) return res.json({ installed: false });
  if (!v.ok) return res.json({ installed: true, running: false, error: v.stderr });
  const info = JSON.parse(v.stdout);
  const c = await docker(['compose', 'version', '--short']);
  const df = await docker(['system', 'df', '--format', '{{json .}}']);
  res.json({
    installed: true,
    running: true,
    version: info.ServerVersion,
    compose: c.ok ? c.stdout : null,
    containers: info.Containers,
    containersRunning: info.ContainersRunning,
    images: info.Images,
    df: df.ok ? jsonLines(df.stdout) : [],
  });
});

// --- Container ---
router.get('/containers', async (req, res) => {
  const r = await docker(['ps', '-a', '--format', '{{json .}}']);
  if (!r.ok) return fail(res, r, 'docker ps fallito');
  const containers = jsonLines(r.stdout).map((c) => {
    const labels = Object.fromEntries((c.Labels || '').split(',').filter(Boolean).map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i), kv.slice(i + 1)];
    }));
    return {
      id: c.ID,
      name: c.Names,
      image: c.Image,
      state: c.State,
      status: c.Status,
      ports: c.Ports,
      createdAt: c.CreatedAt,
      project: labels['com.docker.compose.project'] || null,
    };
  });
  res.json({ containers });
});

router.get('/stats', async (req, res) => {
  const r = await docker(['stats', '--no-stream', '--format', '{{json .}}'], { timeout: 30000 });
  if (!r.ok) return fail(res, r, 'docker stats fallito');
  res.json({ stats: jsonLines(r.stdout).map((s) => ({ id: s.ID, name: s.Name, cpu: s.CPUPerc, mem: s.MemUsage, memPerc: s.MemPerc })) });
});

router.post('/containers/:id/:action(start|stop|restart|remove)', async (req, res) => {
  const { id, action } = req.params;
  if (!ID.test(id)) return res.status(400).json({ error: 'container non valido' });
  const args = action === 'remove' ? ['rm', id] : [action, id];
  const r = await docker(args, { timeout: 60000 });
  if (!r.ok) {
    const msg = /running container/i.test(r.stderr) ? 'il container è in esecuzione: fermalo prima di rimuoverlo' : r.stderr;
    return res.status(500).json({ error: msg || 'operazione fallita' });
  }
  res.json({ ok: true });
});

router.get('/containers/:id/logs', async (req, res) => {
  if (!ID.test(req.params.id)) return res.status(400).json({ error: 'container non valido' });
  const tail = Math.min(2000, Math.max(10, parseInt(req.query.tail, 10) || 300));
  const r = await docker(['logs', '--tail', String(tail), '--timestamps', req.params.id], { timeout: 20000 });
  if (!r.ok && !r.stdout && !r.stderr) return fail(res, r, 'log non disponibili');
  // docker logs scrive lo stderr del container su stderr: li uniamo
  res.json({ logs: [r.stdout, r.ok ? r.stderr : ''].filter(Boolean).join('\n') });
});

// --- Immagini ---
router.get('/images', async (req, res) => {
  const r = await docker(['images', '--format', '{{json .}}']);
  if (!r.ok) return fail(res, r, 'docker images fallito');
  res.json({
    images: jsonLines(r.stdout).map((i) => ({
      id: i.ID,
      repository: i.Repository,
      tag: i.Tag,
      size: i.Size,
      created: i.CreatedSince,
    })),
  });
});

router.post('/images/pull', (req, res) => {
  const { name } = req.body || {};
  if (typeof name !== 'string' || !IMAGE_REF.test(name)) return res.status(400).json({ error: 'nome immagine non valido' });
  res.json({ job: startJob('pull ' + name, ['pull', name]).id });
});

router.delete('/images/:id', async (req, res) => {
  if (!IMAGE_ID.test(req.params.id)) return res.status(400).json({ error: 'immagine non valida' });
  const r = await docker(['rmi', req.params.id], { timeout: 60000 });
  if (!r.ok) {
    const msg = /in use|being used|conflict/i.test(r.stderr) ? 'immagine usata da un container: rimuovi prima il container' : r.stderr;
    return res.status(500).json({ error: msg || 'rimozione fallita' });
  }
  res.json({ ok: true });
});

// --- Pulizia (mai i volumi: contengono i dati) ---
router.post('/prune', async (req, res) => {
  const { what } = req.body || {};
  const map = {
    containers: ['container', 'prune', '-f'],
    images: ['image', 'prune', '-f'],
    'images-all': ['image', 'prune', '-a', '-f'],
    builder: ['builder', 'prune', '-f'],
  };
  if (!map[what]) return res.status(400).json({ error: 'tipo di pulizia non valido' });
  const r = await docker(map[what], { timeout: 120000 });
  if (!r.ok) return fail(res, r, 'pulizia fallita');
  res.json({ ok: true, output: r.stdout.split('\n').pop() });
});

// --- Progetti Compose ---
const PROJECT_ACTIONS = {
  up: ['up', '-d'],
  upbuild: ['up', '-d', '--build'],
  down: ['down'],
  stop: ['stop'],
  start: ['start'],
  restart: ['restart'],
  pull: ['pull'],
  build: ['build'],
};

async function listProjects() {
  const r = await docker(['compose', 'ls', '-a', '--format', 'json']);
  if (!r.ok) throw Object.assign(new Error(r.stderr || 'docker compose non disponibile'), { result: r });
  return (JSON.parse(r.stdout || '[]') || []).map((p) => ({
    name: p.Name,
    status: p.Status,
    files: (p.ConfigFiles || '').split(',').filter(Boolean),
  }));
}

router.get('/projects', async (req, res) => {
  try {
    res.json({ projects: await listProjects() });
  } catch (err) {
    fail(res, err.result || { stderr: err.message }, err.message);
  }
});

function composeArgs(files, project, action) {
  return ['compose', ...(project ? ['-p', project] : []), ...files.flatMap((f) => ['-f', f]), ...PROJECT_ACTIONS[action]];
}

router.post('/projects/:name/:action', async (req, res) => {
  const { name, action } = req.params;
  if (!PROJECT.test(name)) return res.status(400).json({ error: 'progetto non valido' });
  if (!PROJECT_ACTIONS[action]) return res.status(400).json({ error: 'azione non consentita' });
  try {
    const project = (await listProjects()).find((p) => p.name === name);
    if (!project || !project.files.length) return res.status(404).json({ error: 'progetto non trovato' });
    const files = project.files.filter((f) => path.isAbsolute(f) && fs.existsSync(f));
    if (!files.length) return res.status(404).json({ error: 'file compose non più presente sul disco' });
    res.json({ job: startJob(`${name}: ${action}`, composeArgs(files, name, action), path.dirname(files[0])).id });
  } catch (err) {
    fail(res, err.result || { stderr: err.message }, err.message);
  }
});

router.get('/projects/:name/logs', async (req, res) => {
  if (!PROJECT.test(req.params.name)) return res.status(400).json({ error: 'progetto non valido' });
  const r = await docker(['compose', '-p', req.params.name, 'logs', '--tail', '300', '--no-color', '--timestamps'], { timeout: 30000 });
  if (!r.ok && !r.stdout) return fail(res, r, 'log non disponibili');
  res.json({ logs: r.stdout });
});

// --- App clonate dalla dashboard: hanno un file compose / Dockerfile? ---
function findAppDocker(app) {
  const dir = path.join(APPS_ROOT, app.dir);
  if (!dir.startsWith(APPS_ROOT + path.sep) || !fs.existsSync(dir)) return null;
  const compose = COMPOSE_NAMES.map((n) => path.join(dir, n)).find((f) => fs.existsSync(f)) || null;
  return { dir, compose, dockerfile: fs.existsSync(path.join(dir, 'Dockerfile')) };
}

router.get('/apps/:id', async (req, res) => {
  const app = readJson('apps.json', []).find((a) => a.id === req.params.id);
  if (!app) return res.status(404).json({ error: 'app non trovata' });
  const d = findAppDocker(app);
  if (!d) return res.status(404).json({ error: 'cartella dell\'app non trovata' });

  let project = null;
  if (d.compose) {
    try {
      project = (await listProjects()).find((p) => p.files.some((f) => f.startsWith(d.dir + path.sep))) || null;
    } catch {}
  }
  res.json({ composeFile: d.compose ? path.basename(d.compose) : null, dockerfile: d.dockerfile, project });
});

router.post('/apps/:id/:action', (req, res) => {
  const { id, action } = req.params;
  if (!PROJECT_ACTIONS[action]) return res.status(400).json({ error: 'azione non consentita' });
  const app = readJson('apps.json', []).find((a) => a.id === id);
  if (!app) return res.status(404).json({ error: 'app non trovata' });
  const d = findAppDocker(app);
  if (!d || !d.compose) return res.status(404).json({ error: 'nessun file compose in questa app' });
  res.json({ job: startJob(`${app.fullName}: ${action}`, composeArgs([d.compose], null, action), d.dir).id });
});

module.exports = router;
