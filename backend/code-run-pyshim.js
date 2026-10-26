// backend/code-run-pyshim.js — Python side of the sandbox: a tiny pytest look-alike + a guard + a test runner (plain text, copied into the temp folder).
// Python has no OS-level permission sandbox like Node's --permission, so before anything runs, the code is scanned (ast) and
// obvious file / network / process access is refused. This is a deny-list, NOT a hard wall: owner-only + Approve + clean env + time limit stay the real safety.
exports.PYTEST_SHIM = String.raw`import re, contextlib

class _Fail(AssertionError): pass
class _Skip(Exception): pass
def fail(msg=''): raise _Fail(msg)
def skip(msg=''): raise _Skip(msg)

class _Raises:
    def __init__(self, exc, match=None): self.exc, self.match, self.value = exc, match, None
    def __enter__(self): return self
    def __exit__(self, t, v, tb):
        if t is None: raise _Fail('DID NOT RAISE ' + getattr(self.exc, '__name__', str(self.exc)))
        if not issubclass(t, self.exc): return False
        if self.match is not None and not re.search(self.match, str(v)): raise _Fail("Regex '%s' not found in '%s'" % (self.match, v))
        self.value = v; return True
def raises(exc, match=None): return _Raises(exc, match)

class approx:
    def __init__(self, v, rel=1e-6, abs=1e-12): self.v, self.rel, self.abs = v, rel, abs
    def __eq__(self, o):
        try: return abs(o - self.v) <= max(self.rel * abs(self.v), self.abs)
        except TypeError: return False
    def __repr__(self): return 'approx(%r)' % (self.v,)

_fixtures = {}
def fixture(fn=None, **kw):
    def deco(f): _fixtures[f.__name__] = f; return f
    return deco(fn) if callable(fn) else deco

class _Mark:
    def parametrize(self, names, values, **kw):
        def deco(f):
            f._params = (names, list(values)); return f
        return deco
    def skip(self, reason=''):
        def deco(f): f._skip = True; return f
        return deco if not callable(reason) else deco(reason)
    def __getattr__(self, name): return lambda *a, **k: (lambda f: f)
mark = _Mark()
`;

exports.PY_RUNNER = String.raw`import ast, sys, os, inspect, traceback, unittest, importlib, io, contextlib, time

FORBIDDEN_IMPORTS = {'subprocess','socket','ssl','urllib','http','requests','ftplib','smtplib','ctypes','multiprocessing','shutil','pathlib','importlib','pty','signal','tempfile','glob','webbrowser','asyncio.subprocess','sqlite3'}
FORBIDDEN_CALLS = {'open','exec','eval','compile','__import__','input','breakpoint'}

def guard(path):
    src = open(path, encoding='utf-8').read()
    tree = ast.parse(src, path)
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            for a in n.names:
                top = a.name.split('.')[0]
                if top in FORBIDDEN_IMPORTS or (top == 'os' and a.name != 'os.path'): raise SystemExit("BLOCKED: import '%s' sandbox me allowed nahi (file/network/process access)." % a.name)
        elif isinstance(n, ast.ImportFrom):
            top = (n.module or '').split('.')[0]
            if top in FORBIDDEN_IMPORTS or (top == 'os' and (n.module != 'os.path' and not all(a.name == 'path' for a in n.names))): raise SystemExit("BLOCKED: 'from %s import ...' sandbox me allowed nahi." % n.module)
        elif isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in FORBIDDEN_CALLS:
            raise SystemExit("BLOCKED: %s() sandbox me allowed nahi." % n.func.id)

here = os.path.dirname(os.path.abspath(__file__))
for f in os.listdir(here):
    if f.endswith('.py') and f not in ('_run_tests.py', 'pytest.py'): guard(os.path.join(here, f))

import pytest as _pt
mod = importlib.import_module(sys.argv[1])
passed = failed = skipped = 0
t0 = time.time()

def call(fn, **extra):
    kw = {}
    for name in inspect.signature(fn).parameters:
        if name in extra: kw[name] = extra[name]
        elif name in _pt._fixtures:
            fx = _pt._fixtures[name]
            kw[name] = fx(**{p: kw[p] for p in inspect.signature(fx).parameters if p in kw})
            if inspect.isgenerator(kw[name]): kw[name] = next(kw[name])
    return fn(**kw)

def report(name, exc):
    global passed, failed, skipped
    if exc is None: passed += 1; print('  PASS  ' + name)
    elif isinstance(exc, _pt._Skip): skipped += 1; print('  SKIP  ' + name)
    else:
        failed += 1
        msg = ''.join(traceback.format_exception_only(type(exc), exc)).strip()
        if isinstance(exc, AssertionError) and not str(exc):
            try:
                fr = traceback.extract_tb(exc.__traceback__)[-1]
                msg = 'AssertionError: ' + (fr.line or '') + '   (line ' + str(fr.lineno) + ')'
            except Exception: pass
        print('  FAIL  ' + name + '\n        ' + msg.replace('\n', '\n        '))

for name, fn in sorted(vars(mod).items(), key=lambda kv: getattr(kv[1], '__code__', None) and kv[1].__code__.co_firstlineno or 0):
    if not (name.startswith('test') and callable(fn) and not inspect.isclass(fn)): continue
    if getattr(fn, '_skip', False): report(name, _pt._Skip()); continue
    params = getattr(fn, '_params', None)
    cases = [(name, {})]
    if params:
        names = [p.strip() for p in params[0].split(',')] if isinstance(params[0], str) else list(params[0])
        cases = []
        for i, v in enumerate(params[1]):
            vals = v if len(names) > 1 else (v,)
            cases.append(('%s[%s]' % (name, i), dict(zip(names, vals))))
    for label, extra in cases:
        try: call(fn, **extra); report(label, None)
        except BaseException as e: report(label, e)

suite = unittest.TestSuite()
for name, cls in vars(mod).items():
    if inspect.isclass(cls) and issubclass(cls, unittest.TestCase): suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(cls))
if suite.countTestCases():
    buf = io.StringIO(); res = unittest.TextTestRunner(stream=buf, verbosity=0).run(suite)
    passed += res.testsRun - len(res.failures) - len(res.errors); failed += len(res.failures) + len(res.errors)
    for t, tb in res.failures + res.errors: print('  FAIL  ' + str(t) + '\n        ' + tb.strip().splitlines()[-1])
    print('  (unittest: %d tests)' % res.testsRun)

print('\nTests: %d passed, %d failed%s (%dms)' % (passed, failed, (', %d skipped' % skipped) if skipped else '', (time.time() - t0) * 1000))
if passed + failed == 0: print('Koi test nahi mila: function ka naam test_ se shuru hona chahiye.'); sys.exit(1)
sys.exit(1 if failed else 0)
`;
