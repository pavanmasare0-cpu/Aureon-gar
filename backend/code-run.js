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

// Report sirf real result se. Model ka "Verified" yahan se nahi aata.
function buildReport(res) {
  if (!res) return 'NOT TESTED: koi check nahi chala.';
  switch (res.status) {
    case 'tested': return 'VERIFIED (tests pass, ' + res.ms + 'ms): code chala aur tests exit code 0 ke saath nikle.' + (res.sandboxFlag === false ? ' (Dhyan: Node sandbox flag nahi laga.)' : '');
    case 'ran': return 'RAN OK, TESTS NAHI: code error ke bina chala (' + res.ms + 'ms), par logic ka koi test nahi tha. "Verified" mat bolo.';
    case 'failed': return 'FAILED (exit ' + res.exitCode + '):\n' + (res.stderr || res.stdout || '(koi output nahi)');
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

module.exports = { runCode, buildReport, verifyLoop, LIMITS };
