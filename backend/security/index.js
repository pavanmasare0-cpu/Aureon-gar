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
const { THEME_TAGS } = require('../theme-tags');
const { detectUrl, detectPayload } = require('./detect');
const { sendAlert } = require('./notify');
const { runScan } = require('./scan');
const github = require('./github');
const auth = require('../dash-auth');
const linkscan = require('./linkscan');
const filescan = require('./filescan');
const textscan = require('./textscan');
const device = require('./device');
const soc = require('./soc');
const ti = require('./threatintel');
const firewall = require('./firewall');
const history = require('./history');
const endpoint = require('./endpoint');
const recovery = require('./recovery');
const depscan = require('./depscan');
const corpus = require('./corpus');
const { validate } = require('../hardening/validate');
const nodeCrypto = require('crypto');

const ENV_MODE = (process.env.SECURITY_MODE || 'protect').toLowerCase();
const ENV_RATE = parseInt(process.env.SECURITY_RATE_MAX, 10) || 200;   // requests / 10 s / IP
let MODE = ENV_MODE;          // both can be changed live from the dashboard (Defense options)
let RATE_MAX = ENV_RATE;
const RATE_WINDOW_MS = 10 * 1000;
const csv = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const ENV_ALLOW = new Set(csv(process.env.SECURITY_ALLOW_IPS));
let ALLOW = new Set(ENV_ALLOW);
const TOOL_UA = /(sqlmap|nikto|nmap|masscan|acunetix|nessus|wpscan|dirbuster|gobuster|zgrab|hydra|havij|openvas|w3af|burpsuite|zaproxy|nuclei|ffuf|feroxbuster|metasploit|commix|whatweb|wfuzz)/i;
const BLOCKLIST = new Set(csv(process.env.SECURITY_BLOCKLIST));
const BODY_SKIP = csv(process.env.SECURITY_BODY_SKIP || '/api/chat,/chat,/api/ava,/api/sentinel,/api/security,/api/memory,/api/apk');

const DATA_DIR = require('../data-dir').dataDir();
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

// ---------------- defense options (edited from the dashboard, saved in Firestore) ----------------
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const S = { mode: null, lockdown: false, rateMax: null, blockTools: true, blockEmptyUA: false, alertEmail: true, probeBanHours: 24, banMinutes: 60, allowIps: [] };
function applySettings() { MODE = S.mode || ENV_MODE; RATE_MAX = S.rateMax || ENV_RATE; ALLOW = new Set([...ENV_ALLOW, ...S.allowIps]); }
const settingsReady = (async () => {
  await store.whenFirestore(20000);
  const r = await store.load('sec_settings', SETTINGS_FILE);
  if (r.value && typeof r.value === 'object') Object.assign(S, r.value);
  applySettings();
})().catch((e) => console.error('[security] settings load failed:', e.message));
function saveSettings() { settingsReady.then(() => store.save('sec_settings', S, SETTINGS_FILE)).catch(() => {}); }

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
    app: 'aureon-backend', id: nodeCrypto.randomBytes(4).toString('hex'),
  };
  incidents.push(inc);
  if (incidents.length > 500) incidents.shift();
  try { soc.ingest(inc); } catch (e) { /* the SOC must never break request handling */ }
  if (action === 'BLOCKED') counters.blocked++; else counters.flagged++;
  persistSoon();
  if (severity === 'HIGH' && action === 'BLOCKED' && S.alertEmail) {
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
    detail: String(o.detail || '').slice(0, 300), ua: '', app: String(o.app || 'unknown').slice(0, 60), id: nodeCrypto.randomBytes(4).toString('hex'),
  };
  incidents.push(inc);
  if (incidents.length > 500) incidents.shift();
  try { soc.ingest(inc); } catch (e) { /* the SOC must never break request handling */ }
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
const fwLogged = new Map();
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

  // ---- threat intelligence: known-bad IPs (feeds + your IOC list) ----
  const tiHit = ti.matchIp(ip);
  if (tiHit && enforce(req, res, ip, { id: 'THREAT_INTEL_IP', severity: 'HIGH', name: 'IP is on ' + tiHit.list + (tiHit.note ? ' (' + tiHit.note + ')' : '') }, S.banMinutes, true)) return;

  // ---- extra defences (dashboard -> Defense options) ----
  const ua = String(req.headers['user-agent'] || '');
  if (S.lockdown && MODE !== 'off' && !req.path.startsWith('/api/security') && !req.path.startsWith('/api/sentinel') && req.path !== '/health') {
    return res.status(503).json({ error: 'Service temporarily unavailable' });       // LOCKDOWN: only allow-listed IPs get through
  }
  if (S.blockTools && TOOL_UA.test(ua) && enforce(req, res, ip, { id: 'ATTACK_TOOL_UA', severity: 'HIGH', name: 'Known attack tool: ' + ua.slice(0, 50) }, S.banMinutes, true)) return;
  if (S.blockEmptyUA && !ua && enforce(req, res, ip, { id: 'EMPTY_USER_AGENT', severity: 'MEDIUM', name: 'Request without User-Agent' }, S.banMinutes, true)) return;

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

  // ---- firewall policy (ordered rules; first match wins) ----
  const fw = firewall.check(req, ip);
  if (fw && fw.action === 'deny') {
    const k = ip + '|' + fw.rule.id, nowMs = Date.now();
    if (!fwLogged.has(k) || nowMs - fwLogged.get(k) > 300000) { fwLogged.set(k, nowMs); if (fwLogged.size > 5000) fwLogged.clear(); record(req, ip, fw.throttled ? 'FIREWALL_THROTTLE' : 'FIREWALL_DENY', 'MEDIUM', MODE === 'monitor' ? 'MONITORED' : 'BLOCKED', `rule "${fw.rule.name}"`); }
    if (MODE !== 'monitor') return fw.throttled ? res.status(429).json({ error: 'Too many requests' }) : deny(res);
  }
  if (fw && fw.action === 'allow') return next();       // trusted by your own rule: skip signature checks (rate-limit above still applied)

  // owner-facing dashboards are exempt from signature checks (they carry the owner code in the URL)
  if (req.path.startsWith('/api/security') || req.path.startsWith('/api/sentinel')) return next();

  const hit = detectUrl(req);
  if (hit && enforce(req, res, ip, hit, hit.id === 'SCANNER_PROBE' ? S.probeBanHours * 60 : S.banMinutes, true)) return;

  // payload patterns in the query string
  const qs = (req.originalUrl || '').split('?')[1] || '';
  const ph = qs ? detectPayload(qs) : null;
  if (ph && enforce(req, res, ip, ph, S.banMinutes, MODE === 'strict')) return;

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
  if (hit && enforce(req, res, ip, hit, S.banMinutes, MODE === 'strict')) return;
  next();
}

// ---------------- owner-only API + dashboard ----------------
const router = express.Router();
const failed = new Map(); // ip -> { n, t }

function registerFailure(req, ip, what) {
  const f = failed.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 10 * 60 * 1000) { f.n = 0; f.t = Date.now(); }
  f.n++; failed.set(ip, f);
  if (f.n >= 5) { failed.delete(ip); if (blockIp(ip, 30, 'OWNER_CODE_BRUTEFORCE', 'auto')) record(req, ip, 'OWNER_CODE_BRUTEFORCE', 'HIGH', 'BLOCKED', `5 wrong ${what} attempts`); }
}

let DASH_TEMPLATE = null;
function dashHtml() {
  if (!DASH_TEMPLATE) DASH_TEMPLATE = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8').replace('<!--THEME-->', THEME_TAGS);
  return DASH_TEMPLATE.split('__OWNER_CODE_JSON__').join('""').split('__MODE__').join(MODE);   // no secret is ever put in the page
}

auth.init({ blockIp: (ip, min, reason, by) => blockIp(ip, min, reason, by), record: recordEvent, alert: (s, t) => sendAlert(s, t, { urgent: true }) });
router.use(auth.shieldHeaders);
router.use('/auth', auth.router);                                  // login, 2FA, sessions, audit  (see dash-auth.js)
router.get('/dashboard', (req, res) => auth.dashboard(req, res, () => res.type('html').send(dashHtml())));

// ---- the Android app reports phone security here (its own scoped device key; can ONLY submit reports) ----
router.post('/device/report', (req, res) => {
  const dev = device.verifyKey(req.header('x-device-key'));
  if (!dev) { registerFailure(req, clientIp(req), 'device key'); return auth.notFound(req, res); }
  try {
    const a = device.ingest(dev, req.body, { record: recordEvent, alert: (s, t) => sendAlert(s, t, { urgent: true }) });
    res.json({ ok: true, score: a.score, level: a.level, findings: a.findings.length });
  } catch (e) { res.status(400).json({ error: 'bad report' }); }
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

// ---- Windows endpoint agent (its own agent key; can only report / fetch approved actions / report results) ----
function agentOf(req, res) {
  const a = endpoint.verifyKey(req.header('x-agent-key'));
  if (!a) { registerFailure(req, clientIp(req), 'agent key'); auth.notFound(req, res); return null; }
  return a;
}
router.post('/endpoint/report', (req, res) => {
  const ag = agentOf(req, res); if (!ag) return;
  try { const a = endpoint.ingest(ag, req.body, { record: recordEvent, alert: (s, t) => sendAlert(s, t, { urgent: true }) }); res.json({ ok: true, score: a.score, level: a.level, findings: a.findings.length }); }
  catch (e) { res.status(400).json({ error: 'bad report' }); }
});
router.get('/endpoint/poll', (req, res) => { const ag = agentOf(req, res); if (!ag) return; res.json({ actions: endpoint.poll(ag) }); });
router.post('/endpoint/result', validate({ actionId: { type: 'string', required: true, max: 20 }, ok: { type: 'boolean', required: true }, message: { type: 'string', max: 300 } }), (req, res) => {
  const ag = agentOf(req, res); if (!ag) return;
  try { endpoint.result(ag, req.body.actionId, req.body.ok, req.body.message); res.json({ ok: true }); } catch (e) { res.status(404).json({ error: 'not found' }); }
});

// ---- role matrix: viewer = read, analyst = triage / scans / block IP, admin = everything else ----
router.use(auth.apiGate);                      // everything below needs a logged-in session (or owner code + 2FA header)
router.use((req, res, next) => {
  const m = req.method, p = req.path; let min = m === 'GET' || m === 'HEAD' ? 'viewer' : 'admin';
  if (m !== 'GET' && (/^\/(block|unblock)$/.test(p) || /^\/scan\//.test(p) || /^\/soc\/cases\/[^/]+$/.test(p) || /^\/ti\/ioc$/.test(p) || (m === 'POST' && p === '/endpoint/actions') || p === '/recovery/verify')) min = 'analyst';
  if (m === 'GET' && (/^\/devices/.test(p) || /^\/endpoint\//.test(p) || /^\/recovery\//.test(p) || /^\/health\/(deps|eval)/.test(p))) min = 'analyst';
  if (/^\/recovery\/(export|import|rollback)/.test(p)) min = 'admin';
  return auth.requireRole(min)(req, res, next);
});

// ---- GitHub Guard management ----
router.get('/github', (req, res) => res.json({ repos: github.list(), webhookConfigured: !!process.env.GITHUB_WEBHOOK_SECRET, tokenConfigured: !!process.env.GITHUB_TOKEN }));
router.post('/github', validate({ repo: { type: 'string', required: true, max: 120 }, token: { type: 'string', max: 200 }, trusted: { type: 'string', max: 200 } }), (req, res) => { if (!auth.stepUp(req, res)) return; try { res.json(github.add(req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); } });
router.delete('/github/:id', (req, res) => (!auth.stepUp(req, res) ? undefined : github.remove(req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: 'not found' })));
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

router.post('/unblock', validate({ ip: { type: 'string', required: true, max: 45 } }), (req, res) => {
  if (!auth.stepUp(req, res)) return; auth.action(req, 'unblock ' + String((req.body || {}).ip));
  const ip = String((req.body && req.body.ip) || '').trim();
  if (!blocked[ip]) return res.status(404).json({ error: 'not blocked' });
  delete blocked[ip]; persistSoon();
  res.json({ ok: true });
});

router.post('/block', validate({ ip: { type: 'string', required: true, max: 45 }, minutes: { type: 'integer', min: 1, max: 43200 } }), (req, res) => {
  if (!auth.stepUp(req, res)) return; auth.action(req, 'block ' + String((req.body || {}).ip));
  const ip = String((req.body && req.body.ip) || '').trim();
  const minutes = Math.min(Math.max(parseInt(req.body && req.body.minutes, 10) || 60, 1), 60 * 24 * 30);
  if (!isValidIp(ip)) return res.status(400).json({ error: 'invalid IP' });
  if (ip === clientIp(req)) return res.status(400).json({ error: 'apna hi IP block nahi kar sakte' });
  if (!blockIp(ip, minutes, 'MANUAL', 'owner')) return res.status(400).json({ error: 'private / allow-listed IP block nahi ho sakta' });
  res.json({ ok: true });
});

router.get('/scan', (req, res) => res.json(runScan(req.app, MODE)));


// ---------------- defense options ----------------
const clampInt = (v, lo, hi, d) => Math.min(Math.max(parseInt(v, 10) || d, lo), hi);
router.get('/settings', (req, res) => res.json({ settings: S, effective: { mode: MODE, rateMax: RATE_MAX }, env: { mode: ENV_MODE, rateMax: ENV_RATE } }));
const SETTINGS_SCHEMA = { mode: { type: 'string', enum: ['env', 'off', 'monitor', 'protect', 'strict'] }, rateMax: { type: 'integer', min: 0, max: 5000 }, probeBanHours: { type: 'integer', min: 1, max: 168 }, banMinutes: { type: 'integer', min: 5, max: 10080 },
  lockdown: { type: 'boolean' }, blockTools: { type: 'boolean' }, blockEmptyUA: { type: 'boolean' }, alertEmail: { type: 'boolean' }, allowIps: { type: 'array', max: 30, items: { type: 'string', max: 45 } } };
router.post('/settings', validate(SETTINGS_SCHEMA), (req, res) => {
  if (!auth.stepUp(req, res)) return;
  const b = req.body || {};
  ['lockdown', 'blockTools', 'blockEmptyUA', 'alertEmail'].forEach((k) => { if (typeof b[k] === 'boolean') S[k] = b[k]; });
  if (['off', 'monitor', 'protect', 'strict'].includes(b.mode)) S.mode = b.mode; else if (b.mode === 'env' || b.mode === null) S.mode = null;
  if (b.rateMax !== undefined) S.rateMax = b.rateMax ? clampInt(b.rateMax, 20, 5000, ENV_RATE) : null;
  if (b.probeBanHours !== undefined) S.probeBanHours = clampInt(b.probeBanHours, 1, 168, 24);
  if (b.banMinutes !== undefined) S.banMinutes = clampInt(b.banMinutes, 5, 10080, 60);
  if (Array.isArray(b.allowIps)) S.allowIps = b.allowIps.map((x) => String(x).trim()).filter(isValidIp).slice(0, 30);
  applySettings(); saveSettings(); history.snapshot('defense', S, (req.auth && req.auth.name) || 'owner', Object.keys(b).join(',')); auth.action(req, 'defense settings: ' + Object.keys(b).join(','));
  res.json({ ok: true, settings: S, effective: { mode: MODE, rateMax: RATE_MAX } });
});

// ---------------- link / message / file checker ----------------
const scanHits = new Map();
function scanLimit(req, res) {
  const k = (req.auth && req.auth.sid) || clientIp(req), now = Date.now();
  const a = (scanHits.get(k) || []).filter((t) => now - t < 60000);
  if (a.length >= 20) { res.status(429).json({ error: 'Thoda ruko — 1 minute mein 20 se zyada scan nahi' }); return false; }
  a.push(now); scanHits.set(k, a); if (scanHits.size > 500) scanHits.clear(); return true;
}
router.post('/scan/link', validate({ url: { type: 'string', required: true, max: 2000 } }), async (req, res) => {
  if (!scanLimit(req, res)) return;
  try { res.json(await linkscan.analyzeUrl((req.body || {}).url)); } catch (e) { res.status(500).json({ error: 'scan fail: ' + String(e.message).slice(0, 80) }); }
});
router.post('/scan/text', validate({ text: { type: 'string', required: true, max: 5000 } }), async (req, res) => {
  if (!scanLimit(req, res)) return;
  try { res.json(await textscan.analyzeText((req.body || {}).text)); } catch (e) { res.status(500).json({ error: 'scan fail: ' + String(e.message).slice(0, 80) }); }
});
// send the raw file bytes with Content-Type: application/octet-stream  (?name=original-file-name)
router.post('/scan/file', express.raw({ type: '*/*', limit: filescan.MAX_BYTES + 4096 }), async (req, res) => {
  if (!scanLimit(req, res)) return;
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'file nahi mili (octet-stream body bhejo)' });
  try {
    const r = filescan.analyzeFile(req.body, String(req.query.name || 'file'));
    if (!r.error) { const vt = await filescan.vtLookup(r.info.sha256); if (vt) { r.virustotalResult = vt; if (vt.malicious >= 3) { r.score = 100; r.verdict = 'DANGEROUS'; r.reasons.unshift({ sev: 'HIGH', w: 80, text: `VirusTotal: ${vt.malicious} antivirus engines ise malware bol rahe hain` }); } } }
    res.json(r);
  } catch (e) { res.status(500).json({ error: 'scan fail: ' + String(e.message).slice(0, 80) }); }
});

// ---------------- my phone(s) ----------------
router.get('/devices', (req, res) => res.json(device.list()));
router.post('/devices', validate({ name: { type: 'string', max: 40 } }), (req, res) => { if (!auth.stepUp(req, res)) return; auth.action(req, 'new device key'); res.json(device.createDevice((req.body || {}).name)); });
router.delete('/devices/:id', (req, res) => { if (!auth.stepUp(req, res)) return; auth.action(req, 'remove device'); return device.removeDevice(req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: 'not found' }); });
router.get('/devices/:id', (req, res) => { const l = device.latest(req.params.id); return l ? res.json({ latest: l, history: device.history(req.params.id) }) : res.status(404).json({ error: 'abhi tak koi report nahi aayi' }); });


// ============================================================ SOC: cases, correlation, evidence
const casePatch = validate({ status: { type: 'string', enum: ['open', 'investigating', 'resolved'] }, resolution: { type: 'string', enum: ['true_positive', 'false_positive', 'benign'] }, assignee: { type: 'string', max: 40 }, note: { type: 'string', max: 1000 } });
router.get('/soc/stats', (req, res) => res.json(soc.stats()));
router.get('/soc/cases', (req, res) => res.json(soc.listCases(['open', 'investigating', 'resolved', 'active'].includes(req.query.status) ? req.query.status : undefined)));
router.get('/soc/cases/:id', (req, res) => { const c = soc.getCase(req.params.id); return c ? res.json(c) : res.status(404).json({ error: 'case nahi mila' }); });
router.patch('/soc/cases/:id', casePatch, (req, res) => {
  try { const c = soc.updateCase(req.params.id, req.body, (req.auth && req.auth.name) || 'owner'); auth.action(req, `case ${c.id}: ${Object.keys(req.body).join(',')}`); res.json(c); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/soc/cases/:id/export', (req, res) => {
  try {
    const c = soc.getCase(req.params.id); if (!c) return res.status(404).json({ error: 'case nahi mila' });
    const ips = new Set(c.events.map((e) => e.ip).filter(Boolean));
    const aud = (auth._t.audit() || []).filter((a) => ips.has(a.ip)).slice(-40).map((a) => ({ t: a.t, ip: a.ip, event: a.event, detail: a.detail }));
    const out = soc.exportCase(req.params.id, ['csv', 'html'].includes(req.query.format) ? req.query.format : 'json', (req.auth && req.auth.name) || 'owner', aud);
    auth.action(req, `evidence export ${req.params.id}`);
    res.setHeader('Content-Type', out.type); res.setHeader('Content-Disposition', `attachment; filename="${out.name}"`); res.send(out.body);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/soc/timeline', (req, res) => res.json(soc.timeline(120)));

// ============================================================ firewall policy
const FW_SCHEMA = { name: { type: 'string', required: true, min: 2, max: 60 }, action: { type: 'string', required: true, enum: ['allow', 'deny', 'throttle'] }, enabled: { type: 'boolean' }, path: { type: 'string', max: 120 }, methods: { type: 'array', max: 7, items: { type: 'string', max: 8 } },
  src: { type: 'object' }, throttleMax: { type: 'integer', min: 1, max: 1000 }, comment: { type: 'string', max: 120 }, expiresAt: { type: 'string', max: 40 } };
const who = (req) => (req.auth && req.auth.name) || 'owner';
router.get('/firewall', (req, res) => res.json({ rules: firewall.list(), history: history.list('firewall').slice(0, 10), scope: 'Application-level rules for this backend (not a host firewall). Windows PC: use the Endpoint Agent.' }));
router.post('/firewall', validate(FW_SCHEMA), (req, res) => { if (!auth.stepUp(req, res)) return; try { const r = firewall.add(req.body, who(req), clientIp(req)); auth.action(req, 'firewall add: ' + r.name); res.json(r); } catch (e) { res.status(400).json({ error: e.message }); } });
router.put('/firewall/:id', validate(FW_SCHEMA), (req, res) => { if (!auth.stepUp(req, res)) return; try { const r = firewall.update(req.params.id, req.body, who(req), clientIp(req)); auth.action(req, 'firewall edit: ' + r.name); res.json(r); } catch (e) { res.status(400).json({ error: e.message }); } });
router.delete('/firewall/:id', (req, res) => { if (!auth.stepUp(req, res)) return; auth.action(req, 'firewall delete ' + req.params.id); return firewall.remove(req.params.id, who(req)) ? res.json({ ok: true }) : res.status(404).json({ error: 'not found' }); });
router.post('/firewall/:id/move', validate({ dir: { type: 'string', required: true, enum: ['up', 'down'] } }), (req, res) => { if (!auth.stepUp(req, res)) return; return firewall.move(req.params.id, req.body.dir, who(req)) ? res.json({ ok: true }) : res.status(400).json({ error: 'move nahi hua' }); });

// ============================================================ threat intelligence
router.get('/ti', (req, res) => res.json(ti.status()));
router.post('/ti/feed', validate({ id: { type: 'string', required: true, max: 40 }, on: { type: 'boolean', required: true } }), (req, res) => { if (!auth.stepUp(req, res)) return; try { ti.setFeed(req.body.id, req.body.on); history.snapshot('iocs', ti.exportState(), who(req), 'feed ' + req.body.id + ' ' + req.body.on); auth.action(req, `feed ${req.body.id} -> ${req.body.on}`); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });
router.post('/ti/ioc', validate({ type: { type: 'string', required: true, enum: ['ip', 'domain', 'hash'] }, value: { type: 'string', required: true, max: 100 }, note: { type: 'string', max: 120 } }), (req, res) => { try { ti.addIoc(req.body.type, req.body.value, req.body.note, who(req)); history.snapshot('iocs', ti.exportState(), who(req), 'add ' + req.body.type); auth.action(req, `ioc add ${req.body.type} ${req.body.value}`); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });
router.delete('/ti/ioc', validate({ type: { type: 'string', required: true, enum: ['ip', 'domain', 'hash'] }, value: { type: 'string', required: true, max: 100 } }), (req, res) => { if (!auth.stepUp(req, res)) return; const ok = ti.removeIoc(req.body.type, req.body.value); history.snapshot('iocs', ti.exportState(), who(req), 'remove ' + req.body.type); return ok ? res.json({ ok: true }) : res.status(404).json({ error: 'not found' }); });
router.post('/ti/refresh', async (req, res) => { await ti.refreshAll(true); res.json(ti.status()); });

// ============================================================ Windows endpoints (agent keys, telemetry, approved actions)
router.get('/endpoint/agents', (req, res) => res.json(endpoint.listAgents()));
router.post('/endpoint/agents', validate({ name: { type: 'string', max: 40 } }), (req, res) => { if (!auth.stepUp(req, res)) return; auth.action(req, 'new endpoint agent key'); res.json(endpoint.createAgent(req.body.name)); });
router.delete('/endpoint/agents/:id', (req, res) => { if (!auth.stepUp(req, res)) return; auth.action(req, 'remove endpoint agent'); return endpoint.removeAgent(req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: 'not found' }); });
router.get('/endpoint/agents/:id', (req, res) => { const l = endpoint.latest(req.params.id); return l ? res.json(l) : res.status(404).json({ error: 'abhi tak koi report nahi' }); });
router.get('/endpoint/actions', (req, res) => res.json(endpoint.listActions(req.query.agent)));
router.post('/endpoint/actions', validate({ agentId: { type: 'string', required: true, max: 20 }, type: { type: 'string', required: true, max: 30 }, params: { type: 'object' } }), (req, res) => {
  try { const a = endpoint.propose(req.body.agentId, req.body.type, req.body.params, who(req)); auth.action(req, `endpoint action proposed: ${a.type}`); res.json(a); } catch (e) { res.status(400).json({ error: e.message }); }
});
for (const verb of ['approve', 'reject', 'rollback']) {
  router.post(`/endpoint/actions/:id/${verb}`, requireAdminStep, (req, res) => {
    try { const a = endpoint[verb](req.params.id, who(req)); auth.action(req, `endpoint action ${verb}: ${a.type} ${a.id}`); res.json(a); } catch (e) { res.status(400).json({ error: e.message }); }
  });
}
function requireAdminStep(req, res, next) { if (!auth.stepUp(req, res)) return; next(); }

// ============================================================ recovery: backup, restore drill, version history
const providers = { sec_settings: () => S, fw_rules: () => firewall.exportState(), ti_state: () => ti.exportState(), sec_github: () => github.exportState(), sec_devices: () => device.exportState(), ep_agents: () => endpoint.exportState(), dash_ops: () => auth.exportOps(), dash_auth: () => auth.exportCfg(), soc: () => soc.exportState() };
const appliers = {
  sec_settings: async (v) => { Object.assign(S, v); applySettings(); saveSettings(); }, fw_rules: async (v) => firewall.importState(v), ti_state: async (v) => ti.importState(v), sec_github: async (v) => github.importState(v),
  sec_devices: async (v) => device.importState(v), ep_agents: async (v) => endpoint.importState(v), dash_ops: async (v) => auth.importOps(v), dash_auth: async (v) => auth.importCfg(v), soc: async (v) => soc.importState(v),
};
router.get('/recovery/export', async (req, res) => {
  if (!auth.stepUp(req, res)) return;
  try {
    if (S.backupRequiresFresh) { /* reserved */ }
    const b = await recovery.exportBundle(who(req), Object.assign({}, providers, { servers: () => (require('../sentinel-dashboard')._backup ? require('../sentinel-dashboard')._backup.export() : null) }));
    S.lastBackupAt = new Date().toISOString(); saveSettings(); auth.action(req, 'backup exported');
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Content-Disposition', `attachment; filename="aureon-backup-${S.lastBackupAt.slice(0, 10)}.json"`); res.send(JSON.stringify(b, null, 2));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/recovery/verify', express.json({ limit: '5mb' }), (req, res) => { const v = recovery.verifyBundle(req.body); S.lastDrillAt = new Date().toISOString(); S.lastDrillOk = v.ok; saveSettings(); res.json(v); });
router.post('/recovery/import', express.json({ limit: '5mb' }), async (req, res) => {
  if (!auth.stepUp(req, res)) return;
  try { const r = await recovery.importBundle(req.body, Object.assign({}, appliers, { servers: async (v) => { const sd = require('../sentinel-dashboard'); if (sd._backup) sd._backup.import(v); } })); auth.action(req, 'backup RESTORED: ' + r.restored.join(',')); res.json(r); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/recovery/history/:ns', (req, res) => res.json(history.list(req.params.ns)));
router.post('/recovery/rollback', validate({ ns: { type: 'string', required: true, enum: ['firewall', 'defense', 'iocs'] }, id: { type: 'string', required: true, max: 20 } }), (req, res) => {
  if (!auth.stepUp(req, res)) return;
  const { ns, id } = req.body; const v = history.get(ns, id); if (v === null) return res.status(404).json({ error: 'version nahi mila' });
  if (ns === 'firewall') firewall.rollback(id, who(req));
  else if (ns === 'defense') { Object.assign(S, v); applySettings(); saveSettings(); history.snapshot('defense', S, who(req), 'rollback to ' + id); }
  else { ti.importState(v); history.snapshot('iocs', ti.exportState(), who(req), 'rollback to ' + id); }
  auth.action(req, `rollback ${ns} -> ${id}`); res.json({ ok: true });
});

// ============================================================ health: self-test, detection quality, dependency vulnerabilities
router.get('/health/selftest', async (req, res) => {
  const st = (await Promise.resolve(auth.status ? auth.status() : {})) || {};
  const checks = [];
  const add = (area, name, ok, detail, sev) => checks.push({ area, name, ok: !!ok, detail: detail || '', sev: sev || 'MEDIUM' });
  const scan = runScan(req.app, MODE);
  const cfgS = auth._t.cfg();
  add('Access', 'Owner code set & long', !scan.findings.some((f) => /Owner code/.test(f.title)), 'SENTINEL_OWNER_CODE 10+ akshar', 'HIGH');
  add('Access', '2-Step (2FA) ON', cfgS.totp && cfgS.totp.enabled, 'Authenticator app se', 'HIGH');
  add('Access', 'Stealth mode ON', cfgS.stealth, 'Dashboard bina login ke 404 dikhaye', 'MEDIUM');
  add('Access', 'Step-up 2FA for dangerous actions', cfgS.stepUp, 'Approve / block / settings par naya code', 'MEDIUM');
  const chain = auth.verifyAudit(); add('Audit', 'Audit log chain intact (tamper-evident)', chain.ok, chain.ok ? `${chain.entries} entries` : chain.why, 'HIGH');
  add('Guard', 'Security guard active (not off)', MODE !== 'off', 'mode = ' + MODE, 'HIGH');
  add('Guard', 'Trust proxy configured', !!(req.app && req.app.get('trust proxy')), 'sahi client IP ke liye', 'MEDIUM');
  add('Guard', 'Lockdown is OFF (normal operation)', !S.lockdown, S.lockdown ? 'LOCKDOWN abhi ON hai' : 'ok', 'MEDIUM');
  const tis = ti.status(); add('Threat intel', 'Threat feeds loaded', tis.feeds.filter((f) => f.on).every((f) => f.count > 0) || tis.feedsDisabledByEnv, tis.feeds.filter((f) => f.on).map((f) => `${f.id}:${f.count}`).join(' '), 'LOW');
  const bAge = S.lastBackupAt ? Math.floor((Date.now() - Date.parse(S.lastBackupAt)) / 86400000) : null;
  add('Recovery', 'Backup taken in last 7 days', bAge !== null && bAge <= 7, bAge === null ? 'kabhi backup nahi liya' : `${bAge} din purana (RPO target: 1 din)`, 'MEDIUM');
  const dAge = S.lastDrillAt ? Math.floor((Date.now() - Date.parse(S.lastDrillAt)) / 86400000) : null;
  add('Recovery', 'Restore drill (backup verify) done in last 30 days & passed', dAge !== null && dAge <= 30 && S.lastDrillOk, dAge === null ? 'kabhi verify nahi kiya' : `${dAge} din pehle`, 'MEDIUM');
  add('Recovery', 'Firestore persistence configured', !!process.env.FIREBASE_SERVICE_ACCOUNT, 'deploy par data bachta hai', 'MEDIUM');
  add('Alerts', 'Email alerts configured', !!(process.env.RESEND_API_KEY && process.env.ALERT_EMAIL_TO), 'RESEND_API_KEY + ALERT_EMAIL_TO', 'LOW');
  const sec = scan.findings.filter((f) => f.severity === 'HIGH' && /secret|key|token/i.test(f.title));
  add('Code', 'No hard-coded secrets in source', sec.length === 0, sec.length ? sec.map((f) => f.title).join('; ') : `${scan.filesScanned} files scanned`, 'HIGH');
  add('Code', 'Express is current enough', !scan.findings.some((f) => /Express is outdated/.test(f.title)), 'package.json', 'MEDIUM');
  add('Code', 'helmet-style security headers', true, 'dashboards: CSP, no-frame, no-referrer, no-store (dash-auth.js)', 'LOW');
  const failed = checks.filter((c) => !c.ok); const w = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  const maxPts = checks.reduce((s, c) => s + w[c.sev], 0), lost = failed.reduce((s, c) => s + w[c.sev], 0);
  res.json({ at: new Date().toISOString(), score: Math.round(100 * (maxPts - lost) / maxPts), passed: checks.length - failed.length, total: checks.length, checks, posture: scan });
});
let evalCache = null;
router.get('/health/eval', async (req, res) => { if (!evalCache || Date.now() - evalCache.t > 600000 || req.query.fresh) evalCache = { t: Date.now(), v: await corpus.evaluate() }; res.json(evalCache.v); });
router.get('/health/deps', async (req, res) => res.json(await depscan.run(!!req.query.fresh)));

module.exports = { guard, bodyGuard, githubWebhook: github.webhook, router, ready, _internals: { blockIp, blocked, incidents, detectUrl, detectPayload } };
