// backend/dash-auth.js — the lock on the Sentinel + Security dashboards.
//
// Layers (all on by default except 2FA, which you switch on in the dashboard):
//  1. STEALTH     — anyone without a valid session gets the same 404 an unknown URL gets,
//                   so scanners cannot even tell the dashboards exist.
//  2. OWNER CODE  — only accepted via ?code= ONCE; it is exchanged for a session and the
//                   code disappears from the URL (no more codes in browser history / logs).
//  3. 2FA (TOTP)  — Google Authenticator / any TOTP app. Optional "step-up": ask for a fresh
//                   code again before approving fixes, blocking IPs, changing settings.
//  4. SESSIONS    — random server-side id in an HttpOnly + Secure + SameSite=Lax cookie,
//                   30 min idle / 8 h max, bound to your browser's User-Agent. Revocable.
//  5. LOCKOUTS    — 5 wrong tries => IP banned 30 min; 25 wrong tries from ANYONE in 10 min
//                   => no new logins for 15 min (stops distributed guessing).
//  6. IP ALLOW-LIST (optional), AUDIT LOG, new-device alert e-mail, strict security headers.
//  7. ROLES (RBAC)  — owner = admin. You can add operators with their own access codes:
//                   viewer (read only) / analyst (read + triage + scans + block IP) / admin.
//  8. TAMPER-EVIDENT AUDIT — every audit entry is hash-chained to the previous one; a deleted or
//                   edited entry breaks the chain and the dashboard shows it.
//  9. RISK-BASED RE-AUTH — if a session suddenly appears from a different network, every
//                   state-changing action needs a fresh 2FA code again.
// Recovery if you lose your phone: set DASH_TOTP_DISABLE=1 on Render, log in, set up 2FA again.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const store = require('./persist');
const box = require('./secret-box');
const { THEME_TAGS } = require('./theme-tags');   // optional theme layer (wraps ui-theme.js when present)

const DATA_DIR = require('./data-dir').dataDir();
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* read-only disk is fine */ }
const CFG_FILE = path.join(DATA_DIR, 'dash-auth.json');
const AUDIT_FILE = path.join(DATA_DIR, 'dash-audit.json');
const OPS_FILE = path.join(DATA_DIR, 'dash-ops.json');
const COOKIE = 'aureon_sid';
const MAX_SESSION_MS = 8 * 3600 * 1000;

let cfg = { totp: { secretEnc: null, pendingSecretEnc: null, enabled: false, lastCounter: 0, enrolledAt: null }, stealth: false, stepUp: false, allowIps: [], idleMin: 30, knownUa: [] };
let audit = [];
let ops = [];                // operators: { id, name, role, salt, hash, createdAt, lastLogin, disabled }
const ROLE_RANK = { viewer: 1, analyst: 2, admin: 3 };
let hooks = { blockIp() { return false; }, record() {}, alert() {} };
const sessions = new Map();     // sid -> { iat, last, uaHash, ip }
const pendings = new Map();     // token -> { ip, t, tries }
const fails = new Map();        // ip -> { n, t }
let globalFails = [];
let globalLockUntil = 0;

const ready = (async () => {
  await store.whenFirestore(20000);
  const c = await store.load('dash_auth', CFG_FILE);
  if (c.value && typeof c.value === 'object') cfg = Object.assign(cfg, c.value, { totp: Object.assign(cfg.totp, c.value.totp || {}) });
  cfg.stealth = false;   // stealth removed: login page hamesha dikhega (404 nahi)
  const a = await store.load('dash_audit', AUDIT_FILE);
  if (Array.isArray(a.value)) audit = a.value.slice(-300);
  const o = await store.load('dash_ops', OPS_FILE);
  if (Array.isArray(o.value)) ops = o.value;
})().catch((e) => console.error('[dash-auth] hydrate failed:', e.message));

function saveOps() { ready.then(() => store.save('dash_ops', ops, OPS_FILE)).catch(() => {}); }
function saveCfg() { ready.then(() => store.save('dash_auth', cfg, CFG_FILE)).catch(() => {}); }
let auditTimer = null;
function saveAudit() { if (auditTimer) return; auditTimer = setTimeout(() => { auditTimer = null; ready.then(() => store.save('dash_audit', audit, AUDIT_FILE)).catch(() => {}); }, 2000); }

function init(h) { hooks = Object.assign(hooks, h); }

// ------------------------------------------------------------ helpers
const ipOf = (req) => String(req.ip || (req.connection && req.connection.remoteAddress) || '').replace(/^::ffff:/, '');
const isPrivate = (ip) => !ip || ip === '::1' || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|fc|fd|fe80)/i.test(ip);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const uaHash = (req) => sha(req.headers['user-agent'] || '').toString('hex').slice(0, 16);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function cookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
const isSecure = (req) => req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
const chainHash = (prev, e) => crypto.createHash('sha256').update(prev + '|' + [e.t, e.ip, e.ua, e.event, e.detail, e.who || ''].join('|')).digest('hex').slice(0, 32);
function log(req, event, detail) {
  const e = { t: new Date().toISOString(), ip: ipOf(req), ua: String(req.headers['user-agent'] || '').slice(0, 90), event, detail: String(detail || '').slice(0, 160), who: (req.auth && req.auth.name) || '' };
  e.prev = audit.length ? audit[audit.length - 1].h : 'genesis';
  e.h = chainHash(e.prev, e);
  audit.push(e);
  if (audit.length > 300) audit.shift();
  saveAudit();
}
// walks the retained entries; any edited / removed / re-ordered entry breaks the chain
function verifyAudit() {
  for (let i = 0; i < audit.length; i++) {
    const e = audit[i];
    if (!e.h) continue;                                   // entries from before the chain existed
    if (i > 0 && audit[i - 1].h && e.prev !== audit[i - 1].h) return { ok: false, brokenAt: i, at: e.t, why: 'link broken (entry removed or re-ordered)' };
    if (chainHash(e.prev, e) !== e.h) return { ok: false, brokenAt: i, at: e.t, why: 'entry content was modified' };
  }
  return { ok: true, entries: audit.length };
}
const normCode = (v) => String(v == null ? '' : v).trim().replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, '').trim();   // phone keyboards / Render env often add spaces, newlines or quotes
function codeOk(code) {
  const configured = normCode(process.env.SENTINEL_OWNER_CODE);
  return !!configured && typeof code === 'string' && crypto.timingSafeEqual(sha(normCode(code)), sha(configured));
}

function opHash(code, salt) { return crypto.scryptSync(String(code), salt, 32).toString('hex'); }
// -> { role, name, opId } | null
function identify(code) {
  if (typeof code !== 'string' || !code) return null;
  if (codeOk(code)) return { role: 'admin', name: 'owner', opId: null };
  for (const o of ops) {
    if (o.disabled) continue;
    const a = Buffer.from(opHash(code, o.salt), 'hex'), b = Buffer.from(o.hash, 'hex');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return { role: o.role, name: o.name, opId: o.id };
  }
  return null;
}

// ------------------------------------------------------------ TOTP (RFC 6238, SHA-1, 6 digits, 30 s)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32enc(buf) { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; }
function b32dec(s) { let bits = ''; for (const c of String(s).replace(/=+$/, '').toUpperCase()) { const v = B32.indexOf(c); if (v < 0) return null; bits += v.toString(2).padStart(5, '0'); } const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); }
function hotp(secret, counter, digits) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % (10 ** (digits || 6));
  return String(code).padStart(digits || 6, '0');
}
// returns the matched counter (for replay protection) or null
function totpMatch(secretB32, token, now) {
  const secret = b32dec(secretB32); const t = String(token || '').replace(/\s/g, '');
  if (!secret || !/^\d{6}$/.test(t)) return null;
  const c0 = Math.floor((now || Date.now()) / 30000);
  for (let d = -1; d <= 1; d++) if (crypto.timingSafeEqual(Buffer.from(hotp(secret, c0 + d)), Buffer.from(t))) return c0 + d;
  return null;
}
const totpOn = () => cfg.totp.enabled && process.env.DASH_TOTP_DISABLE !== '1';
const totpSecret = () => (cfg.totp.secretEnc ? box.decrypt(cfg.totp.secretEnc) : null);
function totpCheck(token) {   // verifies AND burns the code (no replay)
  const s = totpSecret(); if (!s) return false;
  const c = totpMatch(s, token);
  if (c === null || c <= cfg.totp.lastCounter) return false;
  cfg.totp.lastCounter = c; saveCfg(); return true;
}

// ------------------------------------------------------------ failures / lockouts
function registerFailure(req, what) {
  const ip = ipOf(req), now = Date.now();
  const f = fails.get(ip) || { n: 0, t: now };
  if (now - f.t > 10 * 60 * 1000) { f.n = 0; f.t = now; }
  f.n++; fails.set(ip, f);
  log(req, 'login_fail', what);
  globalFails = globalFails.filter((t) => now - t < 10 * 60 * 1000); globalFails.push(now);
  if (f.n >= 3) hooks.record({ app: 'dashboard', ip, method: req.method, path: req.baseUrl + req.path, rule: 'DASH_LOGIN_FAILED', severity: 'MEDIUM', action: 'FLAGGED', detail: `${f.n} failed ${what} attempts` });
  if (f.n >= 5) { fails.delete(ip); hooks.blockIp(ip, 30, 'DASH_LOGIN_BRUTEFORCE', 'auto'); log(req, 'ip_banned', '5 failed attempts'); }
  if (globalFails.length >= 25 && now > globalLockUntil) {
    globalLockUntil = now + 15 * 60 * 1000;
    hooks.alert('Aureon Security: dashboard par bahut galat login attempts', `10 minute mein ${globalFails.length} galat attempts (alag alag IP se bhi). Naye logins 15 minute ke liye band hain; pehle se logged-in session chalte rahenge.`);
  }
}

// ------------------------------------------------------------ sessions
function createSession(req, res, who) {
  who = who || { role: 'admin', name: 'owner', opId: null };
  const sid = crypto.randomBytes(32).toString('base64url');
  const now = Date.now(), ua = uaHash(req);
  sessions.set(sid, { iat: now, last: now, uaHash: ua, ip: ipOf(req), role: who.role, name: who.name, opId: who.opId, riskIp: false });
  req.auth = { name: who.name };
  if (sessions.size > 200) { for (const [k, v] of sessions) if (now - v.last > cfg.idleMin * 60000) sessions.delete(k); }
  res.append('Set-Cookie', `${COOKIE}=${sid}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=${MAX_SESSION_MS / 1000}${isSecure(req) ? '; Secure' : ''}`);
  log(req, 'login_ok', `${who.name} (${who.role})` + (totpOn() && who.role === 'admin' ? ' · code + 2FA' : ''));
  if (who.opId) { const o = ops.find((x) => x.id === who.opId); if (o) { o.lastLogin = new Date().toISOString(); saveOps(); } }
  if (cfg.knownUa.length && !cfg.knownUa.includes(ua)) hooks.record({ app: 'dashboard', ip: ipOf(req), method: 'LOGIN', path: '/dashboard', rule: 'DASH_NEW_DEVICE', severity: 'MEDIUM', action: 'ALERT', detail: `login from a new browser/device by ${who.name}` });
  if (cfg.knownUa.length && !cfg.knownUa.includes(ua)) hooks.alert('Aureon Security: naye device se dashboard login', `IP ${ipOf(req)}\n${String(req.headers['user-agent'] || '').slice(0, 120)}\n${new Date().toISOString()}\n\nAgar ye tum nahi ho: dashboard → Dashboard access → "Saare sessions band karo", aur SENTINEL_OWNER_CODE badal do.`);
  if (!cfg.knownUa.includes(ua)) { cfg.knownUa = cfg.knownUa.concat(ua).slice(-20); saveCfg(); }
  return sid;
}
function sessionOf(req) {
  const sid = cookies(req)[COOKIE]; if (!sid) return { present: false };
  const s = sessions.get(sid), now = Date.now();
  if (!s || now - s.last > cfg.idleMin * 60000 || now - s.iat > MAX_SESSION_MS || s.uaHash !== uaHash(req)) { sessions.delete(sid); return { present: true, valid: false }; }
  s.last = now;
  const net = (ip) => (ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip.split('.').slice(0, 3).join('.'));
  if (!s.riskIp && net(ipOf(req)) !== net(s.ip) && !(isPrivate(ipOf(req)) && isPrivate(s.ip))) {   // session suddenly used from another network
    s.riskIp = true; log(req, 'session_ip_changed', `${s.ip} -> ${ipOf(req)}`);
    hooks.record({ app: 'dashboard', ip: ipOf(req), method: req.method, path: req.originalUrl || '', rule: 'DASH_SESSION_IP_CHANGED', severity: 'MEDIUM', action: 'ALERT', detail: `session of ${s.name} moved from ${s.ip} to ${ipOf(req)} — fresh 2FA now required for changes` });
  }
  return { present: true, valid: true, sid, role: s.role, name: s.name };
}

// ------------------------------------------------------------ authenticate
function ipAllowed(req) {
  if (!cfg.allowIps.length) return true;
  const ip = ipOf(req); return isPrivate(ip) || cfg.allowIps.includes(ip);
}
// -> { ok, via, expired }
function authenticate(req) {
  if (!process.env.SENTINEL_OWNER_CODE) return { ok: false, reason: 'no-owner-code' };
  if (!ipAllowed(req)) return { ok: false, reason: 'ip' };
  const s = sessionOf(req);
  if (s.valid) return { ok: true, via: 'session', sid: s.sid, role: s.role, name: s.name };
  const hdr = req.header('x-owner-code');
  if (hdr) {   // legacy / scripts
    if (!codeOk(hdr)) { registerFailure(req, 'owner code (header)'); return { ok: false, reason: 'bad-code' }; }
    if (!totpOn()) return { ok: true, via: 'header', role: 'admin', name: 'owner' };
    if (totpCheck(req.header('x-totp'))) return { ok: true, via: 'header+totp', role: 'admin', name: 'owner' };
    registerFailure(req, '2FA code (header)'); return { ok: false, reason: 'need-totp' };
  }
  return { ok: false, reason: s.present ? 'expired' : 'none' };
}

// ------------------------------------------------------------ responses
function shieldHeaders(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'");
  next();
}
function notFound(req, res) {   // identical to Express' own answer for an unknown URL
  res.status(404).type('html').send(`<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot ${esc(req.method)} ${esc((req.originalUrl || req.url || '').split('?')[0])}</pre>\n</body>\n</html>\n`);
}
function pageShell(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0d;color:#eee;font-family:-apple-system,sans-serif}
.box{background:#15151b;border:1px solid #24242e;border-radius:12px;padding:28px;width:90%;max-width:330px;text-align:center}
h1{color:#d4af37;font-size:18px;margin:0 0 14px}p{color:#9a9aa8;font-size:13px;margin:0 0 14px}input{width:100%;box-sizing:border-box;background:#101014;border:1px solid #24242e;color:#eee;padding:12px;border-radius:8px;font-size:18px;letter-spacing:4px;text-align:center;margin-bottom:12px}
button{width:100%;background:#d4af37;color:#141414;border:none;border-radius:8px;padding:11px;font-weight:600;font-size:14px;cursor:pointer}.err{color:#ff6b6b;font-size:12px;min-height:16px;margin-bottom:8px}</style>${THEME_TAGS}</head><body><div class="box">${body}</div></body></html>`;
}
function totpPage(pending, next) {
  return pageShell('Aureon — 2FA', `<h1>🔐 2-Step check</h1><p>Authenticator app ka 6-digit code daalo.</p>
<input id="c" inputmode="numeric" maxlength="6" autocomplete="one-time-code" autofocus><div class="err" id="e"></div><button id="b">Verify</button>
<script>var P=${JSON.stringify(pending)},N=${JSON.stringify(next).replace(/</g, '\\u003c')};
document.getElementById('b').onclick=async function(){var r=await fetch('/api/security/auth/verify',{method:'POST',headers:{'Content-Type':'application/json','x-csrf':'1'},body:JSON.stringify({pending:P,totp:document.getElementById('c').value})});var j=await r.json().catch(function(){return{}});if(r.ok&&j.ok){location.replace(N);}else{document.getElementById('e').textContent=j.error||'Galat code';}};
document.getElementById('c').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('b').click();});</script>`);
}
function loginPage(next) {
  return pageShell('Aureon — Login', `<h1>🔐 Aureon Security</h1><p>Owner code daalo.</p>
<input id="c" type="password" style="letter-spacing:1px" autofocus><div class="err" id="e"></div><button id="b">Unlock</button>
<script>var N=${JSON.stringify(next).replace(/</g, '\\u003c')};
document.getElementById('b').onclick=async function(){var r=await fetch('/api/security/auth/login',{method:'POST',headers:{'Content-Type':'application/json','x-csrf':'1'},body:JSON.stringify({code:document.getElementById('c').value})});var j=await r.json().catch(function(){return{}});
if(r.ok&&j.ok){location.replace(N);}else if(r.ok&&j.needTotp){document.body.innerHTML='';location.replace(N+(N.indexOf('?')<0?'?':'&')+'p='+encodeURIComponent(j.pending));}else{document.getElementById('e').textContent=j.error||'Galat code';}};
document.getElementById('c').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('b').click();});</script>`);
}
const cleanNext = (req) => {
  const keep = req.query && typeof req.query.theme === 'string' && /^[a-z]{3,10}$/.test(req.query.theme) ? '?theme=' + req.query.theme : '';
  return (req.baseUrl || '') + (req.path || '') + keep;
};
function newPending(req) {
  const token = crypto.randomBytes(24).toString('base64url');
  pendings.set(token, { ip: ipOf(req), t: Date.now(), tries: 0 });
  if (pendings.size > 100) for (const [k, v] of pendings) if (Date.now() - v.t > 300000) pendings.delete(k);
  return token;
}

// the dashboard HTML pages call this; render() is only called for an authenticated owner
function dashboard(req, res, render) {
  shieldHeaders(req, res, () => {});
  const a = authenticate(req);
  if (a.ok) return render(a);
  if (a.reason === 'no-owner-code') return res.status(503).type('html').send(pageShell('Setup', '<h1>Setup baaki hai</h1><p>Render → Environment mein <b>SENTINEL_OWNER_CODE</b> set karo, phir dobara kholo.</p>'));
  if (a.reason === 'ip') { log(req, 'blocked_ip', 'not in allow-list'); return notFound(req, res); }
  const next = cleanNext(req);
  const code = req.query && req.query.code;
  if (typeof code === 'string' && code) {
    if (Date.now() < globalLockUntil) { log(req, 'locked', 'global lockout'); return notFound(req, res); }
    const who = identify(code);
    if (!who) { registerFailure(req, 'access code'); return cfg.stealth ? notFound(req, res) : res.type('html').send(loginPage(next)); }
    if (who.role !== 'admin' || !totpOn()) { createSession(req, res, who); return res.redirect(302, next); }
    return res.type('html').send(totpPage(newPending(req), next));
  }
  if (typeof req.query.p === 'string' && pendings.has(req.query.p)) return res.type('html').send(totpPage(req.query.p, next));
  if (cfg.stealth) return notFound(req, res);
  return res.type('html').send(loginPage(next));
}

// JSON API gate
function apiGate(req, res, next) {
  shieldHeaders(req, res, () => {});
  const a = authenticate(req);
  if (a.ok) {
    if (a.via === 'session' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.header('x-csrf')) return res.status(403).json({ error: 'csrf header missing' });
    req.auth = a; return next();
  }
  if (a.reason === 'expired') return res.status(401).json({ error: 'session expired — dashboard link dobara kholo' });
  if (a.reason === 'need-totp') return res.status(403).json({ error: '2FA code chahiye', needTotp: true });
  if (cfg.stealth || a.reason === 'ip') return notFound(req, res);
  return res.status(401).json({ error: 'login required' });
}

// extra "are you really you?" for dangerous actions (approve fix, block IP, change settings)
const STEP_UP_GRACE_MS = 5 * 60 * 1000;   // after one good code, further sensitive actions in the same session pass for 5 min (a code can only be used once)
// force=true: used for changes that WEAKEN protection (turn off step-up/stealth, IP list, 2FA setup) — always ask when 2FA is on
function stepUp(req, res, force) {
  if (!totpOn()) return true;
  const sess = req.auth && req.auth.sid ? sessions.get(req.auth.sid) : null;
  const risky = !!(sess && sess.riskIp);                // session moved to another network -> always ask again
  if (!cfg.stepUp && !risky && !force) return true;
  if (!risky && sess && sess.stepUpUntil && sess.stepUpUntil > Date.now()) return true;
  if (totpCheck(req.header('x-totp'))) {
    if (sess && !risky) sess.stepUpUntil = Date.now() + STEP_UP_GRACE_MS;
    log(req, 'step_up_ok', req.method + ' ' + (req.originalUrl || '').split('?')[0]); return true;
  }
  res.status(403).json({ error: '2FA code chahiye', needTotp: true });
  return false;
}
function action(req, what) {
  log(req, 'action', what);
  try { if (global.__brain) global.__brain.record(0, 'Owner action: ' + String(what || ''), { kind: 'action' }); } catch (e) { /* brain is optional */ }
  hooks.record({ app: 'dashboard', ip: ipOf(req), method: req.method, path: (req.originalUrl || '').split('?')[0], rule: 'DASH_SENSITIVE_ACTION', severity: 'LOW', action: 'ALERT', detail: `${(req.auth && req.auth.name) || 'owner'}: ${what}`.slice(0, 200) });
}

// ------------------------------------------------------------ roles
// requireRole('analyst') -> middleware; must run AFTER apiGate (it needs req.auth.role)
function requireRole(min) {
  return function roleGuard(req, res, next) {
    const have = (req.auth && req.auth.role) || 'viewer';
    if ((ROLE_RANK[have] || 0) >= ROLE_RANK[min]) return next();
    log(req, 'role_denied', `${have} tried ${req.method} ${(req.originalUrl || '').split('?')[0]} (needs ${min})`);
    hooks.record({ app: 'dashboard', ip: ipOf(req), method: req.method, path: (req.originalUrl || '').split('?')[0], rule: 'DASH_PRIVILEGE_DENIED', severity: 'MEDIUM', action: 'FLAGGED', detail: `${have} tried an action that needs ${min}` });
    return res.status(403).json({ error: `Is kaam ke liye "${min}" role chahiye (tumhara role: ${have})`, role: have, needRole: min });
  };
}

// ------------------------------------------------------------ auth endpoints (mounted at /api/security/auth)
const router = express.Router();
router.use(shieldHeaders);
router.post('/login', (req, res) => {
  if (!process.env.SENTINEL_OWNER_CODE) return res.status(503).json({ error: 'owner code not configured' });
  if (Date.now() < globalLockUntil) return res.status(429).json({ error: 'abhi login band hai, kuch der baad try karo' });
  if (!ipAllowed(req)) return notFound(req, res);
  const who = identify(req.body && req.body.code);
  if (!who) { registerFailure(req, 'access code'); return res.status(401).json({ error: 'Galat code' }); }
  if (who.role !== 'admin' || !totpOn()) { createSession(req, res, who); return res.json({ ok: true, role: who.role }); }
  res.json({ ok: false, needTotp: true, pending: newPending(req) });
});
router.post('/verify', (req, res) => {
  const p = pendings.get(req.body && req.body.pending);
  if (!p || Date.now() - p.t > 300000 || p.ip !== ipOf(req)) return res.status(401).json({ error: 'Time out — link dobara kholo' });
  if (++p.tries > 5) { pendings.delete(req.body.pending); return res.status(429).json({ error: 'bahut galat try' }); }
  if (!totpCheck(req.body.totp)) { registerFailure(req, '2FA code'); return res.status(401).json({ error: 'Galat code' }); }
  pendings.delete(req.body.pending); createSession(req, res); res.json({ ok: true });
});
router.post('/logout', (req, res) => {
  const sid = cookies(req)[COOKIE]; if (sid) sessions.delete(sid);
  log(req, 'logout', ''); res.append('Set-Cookie', `${COOKIE}=; Path=/api; HttpOnly; SameSite=Lax; Max-Age=0`); res.json({ ok: true });
});

router.use(apiGate);
router.get('/status', (req, res) => res.json({
  totpEnabled: totpOn(), totpConfigured: !!cfg.totp.enabled, stealth: cfg.stealth, stepUp: cfg.stepUp, allowIps: cfg.allowIps, idleMin: cfg.idleMin,
  role: req.auth.role, name: req.auth.name, operators: ops.length, auditChain: verifyAudit(),
  sessions: sessions.size, yourIp: ipOf(req), globalLock: Date.now() < globalLockUntil, via: req.auth.via, recoveryMode: process.env.DASH_TOTP_DISABLE === '1',
}));
router.get('/audit', requireRole('analyst'), (req, res) => res.json(audit.slice(-100).reverse().map(({ prev, ...e }) => e)));
router.get('/audit/verify', requireRole('analyst'), (req, res) => res.json(verifyAudit()));
const NAME_OK = /^[\w .@-]{2,40}$/;
router.get('/operators', requireRole('admin'), (req, res) => res.json(ops.map((o) => ({ id: o.id, name: o.name, role: o.role, createdAt: o.createdAt, lastLogin: o.lastLogin, disabled: !!o.disabled }))));
router.post('/operators', requireRole('admin'), (req, res) => {
  if (!stepUp(req, res)) return;
  const b = req.body || {};
  if (!NAME_OK.test(String(b.name || ''))) return res.status(400).json({ error: 'Naam 2-40 akshar (letters, number, space, . _ - @)' });
  if (!['viewer', 'analyst'].includes(b.role)) return res.status(400).json({ error: 'role: viewer ya analyst (admin sirf owner hai)' });
  if (ops.length >= 10) return res.status(400).json({ error: 'Max 10 operators' });
  const code = 'op_' + crypto.randomBytes(15).toString('base64url');
  const salt = crypto.randomBytes(16).toString('hex');
  const o = { id: crypto.randomBytes(5).toString('hex'), name: String(b.name), role: b.role, salt, hash: opHash(code, salt), createdAt: new Date().toISOString(), lastLogin: null, disabled: false };
  ops.push(o); saveOps(); action(req, `operator created: ${o.name} (${o.role})`);
  res.json({ id: o.id, name: o.name, role: o.role, code });          // shown ONCE; only a scrypt hash is stored
});
router.post('/operators/:id/:what', requireRole('admin'), (req, res) => {
  if (!stepUp(req, res)) return;
  const o = ops.find((x) => x.id === req.params.id); if (!o) return res.status(404).json({ error: 'not found' });
  if (req.params.what === 'disable') o.disabled = true; else if (req.params.what === 'enable') o.disabled = false; else return res.status(400).json({ error: 'disable | enable' });
  for (const [k, v] of sessions) if (v.opId === o.id) sessions.delete(k);
  saveOps(); action(req, `operator ${req.params.what}: ${o.name}`); res.json({ ok: true });
});
router.delete('/operators/:id', requireRole('admin'), (req, res) => {
  if (!stepUp(req, res)) return;
  const o = ops.find((x) => x.id === req.params.id); if (!o) return res.status(404).json({ error: 'not found' });
  ops = ops.filter((x) => x.id !== o.id); for (const [k, v] of sessions) if (v.opId === o.id) sessions.delete(k);
  saveOps(); action(req, `operator removed: ${o.name}`); res.json({ ok: true });
});
router.post('/totp/start', requireRole('admin'), (req, res) => {
  if (!stepUp(req, res, true)) return;
  if (!box.available()) return res.status(400).json({ error: 'SENTINEL_OWNER_CODE / SENTINEL_ENC_KEY set hona chahiye' });
  const secret = b32enc(crypto.randomBytes(20));
  cfg.totp.pendingSecretEnc = box.encrypt(secret); saveCfg();
  res.json({ secret, otpauth: `otpauth://totp/Aureon%20Security:owner?secret=${secret}&issuer=Aureon%20Security&digits=6&period=30` });
});
router.post('/totp/confirm', requireRole('admin'), (req, res) => {
  const pend = cfg.totp.pendingSecretEnc && box.decrypt(cfg.totp.pendingSecretEnc);
  if (!pend) return res.status(400).json({ error: 'pehle Setup 2FA dabao' });
  const c = totpMatch(pend, req.body && req.body.token);
  if (c === null) return res.status(400).json({ error: 'Code match nahi hua — app mein abhi ka code daalo' });
  cfg.totp = { secretEnc: cfg.totp.pendingSecretEnc, pendingSecretEnc: null, enabled: true, lastCounter: c, enrolledAt: new Date().toISOString() }; saveCfg();
  log(req, 'totp_enabled', ''); res.json({ ok: true });
});
router.post('/totp/disable', requireRole('admin'), (req, res) => {
  if (!totpCheck(req.body && req.body.token)) { registerFailure(req, '2FA disable'); return res.status(400).json({ error: 'Galat 2FA code' }); }
  cfg.totp = { secretEnc: null, pendingSecretEnc: null, enabled: false, lastCounter: 0, enrolledAt: null }; cfg.stepUp = false; saveCfg();
  log(req, 'totp_disabled', ''); res.json({ ok: true });
});
router.post('/settings', requireRole('admin'), (req, res) => {
  if (!stepUp(req, res, true)) return;
  const b = req.body || {};
  /* stealth removed */
  if (typeof b.stepUp === 'boolean') { if (b.stepUp && !totpOn()) return res.status(400).json({ error: 'Step-up ke liye pehle 2FA on karo' }); cfg.stepUp = b.stepUp; }
  if (b.idleMin !== undefined) cfg.idleMin = Math.min(Math.max(parseInt(b.idleMin, 10) || 30, 5), 240);
  if (Array.isArray(b.allowIps)) {
    const list = b.allowIps.map((x) => String(x).trim()).filter((x) => /^[0-9a-f:.]{3,45}$/i.test(x)).slice(0, 20);
    if (list.length && !list.includes(ipOf(req)) && !isPrivate(ipOf(req))) return res.status(400).json({ error: `Apna current IP (${ipOf(req)}) list mein daalo, warna tum khud bahar ho jaoge` });
    cfg.allowIps = list;
  }
  saveCfg(); log(req, 'settings_changed', JSON.stringify(Object.keys(b))); res.json({ ok: true });
});
router.post('/sessions/revoke', requireRole('admin'), (req, res) => {
  const keep = req.auth && req.auth.sid; for (const k of [...sessions.keys()]) if (k !== keep) sessions.delete(k);
  log(req, 'sessions_revoked', ''); res.json({ ok: true });
});

const exportOps = () => ops;
function importOps(v) { if (Array.isArray(v)) { ops = v.slice(0, 10); saveOps(); } }
const exportCfg = () => ({ stealth: cfg.stealth, stepUp: cfg.stepUp, allowIps: cfg.allowIps, idleMin: cfg.idleMin });   // never the 2FA secret
function importCfg(v) { if (!v || typeof v !== 'object') return;  if (typeof v.stepUp === 'boolean' && totpOn()) cfg.stepUp = v.stepUp; if (Number.isFinite(v.idleMin)) cfg.idleMin = Math.min(Math.max(v.idleMin, 5), 240); if (Array.isArray(v.allowIps)) cfg.allowIps = v.allowIps.slice(0, 20); saveCfg(); }
module.exports = { exportOps, importOps, exportCfg, importCfg, init, router, dashboard, apiGate, stepUp, action, requireRole, verifyAudit, shieldHeaders, authenticate, notFound, ready, _t: { totpMatch, hotp, b32enc, b32dec, cfg: () => cfg, sessions, codeOk, ops: () => ops, audit: () => audit } };
