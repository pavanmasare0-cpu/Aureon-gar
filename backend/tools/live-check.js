#!/usr/bin/env node
// backend/tools/live-check.js — LIVE test of Apps & Automation against your REAL deployed server (no fakes).
//
//   AUREON_EMAIL=you@gmail.com AUREON_PASSWORD='...' node backend/tools/live-check.js
//   optional: AUREON_URL=https://aureone.onrender.com   (default)   |   --keep  (do not delete the test app / automations)
//
// It signs in with your Aureon login (Firebase REST, apiKey read from www/firebase-config.js), then on the real server:
//   health, encryption key set, SSRF blocked, real public REST app (api.github.com, no token), real AI run, read-only block, webhook trigger.
// Everything it creates is named "LiveCheck ..." and deleted at the end. Your password is only used for the sign-in call, never printed or stored.
const fs = require('fs');
const path = require('path');

const BASE = String(process.env.AUREON_URL || 'https://aureone.onrender.com').replace(/\/$/, '');
const KEEP = process.argv.includes('--keep');
let pass = 0, fail = 0, warn = 0;
const ok = (m) => { pass++; console.log('  ✅ ' + m); };
const bad = (m) => { fail++; console.log('  ❌ ' + m); };
const meh = (m) => { warn++; console.log('  ⚠️  ' + m); };
const step = (m) => console.log('\n' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function firebaseKey() {
  const f = path.join(__dirname, '..', '..', 'www', 'firebase-config.js');
  const m = fs.readFileSync(f, 'utf8').match(/apiKey:\s*["']([^"']+)["']/);
  if (!m) throw new Error('www/firebase-config.js me apiKey nahi mili');
  return m[1];
}
async function signIn() {
  const email = process.env.AUREON_EMAIL, password = process.env.AUREON_PASSWORD;
  if (!email || !password) throw new Error('AUREON_EMAIL aur AUREON_PASSWORD set karo (upar header dekho)');
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + firebaseKey(), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }), signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('Login fail: ' + ((j.error && j.error.message) || r.status));
  return j.idToken;
}
let TOKEN = '';
async function api(p, method, body, ms) {
  const r = await fetch(BASE + p, { method: method || 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(ms || 40000) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}

(async () => {
  const made = { app: null, autos: [] };
  try {
    console.log('Aureon live check →', BASE);

    step('1) Server jaag raha hai? (Render free cold start me ~50s lag sakte hain)');
    const h = await fetch(BASE + '/health', { signal: AbortSignal.timeout(90000) }).then((r) => r.json()).catch(() => null);
    h && h.ok ? ok('/health ok') : bad('/health jawab nahi de raha — Render deploy / URL check karo');
    if (!h) throw new Error('server down');

    step('2) Login + Apps & Automation deployed hai?');
    TOKEN = await signIn(); ok('login ho gaya');
    const list = await api('/api/connect/apps');
    if (list.status === 404) { bad('/api/connect nahi mila — naya backend (v31) Render par deploy nahi hua'); throw new Error('not deployed'); }
    list.ok ? ok('/api/connect/apps chal raha hai') : bad('apps list fail: ' + list.error);
    list.canStore ? ok('SENTINEL_ENC_KEY set hai (token encrypt hoke save honge)') : bad('SENTINEL_ENC_KEY Render env me set nahi hai — apps save nahi honge');

    step('3) SSRF: internal addresses server ko rokna chahiye');
    for (const u of ['https://localhost/x', 'https://169.254.169.254/latest/meta-data', 'https://127.0.0.1:3000/health', 'http://example.com/x']) {
      const r = await api('/api/connect/apps', 'POST', { name: 'LiveCheck ssrf', kind: 'webhook', url: u });
      if (r.ok) { bad('ROKA NAHI GAYA: ' + u); await api('/api/connect/apps/' + r.id, 'DELETE'); } else ok('blocked: ' + u);
    }

    step('4) Asli public REST app (api.github.com, bina token)');
    const a = await api('/api/connect/apps', 'POST', { name: 'LiveCheck GitHub', kind: 'rest', url: 'https://api.github.com', authType: 'none' });
    if (!a.ok) { bad('app connect nahi hui: ' + a.error); throw new Error('no app'); }
    made.app = a.id; ok('connect + test ho gaya (HTTP ' + (a.info && a.info.status) + ')');
    const t = await api('/api/connect/apps/' + a.id + '/test', 'POST');
    t.ok ? ok('Test button wala endpoint chal raha hai') : bad('test fail: ' + t.error);

    step('5) Asli AI run: GitHub API se octocat ki details padho (read-only)');
    const c1 = await api('/api/connect/automations', 'POST', { name: 'LiveCheck read', instruction: 'Use the GitHub REST API: GET /users/octocat. In your final report give the login name and the public_repos number.', appIds: [made.app], trigger: { type: 'manual' }, allowWrite: false });
    if (!c1.ok) { bad('automation nahi bani: ' + c1.error); } else {
      made.autos.push(c1.id);
      const t0 = Date.now();
      const run = await api('/api/connect/automations/' + c1.id + '/run', 'POST', null, 150000);
      const rr = run.run || {};
      console.log('     jawab:', String(rr.text || run.error || '').replace(/\s+/g, ' ').slice(0, 220), '(' + Math.round((Date.now() - t0) / 1000) + 's)');
      if (rr.ok && (rr.steps || []).length >= 1) ok('AI ne tool call kiya aur report di (' + rr.steps.length + ' call)');
      else bad('run fail: ' + (rr.text || run.error) + ' — GEMINI/GROQ key ya quota check karo');
      /octocat/i.test(rr.text || '') ? ok('report me asli data hai (octocat)') : meh('report me "octocat" nahi dikha (AI ne alag likha ho sakta hai)');
    }

    step('6) Read-only block: change wali call roki jani chahiye');
    const c2 = await api('/api/connect/automations', 'POST', { name: 'LiveCheck block', instruction: 'Send a POST request to /gists on the GitHub API with body {"public":false}. Then report exactly what happened.', appIds: [made.app], trigger: { type: 'manual' }, allowWrite: false });
    if (c2.ok) {
      made.autos.push(c2.id);
      const run = await api('/api/connect/automations/' + c2.id + '/run', 'POST', null, 150000);
      const steps = (run.run && run.run.steps) || [];
      if (steps.some((s) => s.blocked)) ok('POST ko BLOCK kiya gaya (Changes allowed OFF tha)');
      else if (!steps.length) meh('AI ne POST try hi nahi kiya — block check nahi ho paya (dobara chalao)');
      else bad('POST block nahi hua!');
    } else bad('automation nahi bani: ' + c2.error);

    step('7) Webhook trigger');
    const c3 = await api('/api/connect/automations', 'POST', { name: 'LiveCheck hook', instruction: 'Use the GitHub REST API: GET /zen and report the sentence.', appIds: [made.app], trigger: { type: 'webhook' }, allowWrite: false });
    if (c3.ok && c3.hookUrl) {
      made.autos.push(c3.id);
      const hp = new URL(c3.hookUrl).pathname;
      const w = await fetch(BASE + hp.replace(/\/[^/]+$/, '/wrong-secret'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      w.status === 404 ? ok('galat secret → 404') : bad('galat secret par ' + w.status + ' aaya (404 chahiye)');
      const g = await fetch(BASE + hp, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"hello":"live"}' });
      g.status === 202 ? ok('sahi link → 202, run background me shuru') : bad('sahi link par ' + g.status);
      let done = null;
      for (let i = 0; i < 30 && !done; i++) {
        await sleep(3000);
        const L = await api('/api/connect/automations');
        const me = (L.automations || []).find((x) => x.id === c3.id);
        if (me && me.lastRun) done = me.lastRun;
      }
      done ? (done.ok ? ok('webhook run poora hua: ' + String(done.text).replace(/\s+/g, ' ').slice(0, 80)) : bad('webhook run fail: ' + done.text)) : bad('90s me webhook run ka result nahi aaya');
    } else bad('webhook automation nahi bani: ' + (c3.error || 'hookUrl nahi mila'));
  } catch (e) {
    console.log('\n⛔ ' + e.message);
    if (!/server down|not deployed|no app/.test(e.message)) fail++;
  } finally {
    if (!KEEP && TOKEN) {
      step('Safai (LiveCheck wali cheezein delete)');
      for (const id of made.autos) await api('/api/connect/automations/' + id, 'DELETE').catch(() => {});
      if (made.app) await api('/api/connect/apps/' + made.app, 'DELETE').catch(() => {});
      console.log('  done');
    }
    console.log('\n==== ' + pass + ' pass · ' + warn + ' warning · ' + fail + ' fail ====');
    process.exit(fail ? 1 : 0);
  }
})();
