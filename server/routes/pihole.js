const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const router = express.Router();

const BASE = process.env.PIHOLE_URL || 'http://127.0.0.1:8081';
const ENV_FILE = process.env.PIHOLE_ENV || path.join(os.homedir(), 'pihole', '.env');

function readPassword() {
  if (process.env.PIHOLE_PASSWORD) return process.env.PIHOLE_PASSWORD;
  try {
    const m = fs.readFileSync(ENV_FILE, 'utf8').match(/^PIHOLE_PASSWORD=(.*)$/m);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

async function api(method, url, sid, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(sid ? { sid } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* risposta non JSON */ }
  return { ok: res.ok, status: res.status, json };
}

let cache = { at: 0, data: null };

router.get('/', async (req, res) => {
  if (cache.data && Date.now() - cache.at < 15000) return res.json(cache.data);
  const password = readPassword();
  if (!password) return res.status(412).json({ error: 'Pi-hole non configurato (PIHOLE_PASSWORD mancante)' });

  let sid = null;
  try {
    const auth = await api('POST', '/api/auth', null, { password });
    sid = auth.json && auth.json.session && auth.json.session.sid;
    if (!sid) return res.status(502).json({ error: 'Pi-hole: autenticazione rifiutata' });

    const [sum, top, blk] = await Promise.all([
      api('GET', '/api/stats/summary', sid),
      api('GET', '/api/stats/top_domains?blocked=true&count=5', sid),
      api('GET', '/api/dns/blocking', sid),
    ]);
    const s = (sum.json || {});
    const q = s.queries || {};
    const ts = ((os.networkInterfaces().tailscale0 || []).find((i) => i.family === 'IPv4') || {}).address;
    const data = {
      adminHost: ts || null,
      blocking: blk.json ? blk.json.blocking : null,
      total: q.total ?? 0,
      blocked: q.blocked ?? 0,
      percentBlocked: q.percent_blocked ?? 0,
      uniqueDomains: q.unique_domains ?? 0,
      forwarded: q.forwarded ?? 0,
      cached: q.cached ?? 0,
      domainsOnLists: (s.gravity || {}).domains_being_blocked ?? 0,
      clients: (s.clients || {}).active ?? 0,
      topBlocked: ((top.json && top.json.domains) || []).map((d) => ({ domain: d.domain, count: d.count })),
    };
    cache = { at: Date.now(), data };
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Pi-hole non raggiungibile: ' + err.message });
  } finally {
    if (sid) api('DELETE', '/api/auth', sid).catch(() => {});
  }
});

module.exports = router;
