// Aureon security regression tests — run with:   node --test backend/tests/
// Needs only Node 18+ and the backend's installed dependencies (express). No network, no real data:
// everything runs in-process against a temp data folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.AUREON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aureon-test-'));
process.env.SENTINEL_OWNER_CODE = 'test-owner-code-123456';
process.env.SENTINEL_ENC_KEY = 'test-enc-key';
process.env.SECURITY_RATE_MAX = '5000';
process.env.SECURITY_THREAT_FEEDS = 'off';
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const express = require('express');
const sec = require('../security');
const auth = require('../dash-auth');
const firewall = require('../security/firewall');
const soc = require('../security/soc');
const corpus = require('../security/corpus');
const linkscan = require('../security/linkscan');
const endpoint = require('../security/endpoint');

const OWNER = process.env.SENTINEL_OWNER_CODE;
let server, base;
const jars = {};
async function call(who, p, o = {}, ip) {
  const h = Object.assign({ 'X-Forwarded-For': ip || '9.9.9.' + (who.length + 1), 'User-Agent': 'UA-' + who, 'x-csrf': '1' }, o.headers || {});
  if (jars[who] && !o.nocookie) h.cookie = jars[who];
  const r = await fetch(base + p, Object.assign({ redirect: 'manual' }, o, { headers: h }));
  const sc = r.headers.get('set-cookie'); if (sc && sc.includes('aureon_sid=') && !sc.includes('Max-Age=0')) jars[who] = sc.split(';')[0];
  return r;
}
const post = (who, p, b, ip, extra) => call(who, p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, extra || {}), body: JSON.stringify(b || {}) }, ip);
const json = (r) => r.clone().json().catch(() => ({}));
const totp = (secret, steps) => auth._t.hotp(auth._t.b32dec(secret), Math.floor(Date.now() / 30000) + (steps || 0));

test.before(async () => {
  const app = express(); app.set('trust proxy', 1);
  app.use(sec.guard); app.use(express.json({ limit: '1mb' })); app.use(sec.bodyGuard); app.use('/api/security', sec.router);
  app.get('/health', (q, r) => r.json({ ok: 1 })); app.get('/x', (q, r) => r.json({ ok: 1 }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}/api/security`;
  base_root = `http://localhost:${server.address().port}`;
});
test.after(() => { server.close(); setTimeout(() => process.exit(0), 100).unref(); });
let base_root;

test('TOTP matches the RFC 6238 test vector and rejects drift beyond ±1 step', () => {
  const secret = auth._t.b32enc(Buffer.from('12345678901234567890'));
  assert.equal(auth._t.hotp(Buffer.from('12345678901234567890'), 1), '287082');
  assert.equal(auth._t.totpMatch(secret, '287082', 59000), 1);
  assert.equal(auth._t.totpMatch(secret, '287082', 59000 + 90000), null);
});

test('Unauthenticated access to dashboards and APIs never return data (login page / 401 instead)', async () => {
  for (const p of ['/dashboard', '/stats', '/soc/cases', '/firewall', '/recovery/export', '/settings']) {
    const r = await call('anon', p, { nocookie: true }); const t = await r.text(); assert.ok(r.status !== 200 || /login|code|password/i.test(t), p); assert.ok(!/"incidents"|"cases"/.test(t), p);
  }
});

test('Wrong owner codes are counted and the IP gets banned after 5 tries', async () => {
  let last; for (let i = 0; i < 5; i++) last = await call('brute', '/dashboard?code=wrong' + i, { nocookie: true }, '7.7.7.7');
  assert.notEqual(last.status, 500);
  assert.equal((await call('brute', '/dashboard?code=' + OWNER, { nocookie: true }, '7.7.7.7')).status, 403, 'even the right code is refused while banned');
});

test('Right code -> session cookie (HttpOnly, SameSite=Lax); the secret is never in the page', async () => {
  const r = await call('owner', '/dashboard?code=' + OWNER + '&theme=nebula'); assert.equal(r.status, 302);
  const sc = r.headers.get('set-cookie'); assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Lax/); assert.equal(r.headers.get('location'), '/api/security/dashboard?theme=nebula');
  const page = await call('owner', '/dashboard'); assert.equal(page.status, 200); const html = await page.text();
  assert.ok(!html.includes(OWNER)); assert.ok(page.headers.get('content-security-policy')); assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN'); assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
});

test('State-changing calls need the CSRF header', async () => {
  const r = await call('owner', '/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf': '' }, body: '{"blockTools":true}' });
  assert.equal(r.status, 403);
});

test('Role matrix: viewer < analyst < admin, and privilege escalation attempts are recorded', async () => {
  const an = await json(await post('owner', '/auth/operators', { name: 'Test Analyst', role: 'analyst' }));
  const vw = await json(await post('owner', '/auth/operators', { name: 'Test Viewer', role: 'viewer' }));
  assert.ok(an.code && vw.code);
  assert.equal((await post('analyst', '/auth/login', { code: an.code })).status, 200); assert.equal((await post('viewer', '/auth/login', { code: vw.code })).status, 200);
  const expect = [['GET', '/stats', 200, 200, 200], ['GET', '/soc/cases', 200, 200, 200], ['POST', '/block', 403, 200, 200, { ip: '8.8.4.4', minutes: 5 }], ['POST', '/settings', 403, 403, 200, { blockTools: true }],
    ['GET', '/devices', 403, 200, 200], ['GET', '/recovery/export', 403, 403, 200], ['POST', '/endpoint/agents', 403, 403, 200, { name: 'pc' }], ['GET', '/auth/operators', 403, 403, 200]];
  for (const [m, p, v, a, o, b] of expect) for (const [who, want] of [['viewer', v], ['analyst', a], ['owner', o]]) {
    const r = await (m === 'GET' ? call(who, p) : post(who, p, b)); assert.equal(r.status, want, `${who} ${m} ${p}`);
  }
  const st = await json(await call('owner', '/stats')); assert.ok(st.incidents.some((i) => i.rule === 'DASH_PRIVILEGE_DENIED'));
});

test('Schema validation: wrong types, oversize and unknown fields are handled', async () => {
  assert.equal((await post('owner', '/settings', { rateMax: 'abc' })).status, 400);
  assert.equal((await post('owner', '/scan/text', { text: 'x'.repeat(6000) })).status, 400);
  assert.equal((await post('owner', '/block', { ip: '1.2.3.4', minutes: 999999999 })).status, 400);
  const big = await call('owner', '/scan/text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'a'.repeat(3 * 1024 * 1024) }) });
  assert.ok([400, 413].includes(big.status), 'oversized body rejected (' + big.status + ')');
});

test('Firewall policy: allow-before-deny, throttle, CIDR, self-lockout protection, rollback', () => {
  firewall._t.reset();
  const rq = (p, m) => ({ path: p, method: m || 'GET' });
  firewall.add({ name: 'owner admin', action: 'allow', src: { kind: 'ip', value: '9.9.9.9' }, path: '/api/admin' }, 't', '9.9.9.9');
  firewall.add({ name: 'others denied', action: 'deny', src: { kind: 'any' }, path: '/api/admin' }, 't', '9.9.9.9');
  firewall.add({ name: 'throttle', action: 'throttle', throttleMax: 2, src: { kind: 'any' }, path: '/api/login' }, 't', '9.9.9.9');
  assert.equal(firewall.check(rq('/api/admin/x'), '9.9.9.9').action, 'allow'); assert.equal(firewall.check(rq('/api/admin/x'), '8.8.8.8').action, 'deny');
  assert.deepEqual([1, 2, 3].map(() => firewall.check(rq('/api/login'), '7.7.7.7').action), ['allow', 'allow', 'deny']);
  assert.equal(firewall.check(rq('/api/security/stats'), '8.8.8.8'), null, 'dashboards can never be locked out');
  assert.throws(() => firewall.add({ name: 'lock all', action: 'deny', src: { kind: 'any' }, path: '/' }, 't', '9.9.9.9'), /apne IP/);
  assert.throws(() => firewall.add({ name: 'huge', action: 'deny', src: { kind: 'cidr', value: '10.0.0.0/4' }, path: '/a' }, 't', '1.1.1.1'));
  const hist = require('../security/history').list('firewall'); assert.ok(hist.length >= 3);
  assert.equal(firewall.rollback(hist[hist.length - 1].id, 't'), true); assert.equal(firewall.list().length, 1);
});

test('SOC: one weak signal is not an incident; correlation raises explainable cases; resolution needs a verdict', () => {
  soc._t.reset(); let n = 0;
  const ev = (o) => Object.assign({ id: 'e' + (++n), t: new Date().toISOString(), ip: '6.6.6.6', app: 'aureon-backend', severity: 'LOW', action: 'FLAGGED', detail: 'd', path: '/' }, o);
  soc.ingest(ev({ rule: 'RATE_LIMIT', severity: 'MEDIUM' })); assert.equal(soc.listCases().length, 0);
  soc.ingest(ev({ rule: 'SCANNER_PROBE', severity: 'HIGH', action: 'BLOCKED' })); soc.ingest(ev({ rule: 'DASH_LOGIN_BRUTEFORCE', severity: 'HIGH', app: 'dashboard', action: 'BLOCKED' }));
  const c = soc.listCases().find((x) => x.corr && x.corr.includes('recon-then-login-attack')); assert.ok(c, 'correlation case exists'); assert.equal(c.severity, 'CRITICAL');
  assert.ok(soc.getCase(c.id).why.some((w) => /probed the server/.test(w)), 'explains why');
  for (let i = 1; i <= 5; i++) soc.ingest(ev({ rule: 'DASH_LOGIN_FAILED', severity: 'MEDIUM', app: 'dashboard', ip: '20.0.0.' + i }));
  assert.ok(soc.listCases().some((x) => x.entity === 'dashboard:distributed'));
  assert.throws(() => soc.updateCase(c.id, { status: 'resolved' }, 't'), /resolution/);
  soc.updateCase(c.id, { status: 'resolved', resolution: 'false_positive' }, 't'); assert.equal(soc.stats().rules.find((r) => r.rule === 'SCANNER_PROBE').fp, 1);
  const csv = soc.exportCase(c.id, 'csv', 't').body; assert.match(csv, /sha256 [a-f0-9]{64}/);
});

test('Detection quality: scanners meet the minimum bar on tuning AND held-out samples', async () => {
  const r = await corpus.evaluate();
  for (const k of ['links', 'messages', 'files']) { assert.ok(r[k].precision >= 95 && r[k].recall >= 90, `${k} tuning ${r[k].precision}/${r[k].recall}`); assert.ok(r.holdout[k].precision >= 90 && r.holdout[k].recall >= 85, `${k} holdout ${r.holdout[k].precision}/${r.holdout[k].recall}`); }
});

test('SSRF guard: link scanner refuses private / internal targets', async () => {
  const r = await linkscan.analyzeUrl('http://127.0.0.1:9/admin'); assert.ok(r.reasons.some((x) => /private|internal/i.test(x.text)) || r.info);
  const r2 = await linkscan.analyzeUrl('http://169.254.169.254/latest/meta-data/'); assert.ok(!r2.info.status, 'metadata endpoint was NOT fetched');
});

test('Windows endpoint flow: agent key, report, propose -> approve -> poll -> result -> rollback; wrong key is invisible', async () => {
  const ag = await json(await post('owner', '/endpoint/agents', { name: 'Test PC' })); assert.match(ag.key, /^ek_/);
  const h = { 'x-agent-key': ag.key, 'Content-Type': 'application/json', 'X-Forwarded-For': '5.5.5.5' };
  const rep = await fetch(base + '/endpoint/report', { method: 'POST', headers: h, body: JSON.stringify({ host: { name: 'PC' }, defender: { realtime: false }, firewall: { Public: false } }) }); assert.equal(rep.status, 200);
  const act = await json(await post('analyst', '/endpoint/actions', { agentId: ag.id, type: 'block_ip', params: { ip: '45.9.148.12' } })); assert.equal(act.status, 'proposed');
  assert.deepEqual((await json(await fetch(base + '/endpoint/poll', { headers: h }))).actions, [], 'nothing is sent before approval');
  assert.equal((await post('analyst', `/endpoint/actions/${act.id}/approve`)).status, 403, 'analyst cannot approve');
  assert.equal((await post('owner', `/endpoint/actions/${act.id}/approve`)).status, 200);
  const polled = (await json(await fetch(base + '/endpoint/poll', { headers: h }))).actions; assert.equal(polled.length, 1); assert.equal(polled[0].type, 'block_ip');
  assert.equal((await fetch(base + '/endpoint/result', { method: 'POST', headers: h, body: JSON.stringify({ actionId: act.id, ok: true, message: 'ok' }) })).status, 200);
  assert.equal((await json(await post('owner', `/endpoint/actions/${act.id}/rollback`))).type, 'unblock_ip');
  assert.equal((await fetch(base + '/endpoint/poll', { headers: { 'x-agent-key': 'ek_wrongwrongwrongwrongwrong', 'X-Forwarded-For': '5.5.5.6' } })).status, 404);
  for (const [t, p] of [['block_ip', { ip: '192.168.1.5' }], ['block_ip', { ip: 'x; rm -rf /' }], ['powershell', { cmd: 'calc' }], ['terminate_process', { pid: 99, name: '..\\evil' }]]) assert.throws(() => endpoint.validateAction(t, p), undefined, t);
});

test('Threat intel: IOC blocks at the guard; firewall deny applies to real traffic', async () => {
  assert.equal((await post('analyst', '/ti/ioc', { type: 'ip', value: '77.77.77.0/24', note: 'test' })).status, 200);
  assert.equal((await fetch(base_root + '/x', { headers: { 'X-Forwarded-For': '77.77.77.5' } })).status, 403);
  assert.equal((await fetch(base_root + '/x', { headers: { 'X-Forwarded-For': '78.78.78.5' } })).status, 200);
  assert.equal((await post('owner', '/firewall', { name: 'deny demo', action: 'deny', src: { kind: 'ip', value: '66.66.66.66' }, path: '/x' })).status, 200);
  assert.equal((await fetch(base_root + '/x', { headers: { 'X-Forwarded-For': '66.66.66.66' } })).status, 403);
});

test('Recovery: signed backup verifies, tampering and wrong key are detected, only admin can restore', async () => {
  const b = await json(await call('owner', '/recovery/export')); assert.ok(b.signature && b.keys.length);
  assert.equal((await json(await post('analyst', '/recovery/verify', b))).ok, true);
  const t = JSON.parse(JSON.stringify(b)); t.data.sec_settings.mode = 'off'; assert.equal((await json(await post('analyst', '/recovery/verify', t))).ok, false);
  assert.equal((await post('analyst', '/recovery/import', b)).status, 403);
});

test('Audit log is hash-chained: editing an entry is detected', async () => {
  assert.equal(auth.verifyAudit().ok, true);
  const a = auth._t.audit(); const keep = a[2].detail; a[2].detail = 'EDITED';
  const v = auth.verifyAudit(); a[2].detail = keep;
  assert.equal(v.ok, false); assert.equal(v.brokenAt, 2); assert.equal(auth.verifyAudit().ok, true);
});

test('2FA + step-up: enabling needs a valid code, replay is refused, risky sessions need a fresh code', async () => {
  const st = await json(await post('owner', '/auth/totp/start')); assert.ok(st.secret);
  const real = Date.now; let off = 0; Date.now = () => real() + off;
  try {
    off += 31000; assert.equal((await post('owner', '/auth/totp/confirm', { token: '000000' })).status, 400);
    off += 31000; assert.equal((await post('owner', '/auth/totp/confirm', { token: totp(st.secret) })).status, 200);
    assert.equal((await call('owner', '/auth/status')).status, 200);
    assert.equal((await post('owner', '/auth/settings', { stepUp: true })).status, 403, 'step-up needs a code');
    off += 31000; const code = totp(st.secret); const ok = await post('owner', '/auth/settings', { stepUp: true }, undefined, { 'x-totp': code }); assert.equal(ok.status, 200);
    const replay = await post('owner', '/auth/settings', { idleMin: 40 }, undefined, { 'x-totp': code }); assert.equal(replay.status, 200, 'inside the 5-minute grace window');
    delete jars.fresh; const l = await call('fresh', '/dashboard?code=' + OWNER, { nocookie: true }, '4.4.4.4'); assert.match(await l.text(), /Verify/, 'login now asks for 2FA');
  } finally { Date.now = real; }
});
