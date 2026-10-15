// shield-lite.js — drop this ONE file into any other Express app (OmniSell, ...)
// to get the same protection as Aureon, reporting into the central dashboard.
//
//   const shield = require('./shield-lite');
//   app.set('trust proxy', 1);                       // behind Render / any proxy
//   app.use(shield({
//     app: 'omnisell',                               // name shown in the dashboard
//     reportUrl: 'https://aureone.onrender.com',     // your Aureon backend
//     key: process.env.SHIELD_KEY,                   // = the key set in SECURITY_INGEST_KEYS on Aureon
//   }));                                             // put it FIRST, before express.json()
//
// Needs Node 18+ (global fetch). No other dependencies.
//
// What it does: blocks scanner probes / path traversal / floods, honours IPs
// banned anywhere (synced from the central dashboard), and reports every
// incident to it. Modes: 'protect' (default) | 'monitor' (log only) | 'off'.
// Defensive only — it never contacts or attacks the sender.

const URL_RULES = [
  { id: 'PATH_TRAVERSAL', re: /(\.\.[\/\\]|%2e%2e(%2f|%5c|\/|\\)|\.\.%2f|%252e%252e)/i, ban: 60 },
  { id: 'SYSTEM_FILE', re: /(\/etc\/(passwd|shadow|hosts)\b|\/proc\/self\/|\bwin\.ini\b|\bboot\.ini\b)/i, ban: 60 },
  { id: 'SCANNER_PROBE', re: /^\/(\.env|\.git(\/|$)|\.aws|\.ssh|wp-(login|admin|content|includes)|wordpress|phpmyadmin|pma\b|xmlrpc\.php|cgi-bin|vendor\/phpunit|actuator|server-status|config\.(env|json|php|yml)|backup\.(sql|zip|tar)|\.ds_store)/i, ban: 24 * 60 },
];

module.exports = function shield(opts = {}) {
  const name = opts.app || 'app';
  const mode = (opts.mode || process.env.SHIELD_MODE || 'protect').toLowerCase();
  const rateMax = opts.rateMax || 200;
  const allow = new Set(opts.allowIps || []);
  const base = (opts.reportUrl || '').replace(/\/$/, '');
  const key = opts.key;

  const bans = new Map();          // ip -> until
  let central = new Set();         // IPs banned by the central dashboard
  const rate = new Map(), nf = new Map();
  let queue = [], timer = null;

  const isPrivate = (ip) => !ip || ip === '::1' || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|fc|fd|fe80)/i.test(ip);
  const ipOf = (req) => String(req.ip || (req.connection && req.connection.remoteAddress) || '').replace(/^::ffff:/, '');

  function report(req, ip, rule, severity, action, detail) {
    if (!base || !key) return;
    if (queue.length < 100) queue.push({ ip, method: req.method, path: String(req.originalUrl || '').slice(0, 200), rule, severity, action, detail });
    if (!timer) timer = setTimeout(flush, 5000);
  }
  async function flush() {
    timer = null;
    const events = queue.splice(0, 20);
    try {
      const r = await fetch(base + '/api/security/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-shield-key': key }, body: JSON.stringify({ events }) });
      if (r.ok) { const j = await r.json(); if (Array.isArray(j.blocked)) central = new Set(j.blocked); }
    } catch (e) { /* central dashboard unreachable — keep protecting locally */ }
    if (queue.length) timer = setTimeout(flush, 5000);
  }
  // pull the central ban list once a minute even when nothing happened
  if (base && key) setInterval(() => { flush(); }, 60000).unref();

  function ban(ip, minutes) { bans.set(ip, Date.now() + minutes * 60000); }
  const deny = (res) => res.status(403).json({ error: 'Blocked', message: 'Request blocked.' });

  return function shieldMiddleware(req, res, next) {
    if (mode === 'off') return next();
    const ip = ipOf(req);
    if (isPrivate(ip) || allow.has(ip)) return next();
    const until = bans.get(ip);
    if (until && until > Date.now()) return deny(res);
    if (central.has(ip)) return deny(res);

    const now = Date.now();
    let r = rate.get(ip);
    if (!r || now - r.start > 10000) { r = { c: 0, start: now }; rate.set(ip, r); if (rate.size > 20000) rate.clear(); }
    if (++r.c === rateMax + 1) {
      report(req, ip, 'RATE_LIMIT', 'MEDIUM', mode === 'monitor' ? 'MONITORED' : 'BLOCKED', `>${rateMax} req/10s`);
    }
    if (r.c > rateMax && mode !== 'monitor') return res.status(429).json({ error: 'Too many requests' });

    res.on('finish', () => {
      if (res.statusCode !== 404) return;
      const t = Date.now(), arr = (nf.get(ip) || []).filter((x) => t - x < 60000); arr.push(t); nf.set(ip, arr);
      if (nf.size > 20000) nf.clear();
      if (arr.length >= 15) {
        nf.delete(ip);
        report(req, ip, 'SCANNER_BEHAVIOR', 'HIGH', mode === 'monitor' ? 'MONITORED' : 'BLOCKED', '15+ unknown URLs in 60s');
        if (mode !== 'monitor') ban(ip, 30);
      }
    });

    let raw = req.originalUrl || req.url || '', dec = raw;
    try { dec = decodeURIComponent(raw); } catch (e) { /* keep raw */ }
    for (const rule of URL_RULES) {
      if (rule.re.test(raw) || rule.re.test(dec)) {
        report(req, ip, rule.id, 'HIGH', mode === 'monitor' ? 'MONITORED' : 'BLOCKED', rule.id);
        if (mode === 'monitor') return next();
        ban(ip, rule.ban);
        return deny(res);
      }
    }
    next();
  };
};
