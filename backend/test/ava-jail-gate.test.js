'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const gate = require('../ava-jail-gate');
const guard = fs.readFileSync(path.join(__dirname, './fixtures/jail-sample.js'), 'utf8');

const TOY = `(function(){'use strict';var s=document.createElement('div');s.textContent='\u{1F6E1}';document.body.appendChild(s);
document.addEventListener('input',function(e){if(/</.test(e.target.value))e.target.style.border='1px solid red';});})();`;

test('toy shield widget is rejected', () => {
  const r = gate.checkJailQuality(TOY, 'security');
  assert.strictEqual(r.ok, false);
  assert.ok(r.reasons.some((x) => /too small/.test(x)));
});
test('real widget passes gate and self-test', () => {
  assert.deepStrictEqual(gate.checkJailQuality(guard, 'security').reasons, []);
  assert.strictEqual(gate.runSelfTest(guard).ok, true);
});
test('infinite loop in selfTest is killed', () => {
  const evil = '(function(){"use strict";window.__AVA_JAIL__={name:"x",selfTest:function(){while(true){}}}})();';
  assert.strictEqual(gate.runSelfTest(evil).ok, false);
});
test('{ok:true} with no cases is not accepted', () => {
  const lazy = '(function(){"use strict";window.__AVA_JAIL__={name:"x",selfTest:function(){return {ok:true,cases:[]}}}})();';
  assert.strictEqual(gate.runSelfTest(lazy).ok, false);
});
test('fake markers and network calls are rejected', () => {
  const bad = 'window.__AVA_JAIL__={selfTest:1}; // TODO later\nfetch("/x")';
  const r = gate.checkJailQuality(bad, 'other');
  assert.ok(r.reasons.some((x) => /marker/.test(x)) && r.reasons.some((x) => /network/.test(x)));
});
test('repair loop: bad draft then good draft', async () => {
  let n = 0;
  const out = await gate.produceVariant({
    brief: 'guard', safety: () => null,
    ask: async () => (++n === 1 ? '===META===\ntitle: t\ncategory: security\n===CODE===\n' + TOY + '\n===END===' : '===META===\ntitle: Guard\ncategory: security\n===CODE===\n' + guard + '\n===END==='),
  });
  assert.strictEqual(out.rounds, 2);
});
