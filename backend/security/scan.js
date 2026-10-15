// security/scan.js — "security posture" check. Looks at configuration and the
// source tree of THIS backend only. It never prints a secret value — only the
// file, line number and the kind of secret.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const SECRET_PATTERNS = [
  { name: 'GitHub token', re: /\b(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/ },
  { name: 'Groq / OpenAI-style API key', re: /\b(gsk_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{30,})/ },
  { name: 'Resend API key', re: /\bre_[A-Za-z0-9]{20,}/ },
  { name: 'Private key block', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
];

function listJs(dir, depth, out) {
  if (depth > 2) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.') || e.name.endsWith('-data')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listJs(p, depth + 1, out);
    else if (/\.(js|json|env)$/.test(e.name) && !/package(-lock)?\.json$/.test(e.name)) out.push(p);
  }
  return out;
}

function semverLt(v, min) {
  const a = String(v).replace(/[^\d.]/g, '').split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) < b[i]) return true; if ((a[i] || 0) > b[i]) return false; }
  return false;
}

function runScan(app, mode) {
  const f = [];
  const add = (severity, title, detail, fix) => f.push({ severity, title, detail, fix: fix || '' });

  // --- configuration ---
  const code = process.env.SENTINEL_OWNER_CODE;
  if (!code) add('HIGH', 'Owner code not set', 'Sentinel / Security dashboards are not protected.', 'Render → Environment → SENTINEL_OWNER_CODE=<long random value>');
  else if (code.length < 10) add('MEDIUM', 'Owner code is short', `Only ${code.length} characters — easy to guess.`, 'Use 16+ random characters.');

  if (mode === 'off') add('HIGH', 'Security guard is OFF', 'SECURITY_MODE=off — no requests are inspected.', 'Remove SECURITY_MODE or set it to protect.');
  else if (mode === 'monitor') add('INFO', 'Monitor-only mode', 'Attacks are logged but never blocked.', 'Set SECURITY_MODE=protect once you are happy with the incident log.');

  if (!process.env.FIREBASE_SERVICE_ACCOUNT) add('MEDIUM', 'Firestore not configured', 'Sentinel/Security data is lost on every Render deploy.', 'Set FIREBASE_SERVICE_ACCOUNT on Render.');
  if (!process.env.RESEND_API_KEY || !process.env.ALERT_EMAIL_TO) add('LOW', 'Email alerts not configured', 'You will not be emailed about attacks.', 'Set RESEND_API_KEY and ALERT_EMAIL_TO.');

  const gh = process.env.GITHUB_TOKEN || '';
  if (gh.startsWith('ghp_')) add('MEDIUM', 'Classic GitHub token in use', 'Classic tokens are not limited to one repo.', 'Switch to a fine-grained token (github_pat_…), single repo, Contents: read & write.');
  if (!process.env.SENTINEL_ENC_KEY && process.env.GITHUB_TOKEN === undefined) { /* nothing */ }
  else if (!process.env.SENTINEL_ENC_KEY) add('LOW', 'SENTINEL_ENC_KEY not set', 'Per-repo GitHub tokens are encrypted with the owner code; changing the owner code would make them unreadable.', 'Set a separate SENTINEL_ENC_KEY.');

  try {
    if (!app || !app.get('trust proxy')) add('MEDIUM', 'trust proxy not enabled', 'Client IPs may be wrong behind Render’s proxy, weakening rate-limits and blocking.', "app.set('trust proxy', 1) in server.js");
  } catch (e) { /* ignore */ }

  // --- dependencies ---
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.express && semverLt(deps.express, '4.19.2')) add('MEDIUM', 'Express is outdated', `package.json asks for express ${deps.express}; older 4.x releases have known security fixes.`, 'npm i express@latest (4.x) and redeploy.');
    if (!deps.helmet) add('LOW', 'No helmet middleware', 'Standard security headers are not set.', 'npm i helmet and app.use(helmet()).');
  } catch (e) { add('LOW', 'Could not read package.json', e.message); }

  // --- hard-coded secrets ---
  let filesScanned = 0;
  for (const file of listJs(ROOT, 0, [])) {
    let text = '';
    try { if (fs.statSync(file).size > 2 * 1024 * 1024) continue; text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
    filesScanned++;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const p of SECRET_PATTERNS) {
        if (p.re.test(lines[i])) add('HIGH', `Possible ${p.name} in source`, `${path.relative(ROOT, file)} line ${i + 1} (value hidden).`, 'Move it to a Render environment variable and rotate the key.');
      }
    }
  }

  const counts = { HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  f.forEach((x) => { counts[x.severity] = (counts[x.severity] || 0) + 1; });
  return { scannedAt: new Date().toISOString(), filesScanned, counts, findings: f };
}

module.exports = { runScan };
