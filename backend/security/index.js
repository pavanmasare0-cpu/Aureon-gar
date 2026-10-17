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
const auth = require('../dash-auth');
const linkscan = require('./linkscan');
const filescan = require('./filescan');
const textscan = require('./textscan');
const device = require('./device');

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
const BODY_SKIP = csv(process.env.SECURITY_BODY_SKIP || '/api/chat,/chat,/api/ava,/api/sentinel,/api/security,/api/memory');

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
    app: 'aureon-backend',
  };
  incidents.push(inc);
  if (incidents.length > 500) incidents.shift();
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

router.use(auth.apiGate);                      // everything below needs a logged-in owner session (or code+2FA header)

// ---- GitHub Guard management ----
router.get('/github', (req, res) => res.json({ repos: github.list(), webhookConfigured: !!process.env.GITHUB_WEBHOOK_SECRET, tokenConfigured: !!process.env.GITHUB_TOKEN }));
router.post('/github', (req, res) => { if (!auth.stepUp(req, res)) return; try { res.json(github.add(req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); } });
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

router.post('/unblock', (req, res) => {
  if (!auth.stepUp(req, res)) return; auth.action(req, 'unblock ' + String((req.body || {}).ip));
  const ip = String((req.body && req.body.ip) || '').trim();
  if (!blocked[ip]) return res.status(404).json({ error: 'not blocked' });
  delete blocked[ip]; persistSoon();
  res.json({ ok: true });
});

router.post('/block', (req, res) => {
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
router.post('/settings', (req, res) => {
  if (!auth.stepUp(req, res)) return;
  const b = req.body || {};
  ['lockdown', 'blockTools', 'blockEmptyUA', 'alertEmail'].forEach((k) => { if (typeof b[k] === 'boolean') S[k] = b[k]; });
  if (['off', 'monitor', 'protect', 'strict'].includes(b.mode)) S.mode = b.mode; else if (b.mode === 'env' || b.mode === null) S.mode = null;
  if (b.rateMax !== undefined) S.rateMax = b.rateMax ? clampInt(b.rateMax, 20, 5000, ENV_RATE) : null;
  if (b.probeBanHours !== undefined) S.probeBanHours = clampInt(b.probeBanHours, 1, 168, 24);
  if (b.banMinutes !== undefined) S.banMinutes = clampInt(b.banMinutes, 5, 10080, 60);
  if (Array.isArray(b.allowIps)) S.allowIps = b.allowIps.map((x) => String(x).trim()).filter(isValidIp).slice(0, 30);
  applySettings(); saveSettings(); auth.action(req, 'defense settings: ' + Object.keys(b).join(','));
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
router.post('/scan/link', async (req, res) => {
  if (!scanLimit(req, res)) return;
  try { res.json(await linkscan.analyzeUrl((req.body || {}).url)); } catch (e) { res.status(500).json({ error: 'scan fail: ' + String(e.message).slice(0, 80) }); }
});
router.post('/scan/text', async (req, res) => {
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
router.post('/devices', (req, res) => { if (!auth.stepUp(req, res)) return; auth.action(req, 'new device key'); res.json(device.createDevice((req.body || {}).name)); });
router.delete('/devices/:id', (req, res) => { if (!auth.stepUp(req, res)) return; auth.action(req, 'remove device'); return device.removeDevice(req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: 'not found' }); });
router.get('/devices/:id', (req, res) => { const l = device.latest(req.params.id); return l ? res.json({ latest: l, history: device.history(req.params.id) }) : res.status(404).json({ error: 'abhi tak koi report nahi aayi' }); });

module.exports = { guard, bodyGuard, githubWebhook: github.webhook, router, ready, _internals: { blockIp, blocked, incidents, detectUrl, detectPayload } };
