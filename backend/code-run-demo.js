// node backend/code-run-demo.js  -> phone terminal me asli pass/fail dikhata hai
// Dhyan: neeche ka "fixer" AI nahi hai, ek fixed stub hai, sirf loop dikhane ke liye.
const { verifyLoop, buildReport, runCode } = require('./code-run');
const TEST = "const assert=require('assert');const {add}=require('./main');assert.strictEqual(add(2,3),5);assert.strictEqual(add(-1,1),0);console.log('ok');";
const GOOD = 'function add(a,b){return a+b} module.exports={add};';
const BAD = 'function add(a,b){return a-b} module.exports={add};';
(async () => {
  console.log('--- 1) sahi code + test ---');
  console.log(buildReport(await runCode({ lang: 'js', code: GOOD, tests: TEST })));
  console.log('\n--- 2) galat code + test (asli error dikhega) ---');
  console.log(buildReport(await runCode({ lang: 'js', code: BAD, tests: TEST })));
  console.log('\n--- 3) bina test: "Verified" nahi milega ---');
  console.log(buildReport(await runCode({ lang: 'js', code: GOOD })));
  console.log('\n--- 4) loop: galat code -> error wapas -> fix -> dobara test ---');
  const r = await verifyLoop({ lang: 'js', code: BAD, tests: TEST, generate: async () => GOOD });
  console.log('rounds:', JSON.stringify(r.rounds));
  console.log(r.report);
})();
