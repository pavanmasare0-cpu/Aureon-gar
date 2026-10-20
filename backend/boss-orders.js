// backend/boss-orders.js — Boss Orders: the owner's priority order queue (from boss-failover-proxy, merged into Aureon).
//
// Mounted by sentinel-dashboard.js at /api/sentinel/boss  (behind the owner login: apiGate, + fresh 2FA for writes).
//
// What "Aureon never refuses the owner" means here (honest version):
//  * An order from the owner is ALWAYS accepted and tracked (HTTP 202 + orderId). No per-minute rate limit, no queue-full refusal
//    (until 2000 open orders), and it survives restarts: orders left "running" by a crash go back to "queued" on boot.
//  * Boss orders run before normal ones. Temporary failures (timeouts, 5xx, 429) are retried with backoff (Retry-After respected)
//    up to BOSS_MAX_ATTEMPTS, and a failed order can be retried again by hand — nothing is silently dropped.
//  * It does NOT bypass someone else's "no": a provider's 403 is recorded as "blocked" and reported, 429 waits for the provider's
//    retry window, keys are rotated only on 401 (a bad key) among keys YOU configured. Private/loopback/metadata hosts are never called.
//
// ENV (all optional):
//   BOSS_ALLOWED_HOSTS   comma list of hostnames. If set, ONLY these hosts can be called. If empty, any public https host works.
//   BOSS_API_KEYS        comma list of provider keys issued to you. Sent (Authorization: Bearer + x-api-key) ONLY to BOSS_ALLOWED_HOSTS hosts.
//   BOSS_MAX_ATTEMPTS    default 5      BOSS_TIMEOUT_MS  default 30000
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');
const express = require('express');

const MAX_OPEN = 2000;
const KEEP = 500;
const RESULT_CAP = 20000;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const iso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- keys (rotation on 401 only)
class KeyPool {
  constructor(keys) { this.items = [...new Set(keys)].map((key) => ({ key, cooldownUntil: 0, failed: 0 })); this.i = -1; }
  size() { return this.items.length; }
  next(skip) {
    const now = Date.now();
    const usable = this.items.filter((k) => !skip.has(k.key));
    if (!usable.length) return null;
    const ok = usable.filter((k) => k.cooldownUntil <= now);
    const pool = ok.length ? ok : usable;
    this.i = (this.i + 1) % pool.length;
    return pool[this.i].key;
  }
  bad(key) { const k = this.items.find((x) => x.key === key); if (k) { k.failed++; k.cooldownUntil = Date.now() + Math.min(300000 * k.failed, 900000); } }
  good(key) { const k = this.items.find((x) => x.key === key); if (k) { k.failed = 0; k.cooldownUntil = 0; } }
  status() { const now = Date.now(); return this.items.map((k) => ({ key: k.key.length < 9 ? '***' : k.key.slice(0, 4) + '…' + k.key.slice(-4), active: k.cooldownUntil <= now, failed: k.failed })); }
}

// ---------------------------------------------------------------- host safety (SSRF): never call private / loopback / metadata
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === '::1' || s === '::' || s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true;
    const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); return m ? privateIp(m[1]) : false;
  }
  return true;
}
async function assertPublicHost(host) {
  if (net.isIP(host)) { if (privateIp(host)) throw Object.assign(new Error('private/loopback address allowed nahi'), { code: 'HOST_PRIVATE' }); return; }
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw Object.assign(new Error('local hostname allowed nahi'), { code: 'HOST_PRIVATE' });
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw Object.assign(new Error('host private network par resolve hota hai — block'), { code: 'HOST_PRIVATE' });
}

module.exports = function createBossOrders({ auth, DATA_DIR, logEvent }) {
  const router = express.Router();
  const json = express.json({ limit: '512kb' });
  const FILE = path.join(DATA_DIR, 'boss-orders.json');
  const allowedHosts = list(process.env.BOSS_ALLOWED_HOSTS).map((h) => h.toLowerCase());
  const keys = new KeyPool(list(process.env.BOSS_API_KEYS));
  const maxAttempts = Math.max(1, Math.min(Number(process.env.BOSS_MAX_ATTEMPTS || 5), 20));
  const timeoutMs = Math.max(2000, Math.min(Number(process.env.BOSS_TIMEOUT_MS || 30000), 120000));

  let orders = [];
  try { const d = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (Array.isArray(d)) orders = d; } catch (e) { /* first run */ }
  for (const o of orders) if (o.status === 'running') { o.status = 'queued'; o.lastError = 'server restart ke baad dobara queue me'; }
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); const t = FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(orders), { mode: 0o600 }); fs.renameSync(t, FILE); } catch (e) { /* read-only disk: memory only */ }
    }, 150);
  }
  function trim() {
    const done = orders.filter((o) => !['queued', 'running'].includes(o.status));
    if (done.length > KEEP) { const drop = new Set(done.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, done.length - KEEP).map((o) => o.id)); orders = orders.filter((o) => !drop.has(o.id)); }
  }

  function validateTarget(raw) {
    let u; try { u = new URL(String(raw)); } catch (e) { throw new Error('targetUrl sahi URL nahi hai'); }
    if (u.protocol !== 'https:') throw new Error('sirf https URL chalta hai');
    if (u.username || u.password) throw new Error('URL me username/password mat daalo');
    const host = u.hostname.toLowerCase();
    if (allowedHosts.length && !allowedHosts.includes(host)) throw new Error('ye host BOSS_ALLOWED_HOSTS me nahi hai');
    return u.toString();
  }

  // ---------------------------------------------------------------- one network attempt; throws an Error with retryable/blocked/code (+retryAfterMs)
  async function attempt(order) {
    const u = new URL(order.targetUrl);
    await assertPublicHost(u.hostname);
    const keyed = allowedHosts.includes(u.hostname.toLowerCase()) && keys.size() > 0; // keys never go to arbitrary hosts
    const tried = new Set();
    for (;;) {
      const key = keyed ? keys.next(tried) : null;
      if (keyed && !key) throw Object.assign(new Error('Saari configured keys 401 se reject hui — keys check karo'), { code: 'ALL_KEYS_UNAUTHORIZED', retryable: false });
      if (key) tried.add(key);
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/plain;q=0.8, */*;q=0.5', 'user-agent': 'Aureon-Boss/1' };
      if (key) { headers.authorization = 'Bearer ' + key; headers['x-api-key'] = key; }
      let r;
      try {
        r = await fetch(order.targetUrl, {
          method: order.method, headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
          body: order.method === 'GET' || order.payload === undefined || order.payload === null ? undefined : JSON.stringify(order.payload),
        });
      } catch (e) {
        throw Object.assign(new Error('Network failure: ' + String((e && (e.cause && e.cause.code || e.name)) || 'unknown')), { code: 'NETWORK', retryable: true });
      }
      const s = r.status;
      if (s >= 200 && s < 300) {
        if (key) keys.good(key);
        let text = ''; try { text = await r.text(); } catch (e) { /* empty */ }
        let data = text; try { data = JSON.parse(text); } catch (e) { /* plain text */ }
        const out = typeof data === 'string' ? data : JSON.stringify(data);
        return { status: s, truncated: out.length > RESULT_CAP, data: out.length > RESULT_CAP ? out.slice(0, RESULT_CAP) : data };
      }
      if (s === 401 && key) { keys.bad(key); continue; }           // a bad key -> try the next configured one
      if (s === 403) throw Object.assign(new Error('Provider ne 403 diya (permission/policy). Ye "blocked" mark hua — Aureon ise bypass nahi karta; provider me permission check karo.'), { code: 'PROVIDER_DENIED', blocked: true, retryable: false });
      if (s === 429) { const ra = Number(r.headers.get('retry-after')); throw Object.assign(new Error('Provider rate limit (429) — retry window ka intezaar'), { code: 'RATE_LIMITED', retryable: true, retryAfterMs: ra > 0 ? Math.min(ra * 1000, 120000) : 0 }); }
      if ([408, 425, 500, 502, 503, 504].includes(s)) throw Object.assign(new Error('Provider temporary failure (HTTP ' + s + ')'), { code: 'UPSTREAM_TRANSIENT', retryable: true });
      throw Object.assign(new Error('Provider ne HTTP ' + s + ' diya'), { code: 'UPSTREAM_' + s, retryable: false });
    }
  }

  // ---------------------------------------------------------------- worker: boss first, then oldest normal
  let working = false;
  const nextOrder = () => orders.filter((o) => o.status === 'queued' && (!o.notBefore || o.notBefore <= Date.now()))
    .sort((a, b) => (a.priority === b.priority ? a.createdAt.localeCompare(b.createdAt) : a.priority === 'boss' ? -1 : 1))[0] || null;
  async function work() {
    if (working) return; working = true;
    try {
      for (;;) {
        const o = nextOrder();
        if (!o) {
          const wait = orders.filter((x) => x.status === 'queued' && x.notBefore).map((x) => x.notBefore - Date.now());
          if (wait.length) { setTimeout(() => work().catch(() => {}), Math.max(250, Math.min(...wait)) + 50); }
          break;
        }
        o.status = 'running'; o.attempts++; o.updatedAt = iso(); o.lastError = null; save();
        try {
          o.result = await attempt(o); o.status = 'succeeded'; o.errorCode = null; o.notBefore = 0;
        } catch (e) {
          o.errorCode = e.code || 'FAILED'; o.lastError = String(e.message || 'failed').slice(0, 400);
          if (e.blocked) o.status = 'blocked';
          else if (e.retryable && o.attempts < maxAttempts) { o.status = 'queued'; o.notBefore = Date.now() + Math.max(e.retryAfterMs || 0, Math.min(1000 * 2 ** (o.attempts - 1), 30000)); }
          else o.status = 'failed';
        }
        o.updatedAt = iso(); save();
        if (['failed', 'blocked'].includes(o.status) && logEvent) { try { logEvent('proposal', { name: 'Boss' }, 'Boss order "' + o.orderName + '" ' + o.status + ': ' + o.lastError); } catch (e) { /* ignore */ } }
      }
    } finally { working = false; trim(); save(); }
  }
  setTimeout(() => work().catch(() => {}), 3000); // resume anything left queued after a restart

  const pub = (o) => { const { targetUrl, payload, ...r } = o; let host = ''; try { host = new URL(targetUrl).host; } catch (e) { /* ignore */ } return { ...r, targetHost: host, hasPayload: payload !== undefined && payload !== null }; };

  // ---------------------------------------------------------------- routes
  router.get('/status', (req, res) => {
    const c = {}; for (const o of orders) c[o.status] = (c[o.status] || 0) + 1;
    res.json({ counts: c, total: orders.length, keys: keys.status(), allowedHosts, openLimit: MAX_OPEN, maxAttempts });
  });
  router.get('/orders', (req, res) => res.json({ orders: orders.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map(pub) }));
  router.get('/orders/:id', (req, res) => { const o = orders.find((x) => x.id === req.params.id); return o ? res.json(pub(o)) : res.status(404).json({ error: 'order nahi mila' }); });

  router.post('/orders', json, (req, res) => {
    if (!auth.stepUp(req, res)) return;
    const b = req.body || {};
    let target; try { target = validateTarget(b.targetUrl); } catch (e) { return res.status(400).json({ error: e.message }); }
    const method = String(b.method || 'POST').toUpperCase();
    if (!METHODS.includes(method)) return res.status(400).json({ error: 'method galat' });
    const priority = b.priority === 'normal' ? 'normal' : 'boss';
    if (orders.filter((o) => ['queued', 'running'].includes(o.status)).length >= MAX_OPEN) return res.status(503).json({ error: 'queue bahut bhari (' + MAX_OPEN + ' open orders) — kuch complete hone do' });
    auth.action(req, 'boss order ' + method);
    const o = { id: crypto.randomUUID(), orderName: String(b.orderName || 'Boss order').slice(0, 120), targetUrl: target, method, payload: b.payload, priority, status: 'queued', attempts: 0, errorCode: null, lastError: null, result: null, notBefore: 0, createdAt: iso(), updatedAt: iso() };
    orders.push(o); save(); work().catch(() => {});
    res.status(202).json({ accepted: true, orderId: o.id, priority, status: o.status });
  });
  router.post('/orders/:id/retry', (req, res) => {
    if (!auth.stepUp(req, res)) return;
    const o = orders.find((x) => x.id === req.params.id); if (!o) return res.status(404).json({ error: 'order nahi mila' });
    if (['queued', 'running', 'succeeded'].includes(o.status)) return res.status(400).json({ error: 'order ' + o.status + ' hai — retry nahi chahiye' });
    o.status = 'queued'; o.attempts = 0; o.notBefore = 0; o.lastError = null; o.updatedAt = iso(); save(); work().catch(() => {});
    res.json({ ok: true, status: o.status });
  });
  router.post('/orders/:id/cancel', (req, res) => {
    if (!auth.stepUp(req, res)) return;
    const o = orders.find((x) => x.id === req.params.id); if (!o) return res.status(404).json({ error: 'order nahi mila' });
    if (o.status !== 'queued') return res.status(400).json({ error: 'sirf queued order cancel hota hai' });
    o.status = 'failed'; o.errorCode = 'CANCELLED'; o.lastError = 'owner ne cancel kiya'; o.updatedAt = iso(); save(); res.json({ ok: true });
  });

  return { router };
};
