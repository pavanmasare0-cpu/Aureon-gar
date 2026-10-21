// backend/data-dir.js — one place that decides where local fallback files live.
// AUREON_DATA_DIR lets tests (and Docker volumes) point somewhere else; default is unchanged.
const path = require('path');
const fs = require('fs');
function dataDir(sub) {
  const base = process.env.AUREON_DATA_DIR || path.join(__dirname, 'security-data');
  const dir = sub ? path.join(base, sub) : base;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* read-only disk is fine, Firestore is the real store */ }
  return dir;
}
module.exports = { dataDir };
