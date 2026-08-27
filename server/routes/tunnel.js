const express = require('express');
const fs = require('fs');
const yaml = require('js-yaml');
const { spawn, execFile } = require('child_process');

const router = express.Router();

const CONFIG_PATH = process.env.CLOUDFLARED_CONFIG || '/etc/cloudflared/config.yml';
const CATCH_ALL = { service: 'http_status:404' };

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: stderr || (err ? err.message : '') });
    });
  });
}

function readConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const doc = yaml.load(raw) || {};
  const ingress = Array.isArray(doc.ingress) ? doc.ingress : [];
  const rules = ingress.filter((r) => r && r.hostname);
  return {
    tunnel: doc.tunnel || null,
    credentialsFile: doc['credentials-file'] || null,
    rules: rules.map((r) => ({ hostname: r.hostname, service: r.service })),
  };
}

function writeConfig(base, rules) {
  const doc = {
    tunnel: base.tunnel,
    'credentials-file': base.credentialsFile,
    ingress: [...rules.map((r) => ({ hostname: r.hostname, service: r.service })), CATCH_ALL],
  };
  const content = yaml.dump(doc, { lineWidth: -1 });
  return new Promise((resolve, reject) => {
    const proc = spawn('sudo', ['tee', CONFIG_PATH], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr || `sudo tee uscito con codice ${code}`))));
    proc.stdin.write(content);
    proc.stdin.end();
  });
}

const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
const SERVICE_RE = /^(https?|tcp|ssh|rdp|unix):\/\/.+$/;

function validateRules(rules) {
  if (!Array.isArray(rules)) return 'ingress deve essere un elenco';
  for (const r of rules) {
    if (!r || typeof r.hostname !== 'string' || !HOSTNAME_RE.test(r.hostname.trim())) {
      return `hostname non valido: ${r && r.hostname}`;
    }
    if (!r || typeof r.service !== 'string' || !SERVICE_RE.test(r.service.trim())) {
      return `servizio non valido (es. http://localhost:3000): ${r && r.service}`;
    }
  }
  const seen = new Set();
  for (const r of rules) {
    if (seen.has(r.hostname)) return `hostname duplicato: ${r.hostname}`;
    seen.add(r.hostname);
  }
  return null;
}

router.get('/status', async (req, res) => {
  const binRes = await run('which', ['cloudflared']);
  const statusRes = await run('systemctl', ['is-active', 'cloudflared']);
  res.json({ installed: binRes.ok, active: statusRes.stdout === 'active' });
});

router.get('/rules', (req, res) => {
  try {
    res.json(readConfig());
  } catch (err) {
    res.status(500).json({ error: 'impossibile leggere ' + CONFIG_PATH, detail: err.message });
  }
});

router.put('/rules', express.json({ limit: '256kb' }), async (req, res) => {
  const rules = (req.body && req.body.rules) || [];
  const error = validateRules(rules);
  if (error) return res.status(400).json({ error });

  let base;
  try {
    base = readConfig();
  } catch (err) {
    return res.status(500).json({ error: 'impossibile leggere ' + CONFIG_PATH, detail: err.message });
  }

  try {
    await writeConfig(base, rules);
  } catch (err) {
    return res.status(500).json({ error: 'scrittura configurazione fallita', detail: err.message });
  }

  const restartRes = await run('sudo', ['systemctl', 'restart', 'cloudflared'], { timeout: 30000 });
  res.json({ ok: true, restarted: restartRes.ok, restartError: restartRes.ok ? null : restartRes.stderr });
});

router.post('/restart', async (req, res) => {
  const result = await run('sudo', ['systemctl', 'restart', 'cloudflared'], { timeout: 30000 });
  res.status(result.ok ? 200 : 500).json(result);
});

module.exports = router;
