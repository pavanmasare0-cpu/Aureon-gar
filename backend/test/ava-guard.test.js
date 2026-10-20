'use strict';
const test = require('node:test');
const assert = require('node:assert');
const G = require('../public/ava-guard.js');

test('built-in selfTest passes', () => {
  const r = G.selfTest();
  assert.deepStrictEqual(r.cases.filter((c) => !c.ok), []);
  assert.ok(r.total >= 40);
});
test('verdicts', () => {
  assert.strictEqual(G.inspect('<img src=x onerror=alert(1)>').verdict, 'block');
  assert.strictEqual(G.inspect('Kal 9 baje milte hain').verdict, 'allow');
});
test('log never holds the secret', () => {
  const g = G.createGuard();
  const key = 'AIza' + 'b'.repeat(35);
  g.check('x ' + key, { key: 'a' });
  assert.ok(!JSON.stringify(g.events()).includes(key));
});
