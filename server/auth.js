const crypto = require('crypto');

const TOKEN = process.env.DASHBOARD_TOKEN;

// Confronto a tempo costante: si confrontano gli hash, così la lunghezza non trapela.
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function checkToken(token) {
  return typeof token === 'string' && token.length > 0 && !!TOKEN && crypto.timingSafeEqual(sha(token), sha(TOKEN));
}

// Limite ai tentativi falliti per IP. Dietro il tunnel Cloudflare l'IP reale è nell'header
// CF-Connecting-IP (la connessione arriva sempre da localhost).
const MAX_FAILS = 8;
const WINDOW_MS = 15 * 60 * 1000;
const fails = new Map(); // ip -> { count, resetAt }

function clientIp(req) {
  return req.headers['cf-connecting-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function isLocked(ip) {
  const e = fails.get(ip);
  if (!e) return false;
  if (Date.now() > e.resetAt) {
    fails.delete(ip);
    return false;
  }
  return e.count >= MAX_FAILS;
}

function registerFail(ip) {
  const now = Date.now();
  const e = fails.get(ip);
  if (!e || now > e.resetAt) fails.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  else e.count++;
}

function retryAfterSec(ip) {
  const e = fails.get(ip);
  return e ? Math.max(1, Math.ceil((e.resetAt - Date.now()) / 1000)) : 1;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of fails) if (now > e.resetAt) fails.delete(ip);
}, 5 * 60 * 1000).unref();

// Controlla il token (header Bearer, oppure `token` passato esplicitamente) applicando il limite.
// Restituisce { ok, locked, retryAfter }.
function verify(req, token) {
  const ip = clientIp(req);
  if (isLocked(ip)) return { ok: false, locked: true, retryAfter: retryAfterSec(ip) };
  if (checkToken(token)) {
    fails.delete(ip);
    return { ok: true };
  }
  if (token) registerFail(ip); // senza token (pagina non ancora autenticata) non è un tentativo
  return { ok: false, locked: false };
}

function bearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function httpAuth(req, res, next) {
  const r = verify(req, bearerToken(req));
  if (r.ok) return next();
  if (r.locked) {
    res.set('Retry-After', String(r.retryAfter));
    return res.status(429).json({ error: 'troppi tentativi, riprova più tardi' });
  }
  res.status(401).json({ error: 'unauthorized' });
}

// Login: il token arriva solo nell'header Authorization, mai nell'URL.
function loginHandler(req, res) {
  const r = verify(req, bearerToken(req));
  if (r.locked) {
    res.set('Retry-After', String(r.retryAfter));
    return res.status(429).json({ ok: false, error: 'troppi tentativi, riprova tra ' + Math.ceil(r.retryAfter / 60) + ' min' });
  }
  res.json({ ok: r.ok });
}

module.exports = { httpAuth, checkToken, verify, loginHandler };
