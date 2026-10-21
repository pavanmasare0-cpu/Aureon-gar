// security/firewall.js — application firewall policy (ordered rules, first match wins).
//
//   allow     — skip the attack checks for this traffic (rate-limits still apply)
//   deny      — block with 403
//   throttle  — allow, but at most N requests / 10 s per client for this rule
//
// Scope: this filters traffic reaching the Aureon backend. It is NOT a network/host firewall:
// for the Windows PC itself use the Windows Endpoint Agent (endpoint.js), which manages the real
// Windows Firewall through its supported PowerShell/NetFirewall interface, with approval + rollback.
// Safety: the dashboards (/api/security, /api/sentinel) can never be locked out by a rule,
// private/loopback addresses are never filtered, and a rule that would match your own IP is refused.
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const store = require('../persist');
const history = require('./history');
const FILE = path.join(require('../data-dir').dataDir(), 'firewall.json');

let rules = [];
const ready = (async () => { await store.whenFirestore(20000); const r = await store.load('fw_rules', FILE); if (Array.isArray(r.value)) rules = r.value; })().catch(() => {});
let timer; const saveSoon = () => { clearTimeout(timer); timer = setTimeout(() => ready.then(() => store.save('fw_rules', rules, FILE)).catch(() => {}), 1000); };

const ip2n = (ip) => ip.split('.').reduce((a, o) => a * 256 + parseInt(o, 10), 0);
function srcRange(src) {
  if (src.kind !== 'cidr') return null;
  const [ip, bits] = src.value.split('/'); const b = parseInt(bits, 10), size = 2 ** (32 - b), start = Math.floor(ip2n(ip) / size) * size;
  return [start, start + size - 1];
}
function srcMatches(src, ip) {
  if (!src || src.kind === 'any') return true;
  if (src.kind === 'ip') return src.value === ip;
  if (src.kind === 'cidr' && net.isIPv4(ip)) { const r = srcRange(src), n = ip2n(ip); return n >= r[0] && n <= r[1]; }
  return false;
}
function validate(r) {
  const out = { name: String(r.name || '').trim().slice(0, 60), enabled: r.enabled !== false, action: r.action, path: String(r.path || '/').trim(), methods: Array.isArray(r.methods) ? r.methods.map((m) => String(m).toUpperCase()) : [], comment: String(r.comment || '').slice(0, 120), throttleMax: undefined, expiresAt: r.expiresAt || null };
  if (out.name.length < 2) throw new Error('Rule ka naam 2+ akshar ka rakho');
  if (!['allow', 'deny', 'throttle'].includes(out.action)) throw new Error('action: allow | deny | throttle');
  if (!/^\/[\w\-./~%]*$/.test(out.path)) throw new Error('path "/" se shuru hona chahiye (jaise /api/admin)');
  if (out.methods.some((m) => !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(m))) throw new Error('methods galat hain');
  const s = r.src || { kind: 'any' };
  if (s.kind === 'any') out.src = { kind: 'any' };
  else if (s.kind === 'ip') { if (!net.isIP(String(s.value))) throw new Error('IP galat hai'); out.src = { kind: 'ip', value: String(s.value) }; }
  else if (s.kind === 'cidr') { const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(s.value)); if (!m || !net.isIPv4(m[1]) || +m[2] > 32) throw new Error('CIDR galat hai (jaise 203.0.113.0/24)'); if (+m[2] < 8) throw new Error('/8 se bada range allowed nahi (galti se sab block na ho)'); out.src = { kind: 'cidr', value: s.value }; }
  else throw new Error('source: any | ip | cidr');
  if (out.action === 'throttle') { out.throttleMax = Math.min(Math.max(parseInt(r.throttleMax, 10) || 10, 1), 1000); }
  if (out.expiresAt && !Number.isFinite(Date.parse(out.expiresAt))) throw new Error('expiresAt galat');
  return out;
}

function add(r, by, ownerIp) {
  if (rules.length >= 100) throw new Error('Max 100 rules');
  const v = validate(r);
  if (v.action !== 'allow' && v.path === '/' && ownerIp && srcMatches(v.src, ownerIp)) throw new Error('Ye rule poori site par tumhare apne IP ko bhi block karega — refuse (khud ko bahar karne se bachane ke liye)');
  const rule = Object.assign({ id: crypto.randomBytes(4).toString('hex'), createdAt: new Date().toISOString(), createdBy: by || 'owner', hits: 0, lastHit: null }, v);
  rules.push(rule); history.snapshot('firewall', rules, by, 'add: ' + rule.name); saveSoon(); return rule;
}
function update(id, patch, by, ownerIp) {
  const i = rules.findIndex((x) => x.id === id); if (i < 0) throw new Error('rule nahi mila');
  const merged = validate(Object.assign({}, rules[i], patch));
  if (merged.enabled && merged.action !== 'allow' && merged.path === '/' && ownerIp && srcMatches(merged.src, ownerIp)) throw new Error('Ye rule poori site par tumhare apne IP ko bhi block karega — refuse');
  rules[i] = Object.assign(rules[i], merged); history.snapshot('firewall', rules, by, 'edit: ' + rules[i].name); saveSoon(); return rules[i];
}
function remove(id, by) { const r = rules.find((x) => x.id === id); if (!r) return false; rules = rules.filter((x) => x.id !== id); history.snapshot('firewall', rules, by, 'remove: ' + r.name); saveSoon(); return true; }
function move(id, dir, by) { const i = rules.findIndex((x) => x.id === id); const j = i + (dir === 'up' ? -1 : 1); if (i < 0 || j < 0 || j >= rules.length) return false; [rules[i], rules[j]] = [rules[j], rules[i]]; history.snapshot('firewall', rules, by, 'reorder'); saveSoon(); return true; }
function rollback(versionId, by) { const v = history.get('firewall', versionId); if (!v || !Array.isArray(v)) return false; rules = v; history.snapshot('firewall', rules, by, 'rollback to ' + versionId); saveSoon(); return true; }
const list = () => rules.map((r) => Object.assign({}, r));
const exportState = () => rules;
function importState(v) { if (Array.isArray(v)) { rules = v.slice(0, 100); saveSoon(); } }

// ---- enforcement (called by the request guard) ----
const buckets = new Map();
function check(req, ip) {
  if (!rules.length) return null;
  const p = req.path || '/', now = Date.now();
  if (p.startsWith('/api/security') || p.startsWith('/api/sentinel')) return null;
  for (const r of rules) {
    if (!r.enabled) continue;
    if (r.expiresAt && Date.parse(r.expiresAt) < now) continue;
    if (!p.startsWith(r.path)) continue;
    if (r.methods.length && !r.methods.includes(req.method)) continue;
    if (!srcMatches(r.src, ip)) continue;
    r.hits = (r.hits || 0) + 1; r.lastHit = new Date(now).toISOString(); saveSoon();
    if (r.action === 'throttle') {
      const k = r.id + '|' + ip; let b = buckets.get(k);
      if (!b || now - b.t > 10000) { b = { t: now, n: 0 }; buckets.set(k, b); if (buckets.size > 10000) buckets.clear(); }
      if (++b.n > r.throttleMax) return { action: 'deny', rule: r, throttled: true };
      return { action: 'allow', rule: r };
    }
    return { action: r.action, rule: r };
  }
  return null;
}
module.exports = { add, update, remove, move, rollback, list, check, exportState, importState, ready, _t: { srcMatches, validate, reset: () => { rules = []; } } };
