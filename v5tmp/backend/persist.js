// backend/persist.js
//
// Tiny persistence helper shared by Sentinel and the Security module.
// Render's free tier wipes the disk on every deploy, so everything is stored
// in Firestore (already used by Aureon) and mirrored to a local JSON file as
// a fallback. If Firestore isn't configured it silently falls back to files
// only — nothing else changes.
const fs = require('fs');
const zlib = require('zlib');
let admin = null;
try { admin = require('firebase-admin'); } catch (e) { /* optional */ }

const COLLECTION = 'aureon_persist';

function db() {
  try { return admin && admin.apps && admin.apps.length ? admin.firestore() : null; }
  catch (e) { return null; }
}

// server.js initialises firebase-admin AFTER our modules are required, so
// wait (briefly) for it. If no service account is configured, don't wait.
function whenFirestore(timeoutMs) {
  return new Promise((resolve) => {
    if (db()) return resolve(true);
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) return resolve(false);
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (db()) { clearInterval(iv); resolve(true); }
      else if (Date.now() - t0 > (timeoutMs || 20000)) { clearInterval(iv); resolve(false); }
    }, 300);
  });
}

function pack(value) {
  const s = JSON.stringify(value);
  if (s.length > 150000) return { gz: true, data: zlib.gzipSync(s).toString('base64') };
  return { gz: false, data: s };
}
function unpack(d) {
  return JSON.parse(d.gz ? zlib.gunzipSync(Buffer.from(d.data, 'base64')).toString('utf8') : d.data);
}

function readFile(file) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; }
  catch (e) { return null; }
}

// -> { value, source: 'firestore' | 'file' | 'none' }
async function load(key, file) {
  const d = db();
  if (d) {
    try {
      const snap = await d.collection(COLLECTION).doc(key).get();
      if (snap.exists) return { value: unpack(snap.data()), source: 'firestore' };
    } catch (e) { console.error('[persist] firestore load failed for', key, e.message); }
  }
  const v = file ? readFile(file) : null;
  return v === null ? { value: null, source: 'none' } : { value: v, source: 'file' };
}

async function save(key, value, file) {
  if (file) {
    try { fs.writeFileSync(file, JSON.stringify(value, null, 2)); } catch (e) { /* read-only disk is fine */ }
  }
  const d = db();
  if (!d) return false;
  try {
    const packed = pack(value);
    if (packed.data.length > 950000) {
      console.error('[persist] value for', key, 'too large for one Firestore doc — kept in local file only');
      return false;
    }
    await d.collection(COLLECTION).doc(key).set({ ...packed, updatedAt: new Date().toISOString() });
    return true;
  } catch (e) {
    console.error('[persist] firestore save failed for', key, e.message);
    return false;
  }
}

module.exports = { whenFirestore, load, save, db };
