// backend/code-run-shim.js — tiny jest/vitest-compatible test runner that the sandbox drops into the temp folder.
// Why: AI-written tests very often import 'vitest' or use jest globals, but the sandbox has no npm packages.
// This file is COPIED as text into the temp folder (see code-run.js); it must stay a plain CommonJS script with no dependencies.
module.exports = String.raw`'use strict';
const util = require('util');
const root = { name: '', hooks: { before: [], after: [], beforeAll: [], afterAll: [] }, parent: null, ranBeforeAll: false };
let cur = root; const tests = []; let scheduled = false;
function schedule() { if (scheduled) return; scheduled = true; setTimeout(runAll, 30); }

function suite(name, fn) { const s = { name, hooks: { before: [], after: [], beforeAll: [], afterAll: [] }, parent: cur, ranBeforeAll: false }; const prev = cur; cur = s; try { fn(); } finally { cur = prev; } }
const describe = (n, f) => suite(n, f); describe.skip = () => {}; describe.only = describe; describe.todo = () => {};
describe.each = (rows) => (n, f) => rows.forEach((r) => suite(fmt(n, r), () => f(...[].concat(r))));
function fmt(n, r) { const a = [].concat(r); let i = 0; return String(n).replace(/%[sdifjo%]/g, (m) => m === '%%' ? '%' : util.inspect(a[i++]).replace(/^'|'$/g, '')); }
function reg(n, f, skip) { tests.push({ suite: cur, name: String(n), fn: f, skip: !!skip }); schedule(); }
const it = (n, f) => reg(n, f); it.skip = (n, f) => reg(n, f, true); it.todo = (n) => reg(n, null, true); it.only = it;
it.each = (rows) => (n, f) => rows.forEach((r) => reg(fmt(n, r), () => f(...[].concat(r))));
const test = it;
const beforeEach = (f) => cur.hooks.before.push(f), afterEach = (f) => cur.hooks.after.push(f);
const beforeAll = (f) => cur.hooks.beforeAll.push(f), afterAll = (f) => cur.hooks.afterAll.push(f);

function deepEq(a, b, strict) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp && b instanceof RegExp) return String(a) === String(b);
  if (a instanceof Map && b instanceof Map) return a.size === b.size && [...a].every(([k, v]) => b.has(k) && deepEq(v, b.get(k), strict));
  if (a instanceof Set && b instanceof Set) return a.size === b.size && [...a].every((v) => b.has(v) || [...b].some((w) => deepEq(v, w, strict)));
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEq(v, b[i], strict));
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const ka = Object.keys(a).filter((k) => strict || a[k] !== undefined), kb = Object.keys(b).filter((k) => strict || b[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEq(a[k], b[k], strict));
}
const show = (v) => util.inspect(v, { depth: 4, breakLength: 100 });
function getPath(o, p) { const parts = Array.isArray(p) ? p : String(p).replace(/\[(\d+)\]/g, '.$1').split('.'); let c = o; for (const k of parts) { if (c == null || !(k in Object(c))) return { found: false }; c = c[k]; } return { found: true, value: c }; }

function matchers(actual, negate, mode) {
  const wrap = (name, pred, msg) => (...args) => {
    const run = (val) => { const ok = pred(val, ...args); if (negate ? ok : !ok) throw new Error('expect(' + show(val) + ').' + (negate ? 'not.' : '') + name + '(' + args.map(show).join(', ') + ')' + (msg ? ' — ' + msg(val, ...args) : '')); };
    if (mode === 'resolves') return Promise.resolve(actual).then(run);
    if (mode === 'rejects') return Promise.resolve(actual).then(() => { throw new Error('expected promise to reject, but it resolved'); }, (e) => run(e));
    return run(actual);
  };
  const errMatches = (err, exp) => { if (exp === undefined) return true; if (typeof exp === 'string') return String(err && err.message || err).includes(exp); if (exp instanceof RegExp) return exp.test(String(err && err.message || err)); if (typeof exp === 'function') return err instanceof exp; return true; };
  const throwsFn = (fn, exp) => { let err, threw = false; try { fn(); } catch (e) { threw = true; err = e; } if (!threw) return false; if (exp === undefined) return true; if (typeof exp === 'string') return String(err && err.message || err).includes(exp); if (exp instanceof RegExp) return exp.test(String(err && err.message || err)); if (typeof exp === 'function') return err instanceof exp; return true; };
  const m = {
    toBe: wrap('toBe', (a, e) => Object.is(a, e)), toEqual: wrap('toEqual', (a, e) => deepEq(a, e, false)), toStrictEqual: wrap('toStrictEqual', (a, e) => deepEq(a, e, true)),
    toBeTruthy: wrap('toBeTruthy', (a) => !!a), toBeFalsy: wrap('toBeFalsy', (a) => !a), toBeNull: wrap('toBeNull', (a) => a === null),
    toBeUndefined: wrap('toBeUndefined', (a) => a === undefined), toBeDefined: wrap('toBeDefined', (a) => a !== undefined), toBeNaN: wrap('toBeNaN', (a) => Number.isNaN(a)),
    toBeGreaterThan: wrap('toBeGreaterThan', (a, e) => a > e), toBeGreaterThanOrEqual: wrap('toBeGreaterThanOrEqual', (a, e) => a >= e),
    toBeLessThan: wrap('toBeLessThan', (a, e) => a < e), toBeLessThanOrEqual: wrap('toBeLessThanOrEqual', (a, e) => a <= e),
    toBeCloseTo: wrap('toBeCloseTo', (a, e, d = 2) => Math.abs(a - e) < Math.pow(10, -d) / 2),
    toContain: wrap('toContain', (a, e) => (typeof a === 'string' ? a.includes(e) : Array.from(a).includes(e))),
    toContainEqual: wrap('toContainEqual', (a, e) => Array.from(a).some((v) => deepEq(v, e, false))),
    toHaveLength: wrap('toHaveLength', (a, e) => a != null && a.length === e, (a) => 'length is ' + (a && a.length)),
    toMatch: wrap('toMatch', (a, e) => (e instanceof RegExp ? e.test(a) : String(a).includes(e))),
    toHaveProperty: wrap('toHaveProperty', (a, p, v) => { const r = getPath(a, p); return r.found && (v === undefined || deepEq(r.value, v, false)); }),
    toBeInstanceOf: wrap('toBeInstanceOf', (a, C) => a instanceof C),
    toThrow: wrap('toThrow', (a, e) => (mode === 'rejects' ? errMatches(a, e) : throwsFn(a, e))), toThrowError: wrap('toThrowError', (a, e) => (mode === 'rejects' ? errMatches(a, e) : throwsFn(a, e))),
    toHaveBeenCalled: wrap('toHaveBeenCalled', (a) => a.mock && a.mock.calls.length > 0), toBeCalled: wrap('toBeCalled', (a) => a.mock && a.mock.calls.length > 0),
    toHaveBeenCalledTimes: wrap('toHaveBeenCalledTimes', (a, n) => a.mock && a.mock.calls.length === n, (a) => 'called ' + (a.mock && a.mock.calls.length) + ' times'),
    toHaveBeenCalledWith: wrap('toHaveBeenCalledWith', (a, ...args) => a.mock && a.mock.calls.some((c) => deepEq(c, args, false))),
  };
  return m;
}
function expect(actual) {
  const base = matchers(actual, false), not = matchers(actual, true);
  return Object.assign({}, base, { not, resolves: Object.assign(matchers(actual, false, 'resolves'), { not: matchers(actual, true, 'resolves') }), rejects: Object.assign(matchers(actual, false, 'rejects'), { not: matchers(actual, true, 'rejects') }) });
}
expect.any = (C) => ({ asymmetricMatch: (v) => v instanceof C || typeof v === C.name.toLowerCase() });

function fn(impl) {
  let implementation = impl; const queue = [];
  const mock = function (...args) { mock.mock.calls.push(args); const r = queue.length ? queue.shift() : implementation; const out = typeof r === 'function' ? r.apply(this, args) : r; mock.mock.results.push({ value: out }); return out; };
  mock.mock = { calls: [], results: [] };
  mock.mockImplementation = (f) => { implementation = f; return mock; }; mock.mockReturnValue = (v) => { implementation = () => v; return mock; };
  mock.mockReturnValueOnce = (v) => { queue.push(() => v); return mock; }; mock.mockResolvedValue = (v) => { implementation = () => Promise.resolve(v); return mock; };
  mock.mockRejectedValue = (v) => { implementation = () => Promise.reject(v); return mock; };
  mock.mockClear = () => { mock.mock.calls = []; mock.mock.results = []; return mock; }; mock.mockReset = () => { mock.mockClear(); implementation = undefined; return mock; };
  mock.mockRestore = mock.mockReset; return mock;
}
const spies = [];
function spyOn(obj, key) { const orig = obj[key]; const s = fn(orig); s.mockRestore = () => { obj[key] = orig; }; obj[key] = s; spies.push(s); return s; }
const vi = { fn, spyOn, clearAllMocks() {}, restoreAllMocks() { spies.splice(0).forEach((s) => s.mockRestore()); }, resetAllMocks() {}, useFakeTimers() {}, useRealTimers() {}, mock() {} };
vi.setSystemTime = () => {}; vi.advanceTimersByTime = () => {};

const chain = (s) => { const a = []; for (let x = s; x; x = x.parent) a.unshift(x); return a; };
const withTimeout = (p, ms) => { let t; const guard = new Promise((_, rj) => { t = setTimeout(() => rj(new Error('test timed out after ' + ms + 'ms')), ms); }); return Promise.race([Promise.resolve(p), guard]).finally(() => clearTimeout(t)); };
async function runAll() {
  let pass = 0, fail = 0, skip = 0; const t0 = Date.now();
  for (const t of tests) {
    const name = chain(t.suite).map((s) => s.name).filter(Boolean).concat(t.name).join(' > ');
    if (t.skip || !t.fn) { skip++; console.log('  SKIP  ' + name); continue; }
    try {
      for (const s of chain(t.suite)) if (!s.ranBeforeAll) { s.ranBeforeAll = true; for (const h of s.hooks.beforeAll) await h(); }
      for (const s of chain(t.suite)) for (const h of s.hooks.before) await h();
      await withTimeout(t.fn(), 5000);
      for (const s of chain(t.suite).reverse()) for (const h of s.hooks.after) await h();
      pass++; console.log('  PASS  ' + name);
    } catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + String((e && e.message) || e).split('\n').join('\n        ')); }
  }
  for (const s of new Set(tests.map((t) => t.suite))) for (const x of chain(s).reverse()) for (const h of x.hooks.afterAll) { try { await h(); } catch (e) { /* ignore */ } }
  console.log('\nTests: ' + pass + ' passed, ' + fail + ' failed' + (skip ? ', ' + skip + ' skipped' : '') + ' (' + (Date.now() - t0) + 'ms)');
  process.exitCode = fail ? 1 : 0;
}
process.on('unhandledRejection', (e) => { console.log('  FAIL  unhandled promise rejection\n        ' + String((e && e.message) || e)); process.exitCode = 1; });

const api = { describe, it, test, suite: describe, expect, beforeEach, afterEach, beforeAll, afterAll, vi, jest: vi };
Object.assign(globalThis, { describe, it, test, expect, beforeEach, afterEach, beforeAll, afterAll, vi, jest: vi });
module.exports = api;
`;
