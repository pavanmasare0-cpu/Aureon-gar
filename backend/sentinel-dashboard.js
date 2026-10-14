// backend/sentinel-dashboard.js
//
// Aureon Sentinel Dashboard — multi-server health monitoring with a
// human-approval gate. NOTHING in this file ever writes a file or calls a
// restart webhook on its own. A failure only ever produces a *proposal*;
// a file is written / a webhook is called ONLY inside the /approve route,
// which only runs when you click Approve on the dashboard.
//
// Two kinds of monitored servers:
//   - "self"     — a server whose source this process can read/write on
//                  disk (e.g. this same backend checkout, or any other repo
//                  you've cloned into this Codespace). On failure, Sentinel
//                  proposes a patch (you see old vs new content) — never
//                  applies it until you approve.
//   - "external" — any URL you paste in, hosted elsewhere. Sentinel has no
//                  filesystem access to someone else's server, so it can
//                  only monitor uptime. If you also give a restart webhook
//                  for it, a failure proposes calling that webhook — again
//                  gated behind Approve, never automatic.
//
// Data persists to backend/sentinel-data/*.json so it survives restarts.
//
// Env vars reused from watchdog.js's email setup (same values, nothing new
// to configure if you already set those up): RESEND_API_KEY, ALERT_EMAIL_TO,
// ALERT_EMAIL_FROM (optional).

const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const DATA_DIR = path.join(__dirname, 'sentinel-data');
const SERVERS_PATH = path.join(DATA_DIR, 'servers.json');
const PROPOSALS_PATH = path.join(DATA_DIR, 'proposals.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error('[sentinel] failed to load', p, e.message);
    return fallback;
  }
}
function saveJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

let servers = loadJSON(SERVERS_PATH, []);
let proposals = loadJSON(PROPOSALS_PATH, []);

function persistServers() { saveJSON(SERVERS_PATH, servers); }
function persistProposals() { saveJSON(PROPOSALS_PATH, proposals); }

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------------- Owner-code gate ----------------
// Set SENTINEL_OWNER_CODE on Render to actually lock this down. Without
// it, anyone who finds the dashboard URL could approve/reject proposals —
// so until it's set, every page/response carries a loud warning instead
// of silently pretending to be protected.
function checkOwnerCode(req) {
  const configured = process.env.SENTINEL_OWNER_CODE;
  if (!configured) return 'unprotected';
  const provided = req.header('x-owner-code') || req.query.code;
  return provided === configured ? 'ok' : 'denied';
}

function requireOwnerCode(req, res, next) {
  const status = checkOwnerCode(req);
  if (status === 'denied') return res.status(401).json({ error: 'owner code required' });
  next();
}

async function sendAlertEmail(subject, text) {
  const apiKey = process.env.RESEND_API_KEY;
  // ALERT_EMAIL_TO can be one address or several comma-separated
  // (e.g. "you@gmail.com, owner@yourdomain.com") — every address in it
  // gets every alert.
  const toRaw = process.env.ALERT_EMAIL_TO;
  const to = (toRaw || '').split(',').map((s) => s.trim()).filter(Boolean);
  const from = process.env.ALERT_EMAIL_FROM || 'Aureon Sentinel <onboarding@resend.dev>';
  if (!apiKey || !to.length) {
    console.warn('[sentinel] Email alerting not configured, would have sent:', subject, '|', text);
    return;
  }
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ from, to, subject, text }),
    });
  } catch (e) {
    console.error('[sentinel] email send failed:', e.message);
  }
}

// ---------------- GitHub repo access (for servers hosted elsewhere) ----------------
// Reads/writes files in a remote GitHub repo via the Contents API — no
// local clone needed. A write here IS a real commit on the target branch,
// which is why it only ever happens inside the /approve route.
function githubToken(server) {
  return server.ghToken || process.env.GITHUB_TOKEN;
}

async function githubApi(server, pathSuffix, opts) {
  const token = githubToken(server);
  if (!token) throw new Error('No GitHub token configured (set one on the server or GITHUB_TOKEN env var)');
  const res = await fetch(`https://api.github.com/repos/${server.ghRepo}${pathSuffix}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      ...(opts && opts.headers),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function githubListFiles(server) {
  const folder = (server.ghPath || '').replace(/^\/|\/$/g, '');
  const ref = server.ghBranch || 'main';
  const listing = await githubApi(server, `/contents/${folder}?ref=${encodeURIComponent(ref)}`, { method: 'GET' });
  if (!Array.isArray(listing)) return [];
  return listing.filter((f) => f.type === 'file' && (f.name.endsWith('.js') || f.name.endsWith('.ts')));
}

async function githubReadFile(server, repoFilePath) {
  const ref = server.ghBranch || 'main';
  const data = await githubApi(server, `/contents/${repoFilePath}?ref=${encodeURIComponent(ref)}`, { method: 'GET' });
  const content = Buffer.from(data.content, 'base64').toString('utf8');
  return { content, sha: data.sha };
}

async function githubWriteFile(server, repoFilePath, newContent, sha, message) {
  const ref = server.ghBranch || 'main';
  return githubApi(server, `/contents/${repoFilePath}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: message || 'Aureon Sentinel: approved fix',
      content: Buffer.from(newContent, 'utf8').toString('base64'),
      sha,
      branch: ref,
    }),
  });
}

function hasPendingProposalFor(serverId, kind, key) {
  return proposals.some(
    (p) => p.status === 'pending' && p.serverId === serverId && p.kind === kind &&
      (kind === 'patch' ? p.filePath === key : p.webhookUrl === key)
  );
}

// ---------------- Unified code-source access ----------------
// Both "self" (local filesystem) and "github" (remote repo via API) servers
// go through these three functions, so the AI-diagnosis and proactive-scan
// logic below doesn't need to care which one it's dealing with.
async function listServerFiles(server) {
  if (server.type === 'github') {
    try { return (await githubListFiles(server)).map((f) => f.name); }
    catch (e) { console.warn('[sentinel] github list failed:', e.message); return []; }
  }
  const dir = server.localPath;
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js') || f.endsWith('.ts'));
}

async function readServerFile(server, name) {
  if (server.type === 'github') {
    const folder = (server.ghPath || '').replace(/^\/|\/$/g, '');
    const repoFilePath = folder ? `${folder}/${name}` : name;
    const { content, sha } = await githubReadFile(server, repoFilePath);
    return { content, key: `github:${server.ghRepo}:${repoFilePath}`, meta: { repoFilePath, sha } };
  }
  const filePath = path.join(server.localPath, name);
  const content = fs.readFileSync(filePath, 'utf8');
  return { content, key: filePath, meta: { filePath } };
}

function buildPatchProposal(server, source, name, explanation, oldFile, newContent) {
  const base = {
    id: newId(),
    serverId: server.id,
    serverName: server.name,
    kind: 'patch',
    source,
    description: `${source === 'proactive-ai' ? 'Proactive review found a bug in' : 'AI-diagnosed fix for'} ${name}: ${explanation}`,
    oldContent: oldFile.content,
    newContent,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  if (server.type === 'github') {
    return { ...base, target: 'github', filePath: `${server.ghRepo}/${oldFile.meta.repoFilePath}`, ghRepo: server.ghRepo, ghBranch: server.ghBranch || 'main', ghFilePath: oldFile.meta.repoFilePath, ghSha: oldFile.meta.sha };
  }
  return { ...base, target: 'local', filePath: oldFile.meta.filePath };
}

// Tries real AI diagnosis first (reads the error + the server's own code,
// asks an LLM to find and fix the specific bug). The model is explicitly
// told to say "not confident" rather than guess when the cause isn't
// visible in the code shown (e.g. a network blip, a missing env var, an
// external service being down) — those return null here and the caller
// falls back to the narrower pattern-match check below. Either way, this
// function only ever returns a *proposal*; nothing is written/committed.
async function generateAIFixProposal(server, errorMessage) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  const files = await listServerFiles(server);
  if (!files.length) return null;

  let combined = '';
  for (const name of files) {
    try {
      const f = await readServerFile(server, name);
      combined += `\n\n----- FILE: ${name} -----\n${f.content}`;
    } catch (e) { continue; }
    if (combined.length > 14000) break;
  }
  if (!combined) return null;

  const prompt = `You are a careful senior backend engineer. A server just failed with this error:

ERROR: ${errorMessage}

Here is its source code:
${combined}

Diagnose the SPECIFIC bug causing this error, ONLY if it is visible in the code above. If the cause could be something outside this code (network issue, missing environment variable, a dependency/service being down, insufficient information), do NOT guess — say you are not confident instead.

Respond with ONLY valid JSON, no markdown fences, no extra commentary, in exactly this shape:
{"confident": true or false, "file": "<exact filename from the list above, or null>", "explanation": "<1-2 sentences in Hindi/Hinglish, explaining the bug and the fix in plain language>", "newContent": "<the COMPLETE corrected content of that one file, or null if confident is false>"}`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], temperature: 0.2 }),
    });
    const data = await res.json();
    let raw = data?.choices?.[0]?.message?.content || '';
    raw = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
    const parsed = JSON.parse(raw);

    if (!parsed.confident || !parsed.file || !parsed.newContent) return null;
    if (!files.includes(parsed.file)) return null;

    const oldFile = await readServerFile(server, parsed.file);
    if (hasPendingProposalFor(server.id, 'patch', oldFile.key)) return null;

    return buildPatchProposal(server, 'reactive-ai', parsed.file, parsed.explanation, oldFile, parsed.newContent);
  } catch (e) {
    console.warn('[sentinel] AI diagnosis skipped/failed:', e.message);
    return null;
  }
}

// Proactive scan — runs even when a server is healthy, reviews its own
// code for real bugs (not style nitpicks), and proposes fixes for the
// ones it's confident about. Same rule as reactive diagnosis: if it isn't
// sure, it reports nothing rather than inventing minor complaints. Only
// ever produces proposals — never writes/commits on its own.
async function generateProactiveFindings(server) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return [];
  const files = await listServerFiles(server);
  if (!files.length) return [];

  let combined = '';
  for (const name of files) {
    try {
      const f = await readServerFile(server, name);
      combined += `\n\n----- FILE: ${name} -----\n${f.content}`;
    } catch (e) { continue; }
    if (combined.length > 14000) break;
  }
  if (!combined) return [];

  const prompt = `You are a careful senior backend engineer doing a routine code review (the server is currently running fine — you are looking for bugs BEFORE they cause an outage, not reacting to one).

Here is the code:
${combined}

Find up to 3 REAL bugs only — things like: unhandled promise rejections, null/undefined access, resource/memory leaks, race conditions, broken error handling, obvious security holes (e.g. no input validation on user data). Do NOT report style preferences, formatting, or naming — only things that could actually break or be exploited. If you are not genuinely confident something is a bug, leave it out. It is fine to return zero findings.

Respond with ONLY valid JSON, no markdown fences, no extra commentary, in exactly this shape:
{"findings": [{"file": "<exact filename from above>", "explanation": "<1-2 sentences in Hindi/Hinglish>", "newContent": "<the COMPLETE corrected content of that one file>"}]}`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], temperature: 0.2 }),
    });
    const data = await res.json();
    let raw = data?.choices?.[0]?.message?.content || '';
    raw = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
    const parsed = JSON.parse(raw);
    const findings = Array.isArray(parsed.findings) ? parsed.findings.slice(0, 3) : [];

    const proposals = [];
    for (const f of findings) {
      if (!f.file || !f.newContent || !files.includes(f.file)) continue;
      const oldFile = await readServerFile(server, f.file);
      if (hasPendingProposalFor(server.id, 'patch', oldFile.key)) continue;
      proposals.push(buildPatchProposal(server, 'proactive-ai', f.file, f.explanation, oldFile, f.newContent));
    }
    return proposals;
  } catch (e) {
    console.warn('[sentinel] Proactive scan skipped/failed:', e.message);
    return [];
  }
}

async function runProactiveScanCycle() {
  let changed = false;
  for (const server of servers) {
    if (server.type !== 'self' && server.type !== 'github') continue;
    const found = await generateProactiveFindings(server);
    if (found.length) {
      proposals.push(...found);
      changed = true;
      await sendAlertEmail(
        `Aureon Sentinel: proactive review found ${found.length} issue(s) in ${server.name}`,
        found.map((p) => `- ${p.description}`).join('\n') +
          '\n\nOpen the Sentinel dashboard to approve or reject. Nothing has been changed yet.'
      );
    }
  }
  if (changed) persistProposals();
}

const PROACTIVE_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day
setInterval(() => {
  runProactiveScanCycle().catch((e) => console.error('[sentinel] proactive cycle failed:', e.message));
}, PROACTIVE_SCAN_INTERVAL_MS);

// Deliberately narrow and explainable fallback for "self" (local) servers
// only, used when AI diagnosis above isn't configured, isn't confident, or
// fails. NEVER applied automatically — only ever proposed.
function scanForProposals(server) {
  if (server.type !== 'self' || !server.localPath) return [];
  const dir = server.localPath;
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];

  const found = [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const filePath = path.join(dir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.includes('unhandledRejection')) {
      if (hasPendingProposalFor(server.id, 'patch', filePath)) continue;
      const addition =
        "\n\nprocess.on('unhandledRejection', (reason) => {\n  console.error('[Sentinel] Unhandled rejection:', reason);\n});\n";
      found.push({
        id: newId(),
        serverId: server.id,
        serverName: server.name,
        kind: 'patch',
        source: 'reactive-pattern',
        target: 'local',
        description: `Add missing unhandledRejection guard to ${file}`,
        filePath,
        oldContent: content,
        newContent: content + addition,
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
    }
  }
  return found;
}

async function checkServer(server) {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(server.healthUrl, { signal: controller.signal });
    clearTimeout(t);
    server.lastStatus = res.ok ? 'HEALTHY' : `HTTP_${res.status}`;
    server.lastResponseMs = Date.now() - started;
    server.lastCheckedAt = new Date().toISOString();
    return res.ok;
  } catch (e) {
    server.lastStatus = 'DOWN';
    server.lastError = e.message;
    server.lastCheckedAt = new Date().toISOString();
    return false;
  }
}

async function runMonitorCycle() {
  let changed = false;
  for (const server of servers) {
    const ok = await checkServer(server);
    if (!ok) {
      if (server.type === 'self' || server.type === 'github') {
        const aiProposal = await generateAIFixProposal(server, server.lastError || server.lastStatus);
        const newProposals = aiProposal ? [aiProposal] : scanForProposals(server);
        if (newProposals.length) {
          proposals.push(...newProposals);
          changed = true;
          await sendAlertEmail(
            `Aureon Sentinel: ${newProposals.length} fix(es) proposed for ${server.name}`,
            newProposals.map((p) => `- ${p.description} (${p.filePath})`).join('\n') +
              '\n\nOpen the Sentinel dashboard to approve or reject. Nothing has been changed yet.'
          );
        } else {
          await sendAlertEmail(
            `Aureon Sentinel: ${server.name} is DOWN`,
            `Health check failed: ${server.lastError || server.lastStatus}\nNo fix matched a known pattern — needs a human look.`
          );
        }
      } else if (server.type === 'external') {
        if (server.restartWebhookUrl && !hasPendingProposalFor(server.id, 'restart', server.restartWebhookUrl)) {
          proposals.push({
            id: newId(),
            serverId: server.id,
            serverName: server.name,
            kind: 'restart',
            source: 'reactive-external',
            description: `Call restart webhook for ${server.name} (currently DOWN)`,
            webhookUrl: server.restartWebhookUrl,
            status: 'pending',
            createdAt: new Date().toISOString(),
          });
          changed = true;
          await sendAlertEmail(
            `Aureon Sentinel: ${server.name} is DOWN — restart proposed`,
            `Open the Sentinel dashboard to approve or reject calling its restart webhook. Nothing has been triggered yet.`
          );
        } else {
          await sendAlertEmail(
            `Aureon Sentinel: ${server.name} is DOWN`,
            `No restart webhook configured for it — add one on the dashboard, or fix it manually.`
          );
        }
      }
    }
  }
  persistServers();
  if (changed) persistProposals();
}

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // every 5 min
setInterval(() => {
  runMonitorCycle().catch((e) => console.error('[sentinel] cycle failed:', e.message));
}, CHECK_INTERVAL_MS);

// ---------------- API ----------------
// Every route below the dashboard page itself requires the owner code
// (as the x-owner-code header, which the dashboard page's own JS sends
// automatically once you've unlocked it).
router.use((req, res, next) => {
  if (req.path === '/dashboard') return next(); // has its own login page below
  return requireOwnerCode(req, res, next);
});

router.get('/servers', (req, res) => res.json(servers));

router.post('/servers', (req, res) => {
  const { name, healthUrl, type, localPath, restartWebhookUrl, ghRepo, ghBranch, ghPath, ghToken } = req.body || {};
  if (!name || !healthUrl || !type) {
    return res.status(400).json({ error: 'name, healthUrl, type are required' });
  }
  if (!['self', 'external', 'github'].includes(type)) {
    return res.status(400).json({ error: "type must be 'self', 'external', or 'github'" });
  }
  if (type === 'github' && !ghRepo) {
    return res.status(400).json({ error: "ghRepo (owner/repo) is required for type 'github'" });
  }
  const server = {
    id: newId(),
    name,
    healthUrl,
    type,
    localPath: type === 'self' ? (localPath || null) : null,
    restartWebhookUrl: type === 'external' ? (restartWebhookUrl || null) : null,
    ghRepo: type === 'github' ? ghRepo : null,
    ghBranch: type === 'github' ? (ghBranch || 'main') : null,
    ghPath: type === 'github' ? (ghPath || '') : null,
    ghToken: type === 'github' ? (ghToken || null) : null, // optional per-repo override of GITHUB_TOKEN env var
    lastStatus: 'UNKNOWN',
  };
  servers.push(server);
  persistServers();
  res.json(server);
});

router.delete('/servers/:id', (req, res) => {
  servers = servers.filter((s) => s.id !== req.params.id);
  persistServers();
  res.json({ ok: true });
});

router.get('/proposals', (req, res) => res.json(proposals));

// The ONLY place that ever writes a file or calls a webhook — and it only
// runs because a human clicked Approve on the dashboard.
router.post('/proposals/:id/approve', async (req, res) => {
  const p = proposals.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (p.status !== 'pending') return res.status(400).json({ error: `already ${p.status}` });
  try {
    if (p.kind === 'patch' && p.target === 'github') {
      const server = servers.find((s) => s.id === p.serverId) || { ghRepo: p.ghRepo };
      await githubWriteFile(
        { ...server, ghRepo: p.ghRepo, ghBranch: p.ghBranch },
        p.ghFilePath, p.newContent, p.ghSha,
        `Aureon Sentinel: ${p.description}`
      );
    } else if (p.kind === 'patch') {
      fs.writeFileSync(p.filePath, p.newContent, 'utf8');
    } else if (p.kind === 'restart') {
      await fetch(p.webhookUrl, { method: 'POST' });
    }
    p.status = 'approved';
    p.decidedAt = new Date().toISOString();
    persistProposals();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/proposals/:id/reject', (req, res) => {
  const p = proposals.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  p.status = 'rejected';
  p.decidedAt = new Date().toISOString();
  persistProposals();
  res.json({ ok: true });
});

router.post('/check-now', async (req, res) => {
  await runMonitorCycle();
  res.json({ ok: true });
});

router.post('/servers/:id/scan-now', async (req, res) => {
  const server = servers.find((s) => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'not found' });
  if (server.type !== 'self' && server.type !== 'github') return res.status(400).json({ error: 'proactive scan only works on servers with code access (self-hosted or GitHub)' });
  const found = await generateProactiveFindings(server);
  if (found.length) {
    proposals.push(...found);
    persistProposals();
    await sendAlertEmail(
      `Aureon Sentinel: proactive review found ${found.length} issue(s) in ${server.name}`,
      found.map((p) => `- ${p.description}`).join('\n') + '\n\nOpen the Sentinel dashboard to approve or reject.'
    );
  }
  res.json({ found: found.length });
});

router.get('/dashboard', (req, res) => {
  const status = checkOwnerCode(req);
  if (status === 'denied') {
    return res.type('html').send(LOGIN_HTML(true));
  }
  if (status === 'unprotected') {
    return res.type('html').send(
      DASHBOARD_HTML.replace('__OWNER_CODE__', '').replace('__UNPROTECTED__', 'true')
    );
  }
  const code = req.query.code || '';
  res.type('html').send(
    DASHBOARD_HTML.replace('__OWNER_CODE__', code).replace('__UNPROTECTED__', 'false')
  );
});

const LOGIN_HTML = (wrongAttempt) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aureon Sentinel — Locked</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:#0a0a0d; color:#eee; font-family:-apple-system,sans-serif; }
  form { background:#15151b; border:1px solid #24242e; border-radius:12px; padding:28px; width:90%; max-width:320px; text-align:center; }
  h1 { color:#d4af37; font-size:18px; margin:0 0 18px; }
  input { width:100%; background:#101014; border:1px solid #24242e; color:#eee; padding:10px 12px; border-radius:8px; font-size:14px; margin-bottom:12px; }
  button { width:100%; background:#d4af37; color:#141414; border:none; border-radius:8px; padding:10px; font-weight:600; font-size:14px; cursor:pointer; }
  .err { color:#ff6b6b; font-size:12px; margin:-6px 0 12px; }
</style></head>
<body>
  <form method="GET" action="/api/sentinel/dashboard">
    <h1>🛡️ Aureon Sentinel</h1>
    ${wrongAttempt ? '<div class="err">Galat code, dobara try karo.</div>' : ''}
    <input name="code" type="password" placeholder="Owner code" autofocus>
    <button type="submit">Unlock</button>
  </form>
</body></html>`;

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Aureon Sentinel</title>
<style>
  :root {
    --gold:#d4af37; --gold-dim:rgba(212,175,55,.5);
    --bg:#0a0a0d; --bg2:#101014;
    --card:#15151b; --card-border:#24242e;
    --danger:#ff6b6b; --ok:#4ade80; --warn:#f5a524; --muted:#8b8f99;
    --text:#f0f0f2;
  }
  * { box-sizing: border-box; }
  html, body { height:100%; }
  body {
    margin:0; background:
      radial-gradient(1200px 400px at 50% -10%, rgba(212,175,55,.06), transparent),
      var(--bg);
    color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,sans-serif;
    padding:20px 16px; max-width:1100px; margin-left:auto; margin-right:auto;
    padding-top: calc(20px + env(safe-area-inset-top, 0px)); padding-bottom: calc(20px + env(safe-area-inset-bottom, 0px));
  }
  header { margin-bottom:22px; }
  h1 { color:var(--gold); font-size:21px; font-weight:700; margin:0 0 4px; letter-spacing:.2px; }
  .sub { color:var(--muted); font-size:13px; margin-bottom:16px; }
  .summary-bar { display:flex; gap:10px; flex-wrap:wrap; }
  .summary-chip { background:var(--card); border:1px solid var(--card-border); border-radius:8px; padding:8px 14px; font-size:12px; color:var(--muted); display:flex; align-items:center; gap:6px; }
  .summary-chip b { color:var(--text); font-size:14px; }
  .card {
    background:linear-gradient(180deg, var(--card), var(--bg2));
    border:1px solid var(--card-border); border-radius:12px; padding:16px; margin-bottom:10px;
    box-shadow:0 1px 3px rgba(0,0,0,.3);
  }
  .row { display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; flex-shrink:0; }
  .dot.HEALTHY { background:var(--ok); box-shadow:0 0 6px var(--ok); }
  .dot.DOWN, .dot[class*="HTTP_"] { background:var(--danger); box-shadow:0 0 6px var(--danger); }
  .dot.UNKNOWN { background:var(--muted); }
  .badge { font-size:11px; padding:4px 10px; border-radius:20px; font-weight:600; letter-spacing:.3px; text-transform:uppercase; display:inline-flex; align-items:center; }
  .badge.HEALTHY { background:rgba(74,222,128,.12); color:var(--ok); border:1px solid rgba(74,222,128,.25); }
  .badge.DOWN, .badge[class*="HTTP_"] { background:rgba(255,107,107,.12); color:var(--danger); border:1px solid rgba(255,107,107,.25); }
  .badge.UNKNOWN { background:rgba(139,143,153,.12); color:var(--muted); border:1px solid rgba(139,143,153,.25); }
  .name { font-weight:600; font-size:14px; }
  .meta { font-size:12px; color:var(--muted); margin-top:2px; }
  button { background:var(--gold); color:#141414; border:none; border-radius:8px; padding:8px 16px; font-weight:600; font-size:13px; cursor:pointer; transition:filter .15s; }
  button:hover { filter:brightness(1.08); }
  button.reject { background:transparent; color:var(--text); border:1px solid var(--card-border); }
  button.danger { background:var(--danger); color:#fff; }
  input, select {
    background:var(--bg2); border:1px solid var(--card-border); color:var(--text);
    padding:10px 12px; border-radius:8px; font-size:13px; width:100%;
  }
  input:focus, select:focus { outline:none; border-color:var(--gold-dim); }
  .grid { display:grid; grid-template-columns:1fr; gap:8px; margin-top:10px; }
  details summary { cursor:pointer; color:var(--gold); font-size:12px; font-weight:600; }
  pre { background:var(--bg2); padding:10px; border-radius:8px; overflow-x:auto; font-size:11px; line-height:1.5; white-space:pre-wrap; word-break:break-word; border:1px solid var(--card-border); }
  h2 { font-size:13px; font-weight:700; color:var(--gold); margin:0 0 12px; text-transform:uppercase; letter-spacing:.6px; }
  .empty { color:var(--muted); font-size:13px; padding:14px 0; }
  .columns { display:grid; grid-template-columns:1fr; gap:24px; margin-top:24px; }
  @media(min-width:760px){ .columns { grid-template-columns:1fr 1fr; } }
  .col-left, .col-right { min-width:0; }
  .decide-btns { display:flex; gap:8px; flex-shrink:0; }
  .history-section { margin-top:32px; }
  .ai-tag { font-size:10px; color:var(--gold); background:rgba(212,175,55,.1); border:1px solid rgba(212,175,55,.3); border-radius:5px; padding:2px 6px; margin-left:6px; vertical-align:middle; }
</style>
</head>
<body>
  <header>
    <h1>🛡️ Aureon Sentinel</h1>
    <div class="sub">Every fix is diagnosed and proposed — never applied — until you click Approve.</div>
    <div id="unprotected-banner" style="display:none;background:rgba(255,107,107,.1);border:1px solid rgba(255,107,107,.3);color:#ff6b6b;font-size:12px;padding:10px 14px;border-radius:8px;margin-bottom:14px;">
      ⚠️ SENTINEL_OWNER_CODE set nahi hai Render pe — ye page abhi kisi ke liye bhi locked nahi hai. Render → Environment me add karo.
    </div>
    <div class="summary-bar" id="summary"></div>
  </header>

  <div class="columns">
    <div class="col-left">
      <h2>Servers</h2>
      <div id="servers"></div>
      <div class="card">
        <div class="grid">
          <input id="s-name" placeholder="Name (e.g. Aureon backend)">
          <input id="s-url" placeholder="Health check URL (https://.../health)">
          <select id="s-type" onchange="toggleTypeFields()">
            <option value="self">Self-hosted — code access (full diagnosis)</option>
            <option value="github">GitHub repo — code access via API (full diagnosis)</option>
            <option value="external">External — monitor only</option>
          </select>
          <input id="s-local" placeholder="Local path (self-hosted only, e.g. ./ )">
          <input id="s-webhook" placeholder="Restart webhook URL (external only, optional)">
          <input id="s-gh-repo" placeholder="owner/repo (GitHub only, e.g. pavan/omnisell-backend)" style="display:none">
          <input id="s-gh-branch" placeholder="Branch (GitHub only, default: main)" style="display:none">
          <input id="s-gh-path" placeholder="Folder in repo (GitHub only, optional, e.g. backend)" style="display:none">
          <input id="s-gh-token" type="password" placeholder="GitHub token (optional — else uses GITHUB_TOKEN env)" style="display:none">
        </div>
        <div style="margin-top:12px"><button onclick="addServer()">+ Add server</button></div>
      </div>
    </div>

    <div class="col-right">
      <h2>Accept / Reject</h2>
      <div id="pending"></div>
    </div>
  </div>

  <div class="history-section">
    <h2>History</h2>
    <div id="history"></div>
  </div>

<script>
const API = '/api/sentinel';
const OWNER_CODE = '__OWNER_CODE__';
const UNPROTECTED = __UNPROTECTED__;
if (UNPROTECTED) document.getElementById('unprotected-banner').style.display = 'block';

function authFetch(url, opts) {
  opts = opts || {};
  opts.headers = Object.assign({}, opts.headers, { 'x-owner-code': OWNER_CODE });
  return fetch(url, opts);
}

async function load() {
  const [servers, proposals] = await Promise.all([
    authFetch(API + '/servers').then(r => r.json()),
    authFetch(API + '/proposals').then(r => r.json()),
  ]);
  renderSummary(servers, proposals);
  renderServers(servers);
  renderProposals(proposals);
}

function renderSummary(servers, proposals) {
  const healthy = servers.filter(s => s.lastStatus === 'HEALTHY').length;
  const down = servers.filter(s => s.lastStatus && s.lastStatus !== 'HEALTHY' && s.lastStatus !== 'UNKNOWN').length;
  const pending = proposals.filter(p => p.status === 'pending').length;
  document.getElementById('summary').innerHTML = \`
    <div class="summary-chip"><span class="dot HEALTHY"></span><b>\${healthy}</b>&nbsp;healthy</div>
    <div class="summary-chip"><span class="dot DOWN"></span><b>\${down}</b>&nbsp;down</div>
    <div class="summary-chip"><b>\${pending}</b>&nbsp;awaiting approval</div>
  \`;
}

function renderServers(servers) {
  const el = document.getElementById('servers');
  if (!servers.length) { el.innerHTML = '<div class="empty">No servers added yet.</div>'; return; }
  el.innerHTML = servers.map(s => \`
    <div class="card row">
      <div>
        <div class="name"><span class="dot \${s.lastStatus || 'UNKNOWN'}"></span>\${s.name} <span class="meta">(\${s.type === 'self' ? 'self-hosted' : s.type === 'github' ? 'GitHub repo' : 'external'})</span></div>
        <div class="meta">\${s.healthUrl}</div>
        \${s.type === 'github' ? \`<div class="meta">\${s.ghRepo} @ \${s.ghBranch}\${s.ghPath ? '/' + s.ghPath : ''}</div>\` : ''}
        \${s.lastCheckedAt ? \`<div class="meta">checked \${new Date(s.lastCheckedAt).toLocaleString()}</div>\` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="badge \${s.lastStatus || 'UNKNOWN'}">\${s.lastStatus || 'UNKNOWN'}</span>
        \${(s.type === 'self' || s.type === 'github') ? \`<button class="reject" onclick="scanNow('\${s.id}')">Review now</button>\` : ''}
        <button class="reject" onclick="removeServer('\${s.id}')">Remove</button>
      </div>
    </div>\`).join('');
}

function renderProposals(proposals) {
  const pending = proposals.filter(p => p.status === 'pending');
  const done = proposals.filter(p => p.status !== 'pending').sort((a,b) => new Date(b.decidedAt) - new Date(a.decidedAt));

  const pendEl = document.getElementById('pending');
  pendEl.innerHTML = pending.length ? pending.map(p => \`
    <div class="card">
      <div class="row">
        <div>
          <div class="name">\${p.serverName}\${p.source === 'reactive-ai' ? '<span class="ai-tag">AI diagnosed</span>' : ''}\${p.source === 'proactive-ai' ? '<span class="ai-tag">Proactive scan</span>' : ''}</div>
          <div class="meta">\${p.description}</div>
        </div>
        <div class="decide-btns">
          <button onclick="decide('\${p.id}','approve')">Approve</button>
          <button class="reject" onclick="decide('\${p.id}','reject')">Reject</button>
        </div>
      </div>
      \${p.kind === 'patch' ? \`<details style="margin-top:8px"><summary>View proposed change</summary><pre>\${escapeHtml(p.newContent.slice(-800))}</pre></details>\` : ''}
    </div>\`).join('') : '<div class="empty">Nothing pending.</div>';

  const histEl = document.getElementById('history');
  histEl.innerHTML = done.length ? done.slice(0,20).map(p => \`
    <div class="card row">
      <div>
        <div class="name">\${p.serverName}</div>
        <div class="meta">\${p.description}</div>
      </div>
      <span class="badge \${p.status === 'approved' ? 'HEALTHY' : 'DOWN'}">\${p.status}</span>
    </div>\`).join('') : '<div class="empty">No history yet.</div>';
}

function escapeHtml(s) { return s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

function toggleTypeFields() {
  const type = document.getElementById('s-type').value;
  document.getElementById('s-local').style.display = type === 'self' ? '' : 'none';
  document.getElementById('s-webhook').style.display = type === 'external' ? '' : 'none';
  ['s-gh-repo','s-gh-branch','s-gh-path','s-gh-token'].forEach(id => {
    document.getElementById(id).style.display = type === 'github' ? '' : 'none';
  });
}

async function addServer() {
  const type = document.getElementById('s-type').value;
  const body = {
    name: document.getElementById('s-name').value,
    healthUrl: document.getElementById('s-url').value,
    type,
    localPath: document.getElementById('s-local').value,
    restartWebhookUrl: document.getElementById('s-webhook').value,
    ghRepo: document.getElementById('s-gh-repo').value,
    ghBranch: document.getElementById('s-gh-branch').value,
    ghPath: document.getElementById('s-gh-path').value,
    ghToken: document.getElementById('s-gh-token').value,
  };
  if (!body.name || !body.healthUrl) { alert('Name and health URL are required'); return; }
  if (type === 'github' && !body.ghRepo) { alert('owner/repo is required for GitHub type'); return; }
  const res = await authFetch(API + '/servers', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if (!res.ok) { const e = await res.json().catch(() => ({})); alert(e.error || 'Could not add server'); return; }
  ['s-name','s-url','s-local','s-webhook','s-gh-repo','s-gh-branch','s-gh-path','s-gh-token'].forEach(id => document.getElementById(id).value = '');
  load();
}

async function scanNow(id) {
  const btn = event.target; btn.textContent = 'Scanning…'; btn.disabled = true;
  const res = await authFetch(\`\${API}/servers/\${id}/scan-now\`, { method:'POST' }).then(r => r.json());
  alert(res.found ? \`\${res.found} issue(s) found — check Accept/Reject.\` : 'No confident findings this time.');
  load();
}

async function removeServer(id) {
  if (!confirm('Remove this server from monitoring?')) return;
  await authFetch(API + '/servers/' + id, { method:'DELETE' });
  load();
}

async function decide(id, action) {
  await authFetch(\`\${API}/proposals/\${id}/\${action}\`, { method:'POST' });
  load();
}

load();
setInterval(load, 10000);
</script>
</body>
</html>`;

module.exports = router;
