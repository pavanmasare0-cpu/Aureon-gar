// security/index.js — Aureon Security Operations
//
//   app.set('trust proxy', 1);
//   app.use(security.guard);            // before express.json  (IP / URL / rate checks)
//   app.use(express.json(...));
//   app.use(security.bodyGuard);        // after express.json   (payload checks)
//   app.use('/api/security', security.router);
//
// SECURITY_MODE (env):
//   off      — nothing runs
//   monitor  — everything is detected and logged, NOTHING is blocked
//   protect  — (default) blocks high-confidence attacks: path traversal,
//              scanner probes, honeypot hits, flood / scanning behaviour,
//              owner-code brute force. Payload patterns (SQLi/XSS/...) are
//              only flagged, because users legitimately paste code into chat.
//   strict   — also blocks payload patterns (query string always; request
//              body except SECURITY_BODY_SKIP paths).
//
// Also: GitHub Guard (github.js) alerts when someone touches your repos, and
// /ingest lets your OTHER apps report into this one dashboard (shield-lite.js).
//
// Defensive only: it blocks requests and bans addresses for a limited time.
// It never connects back to, scans, or attacks the sender.
const express = require('express');
const fs = require('fs');
const path = require('path');
const store = require('../persist');
const { THEME_TAGS } = require('../ui-theme');
const { detectUrl, detectPayload } = require('./detect');
const { sendAlert } = require('./notify');
const { runScan } = require('./scan');
const github = require('./github');

const MODE = (process.env.SECURITY_MODE || 'protect').toLowerCase();
const RATE_MAX = parseInt(process.env.SECURITY_RATE_MAX, 10) || 200;   // requests / 10 s / IP
const RATE_WINDOW_MS = 10 * 1000;
const csv = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const ALLOW = new Set(csv(process.env.SECURITY_ALLOW_IPS));
const BLOCKLIST = new Set(csv(process.env.SECURITY_BLOCKLIST));
const BODY_SKIP = csv(process.env.SECURITY_BODY_SKIP || '/api/chat,/chat,/api/sentinel,/api/security,/api/memory');

const DATA_DIR = path.join(__dirname, '..', 'security-data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* read-only is fine */ }
const BLOCKED_FILE = path.join(DATA_DIR, 'blocked.json');
const INCIDENTS_FILE = path.join(DATA_DIR, 'incidents.json');

// ---------------- state ----------------
let blocked = {};                     // ip -> { until, reason, at, by }
let incidents = [];                   // oldest -> newest, capped
const counters = { requests: 0, blocked: 0, flagged: 0, since: Date.now() };
let hydrated = false;

const ready = (async () => {
  await store.whenFirestore(20000);
  const b = await store.load('sec_blocked', BLOCKED_FILE);
  const i = await store.load('sec_incidents', INCIDENTS_FILE);
  if (b.value && typeof b.value === 'object') blocked = Object.assign(blocked, b.value);
  if (Array.isArray(i.value)) incidents = i.value.concat(incidents).slice(-500);
  pruneBlocked();
  hydrated = true;
  console.log(`[security] mode=${MODE} · blocked now: ${Object.keys(blocked).length} · incidents loaded: ${incidents.length}`);
})().catch((e) => { hydrated = true; console.error('[security] hydrate failed:', e.message); });

let saveTimer = null;
function persistSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    ready.then(() => Promise.all([
      store.save('sec_blocked', blocked, BLOCKED_FILE),
      store.save('sec_incidents', incidents, INCIDENTS_FILE),
    ])).catch(() => {});
  }, 3000);
}

github.init({ record: recordEvent, alert: (s, t) => sendAlert(s, t, { urgent: true }), dataDir: DATA_DIR });

// ---------------- helpers ----------------
function clientIp(req) {
  return String(req.ip || (req.connection && req.connection.remoteAddress) || '').replace(/^::ffff:/, '');
}
function isPrivate(ip) {
  return !ip || ip === '::1' || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|fc|fd|fe80)/i.test(ip);
}
function isValidIp(ip) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) || /^[0-9a-f:]{2,45}$/i.test(ip);
}
function pruneBlocked() {
  const now = Date.now();
  for (const ip of Object.keys(blocked)) if (blocked[ip].until <= now) delete blocked[ip];
}

function blockIp(ip, minutes, reason, by) {
  if (!ip || isPrivate(ip) || ALLOW.has(ip)) return false;
  blocked[ip] = { until: Date.now() + minutes * 60 * 1000, reason, at: Date.now(), by: by || 'auto' };
  persistSoon();
  return true;
}

function record(req, ip, rule, severity, action, detail) {
  const inc = {
    t: new Date().toISOString(), ip, method: req.method,
    path: String(req.originalUrl || req.url || '').slice(0, 200),
    rule, severity, action, detail: detail || '',
    ua: String(req.headers['user-agent'] || '').slice(0, 120),
    app: 'aureon-backend',
  };
  incidents.push(inc);
  if (incidents.length > 500) incidents.shift();
  if (action === 'BLOCKED') counters.blocked++; else counters.flagged++;
  persistSoon();
  if (severity === 'HIGH' && action === 'BLOCKED') {
    sendAlert('Aureon Security: attack blocked', `${rule} from ${ip}\n${inc.method} ${inc.path}\n${inc.t}\n(Further alerts are limited to one per 10 minutes.)`);
  }
}

// incidents that did not come from a request on this server (GitHub, other apps)
function recordEvent(o) {
  const inc = {
    t: new Date().toISOString(), ip: String(o.ip || '-').slice(0, 64), method: String(o.method || 'EVENT').slice(0, 16),
    path: String(o.path || '').slice(0, 200), rule: String(o.rule || 'EVENT').slice(0, 60),
    severity: ['HIGH', 'MEDIUM', 'LOW', 'INFO'].includes(o.severity) ? o.severity : 'INFO',
    action: ['BLOCKED', 'FLAGGED', 'MONITORED', 'ALERT'].includes(o.action) ? o.action : 'FLAGGED',
    detail: String(o.detail || '').slice(0, 300), ua: '', app: String(o.app || 'unknown').slice(0, 60),
  };
  incidents.push(inc);
  if (incidents.length > 500) incidents.shift();
  counters.flagged++;
  persistSoon();
  return inc;
}

const deny = (res) => res.status(403).json({ error: 'Blocked', message: 'Request blocked by Aureon Security.' });

// act on a detection according to MODE; returns true if the request was ended
function enforce(req, res, ip, hit, banMinutes, blockable) {
  if (MODE === 'monitor' || !blockable) { record(req, ip, hit.id, hit.severity, MODE === 'monitor' ? 'MONITORED' : 'FLAGGED', hit.name); return false; }
  blockIp(ip, banMinutes, hit.id, 'auto');
  record(req, ip, hit.id, hit.severity, 'BLOCKED', hit.name);
  deny(res);
  return true;
}

// ---------------- rate limit + scanner behaviour ----------------
const rate = new Map();      // ip -> { count, start, strikes, lastStrike }
const notFound = new Map();  // ip -> [timestamps of 404s]

function rateCheck(ip) {
  const now = Date.now();
  if (rate.size > 20000) for (const [k, v] of rate) if (now - v.start > RATE_WINDOW_MS * 6) rate.delete(k);
  let r = rate.get(ip);
  if (!r || now - r.start > RATE_WINDOW_MS) { r = { count: 0, start: now, strikes: r ? r.strikes : 0, lastStrike: r ? r.lastStrike : 0 }; rate.set(ip, r); }
  r.count++;
  if (r.count === RATE_MAX + 1) {
    if (now - r.lastStrike > 10 * 60 * 1000) r.strikes = 0;
    r.strikes++; r.lastStrike = now;
    return r.strikes >= 3 ? 'ban' : 'limit';
  }
  return r.count > RATE_MAX ? 'limit-quiet' : null;
}

function watch404(req, res, ip) {
  res.on('finish', () => {
    if (res.statusCode !== 404 || MODE === 'off') return;
    const now = Date.now();
    const arr = (notFound.get(ip) || []).filter((t) => now - t < 60000);
    arr.push(now); notFound.set(ip, arr);
    if (notFound.size > 20000) notFound.clear();
    if (arr.length >= 15) {
      notFound.delete(ip);
      const hit = { id: 'SCANNER_BEHAVIOR', severity: 'HIGH', name: '15+ unknown URLs in 60s (scanning)' };
      if (MODE === 'monitor') record(req, ip, hit.id, hit.severity, 'MONITORED', hit.name);
      else if (blockIp(ip, 30, hit.id, 'auto')) record(req, ip, hit.id, hit.severity, 'BLOCKED', hit.name);
    }
  });
}

// ---------------- middleware ----------------
function guard(req, res, next) {
  counters.requests++;
  if (MODE === 'off') return next();
  const ip = clientIp(req);
  if (isPrivate(ip) || ALLOW.has(ip)) return next();

  const b = blocked[ip];
  if (b) {
    if (b.until > Date.now()) { counters.blocked++; return deny(res); }
    delete blocked[ip];
  }
  if (BLOCKLIST.has(ip)) { counters.blocked++; return deny(res); }

  const rc = rateCheck(ip);
  if (rc === 'ban') {
    if (MODE !== 'monitor') blockIp(ip, 15, 'DDOS_FLOOD', 'auto');
    record(req, ip, 'DDOS_FLOOD', 'HIGH', MODE === 'monitor' ? 'MONITORED' : 'BLOCKED', `repeated >${RATE_MAX} req/10s`);
    if (MODE !== 'monitor') return deny(res);
  } else if (rc === 'limit' || rc === 'limit-quiet') {
    if (rc === 'limit') record(req, ip, 'RATE_LIMIT', 'MEDIUM', MODE === 'monitor' ? 'MONITORED' : 'BLOCKED', `>${RATE_MAX} req/10s`);
    if (MODE !== 'monitor') return res.status(429).json({ error: 'Too many requests', message: 'Slow down and try again shortly.' });
  }

  watch404(req, res, ip);

  // owner-facing dashboards are exempt from signature checks (they carry the owner code in the URL)
  if (req.path.startsWith('/api/security') || req.path.startsWith('/api/sentinel')) return next();

  const hit = detectUrl(req);
  if (hit && enforce(req, res, ip, hit, hit.id === 'SCANNER_PROBE' ? 24 * 60 : 60, true)) return;

  // payload patterns in the query string
  const qs = (req.originalUrl || '').split('?')[1] || '';
  const ph = qs ? detectPayload(qs) : null;
  if (ph && enforce(req, res, ip, ph, 60, MODE === 'strict')) return;

  next();
}

// after express.json(): inspect the body (strict mode blocks, otherwise flags)
function bodyGuard(req, res, next) {
  if (MODE === 'off') return next();
  if (!req.body || typeof req.body !== 'object') return next();
  const ip = clientIp(req);
  if (isPrivate(ip) || ALLOW.has(ip)) return next();
  if (BODY_SKIP.some((p) => req.path === p || req.path.startsWith(p + '/') || req.path.startsWith(p))) return next();
  let text = '';
  try { text = JSON.stringify(req.body).slice(0, 20000); } catch (e) { return next(); }
  const hit = detectPayload(text);
  if (hit && enforce(req, res, ip, hit, 60, MODE === 'strict')) return;
  next();
}

// ---------------- owner-only API + dashboard ----------------
const router = express.Router();
const failed = new Map(); // ip -> { n, t }

function ownerOk(req, res) {
  const configured = process.env.SENTINEL_OWNER_CODE;
  if (!configured) { res.status(503).json({ error: 'Set SENTINEL_OWNER_CODE on Render to use the security dashboard.' }); return false; }
  const ip = clientIp(req);
  const provided = req.header('x-owner-code') || req.query.code;
  const crypto = require('crypto');
  const same = typeof provided === 'string' &&
    crypto.timingSafeEqual(crypto.createHash('sha256').update(provided).digest(), crypto.createHash('sha256').update(configured).digest());
  if (same) { failed.delete(ip); return true; }
  registerFailure(req, ip, 'owner code');
  res.status(401).json({ error: 'owner code required' });
  return false;
}
function registerFailure(req, ip, what) {
  const f = failed.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 10 * 60 * 1000) { f.n = 0; f.t = Date.now(); }
  f.n++; failed.set(ip, f);
  if (f.n >= 5) { failed.delete(ip); if (blockIp(ip, 30, 'OWNER_CODE_BRUTEFORCE', 'auto')) record(req, ip, 'OWNER_CODE_BRUTEFORCE', 'HIGH', 'BLOCKED', `5 wrong ${what} attempts`); }
}

const LOGIN = (wrong) => `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aureon Security — Locked</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0d;color:#eee;font-family:-apple-system,sans-serif}
form{background:#15151b;border:1px solid #24242e;border-radius:12px;padding:28px;width:90%;max-width:320px;text-align:center}
h1{color:#d4af37;font-size:18px;margin:0 0 18px}input{width:100%;background:#101014;border:1px solid #24242e;color:#eee;padding:10px 12px;border-radius:8px;font-size:14px;margin-bottom:12px}
button{width:100%;background:#d4af37;color:#141414;border:none;border-radius:8px;padding:10px;font-weight:600;font-size:14px;cursor:pointer}.err{color:#ff6b6b;font-size:12px;margin:-6px 0 12px}</style>${THEME_TAGS}</head>
<body><form method="GET" action="/api/security/dashboard"><h1>🔐 Aureon Security</h1>${wrong ? '<div class="err">Galat code, dobara try karo.</div>' : ''}<input name="code" type="password" placeholder="Owner code" autofocus><button type="submit">Unlock</button></form></body></html>`;

let DASH_TEMPLATE = null;
function dashHtml(code) {
  if (!DASH_TEMPLATE) DASH_TEMPLATE = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8').replace('<!--THEME-->', THEME_TAGS);
  const codeJson = JSON.stringify(String(code)).replace(/</g, '\\u003c');
  return DASH_TEMPLATE.split('__OWNER_CODE_JSON__').join(codeJson).split('__MODE__').join(MODE);
}

router.get('/dashboard', (req, res) => {
  const configured = process.env.SENTINEL_OWNER_CODE;
  if (!configured) return res.status(503).type('html').send(LOGIN(false).replace('<input', '<div class="err">SENTINEL_OWNER_CODE set nahi hai — Render → Environment mein add karo.</div><input'));
  if (!req.query.code) return res.type('html').send(LOGIN(false));
  const crypto = require('crypto');
  const ok = crypto.timingSafeEqual(crypto.createHash('sha256').update(String(req.query.code)).digest(), crypto.createHash('sha256').update(configured).digest());
  if (!ok) { ownerOk(req, { status: () => ({ json: () => {} }) }); return res.type('html').send(LOGIN(true)); }
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(dashHtml(req.query.code));
});

// ---- other apps report here (authenticated by per-app key, not the owner code) ----
// SECURITY_INGEST_KEYS="omnisell:longrandomkey,otherapp:anotherkey"
const INGEST = csv(process.env.SECURITY_INGEST_KEYS).map((s) => { const i = s.indexOf(':'); return i > 0 ? [s.slice(i + 1), s.slice(0, i)] : null; }).filter(Boolean);
function appForKey(key) {
  if (typeof key !== 'string') return null;
  const crypto = require('crypto'); const h = (x) => crypto.createHash('sha256').update(x).digest();
  for (const [k, name] of INGEST) if (crypto.timingSafeEqual(h(key), h(k))) return name;
  return null;
}
router.post('/ingest', (req, res) => {
  const name = appForKey(req.header('x-shield-key'));
  if (!name) { registerFailure(req, clientIp(req), 'ingest key'); return res.status(401).json({ error: 'bad key' }); }
  const evs = Array.isArray(req.body && req.body.events) ? req.body.events.slice(0, 20) : [];
  for (const e of evs) {
    if (!e || typeof e !== 'object') continue;
    recordEvent({ app: name, ip: e.ip, method: e.method, path: e.path, rule: e.rule, severity: e.severity, action: e.action, detail: e.detail });
  }
  pruneBlocked();
  res.json({ ok: true, blocked: Object.keys(blocked).slice(0, 500) }); // lets every app enforce bans made anywhere
});

router.use((req, res, next) => (ownerOk(req, res) ? next() : undefined));

// ---- GitHub Guard management ----
router.get('/github', (req, res) => res.json({ repos: github.list(), webhookConfigured: !!process.env.GITHUB_WEBHOOK_SECRET, tokenConfigured: !!process.env.GITHUB_TOKEN }));
router.post('/github', (req, res) => { try { res.json(github.add(req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); } });
router.delete('/github/:id', (req, res) => (github.remove(req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: 'not found' })));
router.post('/github/check', async (req, res) => { await github.runAll(); res.json({ ok: true }); });

router.get('/stats', (req, res) => {
  pruneBlocked();
  const now = Date.now();
  const last24 = incidents.filter((i) => now - Date.parse(i.t) < 86400000);
  res.json({
    mode: MODE,
    counters: { ...counters, uptimeMin: Math.round((now - counters.since) / 60000) },
    incidents24h: last24.length,
    topRules: Object.entries(last24.reduce((m, i) => { m[i.rule] = (m[i.rule] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 5),
    blocked: Object.entries(blocked).map(([ip, v]) => ({ ip, reason: v.reason, by: v.by, at: v.at, until: v.until })).sort((a, b) => b.at - a.at),
    incidents: incidents.slice(-100).reverse(),
    config: { rateMax: RATE_MAX, allowIps: ALLOW.size, bodySkip: BODY_SKIP },
    apps: Object.entries(last24.reduce((m, i) => { const a = i.app || 'aureon-backend'; m[a] = (m[a] || 0) + 1; return m; }, {})).map(([app, count]) => ({ app, count })),
    ingestApps: INGEST.map(([, name]) => name),
    yourIp: clientIp(req),
  });
});

router.post('/unblock', (req, res) => {
  const ip = String((req.body && req.body.ip) || '').trim();
  if (!blocked[ip]) return res.status(404).json({ error: 'not blocked' });
  delete blocked[ip]; persistSoon();
  res.json({ ok: true });
});

router.post('/block', (req, res) => {
  const ip = String((req.body && req.body.ip) || '').trim();
  const minutes = Math.min(Math.max(parseInt(req.body && req.body.minutes, 10) || 60, 1), 60 * 24 * 30);
  if (!isValidIp(ip)) return res.status(400).json({ error: 'invalid IP' });
  if (ip === clientIp(req)) return res.status(400).json({ error: 'apna hi IP block nahi kar sakte' });
  if (!blockIp(ip, minutes, 'MANUAL', 'owner')) return res.status(400).json({ error: 'private / allow-listed IP block nahi ho sakta' });
  res.json({ ok: true });
});

router.get('/scan', (req, res) => res.json(runScan(req.app, MODE)));

module.exports = { guard, bodyGuard, githubWebhook: github.webhook, router, ready, _internals: { blockIp, blocked, incidents, detectUrl, detectPayload } };
