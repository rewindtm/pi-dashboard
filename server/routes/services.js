const express = require('express');
const { execFile } = require('child_process');

const router = express.Router();

// Only allow a small, safe set of systemctl verbs.
const ALLOWED_ACTIONS = new Set(['start', 'stop', 'restart', 'status', 'enable', 'disable']);

// Service names must look like a plain unit name to avoid shell/arg injection.
const SAFE_NAME = /^[a-zA-Z0-9_.@-]+$/;

function runSystemctl(args) {
  return new Promise((resolve) => {
    execFile('systemctl', args, { timeout: 10000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout, stderr: stderr || (err ? err.message : '') });
    });
  });
}

router.get('/', async (req, res) => {
  const result = await runSystemctl(['list-units', '--type=service', '--all', '--no-pager', '--no-legend', '--plain']);
  if (!result.ok && result.stderr) {
    return res.status(500).json({ error: 'systemctl non disponibile su questo host', detail: result.stderr });
  }
  const services = result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      const [unit, load, active, sub, ...descParts] = parts;
      return { unit, load, active, sub, description: descParts.join(' ') };
    });
  res.json({ services });
});

router.post('/:name/:action', async (req, res) => {
  const { name, action } = req.params;
  if (!SAFE_NAME.test(name)) return res.status(400).json({ error: 'nome servizio non valido' });
  if (!ALLOWED_ACTIONS.has(action)) return res.status(400).json({ error: 'azione non consentita' });
  const result = await runSystemctl([action, name]);
  res.status(result.ok ? 200 : 500).json(result);
});

module.exports = router;
