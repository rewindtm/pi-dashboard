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

// Cache stale-while-revalidate: la pagina viene servita subito con gli ultimi dati noti
// (anche dopo un riavvio, perché le repo sono salvate su disco) e GitHub viene
// interrogato in background, senza far aspettare chi apre la vista.
const REPOS_CACHE_FILE = 'github-repos-cache.json';
const REPOS_TTL_MS = 60 * 1000;
const USER_TTL_MS = 10 * 60 * 1000;

let reposCache = readJson(REPOS_CACHE_FILE, null); // { repos, cachedAt }
let reposInflight = null;
let userCache = null; // { user, cachedAt }

function clearCaches() {
  reposCache = null;
  userCache = null;
  writeJson(REPOS_CACHE_FILE, {});
}

async function fetchAllRepos(token) {
  const repos = [];
  for (let page = 1; page <= 5; page++) {
    const r = await ghFetch(`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator`, token);
    if (!r.ok) {
      const err = new Error('errore nella chiamata alle API GitHub');
      err.status = r.status;
      throw err;
    }
    const batch = await r.json();
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos.map((r) => ({
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    description: r.description,
    private: r.private,
    cloneUrl: r.clone_url,
    htmlUrl: r.html_url,
    updatedAt: r.updated_at,
    defaultBranch: r.default_branch,
  }));
}

// Un solo aggiornamento alla volta: chiamate concorrenti condividono la stessa promise.
function refreshRepos(token) {
  if (!reposInflight) {
    reposInflight = fetchAllRepos(token)
      .then((repos) => {
        reposCache = { repos, cachedAt: Date.now() };
        writeJson(REPOS_CACHE_FILE, reposCache);
        return reposCache;
      })
      .finally(() => {
        reposInflight = null;
      });
  }
  return reposInflight;
}

router.get('/status', async (req, res) => {
  const token = getToken();
  if (!token) return res.json({ connected: false });
  if (userCache && Date.now() - userCache.cachedAt < USER_TTL_MS) {
    return res.json({ connected: true, user: userCache.user });
  }
  try {
    const r = await ghFetch('/user', token);
    if (!r.ok) return res.json({ connected: false });
    const user = await r.json();
    userCache = { user: { login: user.login, avatarUrl: user.avatar_url, name: user.name }, cachedAt: Date.now() };
    res.json({ connected: true, user: userCache.user });
  } catch (err) {
    // GitHub non raggiungibile: se l'utente è già noto restiamo "connessi" invece di mostrare il form del token.
    if (userCache) return res.json({ connected: true, user: userCache.user });
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
    clearCaches();
    res.json({ ok: true, user: { login: user.login, avatarUrl: user.avatar_url } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/token', (req, res) => {
  writeJson('github-token.json', {});
  clearCaches();
  res.json({ ok: true });
});

// Senza parametri risponde subito dalla cache e, se è vecchia, avvia l'aggiornamento in
// background. Con ?wait=1 attende l'aggiornamento e restituisce i dati freschi: è la
// chiamata che la pagina fa dopo aver già mostrato la cache.
router.get('/repos', async (req, res) => {
  const token = getToken();
  if (!token) return res.status(401).json({ error: 'GitHub non connesso' });
  const hasCache = !!(reposCache && Array.isArray(reposCache.repos));
  const wait = req.query.wait === '1';

  if (hasCache && !wait) {
    const stale = Date.now() - reposCache.cachedAt >= REPOS_TTL_MS;
    if (stale) refreshRepos(token).catch(() => {});
    return res.json({ repos: reposCache.repos, cachedAt: reposCache.cachedAt, stale, refreshing: !!reposInflight });
  }

  try {
    const fresh = await refreshRepos(token);
    res.json({ repos: fresh.repos, cachedAt: fresh.cachedAt, stale: false, refreshing: false });
  } catch (err) {
    // Aggiornamento fallito: meglio i dati in cache che nessun dato.
    if (hasCache) return res.json({ repos: reposCache.repos, cachedAt: reposCache.cachedAt, stale: true, refreshing: false, error: err.message });
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
