const express = require('express');
const { spawn } = require('child_process');

const router = express.Router();

const SHELL = process.platform === 'win32' ? 'powershell.exe' : 'bash';
const SHELL_ARGS = process.platform === 'win32' ? ['-NoProfile', '-Command'] : ['-lc'];

// Generic remote command execution, protected by the same bearer token as the
// rest of the API. Intended for both the human user and programmatic callers.
router.post('/', express.json(), (req, res) => {
  const { command, cwd, timeoutMs } = req.body || {};
  if (!command || typeof command !== 'string') {
    return res.status(400).json({ error: 'command (string) è richiesto' });
  }
  const child = spawn(SHELL, [...SHELL_ARGS, command], {
    cwd: cwd || undefined,
    timeout: Math.min(Math.max(Number(timeoutMs) || 15000, 1000), 60000),
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stderr += d.toString()));
  child.on('close', (code, signal) => {
    res.json({ code, signal, stdout, stderr });
  });
  child.on('error', (err) => {
    res.status(500).json({ error: err.message });
  });
});

module.exports = router;
