// backend/code-run.js
// Aureon Coding mode: code ko ASLI mein chalao (+ tests), result real exit code se.
// code-check.js sirf syntax padhta hai; ye file code chalata hai.
// Report ka "Verified" sirf tab jab tests sach mein pass hue. Model khud kuch declare nahi karta.
//
// Safety: fresh temp folder, saaf env (API keys nahi), timeout, output cap.
// Node ka --permission flag use hota hai (file system sirf temp folder, child_process/worker band).
// NOTE: network is block NAHI hota (Node 24 me permission model network nahi rokta).
// Isliye ye sirf tab chalao jab user ne Approve kiya ho (project rule).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const LIMITS = { ms: 8000, outChars: 4000 };
const CLEAN_ENV = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: os.tmpdir() };

function spawnRun(cmd, args, cwd, ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '', err = '', done = false, timedOut = false;
    let child;
    try { child = spawn(cmd, args, { cwd, env: CLEAN_ENV }); }
    catch (e) { return resolve({ unavailable: true }); }
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch (e) {} }, ms);
    child.stdout.on('data', (d) => { if (out.length < LIMITS.outChars * 4) out += d; });
    child.stderr.on('data', (d) => { if (err.length < LIMITS.outChars * 4) err += d; });
    child.on('error', (e) => finish(e.code === 'ENOENT' ? { unavailable: true } : { exitCode: null, stdout: out, stderr: String(e.message), timedOut: false, ms: Date.now() - t0 }));
    child.on('close', (code) => finish({ exitCode: code, stdout: out, stderr: err, timedOut, ms: Date.now() - t0 }));
  });
}

const clip = (s) => { s = String(s || '').trim(); return s.length > LIMITS.outChars ? s.slice(0, LIMITS.outChars) + '\n...(kaata gaya)' : s; };

function nodeArgs(dir, file) {
  const a = ['--permission', '--allow-fs-read=' + dir, '--allow-fs-write=' + dir, file];
  return a;
}

async function runNode(dir, file, ms) {
  let r = await spawnRun(process.execPath, nodeArgs(dir, file), dir, ms);
  // purane Node par --permission na ho to bina flag chalao, par note rakho
  if (r.exitCode === 9 && /bad option|--permission/.test(r.stderr || '')) {
    r = await spawnRun(process.execPath, [file], dir, ms);
    r.noSandboxFlag = true;
  }
  return r;
}

// runCode({ lang:'js'|'py', code, tests?, timeoutMs? })
// status: 'tested' (tests pass) | 'ran' (chala, koi test nahi) | 'failed' | 'timeout' | 'skipped'
async function runCode({ lang, code, tests, timeoutMs } = {}) {
  lang = String(lang || '').toLowerCase();
  if (lang === 'javascript' || lang === 'node') lang = 'js';
  if (lang === 'python' || lang === 'python3') lang = 'py';
  const ms = timeoutMs || LIMITS.ms;
  if (!['js', 'py'].includes(lang)) return { status: 'skipped', lang, note: 'Sirf js/py chalta hai; ye language chalayi nahi gayi.' };
  if (!code || !String(code).trim()) return { status: 'skipped', lang, note: 'Code khaali hai.' };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));
  try {
    const main = lang === 'js' ? 'main.js' : 'main.py';
    fs.writeFileSync(path.join(dir, main), code, 'utf8');
    const hasTests = !!(tests && String(tests).trim());
    let target = main;
    if (hasTests) {
      target = lang === 'js' ? 'test.js' : 'test_main.py';
      fs.writeFileSync(path.join(dir, target), tests, 'utf8');
    }
    let r;
    if (lang === 'js') r = await runNode(dir, target, ms);
    else {
      for (const bin of ['python3', 'python']) {
        r = await spawnRun(bin, [target], dir, ms);
        if (!r.unavailable) break;
      }
    }
    if (r.unavailable) return { status: 'skipped', lang, note: (lang === 'js' ? 'node' : 'python') + ' is machine par nahi mila; code chalaya nahi gaya.' };
    const base = { lang, hadTests: hasTests, exitCode: r.exitCode, ms: r.ms, stdout: clip(r.stdout), stderr: clip(r.stderr), sandboxFlag: !r.noSandboxFlag };
    if (r.timedOut) return { ...base, status: 'timeout', note: 'Time limit (' + ms + 'ms) me khatam nahi hua.' };
    if (r.exitCode !== 0) return { ...base, status: 'failed' };
    return { ...base, status: hasTests ? 'tested' : 'ran' };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

// ---------- runBlocks: chat ke saare JS blocks ek saath (code + tests), tests ke liye jest/vitest shim ----------
// AI aksar ek block me code deta hai aur doosre me tests (import ... from 'vitest' / jest globals / node:test).
// Pehle sirf pehla block chalta tha, isliye tests kabhi nahi chalte the. Ab: implementation -> impl.(mjs|cjs), tests -> test.(mjs|cjs),
// tests ke relative imports ('./x', '../src/x') impl file par mod jaate hain, aur 'vitest' / '@jest/globals' / jest-globals shim se chalte hain.
const SHIM_SRC = require('./code-run-shim');
const TEST_BLOCK_RE = /\b(describe|it|test)(\.(each|skip))?\s*\(\s*[`'"]|\bfrom\s+['"](vitest|@jest\/globals|node:test)['"]|require\(\s*['"](node:test|vitest|@jest\/globals)['"]\s*\)/;
const ESM_RE = /^\s*(import\s+[\w{*'"]|export\s+(default|const|let|var|function|class|async|\{|\*))/m;
const isTestBlock = (c) => TEST_BLOCK_RE.test(c);
const isEsm = (c) => ESM_RE.test(c);
const LOCAL_SPEC_RE = /((?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"])(\.{1,2}\/[^'"]*)(['"])/g;

function friendlyError(res) {
  const text = String((res && (res.stderr || '')) + '\n' + String((res && res.stdout) || ''));
  const m = text.match(/Cannot find (?:package|module) '([^']+)'/);
  if (m && !m[1].startsWith('.')) return "Package '" + m[1] + "' sandbox me nahi hai (yahan npm install nahi hota). Tests ke liye built-in node:test + node:assert/strict use karo; jest/vitest ke describe/it/expect ye sandbox khud deta hai.";
  if (/ERR_REQUIRE_ESM|require\(\) of ES Module/.test(text)) return 'Code ESM (import/export) hai aur test CommonJS (require). Dono me ek hi style rakho.';
  return '';
}
function stripNoise(t) {
  return String(t || '').split('\n').filter((l) => !/^\s+at .*node:internal|^node:internal|^\s*\^+\s*$|^Node\.js v\d+/.test(l)).join('\n').trim();
}

async function runBlocks({ blocks, timeoutMs } = {}) {
  blocks = (Array.isArray(blocks) ? blocks : []).map((b) => String(b || '')).filter((b) => b.trim());
  if (!blocks.length) return { status: 'skipped', lang: 'js', note: 'Code khaali hai.' };
  const tests = blocks.filter(isTestBlock);
  const others = blocks.filter((b) => !isTestBlock(b));
  if (!tests.length) return runCode({ lang: 'js', code: others[0] || blocks[0], timeoutMs });   // no tests: run the first block as before
  // implementation = first non-test block that defines something (function/class/export), else the first non-test block
  const impl = others.find((b) => /\b(function|class|=>)\b|module\.exports|\bexport\b/.test(b)) || others[0] || '';
  const ms = timeoutMs || LIMITS.ms;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));
  try {
    const esmImpl = isEsm(impl);
    const implFile = 'impl.' + (esmImpl ? 'mjs' : 'cjs');
    // test files may be several blocks: join those with the same module style
    const testCode = tests.join('\n\n');
    const esmTest = isEsm(testCode);
    const testFile = 'test.' + (esmTest ? 'mjs' : 'cjs');
    if (impl) fs.writeFileSync(path.join(dir, implFile), impl, 'utf8');
    fs.writeFileSync(path.join(dir, testFile), testCode.replace(LOCAL_SPEC_RE, (m0, a, spec, q) => a + './' + implFile + q), 'utf8');
    // shim + fake packages
    fs.writeFileSync(path.join(dir, 'shim.cjs'), SHIM_SRC, 'utf8');
    const wrapper = "import c from './index.cjs';\nexport const { describe, it, test, suite, expect, beforeEach, afterEach, beforeAll, afterAll, vi, jest } = c;\nexport default c;\n";
    for (const pkg of ['vitest', '@jest/globals']) {
      const pd = path.join(dir, 'node_modules', ...pkg.split('/'));
      fs.mkdirSync(pd, { recursive: true });
      fs.writeFileSync(path.join(pd, 'index.cjs'), "module.exports = require(" + JSON.stringify(path.relative(pd, path.join(dir, 'shim.cjs')).split(path.sep).join('/')) + ");\n");
      fs.writeFileSync(path.join(pd, 'index.mjs'), wrapper);
      fs.writeFileSync(path.join(pd, 'package.json'), JSON.stringify({ name: pkg, version: '0.0.0', exports: { '.': { import: './index.mjs', require: './index.cjs', default: './index.cjs' } } }));
    }
    const args = ['--permission', '--allow-fs-read=' + dir, '--allow-fs-write=' + dir, '--require', './shim.cjs', testFile];
    let r = await spawnRun(process.execPath, args, dir, ms);
    if (r.exitCode === 9 && /bad option|--permission/.test(r.stderr || '')) { r = await spawnRun(process.execPath, ['--require', './shim.cjs', testFile], dir, ms); r.noSandboxFlag = true; }
    if (r.unavailable) return { status: 'skipped', lang: 'js', note: 'node is machine par nahi mila; code chalaya nahi gaya.' };
    const base = { lang: 'js', hadTests: true, exitCode: r.exitCode, ms: r.ms, stdout: clipTail(r.stdout), stderr: clip(stripNoise(r.stderr)), sandboxFlag: !r.noSandboxFlag, friendly: friendlyError(r), usedBlocks: { impl: !!impl, tests: tests.length } };
    if (r.timedOut) return { ...base, status: 'timeout', note: 'Time limit (' + ms + 'ms) me khatam nahi hua.' };
    if (r.exitCode !== 0) return { ...base, status: 'failed' };
    return { ...base, status: 'tested' };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ok */ }
  }
}
const clipTail = (s) => { s = String(s || '').trim(); return s.length > LIMITS.outChars ? '...(shuru ka hissa kaata gaya)\n' + s.slice(-LIMITS.outChars) : s; };

// ---------- Python: implementation + pytest/unittest-style tests ----------
const PYSHIM = require('./code-run-pyshim');
const PY_TEST_RE = /^\s*def\s+test\w*\s*\(|\bimport\s+pytest\b|^\s*from\s+pytest\b|\bunittest\.TestCase\b/m;
const PY_STD = new Set('abc argparse array ast asyncio base64 bisect builtins calendar collections contextlib copy csv dataclasses datetime decimal difflib enum fractions functools gzip hashlib heapq html inspect io itertools json logging math numbers operator os pprint queue random re secrets statistics string struct sys textwrap threading time traceback types typing unittest uuid warnings weakref zlib pytest'.split(' '));
function pyFriendly(res) {
  const text = String((res && res.stderr) || '') + '\n' + String((res && res.stdout) || '');
  const b = text.match(/BLOCKED: [^\n]+/); if (b) return b[0].replace('BLOCKED: ', 'Sandbox ne roka: ') + ' (owner-only + approve ke bawajood file/network/process wali cheezein band hain.)';
  const m = text.match(/No module named '([^'.]+)/); if (m) return "Package '" + m[1] + "' sandbox me nahi hai (yahan pip install nahi hota). Sirf Python ki built-in library aur pytest-style tests chalte hain.";
  return '';
}
async function runPyBlocks({ blocks, timeoutMs } = {}) {
  blocks = (Array.isArray(blocks) ? blocks : []).map((b) => String(b || '')).filter((b) => b.trim());
  if (!blocks.length) return { status: 'skipped', lang: 'py', note: 'Code khaali hai.' };
  const tests = blocks.filter((b) => PY_TEST_RE.test(b));
  const others = blocks.filter((b) => !PY_TEST_RE.test(b));
  if (!tests.length) return runCode({ lang: 'py', code: others[0] || blocks[0], timeoutMs });
  const impl = others.find((b) => /^\s*(def|class)\s/m.test(b)) || others[0] || '';
  const testCode = tests.join('\n\n');
  let modName = 'solution';
  const re = /^\s*(?:from\s+([A-Za-z_]\w*)[\w.]*\s+import|import\s+([A-Za-z_]\w*))/gm; let m;
  while ((m = re.exec(testCode))) { const n = m[1] || m[2]; if (n && !PY_STD.has(n)) { modName = n; break; } }
  const ms = timeoutMs || LIMITS.ms;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));
  try {
    if (impl) fs.writeFileSync(path.join(dir, modName + '.py'), impl, 'utf8');
    fs.writeFileSync(path.join(dir, 'test_main.py'), testCode, 'utf8');
    fs.writeFileSync(path.join(dir, 'pytest.py'), PYSHIM.PYTEST_SHIM, 'utf8');
    fs.writeFileSync(path.join(dir, '_run_tests.py'), PYSHIM.PY_RUNNER, 'utf8');
    let r;
    for (const bin of ['python3', 'python']) { r = await spawnRun(bin, ['_run_tests.py', 'test_main'], dir, ms); if (!r.unavailable) break; }
    if (r.unavailable) return { status: 'skipped', lang: 'py', note: 'python is machine par nahi mila; code chalaya nahi gaya.' };
    const base = { lang: 'py', hadTests: true, exitCode: r.exitCode, ms: r.ms, stdout: clipTail(r.stdout), stderr: clip(r.stderr), sandboxFlag: false, friendly: pyFriendly(r), usedBlocks: { impl: !!impl, tests: tests.length } };
    if (r.timedOut) return { ...base, status: 'timeout', note: 'Time limit (' + ms + 'ms) me khatam nahi hua.' };
    if (r.exitCode !== 0) return { ...base, status: 'failed' };
    return { ...base, status: 'tested' };
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ok */ } }
}
// One entry point for the server: lang 'js' or 'py', blocks = every code block of the answer.
function runAnyBlocks({ lang, blocks, timeoutMs } = {}) {
  lang = String(lang || 'js').toLowerCase();
  if (lang === 'py' || lang === 'python') return runPyBlocks({ blocks, timeoutMs });
  return runBlocks({ blocks, timeoutMs });
}

// Report sirf real result se. Model ka "Verified" yahan se nahi aata.
function buildReport(res) {
  if (!res) return 'NOT TESTED: koi check nahi chala.';
  switch (res.status) {
    case 'tested': return 'VERIFIED (tests pass, ' + res.ms + 'ms): code chala aur tests exit code 0 ke saath nikle.' + (res.sandboxFlag === false ? ' (Dhyan: Node sandbox flag nahi laga.)' : '');
    case 'ran': return 'RAN OK, TESTS NAHI: code error ke bina chala (' + res.ms + 'ms), par logic ka koi test nahi tha. "Verified" mat bolo.';
    case 'failed': return 'FAILED (exit ' + res.exitCode + '):\n' + (res.friendly ? res.friendly + '\n\n' : '') + (res.stdout || res.stderr || '(koi output nahi)');
    case 'timeout': return 'FAILED: ' + res.note;
    case 'skipped': return 'NOT TESTED: ' + res.note;
    default: return 'NOT TESTED';
  }
}

// Generate -> run -> asli error wapas -> fix. generate(prevCode, errorText) async -> nayi code string.
// maxRounds tak. Aakhri report real result se.
async function verifyLoop({ lang, code, tests, generate, maxRounds }) {
  const rounds = [];
  let cur = code;
  const max = maxRounds || 3;
  for (let i = 1; i <= max; i++) {
    const res = await runCode({ lang, code: cur, tests });
    rounds.push({ round: i, status: res.status });
    if (res.status === 'tested' || res.status === 'ran' || res.status === 'skipped' || typeof generate !== 'function' || i === max) {
      return { code: cur, final: res, rounds, report: buildReport(res) };
    }
    const next = await generate(cur, buildReport(res));
    if (!next || next === cur) return { code: cur, final: res, rounds, report: buildReport(res) };
    cur = next;
  }
}

module.exports = { runCode, runBlocks, runPyBlocks, runAnyBlocks, buildReport, verifyLoop, LIMITS, _isTestBlock: isTestBlock, _isEsm: isEsm };
