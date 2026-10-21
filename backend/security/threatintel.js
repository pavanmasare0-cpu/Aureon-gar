// security/threatintel.js — threat intelligence: public blocklists + your own IOCs.
//
//  * Feeds (downloaded every 6 h, parsed in memory): Spamhaus DROP (hijacked netblocks),
//    abuse.ch Feodo (botnet C2 IPs), abuse.ch URLhaus (malware domains). Tor exit list is off by
//    default (many legit people use Tor). Turn feeds on/off in the dashboard, or set
//    SECURITY_THREAT_FEEDS=off to disable all downloads.
//  * Manual IOCs: IPs / CIDRs, domains, file SHA-256 — with a note about why.
// Used by: the request guard (block known-bad IPs), the link scanner (known-bad domains),
// the file scanner (known-bad hashes) and the SOC (enrichment of every event).
const path = require('path');
const net = require('net');
const store = require('../persist');
const DATA_DIR = require('../data-dir').dataDir();
const FILE = path.join(DATA_DIR, 'threatintel.json');

const FEEDS = {
  'spamhaus-drop': { name: 'Spamhaus DROP (hijacked netblocks)', url: 'https://www.spamhaus.org/drop/drop.txt', kind: 'cidr', on: true },
  'feodo-c2': { name: 'abuse.ch Feodo (botnet C2 IPs)', url: 'https://feodotracker.abuse.ch/downloads/ipblocklist.txt', kind: 'ip', on: true },
  'urlhaus-domains': { name: 'abuse.ch URLhaus (malware domains)', url: 'https://urlhaus.abuse.ch/downloads/hostfile/', kind: 'host', on: true },
  'tor-exit': { name: 'Tor exit nodes', url: 'https://check.torproject.org/torbulkexitlist', kind: 'ip', on: false },
};
let state = { feeds: {}, iocs: { ips: [], domains: [], hashes: [] }, enabled: { 'spamhaus-drop': true, 'feodo-c2': true, 'urlhaus-domains': true, 'tor-exit': false } };
const cache = { ranges: [], ips: new Set(), domains: new Set(), manualRanges: [], manualIps: new Map(), manualDomains: new Map(), hashes: new Map() };

const ready = (async () => {
  await store.whenFirestore(20000);
  const r = await store.load('ti_state', FILE);
  if (r.value && typeof r.value === 'object') state = Object.assign(state, r.value, { enabled: Object.assign(state.enabled, r.value.enabled || {}) });
  rebuild();
})().catch((e) => console.error('[threatintel] load failed:', e.message));
let t; const saveSoon = () => { clearTimeout(t); t = setTimeout(() => ready.then(() => store.save('ti_state', state, FILE)).catch(() => {}), 1500); };

// ---------------------------------------------------------------- parsing + matching
const ip2n = (ip) => ip.split('.').reduce((a, o) => a * 256 + parseInt(o, 10), 0);
function cidrRange(c) {
  const [ip, bits] = String(c).trim().split('/');
  if (!net.isIPv4(ip)) return null;
  const b = bits === undefined ? 32 : parseInt(bits, 10);
  if (!(b >= 0 && b <= 32)) return null;
  const size = 2 ** (32 - b), start = Math.floor(ip2n(ip) / size) * size;
  return [start, start + size - 1];
}
function parseFeed(kind, text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/[;#].*$/, '').trim();
    if (!line) continue;
    if (kind === 'cidr') { const r = cidrRange(line.split(/\s+/)[0]); if (r) out.push(r); }
    else if (kind === 'ip') { const ip = line.split(/\s+/)[0]; if (net.isIP(ip)) out.push(ip); }
    else if (kind === 'host') { const p = line.split(/\s+/); const h = (p[1] || p[0]).toLowerCase(); if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) out.push(h); }
  }
  return out;
}
function mergeRanges(rs) {
  rs.sort((a, b) => a[0] - b[0]); const out = [];
  for (const r of rs) { const l = out[out.length - 1]; if (l && r[0] <= l[1] + 1) l[1] = Math.max(l[1], r[1]); else out.push([r[0], r[1]]); }
  return out;
}
function inRanges(rs, n) { let lo = 0, hi = rs.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (n < rs[m][0]) hi = m - 1; else if (n > rs[m][1]) lo = m + 1; else return true; } return false; }

function rebuild() {
  const ranges = [], ips = new Set(), domains = new Set();
  for (const [id, f] of Object.entries(state.feeds)) {
    if (!state.enabled[id] || !f.data) continue;
    if (FEEDS[id].kind === 'cidr') ranges.push(...f.data);
    else if (FEEDS[id].kind === 'ip') f.data.forEach((x) => ips.add(x));
    else f.data.forEach((x) => domains.add(x));
  }
  cache.ranges = mergeRanges(ranges); cache.ips = ips; cache.domains = domains;
  cache.manualRanges = []; cache.manualIps = new Map(); cache.manualDomains = new Map(); cache.hashes = new Map();
  for (const i of state.iocs.ips) { if (i.value.includes('/')) { const r = cidrRange(i.value); if (r) cache.manualRanges.push([r[0], r[1], i]); } else cache.manualIps.set(i.value, i); }
  for (const d of state.iocs.domains) cache.manualDomains.set(d.value, d);
  for (const h of state.iocs.hashes) cache.hashes.set(h.value, h);
}

// -> { list, note } | null
function matchIp(ip) {
  ip = String(ip || '').replace(/^::ffff:/, '');
  if (cache.manualIps.has(ip)) { const i = cache.manualIps.get(ip); return { list: 'your IOC list', note: i.note || '' }; }
  if (cache.ips.has(ip)) return { list: 'threat feed (botnet / bad IP)', note: '' };
  if (net.isIPv4(ip)) {
    const n = ip2n(ip);
    for (const r of cache.manualRanges) if (n >= r[0] && n <= r[1]) return { list: 'your IOC list', note: r[2].note || '' };
    if (inRanges(cache.ranges, n)) return { list: 'Spamhaus DROP (hijacked network)', note: '' };
  }
  return null;
}
function matchDomain(host) {
  const parts = String(host || '').toLowerCase().split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const d = parts.slice(i).join('.');
    if (cache.manualDomains.has(d)) return { list: 'your IOC list', note: cache.manualDomains.get(d).note || '', domain: d };
    if (cache.domains.has(d)) return { list: 'URLhaus malware-domain feed', note: '', domain: d };
  }
  return null;
}
const matchHash = (h) => { const i = cache.hashes.get(String(h || '').toLowerCase()); return i ? { list: 'your IOC list', note: i.note || '' } : null; };

// ---------------------------------------------------------------- feeds
async function refresh(id) {
  const f = FEEDS[id]; if (!f) return;
  const st = state.feeds[id] || (state.feeds[id] = {});
  try {
    const c = new AbortController(); const to = setTimeout(() => c.abort(), 20000);
    const r = await fetch(f.url, { signal: c.signal, headers: { 'User-Agent': 'aureon-security/1.0' } }); clearTimeout(to);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const txt = await r.text(); if (txt.length > 6 * 1024 * 1024) throw new Error('feed too large');
    const data = parseFeed(f.kind, txt);
    if (data.length < 3) throw new Error('feed looked empty — kept the old copy');
    st.data = f.kind === 'cidr' ? data : [...new Set(data)].slice(0, 60000); st.count = data.length; st.at = new Date().toISOString(); st.error = null;
  } catch (e) { st.error = String(e.message).slice(0, 80); st.failedAt = new Date().toISOString(); }
  rebuild(); saveSoon();
}
async function refreshAll(force) {
  await ready;
  if (String(process.env.SECURITY_THREAT_FEEDS || '').toLowerCase() === 'off') return;
  for (const id of Object.keys(FEEDS)) {
    const st = state.feeds[id];
    if (state.enabled[id] && (force || !st || !st.at || Date.now() - Date.parse(st.at) > 6 * 3600 * 1000)) await refresh(id);
  }
}
setTimeout(() => refreshAll(false).catch(() => {}), 30000).unref();
setInterval(() => refreshAll(false).catch(() => {}), 3600 * 1000).unref();

// ---------------------------------------------------------------- owner API helpers
function status() {
  return {
    feeds: Object.entries(FEEDS).map(([id, f]) => { const s = state.feeds[id] || {}; return { id, name: f.name, on: !!state.enabled[id], count: s.count || 0, at: s.at || null, error: s.error || null }; }),
    iocs: state.iocs, feedsDisabledByEnv: String(process.env.SECURITY_THREAT_FEEDS || '').toLowerCase() === 'off',
    totals: { ranges: cache.ranges.length, ips: cache.ips.size, domains: cache.domains.size },
  };
}
function setFeed(id, on) { if (!FEEDS[id]) throw new Error('unknown feed'); state.enabled[id] = !!on; rebuild(); saveSoon(); if (on) refresh(id).catch(() => {}); }
function addIoc(type, value, note, by) {
  value = String(value || '').trim().toLowerCase();
  if (type === 'ip') { const ok = net.isIP(value) || (value.includes('/') && cidrRange(value)); if (!ok) throw new Error('IP ya CIDR galat hai (jaise 203.0.113.0/24)'); }
  else if (type === 'domain') { if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) throw new Error('domain galat hai'); }
  else if (type === 'hash') { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('SHA-256 (64 hex) chahiye'); }
  else throw new Error('type: ip | domain | hash');
  const list = state.iocs[type === 'ip' ? 'ips' : type === 'domain' ? 'domains' : 'hashes'];
  if (list.length >= 2000) throw new Error('Max 2000 IOCs');
  if (list.some((x) => x.value === value)) throw new Error('pehle se list mein hai');
  list.push({ value, note: String(note || '').slice(0, 120), by: by || 'owner', at: new Date().toISOString() });
  rebuild(); saveSoon();
}
function removeIoc(type, value) {
  const key = type === 'ip' ? 'ips' : type === 'domain' ? 'domains' : 'hashes';
  const n = state.iocs[key].length; state.iocs[key] = state.iocs[key].filter((x) => x.value !== String(value).toLowerCase());
  rebuild(); saveSoon(); return state.iocs[key].length !== n;
}
const exportState = () => ({ iocs: state.iocs, enabled: state.enabled });
function importState(v) { if (v && v.iocs) state.iocs = { ips: v.iocs.ips || [], domains: v.iocs.domains || [], hashes: v.iocs.hashes || [] }; if (v && v.enabled) state.enabled = Object.assign(state.enabled, v.enabled); rebuild(); saveSoon(); }

module.exports = { matchIp, matchDomain, matchHash, status, setFeed, addIoc, removeIoc, refreshAll, exportState, importState, ready, _t: { parseFeed, cidrRange, rebuild, state: () => state, FEEDS, inRanges, mergeRanges } };
