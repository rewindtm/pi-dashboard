const express = require('express');
const { execFile } = require('child_process');

const router = express.Router();

function runNmcli(args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile('nmcli', args, { timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: stdout || '', stderr: stderr || (err ? err.message : '') });
    });
  });
}

// nmcli -t output uses ':' as separator and escapes literal colons as '\:'.
function splitTerse(line) {
  return line.split(/(?<!\\):/).map((f) => f.replace(/\\:/g, ':'));
}

async function getWifiDevice() {
  const result = await runNmcli(['-t', '-f', 'DEVICE,TYPE', 'device']);
  if (!result.ok) return null;
  const line = result.stdout.split('\n').find((l) => splitTerse(l)[1] === 'wifi');
  return line ? splitTerse(line)[0] : null;
}

router.get('/status', async (req, res) => {
  const device = await getWifiDevice();
  if (!device) return res.status(500).json({ error: 'nmcli non disponibile o nessuna interfaccia WiFi trovata' });
  const result = await runNmcli(['-t', '-f', 'DEVICE,STATE,CONNECTION', 'device']);
  const line = result.stdout.split('\n').find((l) => splitTerse(l)[0] === device);
  const [, state, connection] = line ? splitTerse(line) : [null, null, null];
  const ipResult = await runNmcli(['-t', '-f', 'IP4.ADDRESS', 'device', 'show', device]);
  const ipLine = ipResult.stdout.split('\n').find((l) => l.startsWith('IP4.ADDRESS'));
  const ip = ipLine ? splitTerse(ipLine)[1] : null;
  res.json({ device, state, connection: connection === '--' ? null : connection, ip });
});

router.get('/scan', async (req, res) => {
  const device = await getWifiDevice();
  if (!device) return res.status(500).json({ error: 'nmcli non disponibile o nessuna interfaccia WiFi trovata' });
  const result = await runNmcli(['-t', '-f', 'SSID,SIGNAL,SECURITY,IN-USE', 'device', 'wifi', 'list', '--rescan', 'yes'], 25000);
  if (!result.ok) return res.status(500).json({ error: 'scansione WiFi fallita', detail: result.stderr });
  const seen = new Set();
  const networks = result.stdout
    .split('\n')
    .filter(Boolean)
    .map(splitTerse)
    .map(([ssid, signal, security, inUse]) => ({ ssid, signal: Number(signal) || 0, security: security || '', inUse: inUse === '*' }))
    .filter((n) => n.ssid && !seen.has(n.ssid) && seen.add(n.ssid))
    .sort((a, b) => b.signal - a.signal);
  res.json({ networks });
});

router.get('/saved', async (req, res) => {
  const result = await runNmcli(['-t', '-f', 'NAME,TYPE', 'connection', 'show']);
  if (!result.ok) return res.status(500).json({ error: 'nmcli non disponibile', detail: result.stderr });
  const saved = result.stdout
    .split('\n')
    .filter(Boolean)
    .map(splitTerse)
    .filter(([, type]) => type === '802-11-wireless')
    .map(([name]) => name);
  res.json({ saved });
});

router.post('/connect', express.json(), async (req, res) => {
  const { ssid, password } = req.body || {};
  if (!ssid || typeof ssid !== 'string') return res.status(400).json({ error: 'ssid è richiesto' });
  const device = await getWifiDevice();
  if (!device) return res.status(500).json({ error: 'nessuna interfaccia WiFi trovata' });
  const args = ['device', 'wifi', 'connect', ssid, ...(device ? ['ifname', device] : [])];
  if (password) args.push('password', password);
  const result = await runNmcli(args, 30000);
  res.status(result.ok ? 200 : 500).json({ ok: result.ok, stdout: result.stdout, stderr: result.stderr });
});

router.post('/disconnect', async (req, res) => {
  const device = await getWifiDevice();
  if (!device) return res.status(500).json({ error: 'nessuna interfaccia WiFi trovata' });
  const result = await runNmcli(['device', 'disconnect', device]);
  res.status(result.ok ? 200 : 500).json({ ok: result.ok, stdout: result.stdout, stderr: result.stderr });
});

router.delete('/saved/:name', async (req, res) => {
  const result = await runNmcli(['connection', 'delete', req.params.name]);
  res.status(result.ok ? 200 : 500).json({ ok: result.ok, stdout: result.stdout, stderr: result.stderr });
});

module.exports = router;
