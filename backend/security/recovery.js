// security/recovery.js — backup, restore drill, and "what changed" for Aureon's security configuration.
//
// A backup bundle is plain JSON signed with HMAC-SHA256 (key derived from SENTINEL_ENC_KEY /
// SENTINEL_OWNER_CODE). Secrets inside are never plain text: tokens are already AES-encrypted,
// access codes / device keys are stored as hashes, the 2FA secret is NOT included.
// Restore refuses a bundle whose signature does not verify (tampered or made with another key).
// Suggested targets for a small deployment: RPO 24 h (take a backup daily), RTO 15 min.
const crypto = require('crypto');

const KEYS = ['sec_settings', 'fw_rules', 'ti_state', 'sec_github', 'sec_devices', 'ep_agents', 'dash_ops', 'dash_auth', 'servers', 'soc'];
function signKey() { const s = process.env.SENTINEL_ENC_KEY || process.env.SENTINEL_OWNER_CODE; return s ? crypto.createHash('sha256').update('aureon-backup|' + s).digest() : null; }
const canon = (o) => JSON.stringify(o);
const sign = (payload) => crypto.createHmac('sha256', signKey()).update(canon(payload)).digest('hex');

// providers: { key: () => value }  (each module hands over its live in-memory state)
async function exportBundle(by, providers) {
  if (!signKey()) throw new Error('SENTINEL_OWNER_CODE / SENTINEL_ENC_KEY set hona chahiye');
  const data = {};
  for (const k of KEYS) { if (providers && providers[k]) { const v = await providers[k](); if (v !== null && v !== undefined) data[k] = JSON.parse(JSON.stringify(v)); } }   // deep copy: sign exactly what is exported
  const payload = { app: 'aureon', version: 1, createdAt: new Date().toISOString(), createdBy: by, keys: Object.keys(data), data };
  return Object.assign({}, payload, { signature: sign(payload) });
}
// dry-run: signature + shape + counts. This is the "restore drill" — run it regularly.
function verifyBundle(b) {
  const out = { ok: false, problems: [], counts: {} };
  if (!b || typeof b !== 'object' || b.app !== 'aureon' || !b.data || !b.signature) { out.problems.push('Ye Aureon backup file nahi lagti'); return out; }
  if (!signKey()) { out.problems.push('Is server par SENTINEL_OWNER_CODE / SENTINEL_ENC_KEY nahi hai'); return out; }
  const { signature, ...payload } = b;
  let good = false; try { const a = Buffer.from(sign(payload), 'hex'), c = Buffer.from(String(signature), 'hex'); good = a.length === c.length && crypto.timingSafeEqual(a, c); } catch (e) { good = false; }
  if (!good) { out.problems.push('Signature match nahi hua — file badli gayi hai ya doosri key se bani hai'); return out; }
  for (const [k, v] of Object.entries(b.data)) { if (!KEYS.includes(k)) out.problems.push('anjaan section: ' + k); out.counts[k] = Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : 1); }
  out.createdAt = b.createdAt; out.createdBy = b.createdBy; out.ok = out.problems.length === 0; return out;
}
// appliers: { key: async (value) => void } — each module validates + persists its own state
async function importBundle(b, appliers) {
  const v = verifyBundle(b); if (!v.ok) throw new Error(v.problems.join('; '));
  const done = [], skipped = [];
  for (const [k, val] of Object.entries(b.data)) {
    if (!KEYS.includes(k) || !appliers || !appliers[k]) { skipped.push(k); continue; }
    await appliers[k](val); done.push(k);
  }
  return { restored: done, skipped, note: 'Restore ho gaya. Sentinel servers wagairah ke liye agar kuch purana dikhe to service restart karo (Render → Manual Deploy → Restart).' };
}
module.exports = { exportBundle, verifyBundle, importBundle, KEYS };
