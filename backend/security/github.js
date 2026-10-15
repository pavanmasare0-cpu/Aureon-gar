// security/github.js — GitHub Guard
//
// Watches your repos for anyone "touching" them and alerts you:
//   * REAL-TIME  : GitHub webhook -> POST /api/security/github-webhook (HMAC verified)
//   * POLLING    : Events API every 5 min (works with just a token, no webhook)
//   * STATE DIFF : every 30 min it snapshots visibility, collaborators, deploy
//                  keys, webhooks and branch protection, and alerts on changes.
//   * TRAFFIC    : clone counts (spike alert) — needs a token with enough rights.
//
// Honest limit: GitHub never tells owners WHO viewed or cloned a public repo
// (only aggregate counts). Write / admin actions — push, force-push, branch
// delete, collaborator added, made public, deploy key, webhook change, fork —
// ARE detected and alerted.
const crypto = require('crypto');
const path = require('path');
const store = require('../persist');
const box = require('../secret-box');

const csv = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const TRUSTED_ENV = csv(process.env.SECURITY_GITHUB_TRUSTED).map((s) => s.toLowerCase());
const CLONE_ALERT = parseInt(process.env.SECURITY_GITHUB_CLONE_ALERT, 10) || 5;
const EVENTS_EVERY_MS = 5 * 60 * 1000;
const POSTURE_EVERY_MS = 30 * 60 * 1000;

let fetchFn = (...a) => fetch(...a);
let hooks = { record() {}, alert() {} };
let repos = [];
let ready = Promise.resolve();
let FILE = null;
const seenDeliveries = [];

function init(h) {
  hooks = h;
  FILE = path.join(h.dataDir, 'github.json');
  ready = (async () => {
    await store.whenFirestore(20000);
    const r = await store.load('sec_github', FILE);
    if (Array.isArray(r.value)) repos = r.value;
    for (const name of csv(process.env.SECURITY_GITHUB_REPOS)) {
      if (/^[\w.-]+\/[\w.-]+$/.test(name) && !repos.some((x) => x.repo.toLowerCase() === name.toLowerCase())) repos.push(newRec(name));
    }
    if (repos.length) persist();
    console.log(`[security] GitHub Guard watching ${repos.length} repo(s)`);
  })().catch((e) => console.error('[security] github init failed:', e.message));
  setTimeout(() => runAll().catch(() => {}), 20000).unref();
  setInterval(() => ready.then(() => Promise.all(repos.map((r) => safe(r, 'events', pollEvents)))).catch(() => {}), EVENTS_EVERY_MS).unref();
  setInterval(() => ready.then(() => Promise.all(repos.map((r) => safe(r, 'posture', checkPosture)))).catch(() => {}), POSTURE_EVERY_MS).unref();
}

function newRec(repo, extra) {
  return Object.assign({ id: crypto.randomBytes(5).toString('hex'), repo, trusted: [], tokenEnc: null, token: null, etag: null,
    lastEventId: null, firstPollDone: false, baseline: null, baselineAt: null, lastSpikeDay: null, addedAt: new Date().toISOString(),
    status: { lastCheck: null, warnings: [], lastError: null, lastPush: null, traffic: null, posture: null } }, extra || {});
}
function persist() { ready.then(() => store.save('sec_github', repos, FILE)).catch(() => {}); }

function tokenFor(r) { return (r.tokenEnc && box.decrypt(r.tokenEnc)) || r.token || process.env.GITHUB_TOKEN; }
function trustedSet(r) { return new Set([r.repo.split('/')[0].toLowerCase(), ...TRUSTED_ENV, ...(r.trusted || []).map((s) => s.toLowerCase())]); }
const isTrusted = (r, actor) => trustedSet(r).has(String(actor || '').toLowerCase());

async function api(r, suffix, etag) {
  const token = tokenFor(r);
  if (!token) throw new Error('no GitHub token (set GITHUB_TOKEN on Render, or add one for this repo)');
  const res = await fetchFn(`https://api.github.com/repos/${r.repo}${suffix}`, { headers: {
    Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'aureon-security',
    'X-GitHub-Api-Version': '2022-11-28', ...(etag ? { 'If-None-Match': etag } : {}) } });
  let json = null;
  if (res.status !== 304) { try { json = await res.json(); } catch (e) { /* empty body */ } }
  return { status: res.status, json, etag: res.headers && res.headers.get ? res.headers.get('etag') : null };
}

async function safe(r, what, fn) {
  try { await fn(r); r.status.lastError = null; }
  catch (e) { r.status.lastError = `${what}: ${e.message}`; }
  r.status.lastCheck = new Date().toISOString();
  persist();
}

// ---------- normalise events (Events API  +  webhook) ----------
function fromApiEvent(e) {
  const actor = (e.actor && e.actor.login) || 'unknown', p = e.payload || {};
  switch (e.type) {
    case 'PushEvent': return { kind: 'push', actor, ref: p.ref, commits: p.size, distinct: p.distinct_size, forced: false };
    case 'DeleteEvent': return { kind: 'delete', actor, ref: p.ref, refType: p.ref_type };
    case 'MemberEvent': return p.action === 'added' ? { kind: 'collaborator', actor, who: p.member && p.member.login } : null;
    case 'PublicEvent': return { kind: 'public', actor };
    case 'ForkEvent': return { kind: 'fork', actor };
    case 'WatchEvent': return { kind: 'star', actor };
    case 'IssuesEvent': case 'PullRequestEvent': return p.action === 'opened' ? { kind: 'issue_pr', actor, what: e.type.replace('Event', '') } : null;
    default: return null;
  }
}
function fromWebhook(name, p) {
  const actor = (p.sender && p.sender.login) || (p.pusher && p.pusher.name) || 'unknown';
  switch (name) {
    case 'push': return { kind: 'push', actor, ref: p.ref, commits: (p.commits || []).length, forced: !!p.forced, deleted: !!p.deleted };
    case 'delete': return { kind: 'delete', actor, ref: p.ref, refType: p.ref_type };
    case 'member': return p.action === 'added' ? { kind: 'collaborator', actor, who: p.member && p.member.login } : null;
    case 'public': return { kind: 'public', actor };
    case 'fork': return { kind: 'fork', actor };
    case 'watch': return p.action === 'started' ? { kind: 'star', actor } : null;
    case 'repository': return ['publicized', 'deleted', 'transferred', 'privatized', 'archived'].includes(p.action) ? { kind: 'repository', actor, action: p.action } : null;
    case 'deploy_key': return { kind: 'deploy_key', actor, action: p.action };
    case 'branch_protection_rule': return { kind: 'protection', actor, action: p.action };
    case 'issues': case 'pull_request': return p.action === 'opened' ? { kind: 'issue_pr', actor, what: name } : null;
    default: return null;
  }
}

const H = (rule, detail) => ({ rule, severity: 'HIGH', detail });
const M = (rule, detail) => ({ rule, severity: 'MEDIUM', detail });
const L = (rule, detail) => ({ rule, severity: 'LOW', detail });

function classify(r, ev) {
  const who = ev.actor, trusted = isTrusted(r, who);
  switch (ev.kind) {
    case 'push':
      if (ev.forced) return H('GITHUB_FORCE_PUSH', `Force push by ${who} to ${ev.ref}`);
      if (ev.deleted) return H('GITHUB_BRANCH_DELETED', `${ev.ref} deleted by ${who} (via push)`);
      if (!trusted) return H('GITHUB_UNTRUSTED_PUSH', `Push by ${who} to ${ev.ref} (${ev.commits} commit(s)) — not in your trusted list`);
      if (ev.commits === 0 && ev.distinct === 0) return M('GITHUB_EMPTY_PUSH', `Push by ${who} to ${ev.ref} with 0 commits — possible history rewrite`);
      return null;
    case 'delete': return trusted ? M('GITHUB_REF_DELETED', `${ev.refType} ${ev.ref} deleted by ${who}`) : H('GITHUB_REF_DELETED', `${ev.refType} ${ev.ref} deleted by ${who} — not in your trusted list`);
    case 'collaborator': return H('GITHUB_COLLABORATOR_ADDED', `${ev.who || 'someone'} was added as collaborator by ${who}`);
    case 'public': return H('GITHUB_MADE_PUBLIC', `Repository was made PUBLIC by ${who}`);
    case 'repository': return ev.action === 'privatized' ? L('GITHUB_REPO_PRIVATIZED', `Repository made private by ${who}`) : H('GITHUB_REPO_' + ev.action.toUpperCase(), `Repository ${ev.action} by ${who}`);
    case 'deploy_key': return H('GITHUB_DEPLOY_KEY_' + String(ev.action).toUpperCase(), `Deploy key ${ev.action} by ${who}`);
    case 'protection': return H('GITHUB_BRANCH_PROTECTION_' + String(ev.action).toUpperCase(), `Branch protection rule ${ev.action} by ${who}`);
    case 'fork': return M('GITHUB_FORKED', `Repository forked by ${who}`);
    case 'star': return L('GITHUB_STARRED', `${who} starred the repository`);
    case 'issue_pr': return trusted ? null : L('GITHUB_ISSUE_OR_PR', `${ev.what} opened by ${who}`);
    default: return null;
  }
}

function raise(r, c, src) {
  hooks.record({ app: `github:${r.repo}`, ip: 'github', method: src, path: r.repo, rule: c.rule, severity: c.severity, action: 'ALERT', detail: c.detail });
  if (c.severity === 'HIGH') hooks.alert(`Aureon Security: GitHub — ${c.rule}`, `${r.repo}\n${c.detail}\n${new Date().toISOString()}\n\nIf this was not you: GitHub → Settings → Security log, rotate tokens, check collaborators/deploy keys.`);
}

function handleEvent(r, ev, src) {
  if (ev.kind === 'push' && isTrusted(r, ev.actor) && !ev.forced && !ev.deleted) r.status.lastPush = { actor: ev.actor, ref: ev.ref, at: new Date().toISOString() };
  const c = classify(r, ev);
  if (c) raise(r, c, src);
  return c;
}

// ---------- Events API polling ----------
async function pollEvents(r) {
  const res = await api(r, '/events?per_page=30', r.etag);
  if (res.status === 304) return;
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  if (res.etag) r.etag = res.etag;
  const list = Array.isArray(res.json) ? res.json : [];
  const idOf = (e) => BigInt(e.id);
  const last = r.lastEventId ? BigInt(r.lastEventId) : null;
  const fresh = list.filter((e) => last === null || idOf(e) > last).sort((a, b) => (idOf(a) < idOf(b) ? -1 : 1));
  if (list.length) r.lastEventId = list.reduce((m, e) => (idOf(e) > m ? idOf(e) : m), 0n).toString();
  if (!r.firstPollDone) { r.firstPollDone = true; return; }   // first run only sets the starting point
  for (const e of fresh) { const ev = fromApiEvent(e); if (ev) handleEvent(r, ev, 'EVENTS_API'); }
}

// ---------- state snapshot + diff ----------
async function checkPosture(r) {
  const warnings = [];
  const base = await api(r, '');
  if (base.status !== 200) throw new Error(`repo: HTTP ${base.status}${base.json && base.json.message ? ' ' + base.json.message : ''}`);
  const snap = { visibility: base.json.visibility || (base.json.private ? 'private' : 'public'), defaultBranch: base.json.default_branch || 'main' };
  const grab = async (label, suffix, mapFn) => {
    const x = await api(r, suffix);
    if (x.status === 200 && Array.isArray(x.json)) return x.json.map(mapFn).sort();
    warnings.push(`${label}: not visible (HTTP ${x.status}) — token needs admin read access`); return null;
  };
  snap.collaborators = await grab('collaborators', '/collaborators?per_page=100', (c) => String(c.login).toLowerCase());
  snap.keys = await grab('deploy keys', '/keys?per_page=100', (k) => `${k.id}:${k.title}`);
  snap.hooks = await grab('webhooks', '/hooks?per_page=100', (h) => `${h.id}:${(h.config && h.config.url) || ''}`);
  const pr = await api(r, `/branches/${encodeURIComponent(snap.defaultBranch)}/protection`);
  if (pr.status === 200) snap.protected = true;
  else if (pr.status === 404 && pr.json && /not protected/i.test(pr.json.message || '')) snap.protected = false;
  else { snap.protected = null; warnings.push(`branch protection: not visible (HTTP ${pr.status})`); }

  const cl = await api(r, '/traffic/clones');
  if (cl.status === 200 && cl.json) {
    const days = cl.json.clones || [], today = days[days.length - 1];
    r.status.traffic = { clones14d: cl.json.count, unique14d: cl.json.uniques, lastDay: today ? { day: today.timestamp.slice(0, 10), clones: today.count, unique: today.uniques } : null };
    if (today && today.uniques >= CLONE_ALERT && r.lastSpikeDay !== today.timestamp.slice(0, 10)) {
      r.lastSpikeDay = today.timestamp.slice(0, 10);
      raise(r, M('GITHUB_CLONE_SPIKE', `${today.uniques} unique cloners (${today.count} clones) on ${r.lastSpikeDay} — threshold ${CLONE_ALERT}`), 'TRAFFIC');
    }
  } else warnings.push(`clone traffic: not visible (HTTP ${cl.status})`);

  if (r.baseline) {
    const b = r.baseline;
    if (b.visibility !== 'public' && snap.visibility === 'public') raise(r, H('GITHUB_MADE_PUBLIC', 'Repository visibility changed to PUBLIC'), 'STATE_DIFF');
    if (b.defaultBranch !== snap.defaultBranch) raise(r, M('GITHUB_DEFAULT_BRANCH_CHANGED', `${b.defaultBranch} → ${snap.defaultBranch}`), 'STATE_DIFF');
    const added = (a, c) => (a && c ? c.filter((x) => !a.includes(x)) : []);
    for (const c of added(b.collaborators, snap.collaborators)) raise(r, H('GITHUB_COLLABORATOR_ADDED', `New collaborator: ${c}`), 'STATE_DIFF');
    for (const k of added(b.keys, snap.keys)) raise(r, H('GITHUB_DEPLOY_KEY_ADDED', `New deploy key: ${k.split(':').slice(1).join(':')}`), 'STATE_DIFF');
    for (const h of added(b.hooks, snap.hooks)) raise(r, H('GITHUB_WEBHOOK_CHANGED', `New / changed webhook: ${h.split(':').slice(1).join(':')}`), 'STATE_DIFF');
    if (b.protected === true && snap.protected === false) raise(r, H('GITHUB_BRANCH_PROTECTION_REMOVED', `Protection removed from ${snap.defaultBranch}`), 'STATE_DIFF');
  }
  r.baseline = snap; r.baselineAt = r.baselineAt || new Date().toISOString();
  r.status.warnings = warnings;
  r.status.posture = { at: new Date().toISOString(), visibility: snap.visibility, defaultBranch: snap.defaultBranch, protected: snap.protected,
    collaborators: snap.collaborators ? snap.collaborators.length : null, deployKeys: snap.keys ? snap.keys.length : null, webhooks: snap.hooks ? snap.hooks.length : null };
}

async function runAll() {
  await ready;
  await Promise.all(repos.map(async (r) => { await safe(r, 'events', pollEvents); await safe(r, 'posture', checkPosture); }));
}

// ---------- webhook receiver (mounted in server.js with express.raw BEFORE express.json) ----------
function webhook(req, res) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'GITHUB_WEBHOOK_SECRET not set on server' });
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
  const sig = String(req.header('x-hub-signature-256') || '');
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!ok) return res.status(401).json({ error: 'bad signature' });
  const id = req.header('x-github-delivery');
  if (id) { if (seenDeliveries.includes(id)) return res.json({ ok: true, duplicate: true }); seenDeliveries.push(id); if (seenDeliveries.length > 300) seenDeliveries.shift(); }
  const name = req.header('x-github-event');
  if (name === 'ping') return res.json({ ok: true, pong: true });
  let p; try { p = JSON.parse(raw.toString('utf8')); } catch (e) { return res.status(400).json({ error: 'bad json' }); }
  const full = p.repository && p.repository.full_name;
  const r = full && repos.find((x) => x.repo.toLowerCase() === String(full).toLowerCase());
  if (!r) return res.status(202).json({ ok: true, ignored: 'repo not monitored' });
  const ev = fromWebhook(name, p);
  if (ev) handleEvent(r, ev, 'WEBHOOK');
  persist();
  res.json({ ok: true });
}

// ---------- owner API helpers ----------
function publicRec(r) {
  return { id: r.id, repo: r.repo, trusted: r.trusted, addedAt: r.addedAt, hasToken: !!(r.tokenEnc || r.token), baselineAt: r.baselineAt, status: r.status };
}
function list() { return repos.map(publicRec); }
function add({ repo, token, trusted }) {
  repo = String(repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('owner/repo format mein daalo (jaise pavan/omnisell)');
  if (repos.some((x) => x.repo.toLowerCase() === repo.toLowerCase())) throw new Error('ye repo pehle se monitored hai');
  const rec = newRec(repo, { trusted: csv(trusted) });
  if (token) { const enc = box.encrypt(token); if (enc) rec.tokenEnc = enc; else rec.token = token; }
  repos.push(rec); persist();
  safe(rec, 'events', pollEvents).then(() => safe(rec, 'posture', checkPosture));
  return publicRec(rec);
}
function remove(id) { const n = repos.length; repos = repos.filter((r) => r.id !== id); if (repos.length !== n) persist(); return repos.length !== n; }

module.exports = { init, webhook, list, add, remove, runAll, _t: { classify, fromApiEvent, fromWebhook, pollEvents, checkPosture, setFetch: (f) => { fetchFn = f; }, repos: () => repos, newRec, ready: () => ready } };
