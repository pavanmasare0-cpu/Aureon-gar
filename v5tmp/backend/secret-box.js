// backend/secret-box.js — AES-256-GCM encryption for tokens stored at rest.
// Key comes from SENTINEL_ENC_KEY (preferred) or SENTINEL_OWNER_CODE.
const crypto = require('crypto');
function key() {
  const s = process.env.SENTINEL_ENC_KEY || process.env.SENTINEL_OWNER_CODE;
  return s ? crypto.createHash('sha256').update(s).digest() : null;
}
function available() { return !!key(); }
function encrypt(text) {
  const k = key(); if (!k) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return 'v1:' + [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join(':');
}
function decrypt(str) {
  try {
    const k = key(); if (!k || !str || !str.startsWith('v1:')) return null;
    const [iv, tag, enc] = str.slice(3).split(':').map((x) => Buffer.from(x, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', k, iv); d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch (e) { return null; }
}
module.exports = { available, encrypt, decrypt };
