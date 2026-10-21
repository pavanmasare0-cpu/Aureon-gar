// security/soc.js — Security Operations Center core.
//
//   events  ->  enrichment (threat intel)  ->  correlation rules  ->  CASES (incidents)
//
// * A single failed login / blocked probe is NOT an incident (nothing is "confirmed hacking").
//   Events add up per entity (IP, GitHub repo, phone, dashboard); a case opens only when the
//   evidence score is high enough or a correlation rule fires. Every case says WHY (explainable).
// * Workflow: open -> investigating -> resolved (true_positive | false_positive | benign) /
//   auto-closed. Analysts add notes, assign, export evidence (JSON / CSV / printable HTML with an
//   integrity hash). Resolutions feed per-rule precision, so you can see which detections cry wolf.
const crypto = require('crypto');
const path = require('path');
const store = require('../persist');
const ti = require('./threatintel');
const DATA_DIR = require('../data-dir').dataDir();
const FILE_CASES = path.join(DATA_DIR, 'soc-cases.json'), FILE_FP = path.join(DATA_DIR, 'soc-fp.json');

let cases = [];
let fp = {};                          // rule -> { tp, fp, benign }
const recent = [];                    // rolling event buffer used for correlation
const WEIGHT = { HIGH: 30, MEDIUM: 10, LOW: 2, INFO: 0 };
const SEV_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const sevFromScore = (s) => (s >= 90 ? 'CRITICAL' : s >= 45 ? 'HIGH' : s >= 20 ? 'MEDIUM' : 'LOW');
const maxSev = (a, b) => (SEV_ORDER.indexOf(a) >= SEV_ORDER.indexOf(b) ? a : b);

const ready = (async () => {
  await store.whenFirestore(20000);
  const c = await store.load('soc_cases', FILE_CASES); if (Array.isArray(c.value)) cases = c.value;
  const f = await store.load('soc_fp', FILE_FP); if (f.value && typeof f.value === 'object') fp = f.value;
})().catch((e) => console.error('[soc] load failed:', e.message));
let timer; const saveSoon = () => { clearTimeout(timer); timer = setTimeout(() => ready.then(() => Promise.all([store.save('soc_cases', cases, FILE_CASES), store.save('soc_fp', fp, FILE_FP)])).catch(() => {}), 2000); };

const ts = (e) => Date.parse(e.t) || Date.now();
const within = (e, ms, now) => (now || Date.now()) - ts(e) <= ms;
function entityOf(ev) {
  if (ev.app === 'dashboard') return 'dashboard:' + (ev.ip || '-');
  if (ev.app && ev.app !== 'aureon-backend') return ev.app;
  return 'ip:' + (ev.ip || '-');
}
const isPublic = (ip) => ip && ip !== '-' && !/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc|fd|fe80)/i.test(ip);

// ---------------------------------------------------------------- correlation rules
const RECON = new Set(['SCANNER_PROBE', 'PATH_TRAVERSAL', 'SYSTEM_FILE', 'SCANNER_BEHAVIOR', 'ATTACK_TOOL_UA']);
const AUTHATK = new Set(['DASH_LOGIN_FAILED', 'DASH_LOGIN_BRUTEFORCE', 'OWNER_CODE_BRUTEFORCE']);
const REPO_BAD = new Set(['GITHUB_DEPLOY_KEY_ADDED', 'GITHUB_WEBHOOK_CHANGED', 'GITHUB_UNTRUSTED_PUSH', 'GITHUB_FORCE_PUSH', 'GITHUB_MADE_PUBLIC', 'GITHUB_BRANCH_PROTECTION_REMOVED']);
const CORRELATIONS = [
  { id: 'recon-then-login-attack', title: 'Reconnaissance followed by a login attack', severity: 'CRITICAL',
    test: (ev, E, now) => { if (!ev.ip || ev.ip === '-') return null; const m = E.filter((e) => e.ip === ev.ip && within(e, 30 * 60000, now)); const a = m.find((e) => RECON.has(e.rule)), b = m.find((e) => AUTHATK.has(e.rule)); return a && b ? { entity: 'ip:' + ev.ip, ev: [a, b], why: `Same IP ${ev.ip} first probed the server (${a.rule}) and then attacked the login (${b.rule}) within 30 minutes — a typical attack sequence.` } : null; } },
  { id: 'distributed-bruteforce', title: 'Distributed brute-force on the dashboard', severity: 'CRITICAL',
    test: (ev, E, now) => { if (ev.rule !== 'DASH_LOGIN_FAILED') return null; const m = E.filter((e) => e.rule === 'DASH_LOGIN_FAILED' && within(e, 10 * 60000, now)); const ips = new Set(m.map((e) => e.ip)); return ips.size >= 5 ? { entity: 'dashboard:distributed', ev: m.slice(-8), why: `${ips.size} different IPs failed to log in within 10 minutes — guessing spread across addresses to avoid lockout.` } : null; } },
  { id: 'possible-account-takeover', title: 'Possible dashboard account takeover', severity: 'HIGH',
    test: (ev, E, now) => { if (ev.rule !== 'DASH_SENSITIVE_ACTION' && ev.rule !== 'DASH_NEW_DEVICE' && ev.rule !== 'DASH_SESSION_IP_CHANGED') return null; const m = E.filter((e) => e.ip === ev.ip && within(e, 10 * 60000, now)); const sig = m.find((e) => e.rule === 'DASH_NEW_DEVICE' || e.rule === 'DASH_SESSION_IP_CHANGED'); const acts = m.filter((e) => e.rule === 'DASH_SENSITIVE_ACTION'); return sig && acts.length >= 3 ? { entity: 'dashboard:' + ev.ip, ev: [sig, ...acts.slice(-3)], why: `A ${sig.rule === 'DASH_NEW_DEVICE' ? 'login from a new device' : 'session that jumped to a new network'} was followed by ${acts.length} sensitive actions within 10 minutes. If this was not you: revoke sessions and rotate SENTINEL_OWNER_CODE.` } : null; } },
  { id: 'repo-takeover-attempt', title: 'GitHub repository takeover pattern', severity: 'CRITICAL',
    test: (ev, E, now) => { if (!String(ev.app || '').startsWith('github:')) return null; const m = E.filter((e) => e.app === ev.app && within(e, 60 * 60000, now)); const a = m.find((e) => e.rule === 'GITHUB_COLLABORATOR_ADDED'), b = m.find((e) => REPO_BAD.has(e.rule)); return a && b ? { entity: ev.app, ev: [a, b], why: `A new collaborator was added and then ${b.rule} happened on the same repository within an hour — attackers typically add access first, then plant persistence.` } : null; } },
  { id: 'multiple-phone-risks', title: 'Several serious risks on one phone', severity: 'HIGH',
    test: (ev, E, now) => { if (ev.rule !== 'PHONE_RISK') return null; const m = E.filter((e) => e.app === ev.app && e.rule === 'PHONE_RISK' && within(e, 24 * 3600000, now)); return m.length >= 2 ? { entity: ev.app, ev: m.slice(-4), why: `${m.length} HIGH-risk findings on ${ev.app} in 24 hours (${m.map((x) => x.detail.slice(0, 40)).join(' | ')}).` } : null; } },
  { id: 'flood-and-scan', title: 'Flood combined with scanning', severity: 'HIGH',
    test: (ev, E, now) => { if (!ev.ip || ev.ip === '-') return null; const m = E.filter((e) => e.ip === ev.ip && within(e, 30 * 60000, now)); const a = m.find((e) => e.rule === 'DDOS_FLOOD' || e.rule === 'RATE_LIMIT'), b = m.find((e) => RECON.has(e.rule)); return a && b ? { entity: 'ip:' + ev.ip, ev: [a, b], why: `${ev.ip} is both flooding (${a.rule}) and scanning (${b.rule}).` } : null; } },
  { id: 'threat-intel-plus-activity', title: 'Known-bad IP is actively attacking', severity: 'HIGH',
    test: (ev, E, now) => { if (!ev.ioc || !ev.ip) return null; const m = E.filter((e) => e.ip === ev.ip && !e.ioc && within(e, 30 * 60000, now) && e.severity !== 'INFO'); return m.length ? { entity: 'ip:' + ev.ip, ev: [ev, m[m.length - 1]], why: `${ev.ip} is on ${ev.ioc.list} AND is generating attack events here (${m[m.length - 1].rule}).` } : null; } },
];

// ---------------------------------------------------------------- ingest
function ingest(ev) {
  const now = Date.now();
  const e = Object.assign({}, ev);
  if (isPublic(e.ip)) { const hit = ti.matchIp(e.ip); if (hit) e.ioc = hit; }
  recent.push(e); if (recent.length > 3000) recent.shift();
  const ent = entityOf(e);
  const open = cases.find((c) => c.entity === ent && (c.status === 'open' || c.status === 'investigating') && now - Date.parse(c.updated) < 6 * 3600000);
  const pend = recent.filter((x) => entityOf(x) === ent && within(x, 30 * 60000, now));
  const score = pend.reduce((s, x) => s + (WEIGHT[x.severity] || 0) + (x.action === 'BLOCKED' ? 5 : 0) + (x.ioc ? 40 : 0), 0);
  let target = open;
  if (open) addEvent(open, e);
  else if (e.severity === 'HIGH' || score >= 30 || e.ioc) { target = newCase(ent, pend); }
  for (const c of CORRELATIONS) {
    let r = null; try { r = c.test(e, recent, now); } catch (err) { r = null; }
    if (!r) continue;
    let cc = cases.find((x) => x.entity === r.entity && x.corr && x.corr.includes(c.id) && (x.status === 'open' || x.status === 'investigating'));
    if (!cc) { cc = cases.find((x) => x.entity === r.entity && (x.status === 'open' || x.status === 'investigating')) || newCase(r.entity, r.ev); }
    cc.corr = Array.from(new Set([...(cc.corr || []), c.id]));
    if (!cc.why.includes(r.why)) cc.why.push(r.why);
    cc.title = c.title; cc.severity = maxSev(cc.severity, c.severity); cc.score = Math.max(cc.score, 90);
    for (const x of r.ev) if (!cc.events.some((y) => y.id === x.id)) cc.events.push(slim(x));
    cc.updated = new Date().toISOString(); target = cc;
  }
  saveSoon();
  return target ? target.id : null;
}
const slim = (e) => ({ id: e.id, t: e.t, ip: e.ip, app: e.app, rule: e.rule, severity: e.severity, action: e.action, detail: String(e.detail || '').slice(0, 200), path: String(e.path || '').slice(0, 120), ioc: e.ioc ? e.ioc.list : undefined });
function newCase(ent, evs) {
  const c = { id: 'C-' + crypto.randomBytes(3).toString('hex').toUpperCase(), entity: ent, status: 'open', severity: 'LOW', score: 0, title: '', created: new Date().toISOString(), updated: new Date().toISOString(), events: [], why: [], corr: [], assignee: null, notes: [], resolution: null, resolvedAt: null };
  cases.unshift(c); if (cases.length > 300) { const i = cases.map((x) => x.status).lastIndexOf('resolved'); cases.splice(i >= 0 ? i : cases.length - 1, 1); }
  for (const e of evs) addEvent(c, e);
  return c;
}
function addEvent(c, e) {
  if (!c.events.some((y) => y.id === e.id)) c.events.push(slim(e)); if (c.events.length > 120) c.events.shift();
  c.score = Math.min(100, c.events.reduce((s, x) => s + (WEIGHT[x.severity] || 0) + (x.action === 'BLOCKED' ? 5 : 0) + (x.ioc ? 40 : 0), 0));
  c.severity = maxSev(c.severity, sevFromScore(c.score));
  const hit = c.events.find((x) => x.ioc); const top = c.events.slice().sort((a, b) => (WEIGHT[b.severity] || 0) - (WEIGHT[a.severity] || 0))[0];
  const why = `${c.events.length} event(s), strongest: ${top.rule} (${top.severity})${hit ? '; IP is on a threat list (' + hit.ioc + ')' : ''}.`;
  c.why = c.why.filter((w) => !/^\d+ event\(s\), strongest/.test(w)); c.why.unshift(why);
  if (!c.title) c.title = `${top.rule} — ${c.entity}`;
  c.updated = new Date().toISOString();
}

// ---------------------------------------------------------------- workflow
const listCases = (status) => cases.filter((c) => !status || (status === 'active' ? (c.status === 'open' || c.status === 'investigating') : c.status === status)).map((c) => ({ id: c.id, title: c.title, entity: c.entity, status: c.status, severity: c.severity, score: c.score, events: c.events.length, assignee: c.assignee, created: c.created, updated: c.updated, corr: c.corr }));
const getCase = (id) => cases.find((c) => c.id === id) || null;
function updateCase(id, patch, by) {
  const c = getCase(id); if (!c) throw new Error('case nahi mila');
  if (patch.status) {
    if (!['open', 'investigating', 'resolved'].includes(patch.status)) throw new Error('status: open | investigating | resolved');
    if (patch.status === 'resolved') {
      const res = patch.resolution; if (!['true_positive', 'false_positive', 'benign'].includes(res)) throw new Error('resolved ke saath resolution chahiye: true_positive | false_positive | benign');
      c.resolution = res; c.resolvedAt = new Date().toISOString();
      for (const r of new Set(c.events.map((e) => e.rule))) { const f = fp[r] || (fp[r] = { tp: 0, fp: 0, benign: 0 }); if (res === 'true_positive') f.tp++; else if (res === 'false_positive') f.fp++; else f.benign++; }
    } else { c.resolution = null; c.resolvedAt = null; }
    c.status = patch.status; c.notes.push({ t: new Date().toISOString(), by, text: `status -> ${patch.status}${c.resolution ? ' (' + c.resolution + ')' : ''}` });
  }
  if (patch.assignee !== undefined) { c.assignee = patch.assignee ? String(patch.assignee).slice(0, 40) : null; c.notes.push({ t: new Date().toISOString(), by, text: `assigned to ${c.assignee || 'nobody'}` }); }
  if (patch.note) c.notes.push({ t: new Date().toISOString(), by, text: String(patch.note).slice(0, 1000) });
  if (c.notes.length > 100) c.notes.splice(0, c.notes.length - 100);
  c.updated = new Date().toISOString(); saveSoon(); return c;
}
setInterval(() => { const now = Date.now(); for (const c of cases) if ((c.status === 'open') && now - Date.parse(c.updated) > 24 * 3600000 && !['HIGH', 'CRITICAL'].includes(c.severity)) { c.status = 'resolved'; c.resolution = 'auto_closed'; c.resolvedAt = new Date().toISOString(); c.notes.push({ t: c.resolvedAt, by: 'system', text: 'auto-closed: no new events for 24 h (low/medium)' }); } saveSoon(); }, 10 * 60000).unref();

function stats() {
  const act = cases.filter((c) => c.status === 'open' || c.status === 'investigating');
  const res = cases.filter((c) => c.status === 'resolved' && c.resolvedAt);
  const mttr = res.length ? Math.round(res.reduce((s, c) => s + (Date.parse(c.resolvedAt) - Date.parse(c.created)), 0) / res.length / 60000) : null;
  const bySev = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }; act.forEach((c) => { bySev[c.severity]++; });
  const rules = Object.entries(fp).map(([rule, f]) => ({ rule, tp: f.tp, fp: f.fp, benign: f.benign, precision: f.tp + f.fp ? Math.round(100 * f.tp / (f.tp + f.fp)) : null })).sort((a, b) => (b.tp + b.fp) - (a.tp + a.fp)).slice(0, 15);
  return { active: act.length, total: cases.length, bySeverity: bySev, mttrMinutes: mttr, rules };
}
const timeline = (limit) => recent.slice(-(limit || 100)).reverse().map(slim);

// ---------------------------------------------------------------- evidence export
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const csvCell = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };   // also stops spreadsheet formula injection
function exportCase(id, fmt, by, auditEntries) {
  const c = getCase(id); if (!c) throw new Error('case nahi mila');
  const core = { case: { id: c.id, title: c.title, entity: c.entity, status: c.status, severity: c.severity, score: c.score, created: c.created, updated: c.updated, resolution: c.resolution, assignee: c.assignee, correlations: c.corr, why: c.why }, events: c.events, notes: c.notes };
  const sha = crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex');
  const meta = { exportedAt: new Date().toISOString(), exportedBy: by, sha256: sha, note: 'sha256 covers case + events + notes; re-compute to prove the export was not altered' };
  if (fmt === 'csv') {
    const head = ['time', 'ip', 'app', 'rule', 'severity', 'action', 'detail', 'path', 'threat_intel'];
    const rows = c.events.map((e) => [e.t, e.ip, e.app, e.rule, e.severity, e.action, e.detail, e.path, e.ioc || ''].map(csvCell).join(','));
    return { type: 'text/csv; charset=utf-8', name: `${c.id}-evidence.csv`, body: head.join(',') + '\n' + rows.join('\n') + `\n# sha256 ${sha}\n` };
  }
  if (fmt === 'html') {
    const body = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(c.id)} — incident report</title><style>body{font:14px/1.5 -apple-system,Segoe UI,sans-serif;max-width:860px;margin:30px auto;padding:0 16px;color:#111}h1{font-size:20px}table{border-collapse:collapse;width:100%;font-size:12px}td,th{border:1px solid #ccc;padding:5px 7px;text-align:left;vertical-align:top}th{background:#f2f2f2}.sev{font-weight:700}.meta{color:#555;font-size:12px}</style></head><body>
<h1>Incident ${esc(c.id)} — ${esc(c.title)}</h1><div class="meta">Entity: ${esc(c.entity)} · Severity: <span class="sev">${esc(c.severity)}</span> (score ${c.score}/100) · Status: ${esc(c.status)}${c.resolution ? ' (' + esc(c.resolution) + ')' : ''} · Opened ${esc(c.created)}</div>
<h2>Why this is an incident</h2><ul>${c.why.map((w) => '<li>' + esc(w) + '</li>').join('')}</ul>
<h2>Timeline (${c.events.length} events)</h2><table><tr><th>Time</th><th>IP</th><th>Source</th><th>Rule</th><th>Sev</th><th>Action</th><th>Detail</th></tr>${c.events.map((e) => `<tr><td>${esc(e.t)}</td><td>${esc(e.ip)}</td><td>${esc(e.app)}</td><td>${esc(e.rule)}</td><td>${esc(e.severity)}</td><td>${esc(e.action)}</td><td>${esc(e.detail)} ${esc(e.path)}${e.ioc ? ' <b>[threat list: ' + esc(e.ioc) + ']</b>' : ''}</td></tr>`).join('')}</table>
<h2>Analyst notes</h2><ul>${c.notes.map((n) => `<li>${esc(n.t)} — <b>${esc(n.by)}</b>: ${esc(n.text)}</li>`).join('') || '<li>none</li>'}</ul>
${auditEntries && auditEntries.length ? '<h2>Dashboard audit entries from the same IP</h2><ul>' + auditEntries.map((a) => `<li>${esc(a.t)} — ${esc(a.event)}: ${esc(a.detail)}</li>`).join('') + '</ul>' : ''}
<p class="meta">Exported ${esc(meta.exportedAt)} by ${esc(by)} · SHA-256 of case+events+notes: <code>${sha}</code></p></body></html>`;
    return { type: 'text/html; charset=utf-8', name: `${c.id}-report.html`, body };
  }
  return { type: 'application/json; charset=utf-8', name: `${c.id}-evidence.json`, body: JSON.stringify(Object.assign({}, core, { audit: auditEntries || [], integrity: meta }), null, 2) };
}
const exportState = () => ({ cases, fp });
function importState(v) { if (v && Array.isArray(v.cases)) cases = v.cases.slice(0, 300); if (v && v.fp) fp = v.fp; saveSoon(); }

module.exports = { ingest, listCases, getCase, updateCase, stats, timeline, exportCase, exportState, importState, ready, _t: { CORRELATIONS, reset: () => { cases = []; fp = {}; recent.length = 0; }, cases: () => cases } };
