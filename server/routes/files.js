const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const router = express.Router();

const ROOT = path.resolve(process.env.FILES_ROOT || os.homedir());

function resolveSafe(relPath) {
  const target = path.resolve(ROOT, '.' + path.sep + (relPath || ''));
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    throw new Error('percorso fuori dalla directory consentita');
  }
  return target;
}

router.get('/list', async (req, res) => {
  try {
    const dir = resolveSafe(req.query.path || '');
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const items = await Promise.all(
      entries.map(async (e) => {
        const full = path.join(dir, e.name);
        let size = 0;
        let mtime = null;
        try {
          const st = await fs.stat(full);
          size = st.size;
          mtime = st.mtime;
        } catch {}
        return { name: e.name, isDir: e.isDirectory(), size, mtime };
      })
    );
    res.json({ root: ROOT, path: path.relative(ROOT, dir), items });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/read', async (req, res) => {
  try {
    const file = resolveSafe(req.query.path || '');
    const st = await fs.stat(file);
    if (st.isDirectory()) return res.status(400).json({ error: 'è una directory' });
    if (st.size > 2 * 1024 * 1024) return res.status(400).json({ error: 'file troppo grande (>2MB)' });
    const content = await fs.readFile(file, 'utf8');
    res.json({ path: req.query.path, content });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/write', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const file = resolveSafe(req.body.path || '');
    await fs.writeFile(file, req.body.content ?? '', 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/delete', async (req, res) => {
  try {
    const target = resolveSafe(req.query.path || '');
    const st = await fs.stat(target);
    if (st.isDirectory()) await fs.rmdir(target);
    else await fs.unlink(target);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/mkdir', express.json(), async (req, res) => {
  try {
    const dir = resolveSafe(req.body.path || '');
    await fs.mkdir(dir, { recursive: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
