const express = require('express');
const { execFile } = require('child_process');

const router = express.Router();

function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: stdout || '', stderr: stderr || (err ? err.message : '') });
    });
  });
}

function parseUpgradable(stdout) {
  return stdout
    .split('\n')
    .filter((l) => l && !l.startsWith('Listing...'))
    .map((line) => {
      // es: "nginx/stable 1.22.1-1 amd64 [upgradable from: 1.22.0-1]"
      const m = line.match(/^(\S+)\/(\S+)\s+(\S+)\s+(\S+)\s+\[upgradable from:\s*([^\]]+)\]/);
      if (!m) return null;
      const [, pkg, repo, newVersion, arch, currentVersion] = m;
      return { package: pkg, repo, newVersion, arch, currentVersion };
    })
    .filter(Boolean);
}

router.get('/check', async (req, res) => {
  const updateResult = await run('sudo', ['apt-get', 'update', '-qq'], 60000);
  const listResult = await run('apt', ['list', '--upgradable'], 20000);
  const packages = parseUpgradable(listResult.stdout);
  res.json({
    ok: updateResult.ok && listResult.ok,
    updatedIndexes: updateResult.ok,
    updateError: updateResult.ok ? null : updateResult.stderr,
    count: packages.length,
    packages,
  });
});

router.post('/upgrade', async (req, res) => {
  const result = await run('sudo', ['apt-get', 'upgrade', '-y'], 15 * 60 * 1000);
  res.status(result.ok ? 200 : 500).json(result);
});

module.exports = router;
