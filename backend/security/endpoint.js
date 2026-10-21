// security/endpoint.js — Windows Endpoint Agent backend (EDR-lite + managed host firewall).
//
// The agent (windows-agent/aureon-agent.ps1) runs on the PC, READS telemetry through supported
// Windows interfaces (Defender status, Windows Firewall profiles, listening ports, startup items,
// scheduled tasks, local admins, hot-fixes, unsigned processes) and sends it here with its own
// agent key. It can ALSO execute a small whitelist of response actions — but only after you have
// approved them here, and every action can be rolled back where that makes sense.
//
//   detect (this file)  ->  decide (you / policy)  ->  enforce (agent, whitelisted actions only)
//
// Detection, decision and enforcement are separate on purpose: even a compromised AI or a stolen
// dashboard viewer account cannot make the agent run anything. The agent itself re-validates
// every action (see aureon-agent.ps1) and never runs free-form commands.
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const store = require('../persist');
const DATA_DIR = require('../data-dir').dataDir();
const AG_FILE = path.join(DATA_DIR, 'endpoints.json'), REP_FILE = path.join(DATA_DIR, 'endpoint-reports.json'), ACT_FILE = path.join(DATA_DIR, 'endpoint-actions.json');

let agents = [], reports = {}, actions = [];
const ready = (async () => {
  await store.whenFirestore(20000);
  const a = await store.load('ep_agents', AG_FILE); if (Array.isArray(a.value)) agents = a.value;
  const r = await store.load('ep_reports', REP_FILE); if (r.value && typeof r.value === 'object') reports = r.value;
  const x = await store.load('ep_actions', ACT_FILE); if (Array.isArray(x.value)) actions = x.value;
})().catch((e) => console.error('[endpoint] load failed:', e.message));
let timer; const saveSoon = () => { clearTimeout(timer); timer = setTimeout(() => ready.then(() => Promise.all([store.save('ep_agents', agents, AG_FILE), store.save('ep_reports', reports, REP_FILE), store.save('ep_actions', actions.slice(-200), ACT_FILE)])).catch(() => {}), 1500); };
const hashKey = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');

// ---------------------------------------------------------------- agents
function createAgent(name) {
  const key = 'ek_' + crypto.randomBytes(24).toString('base64url');
  const a = { id: crypto.randomBytes(5).toString('hex'), name: String(name || 'Windows PC').slice(0, 40), keyHash: hashKey(key), createdAt: new Date().toISOString(), lastSeen: null };
  agents.push(a); saveSoon(); return { id: a.id, name: a.name, key };
}
function verifyKey(key) {
  if (typeof key !== 'string' || key.length < 20) return null;
  const h = hashKey(key); return agents.find((a) => crypto.timingSafeEqual(Buffer.from(a.keyHash), Buffer.from(h))) || null;
}
function removeAgent(id) { const n = agents.length; agents = agents.filter((a) => a.id !== id); delete reports[id]; actions = actions.filter((x) => x.agentId !== id); saveSoon(); return agents.length !== n; }
const listAgents = () => agents.map((a) => { const l = (reports[a.id] || []).slice(-1)[0]; return { id: a.id, name: a.name, createdAt: a.createdAt, lastSeen: a.lastSeen, online: !!a.lastSeen && Date.now() - Date.parse(a.lastSeen) < 15 * 60000, last: l ? { t: l.t, score: l.score, level: l.level, findings: l.findings.length, host: l.host } : null }; });
const latest = (id) => { const l = (reports[id] || []).slice(-1)[0]; return l ? { t: l.t, score: l.score, level: l.level, findings: l.findings, host: l.host, summary: l.summary } : null; };

// ---------------------------------------------------------------- analysis
const RISKY_PORTS = { 23: ['HIGH', 'Telnet'], 3389: ['HIGH', 'Remote Desktop (RDP)'], 5900: ['HIGH', 'VNC'], 445: ['MEDIUM', 'SMB file sharing'], 21: ['MEDIUM', 'FTP'], 5985: ['MEDIUM', 'WinRM'], 135: ['LOW', 'RPC'], 139: ['LOW', 'NetBIOS'] };
const USER_WRITABLE = /\\(AppData\\(Local\\Temp|Roaming|Local)|Temp|Downloads|Users\\Public|ProgramData)\\/i;
const str = (v, n) => String(v == null ? '' : v).slice(0, n || 120);

function analyze(raw, prev) {
  const f = []; const add = (sev, text, fix, key) => f.push({ sev, text, fix: fix || '', key: key || text.slice(0, 50) });
  const d = raw.defender || {}, fw = raw.firewall || {}, up = raw.updates || {}, sec = raw.security || {};
  if (d.enabled === false || d.realtime === false) add('HIGH', 'Microsoft Defender real-time protection band hai', 'Windows Security → Virus & threat protection → Real-time protection ON karo', 'defender-off');
  else if (typeof d.sigAgeDays === 'number' && d.sigAgeDays > 7) add('MEDIUM', `Defender ke virus definitions ${d.sigAgeDays} din purane hain`, 'Windows Update chalao ya dashboard se "Defender update" action approve karo', 'defender-sig');
  if (d.tamper === false) add('LOW', 'Defender Tamper Protection band hai', 'Windows Security → Virus & threat protection settings mein ON karo', 'tamper');
  for (const p of ['Domain', 'Private', 'Public']) if (fw[p] === false) add(p === 'Public' ? 'HIGH' : 'MEDIUM', `Windows Firewall (${p} profile) band hai`, 'Dashboard se "Firewall ON" action approve karo ya Windows Security mein ON karo', 'fw-' + p);
  const seenPorts = new Set();
  for (const l of (raw.listening || []).slice(0, 300)) {
    const rp = RISKY_PORTS[l.port]; const open = /^(0\.0\.0\.0|::|\*)$/.test(String(l.addr || ''));
    if (rp && open && !seenPorts.has(l.port)) { seenPorts.add(l.port); add(rp[0], `${rp[1]} (port ${l.port}) poore network par khula hai${l.proc ? ' — ' + str(l.proc, 40) : ''}`, 'Zaroorat nahi to service band karo ya firewall rule se sirf trusted IP tak seemit karo', 'port-' + l.port); }
  }
  let unsignedTemp = 0;
  for (const p of (raw.processes || []).slice(0, 200)) {
    if (p.signed === false && USER_WRITABLE.test(String(p.path || ''))) { if (unsignedTemp++ < 5) add('HIGH', `Unsigned program user-writable folder se chal raha hai: ${str(p.name, 40)} (${str(p.path, 90)})`, 'Pehchante nahi to process band karo (dashboard action) aur file delete karo; malware aksar yahin se chalta hai', 'proc:' + p.path); }
  }
  for (const s of (raw.startup || []).slice(0, 100)) if (USER_WRITABLE.test(String(s.cmd || ''))) add('MEDIUM', `Startup entry user-writable folder ki file chalati hai: ${str(s.name, 40)}`, 'Persistence ka aam tareeka — pehchante nahi to hata do', 'start:' + s.name);
  for (const t of (raw.tasks || []).slice(0, 100)) if (USER_WRITABLE.test(String(t.path || ''))) add('MEDIUM', `Scheduled task user-writable folder ki file chalata hai: ${str(t.name, 40)}`, 'Pehchante nahi to task disable karo', 'task:' + t.name);
  const admins = (raw.admins || []).map((x) => str(x, 60));
  if (admins.length > 3) add('MEDIUM', `${admins.length} accounts local Administrators mein hain`, 'Sirf zaroori accounts rakho (least privilege)', 'admins-many');
  if (typeof up.lastHotfixDays === 'number') { if (up.lastHotfixDays > 120) add('HIGH', `Windows ko ${up.lastHotfixDays} din se koi security update nahi mila`, 'Windows Update turant chalao', 'updates'); else if (up.lastHotfixDays > 60) add('MEDIUM', `Last Windows update ${up.lastHotfixDays} din purana hai`, 'Windows Update chalao', 'updates'); }
  if (up.pendingReboot) add('LOW', 'Updates ke baad restart baaki hai', 'PC restart karo', 'reboot');
  if (sec.uac === false) add('HIGH', 'UAC (User Account Control) band hai', 'Control Panel → User Accounts → UAC settings ON karo', 'uac');
  if (sec.smb1 === true) add('HIGH', 'SMBv1 (purana, khatarnaak protocol) chalu hai', 'Windows Features mein SMB 1.0 band karo', 'smb1');
  if (sec.bitlocker === false) add('MEDIUM', 'Drive encryption (BitLocker) band hai — PC chori ho to data khula', 'BitLocker / Device encryption ON karo', 'bitlocker');
  if (sec.rdp === true && !seenPorts.has(3389)) add('LOW', 'Remote Desktop chalu hai', 'Zaroorat nahi to band karo', 'rdp');

  const pen = { HIGH: 20, MEDIUM: 8, LOW: 3 };
  const seen = new Set(); const uniq = f.filter((x) => (seen.has(x.key) ? false : seen.add(x.key)));
  const score = Math.max(0, 100 - uniq.reduce((s, x) => s + pen[x.sev], 0));
  // what is NEW since the last report (persistence / exposure drift)
  const keysOf = (r) => ({ start: (r.startup || []).map((x) => x.name), tasks: (r.tasks || []).map((x) => x.name), admins: r.admins || [], ports: (r.listening || []).map((x) => x.port) });
  const cur = keysOf(raw), old = prev && prev.keys ? prev.keys : null;
  const drift = old ? [
    ...cur.start.filter((x) => !old.start.includes(x)).map((x) => ({ rule: 'ENDPOINT_NEW_STARTUP', sev: 'MEDIUM', text: `Naya startup entry: ${str(x, 60)}` })),
    ...cur.tasks.filter((x) => !old.tasks.includes(x)).map((x) => ({ rule: 'ENDPOINT_NEW_TASK', sev: 'MEDIUM', text: `Naya scheduled task: ${str(x, 60)}` })),
    ...cur.admins.filter((x) => !old.admins.includes(x)).map((x) => ({ rule: 'ENDPOINT_NEW_ADMIN', sev: 'HIGH', text: `Naya local administrator: ${str(x, 60)}` })),
    ...[...new Set(cur.ports)].filter((x) => !old.ports.includes(x) && RISKY_PORTS[x]).map((x) => ({ rule: 'ENDPOINT_NEW_PORT', sev: RISKY_PORTS[x][0], text: `Naya khula port ${x} (${RISKY_PORTS[x][1]})` })),
  ] : [];
  return { score, level: score >= 80 ? 'GOOD' : score >= 50 ? 'ATTENTION' : 'RISK', findings: uniq.sort((a, b) => 'HIGH MEDIUM LOW'.indexOf(a.sev) - 'HIGH MEDIUM LOW'.indexOf(b.sev)), drift, keys: cur };
}
function ingest(agent, raw, hooks) {
  if (!raw || typeof raw !== 'object') throw new Error('bad report');
  const prev = (reports[agent.id] || []).slice(-1)[0];
  const a = analyze(raw, prev);
  const host = { name: str((raw.host || {}).name, 40), os: str((raw.host || {}).os, 60), build: str((raw.host || {}).build, 20) };
  const rec = { t: new Date().toISOString(), score: a.score, level: a.level, findings: a.findings, host, keys: a.keys, summary: { listening: (raw.listening || []).length, startup: (raw.startup || []).length, tasks: (raw.tasks || []).length, admins: (raw.admins || []).length, processes: (raw.processes || []).length } };
  reports[agent.id] = (reports[agent.id] || []).concat(rec).slice(-10);
  agent.lastSeen = rec.t; saveSoon();
  const prevKeys = new Set(prev ? prev.findings.map((x) => x.key) : []);
  const fresh = a.findings.filter((x) => x.sev === 'HIGH' && !prevKeys.has(x.key));
  for (const x of fresh.slice(0, 5)) hooks && hooks.record({ app: `pc:${agent.name}`, ip: '-', method: 'ENDPOINT', path: agent.name, rule: 'ENDPOINT_RISK', severity: 'HIGH', action: 'ALERT', detail: x.text });
  for (const dr of a.drift.slice(0, 8)) hooks && hooks.record({ app: `pc:${agent.name}`, ip: '-', method: 'ENDPOINT', path: agent.name, rule: dr.rule, severity: dr.sev, action: 'ALERT', detail: dr.text });
  const hi = a.drift.filter((x) => x.sev === 'HIGH');
  if (hooks && (fresh.length || hi.length)) hooks.alert(`Aureon Security: "${agent.name}" PC mein naya khatra`, [...fresh.map((x) => `• ${x.text}\n  → ${x.fix}`), ...hi.map((x) => `• ${x.text}`)].join('\n\n'));
  return a;
}

// ---------------------------------------------------------------- response actions (propose -> approve -> agent executes -> result / rollback)
const PROFILES = ['Domain', 'Private', 'Public'];
function validateAction(type, p) {
  p = p || {};
  switch (type) {
    case 'block_ip': { if (!net.isIPv4(String(p.ip))) throw new Error('block_ip ke liye valid IPv4 chahiye'); if (/^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(p.ip)) throw new Error('Private / local IP block nahi hota'); return { ip: p.ip }; }
    case 'unblock_ip': { if (!net.isIPv4(String(p.ip))) throw new Error('valid IPv4 chahiye'); return { ip: p.ip }; }
    case 'enable_firewall': { if (!PROFILES.includes(p.profile)) throw new Error('profile: Domain | Private | Public'); return { profile: p.profile }; }
    case 'defender_update': case 'defender_quick_scan': return {};
    case 'terminate_process': { const pid = parseInt(p.pid, 10); if (!(pid > 4)) throw new Error('pid galat'); if (!/^[\w.\- ]{1,60}\.exe$/i.test(String(p.name || ''))) throw new Error('process ka naam (x.exe) chahiye — pid reuse se bachne ke liye'); return { pid, name: p.name }; }
    default: throw new Error('action type: block_ip | unblock_ip | enable_firewall | defender_update | defender_quick_scan | terminate_process');
  }
}
const NEEDS_ROLLBACK = { block_ip: 'unblock_ip' };
function propose(agentId, type, params, by) {
  if (!agents.some((a) => a.id === agentId)) throw new Error('agent nahi mila');
  const p = validateAction(type, params);
  if (actions.filter((x) => x.agentId === agentId && ['proposed', 'approved'].includes(x.status)).length >= 20) throw new Error('Pehle purane pending actions nipta lo (max 20)');
  const a = { id: crypto.randomBytes(5).toString('hex'), agentId, type, params: p, status: 'proposed', proposedBy: by, createdAt: new Date().toISOString(), approvedBy: null, approvedAt: null, sentAt: null, doneAt: null, result: null, rollbackOf: null };
  actions.push(a); saveSoon(); return a;
}
function approve(id, by) { const a = actions.find((x) => x.id === id); if (!a) throw new Error('action nahi mila'); if (a.status !== 'proposed') throw new Error('sirf "proposed" action approve hota hai'); a.status = 'approved'; a.approvedBy = by; a.approvedAt = new Date().toISOString(); saveSoon(); return a; }
function reject(id, by) { const a = actions.find((x) => x.id === id); if (!a) throw new Error('action nahi mila'); if (!['proposed', 'approved'].includes(a.status)) throw new Error('ye action ab reject nahi ho sakta'); a.status = 'rejected'; a.result = `rejected by ${by}`; a.doneAt = new Date().toISOString(); saveSoon(); return a; }
function rollback(id, by) {
  const a = actions.find((x) => x.id === id); if (!a) throw new Error('action nahi mila');
  if (a.status !== 'done') throw new Error('sirf poora ho chuka action rollback hota hai');
  const rb = NEEDS_ROLLBACK[a.type]; if (!rb) throw new Error('Is action ka automatic rollback nahi hai (firewall ON / terminate / scan ko undo nahi karte)');
  const n = propose(a.agentId, rb, a.params, by); n.rollbackOf = a.id; return n;
}
// agent -> server: fetch approved actions (marks them "sent"); stale approvals expire after 30 min
function poll(agent) {
  const now = Date.now(); const out = [];
  for (const a of actions) {
    if (a.agentId !== agent.id) continue;
    if (a.status === 'approved' && now - Date.parse(a.approvedAt) > 30 * 60000) { a.status = 'expired'; a.doneAt = new Date().toISOString(); continue; }
    if (a.status === 'approved') { a.status = 'sent'; a.sentAt = new Date().toISOString(); out.push({ id: a.id, type: a.type, params: a.params }); }
  }
  agent.lastSeen = new Date().toISOString(); saveSoon(); return out;
}
function result(agent, actionId, ok, message) {
  const a = actions.find((x) => x.id === actionId && x.agentId === agent.id); if (!a || a.status !== 'sent') throw new Error('action nahi mila');
  a.status = ok ? 'done' : 'failed'; a.result = str(message, 200); a.doneAt = new Date().toISOString(); saveSoon(); return a;
}
const listActions = (agentId) => actions.filter((a) => !agentId || a.agentId === agentId).slice(-60).reverse();
const exportState = () => ({ agents, actions: actions.slice(-100) });
function importState(v) { if (v && Array.isArray(v.agents)) agents = v.agents; if (v && Array.isArray(v.actions)) actions = v.actions; saveSoon(); }

module.exports = { createAgent, verifyKey, removeAgent, listAgents, latest, ingest, analyze, propose, approve, reject, rollback, poll, result, listActions, exportState, importState, validateAction, ready };
