const express = require('express');
const { readJson, writeJson } = require('../store');

const router = express.Router();

function getToken() {
  const d = readJson('github-token.json', null);
  return d && d.token;
}

async function ghFetch(url, token, opts = {}) {
  return fetch('https://api.github.com' + url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'pi-dashboard',
      ...(opts.headers || {}),
    },
  });
}

router.get('/status', async (req, res) => {
  const token = getToken();
  if (!token) return res.json({ connected: false });
  try {
    const r = await ghFetch('/user', token);
    if (!r.ok) return res.json({ connected: false });
    const user = await r.json();
    res.json({ connected: true, user: { login: user.login, avatarUrl: user.avatar_url, name: user.name } });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

router.post('/token', express.json(), async (req, res) => {
  const { token } = req.body || {};
  if (!token || typeof token !== 'string') return res.status(400).json({ error: 'token è richiesto' });
  try {
    const r = await ghFetch('/user', token);
    if (!r.ok) return res.status(401).json({ error: 'token non valido o senza i permessi necessari' });
    const user = await r.json();
    writeJson('github-token.json', { token });
    res.json({ ok: true, user: { login: user.login, avatarUrl: user.avatar_url } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/token', (req, res) => {
  writeJson('github-token.json', {});
  res.json({ ok: true });
});

router.get('/repos', async (req, res) => {
  const token = getToken();
  if (!token) return res.status(401).json({ error: 'GitHub non connesso' });
  try {
    const repos = [];
    for (let page = 1; page <= 5; page++) {
      const r = await ghFetch(`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator`, token);
      if (!r.ok) return res.status(r.status).json({ error: 'errore nella chiamata alle API GitHub' });
      const batch = await r.json();
      repos.push(...batch);
      if (batch.length < 100) break;
    }
    res.json({
      repos: repos.map((r) => ({
        id: r.id,
        name: r.name,
        fullName: r.full_name,
        description: r.description,
        private: r.private,
        cloneUrl: r.clone_url,
        htmlUrl: r.html_url,
        updatedAt: r.updated_at,
        defaultBranch: r.default_branch,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
