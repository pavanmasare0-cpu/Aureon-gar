// backend/brain-log.js — Aureon's ever-growing brain log.
// Every important thing the backend learns or does becomes one "neuron" (append-only; nothing is trimmed from Firestore).
// Regions match the brain page: 0 Soch · 1 Tark · 2 Yaad · 3 Dar · 4 Bhavna · 5 Drishti · 6 Sapne.
// Stored in Firestore: collection `aureon_brain` (one small doc per event) + `aureon_brain_meta/totals` (true totals, forever).
// Other modules never import this file: they call global.__brain.record(...) / recordFor(uid, ...) and nothing breaks if it is missing.
// Privacy: recordFor() only keeps events of the OWNER account. Text is short and never contains chat messages.
const REGIONS = 7;
const COL = 'aureon_brain', META = 'aureon_brain_meta';

module.exports = function createBrainLog({ getDb, admin, ringSize = 1500 }) {
  const ring = [];                       // newest events kept in memory (for the brain page)
  let totals = new Array(REGIONS).fill(0);
  let storedTotals = new Array(REGIONS).fill(0), pending = [], timer = null, loaded = false, flushing = false;
  const ownerCache = new Map();           // uid -> { v, at }
  const db = () => { try { return getDb(); } catch (e) { return null; } };
  // Keys, tokens and passwords never become a neuron.
  const SECRET_RES = [/AIza[0-9A-Za-z_\-]{30,}/g, /\bsk-[A-Za-z0-9_\-]{16,}/g, /\bgsk_[A-Za-z0-9]{16,}/g, /\bgh[pousr]_[A-Za-z0-9]{20,}/g, /\bxox[abp]-[A-Za-z0-9\-]{10,}/g, /\bAKIA[0-9A-Z]{16}\b/g,
    /eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}/g, /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    /\bBearer\s+[A-Za-z0-9._\-]{16,}/gi, /\b(?:api[_-]?key|secret|passwd|password|pwd|token|otp|pin)\s*[:=]\s*\S+/gi, /\b[A-Fa-f0-9]{40,}\b/g, /\b[A-Za-z0-9+\/_-]{40,}={0,2}(?=\s|$)/g];
  const redact = (s) => SECRET_RES.reduce((t, re) => t.replace(re, '[hidden]'), String(s == null ? '' : s));
  const clean = (s, n) => redact(s).replace(/\s+/g, ' ').trim().slice(0, n);

  function record(region, text, meta) {
    const r = Math.max(0, Math.min(REGIONS - 1, Number(region) | 0));
    const t = clean(text, 160); if (!t) return null;
    const ts = Date.now();
    const ev = { id: ts.toString(36) + Math.random().toString(36).slice(2, 6), r, t, ts, meta: meta && typeof meta === 'object' ? meta : undefined };
    ring.push(ev); if (ring.length > ringSize) ring.shift();
    totals[r]++; pending.push(ev); schedule();
    return ev;
  }
  const onceAt = new Map();
  function recordOnce(key, minutes, region, text, meta) {   // same key at most once per N minutes (e.g. a provider that keeps failing)
    const last = onceAt.get(key) || 0; if (Date.now() - last < minutes * 60 * 1000) return null;
    onceAt.set(key, Date.now()); return record(region, text, meta);
  }
  async function isOwner(uid) {
    if (!uid) return false;
    const c = ownerCache.get(uid); if (c && Date.now() - c.at < 5 * 60 * 1000) return c.v;
    let v = false;
    try { const d = db(); if (d) { const doc = await d.collection('users').doc(uid).collection('profile').doc('owner').get(); v = !!(doc.exists && doc.data() && doc.data().isOwner); } } catch (e) { /* unknown = not owner */ }
    ownerCache.set(uid, { v, at: Date.now() });
    return v;
  }
  async function recordFor(uid, region, text, meta) { if (await isOwner(uid)) return record(region, text, meta); return null; }

  function schedule() { if (timer) return; timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, 3000); if (timer.unref) timer.unref(); }
  async function flush() {
    const d = db(); if (!d || flushing || !pending.length) return;
    flushing = true;
    const batchEvents = pending.splice(0, 400);
    try {
      const batch = d.batch();
      const inc = new Array(REGIONS).fill(0);
      batchEvents.forEach((ev) => { inc[ev.r]++; const o = { r: ev.r, t: ev.t, ts: ev.ts }; if (ev.meta) o.meta = ev.meta; batch.set(d.collection(COL).doc(ev.id), o); });
      const FV = admin && admin.firestore && admin.firestore.FieldValue;
      const upd = { updatedAt: Date.now() }; inc.forEach((n, i) => { if (n) upd['c' + i] = FV ? FV.increment(n) : n; });
      batch.set(d.collection(META).doc('totals'), upd, { merge: true });
      await batch.commit();
      inc.forEach((n, i) => { storedTotals[i] += n; });
    } catch (e) { pending.unshift(...batchEvents); }   // try again next time
    flushing = false;
    if (pending.length) schedule();
  }
  async function load() {                // after a redeploy: pull the true totals and the newest events back in
    const d = db(); if (!d) return false;
    try {
      const tdoc = await d.collection(META).doc('totals').get();
      const t = tdoc.exists ? tdoc.data() : {};
      const fromDb = new Array(REGIONS).fill(0).map((_, i) => Number(t['c' + i]) || 0);
      const localNew = totals.slice();                       // events recorded before load finished
      storedTotals = fromDb.slice();
      totals = fromDb.map((n, i) => n + localNew[i]);
      const snap = await d.collection(COL).orderBy('ts', 'desc').limit(ringSize).get();
      const have = new Set(ring.map((e) => e.id));
      const old = snap.docs.map((x) => ({ id: x.id, ...x.data() })).filter((e) => !have.has(e.id)).sort((a, b) => a.ts - b.ts);
      ring.unshift(...old); while (ring.length > ringSize) ring.shift();
      loaded = true; return true;
    } catch (e) { return false; }
  }
  // For the brain page: true totals per region + the newest events (the page itself draws the newest 90 per region).
  function snapshot() {
    return { counts: totals.slice(), total: totals.reduce((a, b) => a + b, 0), items: ring.slice().sort((a, b) => b.ts - a.ts).map((e) => ({ id: 'b' + e.id, r: e.r, t: e.t, ts: e.ts })), loaded };
  }
  return { record, recordOnce, recordFor, redact, flush, load, snapshot, isOwner, _t: { ring, get pending() { return pending; }, get totals() { return totals; } } };
};
