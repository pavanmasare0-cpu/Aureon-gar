// security/depscan.js — "are any of my npm packages known to be vulnerable?"
// Uses the free OSV.dev database (no key). Reads the versions that are actually installed
// (node_modules/<pkg>/package.json), falling back to package.json ranges.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
let cache = null;

function listDeps() {
  let pkg; try { pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch (e) { return []; }
  const out = [];
  for (const [name, range] of Object.entries(pkg.dependencies || {})) {
    let v = null;
    try { v = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version; } catch (e) { /* not installed here */ }
    if (!v) { const m = String(range).match(/\d+\.\d+\.\d+/); v = m ? m[0] : null; }
    if (v) out.push({ name, version: v, declared: range });
  }
  return out;
}
async function post(url, body) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 15000);
  try { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: c.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); } finally { clearTimeout(t); }
}
async function getJson(url) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 10000);
  try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) return null; return await r.json(); } catch (e) { return null; } finally { clearTimeout(t); }
}
function severityOf(v) {
  const s = v && v.database_specific && v.database_specific.severity; if (s) return String(s).toUpperCase();
  const cvss = (v && v.severity || []).find((x) => /CVSS/.test(x.type)); return cvss ? 'CVSS' : 'UNKNOWN';
}
async function run(force) {
  if (!force && cache && Date.now() - cache.at < 12 * 3600 * 1000) return cache.result;
  const deps = listDeps();
  if (!deps.length) return { error: 'package.json nahi mila / koi dependency nahi', packages: 0, vulns: [] };
  try {
    const batch = await post('https://api.osv.dev/v1/querybatch', { queries: deps.map((d) => ({ package: { name: d.name, ecosystem: 'npm' }, version: d.version })) });
    const hit = [];
    (batch.results || []).forEach((r, i) => { if (r && r.vulns && r.vulns.length) hit.push({ dep: deps[i], ids: r.vulns.slice(0, 8).map((v) => v.id) }); });
    const vulns = [];
    for (const h of hit.slice(0, 15)) {
      const details = [];
      for (const id of h.ids.slice(0, 3)) { const d = await getJson('https://api.osv.dev/v1/vulns/' + encodeURIComponent(id)); if (d) details.push({ id, summary: String(d.summary || '').slice(0, 140), severity: severityOf(d) }); }
      const fixed = []; // not always available; keep it honest
      vulns.push({ name: h.dep.name, version: h.dep.version, count: h.ids.length, ids: h.ids, details, fixed });
    }
    const result = { at: new Date().toISOString(), packages: deps.length, vulnerable: hit.length, vulns, source: 'osv.dev', note: 'Sirf direct dependencies check hoti hain, aur sirf wo jo database mein report hui hain. Fix: npm update <pkg> / npm audit fix.' };
    cache = { at: Date.now(), result }; return result;
  } catch (e) { return { error: 'OSV se baat nahi ho payi: ' + String(e.message).slice(0, 60), packages: deps.length, vulns: [] }; }
}
module.exports = { run, listDeps };
