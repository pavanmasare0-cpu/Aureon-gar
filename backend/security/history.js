// security/history.js — versioned configuration (change history + rollback).
// Every change to firewall rules / defense settings / IOC lists is snapshotted with who + when,
// so a bad change can be undone in one click ("Firewall policy rollback").
const crypto = require('crypto');
const path = require('path');
const store = require('../persist');
const FILE = path.join(require('../data-dir').dataDir(), 'cfg-history.json');
let h = {};                      // ns -> [{ id, t, by, note, value }]   (newest last)
const PER_NS = 15, MAX_BYTES = 700000;
const ready = (async () => { await store.whenFirestore(20000); const r = await store.load('cfg_history', FILE); if (r.value && typeof r.value === 'object') h = r.value; })().catch(() => {});
let timer; const saveSoon = () => { clearTimeout(timer); timer = setTimeout(() => ready.then(() => store.save('cfg_history', h, FILE)).catch(() => {}), 1500); };
function snapshot(ns, value, by, note) {
  const list = h[ns] || (h[ns] = []);
  list.push({ id: crypto.randomBytes(4).toString('hex'), t: new Date().toISOString(), by: by || 'owner', note: String(note || '').slice(0, 120), value: JSON.parse(JSON.stringify(value)) });
  while (list.length > PER_NS) list.shift();
  while (JSON.stringify(h).length > MAX_BYTES) { const k = Object.keys(h).sort((a, b) => (h[b].length - h[a].length))[0]; if (!h[k] || h[k].length <= 1) break; h[k].shift(); }
  saveSoon();
}
const list = (ns) => (h[ns] || []).map((x) => ({ id: x.id, t: x.t, by: x.by, note: x.note })).reverse();
const get = (ns, id) => { const x = (h[ns] || []).find((e) => e.id === id); return x ? JSON.parse(JSON.stringify(x.value)) : null; };
module.exports = { snapshot, list, get, ready };
