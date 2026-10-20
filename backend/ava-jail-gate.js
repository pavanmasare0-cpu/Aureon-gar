'use strict';
/*
 * Ava Jail quality gate (v17).
 * Ava cannot edit this file (it is not in her EDITABLE list), so she cannot weaken her own gate.
 *
 * Pipeline for every Jail variant:  draft -> static quality check -> real self-test run -> up to 2 repair rounds.
 * The self-test runs in a throw-away child process: empty environment, no secrets, Node permission model when
 * available (no fs / child_process / worker), --disallow-code-generation-from-strings, a vm context that only has
 * stubbed browser globals (no require / process / fetch), hard timeout. Kill switch: AVA_JAIL_RUN_TESTS=0.
 * Limits: a self-test written by the same model proves the code runs and its own claims hold, not that the
 * design is perfect. vm is not a perfect security boundary, so static bans + the container are the other layers.
 */
const { spawnSync } = require('child_process');
const os = require('os');

const MIN_CODE_LINES = 120;
const MIN_TEST_CASES = 6;
const MAX_REPAIRS = 2;

const FAKE_MARKERS = /\b(TODO|FIXME|XXX|HACK)\b|placeholder\s+(code|logic|implementation|function)|\/\/\s*placeholder|lorem ipsum|your (code|logic|implementation) (goes )?here|not (yet )?implemented|implement (me|this|later)|coming soon|for demo purposes|\bdummy\b|\bstub(bed)?\b|simulated? (attack|detection|scan)/i;
const BANNED = [
  [/\b(?:require|import)\s*\(/, 'require()/import() is not allowed in a standalone prototype'],
  [/\bprocess\s*\.|\bglobalThis\s*\.\s*process/, 'no access to process'],
  [/\.\s*constructor\s*\.\s*constructor|__proto__|\bFunction\s*\(|\beval\s*\(|\bWebAssembly\b/, 'dynamic code / prototype tricks are not allowed'],
  [/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts/, 'no network calls (prototype must be standalone)']
];

function stripComments(code) {
  return String(code).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => l.trim() && !/^\s*\/\//.test(l)).join('\n');
}

function checkJailQuality(code, category) {
  const reasons = [];
  const src = String(code || '');
  const body = stripComments(src);
  const lines = body.split('\n').length;
  const fnCount = (body.match(/\bfunction\b|=>/g) || []).length;
  const regexCount = (body.match(/[=(,:!&|?]\s*\/(?![\/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^\/\\\n\[])+\/[gimsuy]*/g) || []).length;
  const emptyNamed = (body.match(/function\s+\w+\s*\([^)]*\)\s*\{\s*\}/g) || []).length;
  const m = { lines, functions: fnCount, regexes: regexCount };

  if (lines < MIN_CODE_LINES) reasons.push('too small: ' + lines + ' real code lines, need at least ' + MIN_CODE_LINES + ' (real logic, not a demo)');
  if (!/^\s*(?:\/\*[\s\S]*?\*\/\s*)?(?:\(function|\(\s*\(|'use strict'|"use strict")/.test(src) && !/['"]use strict['"]/.test(src)) reasons.push("missing 'use strict'");
  if (fnCount < 6) reasons.push('only ' + fnCount + ' functions: split the logic into real, separately testable functions');
  if (emptyNamed) reasons.push(emptyNamed + ' named function(s) with an empty body');
  const fake = FAKE_MARKERS.exec(src);
  if (fake) reasons.push('fake/placeholder marker found: "' + fake[0] + '"');
  BANNED.forEach(([re, why]) => { if (re.test(src)) reasons.push(why); });
  if (!/window\.__AVA_JAIL__\s*=|globalThis\.__AVA_JAIL__\s*=/.test(src)) reasons.push('must expose window.__AVA_JAIL__ = { name, version, api, selfTest }');
  if (!/selfTest/.test(src)) reasons.push('missing selfTest()');

  const cat = String(category || 'other');
  if (cat === 'security') {
    if (regexCount < 6) reasons.push('security tool needs real detection logic: found only ' + regexCount + ' pattern(s), need at least 6');
    if (!/\b(?:Date\.now|performance\.now|clock)\b/.test(body) || !/\b(?:new Map|Object\.create\(null\)|new Set)\b/.test(body)) reasons.push('security tool needs state over time (rate window / counters) — a stateless highlight is cosmetic');
    if (!/\b(?:verdict|allow|block|score|severity)\b/i.test(body)) reasons.push('security tool must return a decision (verdict/score), not just change colors');
  }
  if (cat === 'ui' && !/addEventListener/.test(body)) reasons.push('ui prototype has no event handling');
  if (cat === 'ui' && !/removeEventListener|destroy|unmount/.test(body)) reasons.push('ui prototype needs a destroy()/cleanup path');
  if (cat === 'game' && !/requestAnimationFrame|setInterval/.test(body)) reasons.push('game needs a real loop (requestAnimationFrame/setInterval)');
  return { ok: reasons.length === 0, reasons, metrics: m };
}

// ---- hardened self-test runner ----
const STUBS = `
(function (g) {
  var timers = [];
  function mk() { var f = function () { return mk(); };
    return new Proxy(f, { get: function (_, k) { if (k === Symbol.toPrimitive) return function () { return ''; }; if (k === 'then') return undefined; if (k === 'length') return 0; return mk(); },
      set: function () { return true; }, apply: function () { return mk(); }, construct: function () { return mk(); } }); }
  function store() { var d = {}; return { getItem: function (k) { return k in d ? d[k] : null; }, setItem: function (k, v) { d[k] = String(v); }, removeItem: function (k) { delete d[k]; } }; }
  g.window = g; g.self = g; g.document = mk(); g.navigator = { userAgent: 'ava-jail-harness', language: 'en' };
  g.localStorage = store(); g.sessionStorage = store();
  g.performance = { now: function () { return Date.now(); } };
  g.setTimeout = function (fn) { timers.push(fn); return timers.length; }; g.setInterval = g.setTimeout;
  g.clearTimeout = function () {}; g.clearInterval = function () {};
  g.requestAnimationFrame = g.setTimeout; g.cancelAnimationFrame = function () {};
  g.matchMedia = function () { return { matches: false, addEventListener: function () {} }; };
  g.getComputedStyle = function () { return mk(); };
  ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'CustomEvent', 'Event'].forEach(function (n) { g[n] = function () { return mk(); }; });
  g.__logs = []; g.console = { log: function (x) { g.__logs.push(String(x)); }, warn: function () {}, error: function () {}, info: function () {} };
  g.module = { exports: {} }; g.exports = g.module.exports;
  g.__runTimers = function () { var n = 0; while (timers.length && n++ < 50) { try { timers.shift()(); } catch (e) {} } };
})(this);`;

const HARNESS = `
'use strict';
const vm = require('vm');
let src = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { src += d; });
process.stdin.on('end', async () => {
  const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
  try {
    const ctx = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
    vm.runInContext(${JSON.stringify(STUBS)}, ctx, { timeout: 2000 });
    vm.runInContext(src, ctx, { timeout: 3000 });
    vm.runInContext('(function(){var a=(typeof window.__AVA_JAIL__==="object"&&window.__AVA_JAIL__)||null;if(!a||typeof a.selfTest!=="function"){window.__err="no window.__AVA_JAIL__.selfTest";return;}' +
      'try{Promise.resolve(a.selfTest()).then(function(r){window.__res=JSON.stringify(r)},function(e){window.__err="selfTest rejected: "+(e&&e.message)});}catch(e){window.__err="selfTest threw: "+(e&&e.message)}})();', ctx, { timeout: 5000 });
    for (let i = 0; i < 5; i++) { await new Promise((r) => setImmediate(r)); vm.runInContext('window.__runTimers()', ctx, { timeout: 2000 }); }
    const err = vm.runInContext('window.__err||null', ctx), res = vm.runInContext('window.__res||null', ctx);
    out({ err: err, res: res });
  } catch (e) { out({ err: 'load/run failed: ' + String(e && e.message).slice(0, 200) }); }
});`;

let permFlag;
function permissionFlag() {
  if (permFlag !== undefined) return permFlag;
  permFlag = null;
  try {
    const r = spawnSync(process.execPath, ['--permission', '-e', 'require("vm");process.stdout.write("ok")'], { encoding: 'utf8', timeout: 5000, env: {} });
    if (r.status === 0 && r.stdout === 'ok') permFlag = '--permission';
  } catch (e) { /* older node: rely on the other layers */ }
  return permFlag;
}

function runSelfTest(code) {
  if (process.env.AVA_JAIL_RUN_TESTS === '0') return { ok: true, skipped: true, log: 'self-test skipped (AVA_JAIL_RUN_TESTS=0)' };
  const args = [].concat(permissionFlag() || [], '--disallow-code-generation-from-strings', '-e', HARNESS);
  const r = spawnSync(process.execPath, args, { input: String(code), encoding: 'utf8', timeout: 9000, killSignal: 'SIGKILL', maxBuffer: 1 << 20, cwd: os.tmpdir(), env: { NODE_ENV: 'test' } });
  if (r.error || r.status !== 0) return { ok: false, log: 'self-test did not finish (' + String((r.error && r.error.code) || r.signal || String(r.stderr).split('\n')[0]).slice(0, 120) + ') — infinite loop or crash' };
  let o; try { o = JSON.parse(r.stdout); } catch (e) { return { ok: false, log: 'harness output unreadable' }; }
  if (o.err) return { ok: false, log: o.err };
  let res; try { res = JSON.parse(o.res); } catch (e) { return { ok: false, log: 'selfTest returned no JSON result' }; }
  const cases = Array.isArray(res && res.cases) ? res.cases : [];
  const names = new Set(cases.map((c) => String(c && c.name)));
  if (cases.length < MIN_TEST_CASES || names.size < MIN_TEST_CASES) return { ok: false, log: 'selfTest needs at least ' + MIN_TEST_CASES + ' distinct named cases (got ' + names.size + ') — {ok:true} alone proves nothing' };
  const failed = cases.filter((c) => !c || c.ok !== true);
  if (failed.length) return { ok: false, log: failed.length + ' self-test case(s) failed: ' + failed.slice(0, 3).map((c) => String(c && c.name) + (c && c.detail ? ' (' + String(c.detail).slice(0, 60) + ')' : '')).join('; ') };
  return { ok: true, passed: cases.length, total: cases.length, log: 'self-test ' + cases.length + '/' + cases.length + ' passed' };
}

// ---- the "command" Ava receives ----
const JAIL_CONTRACT = [
  'You are Ava, and in the Jail you are a senior engineer. Deliver REAL, WORKING, TESTED code — never a demo, never a mock, never decoration pretending to be a feature.',
  'This is a prototype gallery: the code is never applied, deployed or executed server-side by the app. The owner will read it and may ship it, so it must be good enough to ship.',
  'HARD RULES:',
  '1. Every feature must have real logic behind it. If a behaviour cannot be done honestly in client-side JS, DO NOT fake it: leave it out and say so in the "limits" line.',
  '2. Structure: one IIFE, "use strict", pure logic separated from DOM code, small named functions (at least 6), defensive input handling (null/undefined/huge/odd-unicode inputs), no global leaks, a destroy()/cleanup if you attach listeners or timers.',
  '3. Size: 150-600 lines of real code (not counting comments). Short toy files are rejected automatically.',
  '4. Forbidden: TODO/FIXME/placeholder/dummy/stub, empty functions, fake data presented as detection, require()/import(), eval/Function, process, fetch/XHR/WebSocket/network, external files, fonts or CDNs.',
  '5. Expose exactly: window.__AVA_JAIL__ = { name, version, api, selfTest }. selfTest() runs with NO DOM (browser globals are stubs), returns { ok, total, passed, failed, cases:[{name, ok, detail}] } with AT LEAST 8 distinct named cases that assert concrete expected values — including negative cases (normal input must NOT be flagged) and edge cases. Time-dependent logic must accept an injectable clock so selfTest can control time.',
  '6. Accessibility/UI (if any): real <button>s, labels, keyboard support, Escape to close, prefers-reduced-motion, text via textContent (never innerHTML with untrusted text).',
  '7. Security tools specifically: normalise input before matching (NFKC, invisible chars, URL/HTML-entity decoding), at least 6 distinct detection rules, a numeric score and an allow/warn/block verdict, rate limiting with a token bucket or sliding window, an event log that never stores the raw input, and tests for false positives AND evasions.',
  'Before writing code, think through the design in the "plan" line (what it does, the edge cases, what it cannot do).'
].join('\n');

const FORMAT = 'OUTPUT FORMAT (exactly, nothing else):\n===META===\ntitle: <short creative name>\ncategory: <ui|security|utility|game|other>\ndescription: <1-2 sentences, Hinglish: what it really does>\nlimits: <1 sentence, Hinglish: what it honestly cannot do>\nplan: <2-3 sentences: design, edge cases>\n===CODE===\n<the COMPLETE JavaScript file>\n===END===';

function buildPrompt(brief, ref) {
  const b = brief ? "Owner's brief: " + brief : 'No brief: pick the most useful category yourself and build something genuinely useful.';
  const r = ref ? '\nReference (your current real widget; only if relevant, do not copy):\n<<<FILE\n' + ref + '\nFILE>>>' : '';
  return JAIL_CONTRACT + '\n\n' + b + r + '\n\n' + FORMAT;
}
function buildRepairPrompt(brief, code, reasons) {
  return JAIL_CONTRACT + '\n\n' + (brief ? "Owner's brief: " + brief + '\n\n' : '') +
    'Your previous attempt was REJECTED by the automatic quality gate for these reasons:\n- ' + reasons.join('\n- ') +
    '\n\nFix every reason with real engineering (do not just add comments or padding). Previous code:\n<<<CODE\n' + String(code).slice(0, 60000) + '\nCODE>>>\n\n' + FORMAT;
}

function parseVariant(text) {
  const t = String(text || '').replace(/\r/g, '');
  const meta = {};
  const m = t.match(/===META===\n([\s\S]*?)\n===CODE===/);
  if (m) m[1].split('\n').forEach((l) => { const k = l.match(/^(\w+):\s*(.+)$/); if (k) meta[k[1].toLowerCase()] = k[2].trim(); });
  const c = t.match(/===CODE===\n([\s\S]*?)(?:\n===END===|$)/);
  const code = c ? c[1].replace(/^\s*```[a-z]*\n/i, '').replace(/\n```\s*$/i, '').trim() : '';
  return { meta, code };
}

/**
 * ask(prompt) -> raw model text. safety(code) -> null | reason (the existing checkSafety).
 * Returns { meta, code, gate, test, rounds } or throws with every reason listed.
 */
async function produceVariant({ ask, brief, ref, safety }) {
  let prompt = buildPrompt(brief, ref), last = null, reasons = [];
  for (let round = 0; round <= MAX_REPAIRS; round++) {
    const v = parseVariant(await ask(prompt));
    if (!v.code) { reasons = ['output was not in the ===META=== / ===CODE=== format']; prompt = buildPrompt(brief, ref); continue; }
    last = v;
    const gate = checkJailQuality(v.code, v.meta.category);
    reasons = gate.reasons.slice();
    if (safety) { const s = safety(v.code); if (s) reasons.push('safety: ' + s); }
    let test = null;
    if (!reasons.length) { test = runSelfTest(v.code); if (!test.ok) reasons.push(test.log); }
    if (!reasons.length) return { meta: v.meta, code: v.code, gate, test, rounds: round + 1 };
    prompt = buildRepairPrompt(brief, v.code, reasons);
  }
  const e = new Error('Quality gate: ' + MAX_REPAIRS + ' repair rounds ke baad bhi reject — ' + reasons.slice(0, 4).join(' | '));
  e.last = last; throw e;
}

module.exports = { checkJailQuality, runSelfTest, produceVariant, parseVariant, buildPrompt, buildRepairPrompt, JAIL_CONTRACT, MIN_CODE_LINES, MAX_REPAIRS };
