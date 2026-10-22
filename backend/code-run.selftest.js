// node backend/code-run.selftest.js  -> har check ka PASS/FAIL asli chalke dikhata hai
const assert = require('assert');
const { runCode, buildReport, verifyLoop } = require('./code-run');
const cases = [];
const t = (name, fn) => cases.push({ name, fn });

const GOOD = 'function add(a,b){return a+b} module.exports={add};';
const BAD = 'function add(a,b){return a-b} module.exports={add};';
const TEST = "const assert=require('assert');const {add}=require('./main');assert.strictEqual(add(2,3),5);console.log('ok');";

t('js sahi code + test -> tested', async () => assert.strictEqual((await runCode({ lang: 'js', code: GOOD, tests: TEST })).status, 'tested'));
t('js galat logic -> failed (assertion dikhe)', async () => { const r = await runCode({ lang: 'js', code: BAD, tests: TEST }); assert.strictEqual(r.status, 'failed'); assert.ok(/AssertionError|Expected/.test(r.stderr)); });
t('js bina test -> sirf ran, VERIFIED nahi', async () => { const r = await runCode({ lang: 'js', code: GOOD }); assert.strictEqual(r.status, 'ran'); assert.ok(!/^VERIFIED/.test(buildReport(r))); });
t('js syntax error -> failed', async () => assert.strictEqual((await runCode({ lang: 'js', code: 'function(' })).status, 'failed'));
t('infinite loop -> timeout', async () => assert.strictEqual((await runCode({ lang: 'js', code: 'while(true){}', timeoutMs: 800 })).status, 'timeout'));
t('env me API key leak nahi', async () => { process.env.FAKE_SECRET_KEY = 'abc123'; const r = await runCode({ lang: 'js', code: 'console.log(process.env.FAKE_SECRET_KEY||"NONE")' }); assert.ok(r.stdout.includes('NONE')); });
t('temp folder ke bahar file padh nahi sakta', async () => { const r = await runCode({ lang: 'js', code: "require('fs').readFileSync('/etc/hostname')" }); assert.strictEqual(r.status, 'failed'); });
t('child_process band', async () => { const r = await runCode({ lang: 'js', code: "require('child_process').execSync('echo hi')" }); assert.strictEqual(r.status, 'failed'); });
t('python sahi + test -> tested', async () => assert.strictEqual((await runCode({ lang: 'py', code: 'def add(a,b):\n    return a+b', tests: 'from main import add\nassert add(2,3)==5\nprint("ok")' })).status, 'tested'));
t('python galat -> failed', async () => assert.strictEqual((await runCode({ lang: 'py', code: 'def add(a,b):\n    return a-b', tests: 'from main import add\nassert add(2,3)==5' })).status, 'failed'));
t('anjaan language -> skipped (fake pass nahi)', async () => { const r = await runCode({ lang: 'kotlin', code: 'fun main(){}' }); assert.strictEqual(r.status, 'skipped'); assert.ok(/^NOT TESTED/.test(buildReport(r))); });
t('verifyLoop: round 2 me fix hota hai', async () => { const r = await verifyLoop({ lang: 'js', code: BAD, tests: TEST, generate: async () => GOOD }); assert.strictEqual(r.final.status, 'tested'); assert.strictEqual(r.rounds.length, 2); });
t('verifyLoop: fix na ho to FAILED hi dikhe', async () => { const r = await verifyLoop({ lang: 'js', code: BAD, tests: TEST, generate: async (c) => c + ' ', maxRounds: 2 }); assert.strictEqual(r.final.status, 'failed'); assert.ok(/^FAILED/.test(r.report)); });

(async () => {
  let bad = 0;
  for (const c of cases) {
    try { await c.fn(); console.log('PASS: ' + c.name); }
    catch (e) { bad++; console.log('FAIL: ' + c.name + ' -> ' + String(e.message).split('\n')[0]); }
  }
  console.log('\n' + (cases.length - bad) + '/' + cases.length + ' passed');
  process.exit(bad ? 1 : 0);
})();
