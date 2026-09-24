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

  const oldHostnames = new Set(base.rules.map((r) => r.hostname));
  const newHostnames = rules.map((r) => r.hostname.trim()).filter((h) => !oldHostnames.has(h));

  try {
    await writeConfig(base, rules);
  } catch (err) {
    return res.status(500).json({ error: 'scrittura configurazione fallita', detail: err.message });
  }

  // Se il browser sta usando la dashboard proprio attraverso questo tunnel (es. pi.rewi.dev),
  // riavviare cloudflared PRIMA di rispondere interromperebbe la connessione che deve
  // portare questa stessa risposta. Rispondi subito e riavvia dopo, fuori dal ciclo richiesta/risposta.
  res.json({ ok: true, newHostnames, tunnel: base.tunnel });
  setTimeout(() => {
    run('sudo', ['systemctl', 'restart', 'cloudflared'], { timeout: 30000 });
  }, 300);
});

// `cloudflared tunnel route dns` decide sempre la zona guardandosi il certificato locale
// (autorizzato su UNA sola zona, es. rewi.dev): dato un hostname di una zona diversa anche
// se nello stesso account Cloudflare, non fallisce ma lo tratta come etichetta e lo appende
// alla zona nota, creando record come "stats.altrodominio.it.rewi.dev". Per gestire più
// domini serve passare dalla API Cloudflare, che sceglie la zona giusta in base all'hostname.
async function cfFetch(url, token, opts = {}) {
  return fetch('https://api.cloudflare.com/client/v4' + url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
}

async function listCloudflareZones(token) {
  const r = await cfFetch('/zones?per_page=50', token);
  const data = await r.json();
  if (!r.ok || !data.success) throw new Error((data.errors && data.errors[0] && data.errors[0].message) || 'impossibile elencare le zone Cloudflare');
  return data.result.map((z) => ({ id: z.id, name: z.name }));
}

function findZoneForHostname(hostname, zones) {
  const matches = zones.filter((z) => hostname === z.name || hostname.endsWith('.' + z.name));
  matches.sort((a, b) => b.name.length - a.name.length);
  return matches[0] || null;
}

async function createDnsRecordViaApi(hostname, tunnel, zone, token) {
  const r = await cfFetch(`/zones/${zone.id}/dns_records`, token, {
    method: 'POST',
    body: JSON.stringify({ type: 'CNAME', name: hostname, content: `${tunnel}.cfargotunnel.com`, proxied: true, ttl: 1 }),
  });
  const data = await r.json();
  if (data.success) return { ok: true, error: null };
  const message = (data.errors && data.errors.map((e) => e.message).join('; ')) || 'errore sconosciuto';
  const ok = /already exists/i.test(message);
  return { ok, error: ok ? null : message };
}

router.post('/rules/dns', express.json({ limit: '4kb' }), async (req, res) => {
  const hostnames = Array.isArray(req.body && req.body.hostnames) ? req.body.hostnames : [];
  const tunnel = req.body && req.body.tunnel;
  if (!tunnel || !hostnames.length) return res.json({ results: [] });

  const cfToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!cfToken) {
    // Nessun token API configurato: comportamento storico, valido solo per la zona del
    // certificato locale di cloudflared.
    const results = [];
    for (const hostname of hostnames) {
      const dnsRes = await run('cloudflared', ['tunnel', 'route', 'dns', tunnel, hostname], { timeout: 20000 });
      const ok = dnsRes.ok || /already exists/i.test(dnsRes.stderr);
      results.push({ hostname, ok, error: ok ? null : dnsRes.stderr });
    }
    return res.json({ results });
  }

  let zones;
  try {
    zones = await listCloudflareZones(cfToken);
  } catch (err) {
    return res.json({ results: hostnames.map((hostname) => ({ hostname, ok: false, error: err.message })) });
  }

  const results = [];
  for (const hostname of hostnames) {
    const zone = findZoneForHostname(hostname, zones);
    if (!zone) {
      results.push({ hostname, ok: false, error: `nessuna zona Cloudflare trovata per ${hostname}` });
      continue;
    }
    try {
      const result = await createDnsRecordViaApi(hostname, tunnel, zone, cfToken);
      results.push({ hostname, ...result });
    } catch (err) {
      results.push({ hostname, ok: false, error: err.message });
    }
  }
  res.json({ results });
});

router.post('/restart', async (req, res) => {
  // Stesso motivo del salvataggio: rispondi prima, poi riavvia — non nel mezzo della
  // richiesta che potrebbe star viaggiando proprio su questo tunnel.
  res.json({ ok: true });
  setTimeout(() => {
    run('sudo', ['systemctl', 'restart', 'cloudflared'], { timeout: 30000 });
  }, 300);
});

module.exports = router;
