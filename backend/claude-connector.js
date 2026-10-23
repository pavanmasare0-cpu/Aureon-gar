// backend/claude-connector.js — "Claude connector": each user can connect THEIR OWN Anthropic API key.
// Storage: Firestore users/{uid}/connectors/claude  { keyEnc, last4, model, savedAt }  (key encrypted with secret-box, AES-256-GCM).
// The key is never returned to the app (only last 4 chars) and never logged.
// If the user has no key, the server-wide ANTHROPIC_API_KEY (backend/.env) is used as before.
const secretBox = require('./secret-box');

const MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — balanced (default)' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — most capable' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — fastest' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 — older' },
];
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const FALLBACK_MODEL = 'claude-sonnet-4-6';
const KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;
const isModel = (m) => MODELS.some((x) => x.id === m);

function docRef(db, uid) { return db.collection('users').doc(uid).collection('connectors').doc('claude'); }

// -> { apiKey, model, source: 'user' | 'server' } or null when no key anywhere
async function resolve(db, uid) {
  let model = DEFAULT_MODEL;
  if (db && uid) {
    try {
      const snap = await docRef(db, uid).get();
      const d = snap.exists ? snap.data() : null;
      if (d && isModel(d.model)) model = d.model;
      const key = d && d.keyEnc ? secretBox.decrypt(d.keyEnc) : null;
      if (key) return { apiKey: key, model, source: 'user' };
    } catch (e) { console.warn('claude connector read failed:', e.message); }
  }
  if (process.env.ANTHROPIC_API_KEY) return { apiKey: process.env.ANTHROPIC_API_KEY, model, source: 'server' };
  return null;
}

// One Messages API call. Retries once with an older model if the chosen one does not exist for this key.
async function call({ apiKey, model, messages, system, maxTokens = 4096 }) {
  const send = async (m) => {
    const body = { model: m, max_tokens: maxTokens, messages: messages.map((x) => ({ role: x.role === 'assistant' ? 'assistant' : 'user', content: String(x.content) })) };
    if (system) body.system = system;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };
  let { res, data } = await send(model);
  if (!res.ok && (res.status === 404 || /model/i.test((data.error && data.error.message) || '')) && model !== FALLBACK_MODEL) {
    ({ res, data } = await send(FALLBACK_MODEL));
  }
  if (!res.ok) {
    const e = new Error((data.error && data.error.message) || 'Claude request failed (' + res.status + ')');
    e.status = res.status; throw e;
  }
  return (data.content || []).map((c) => c.text || '').join('');
}

function friendly(e) {
  if (e.status === 401) return 'Ye Anthropic key galat hai ya band ho chuki hai.';
  if (e.status === 403) return 'Is key ko permission nahi hai.';
  if (e.status === 429) return 'Key valid hai par abhi rate limit / credit khatam hai.';
  return e.message || 'Claude se connect nahi hua';
}

function createRouter({ express, verifyAuth, getDb }) {
  const r = express.Router();
  r.use(verifyAuth);

  r.get('/', async (req, res) => {
    try {
      const snap = await docRef(getDb(), req.verifiedUid).get();
      const d = snap.exists ? snap.data() : {};
      res.json({
        connected: !!d.keyEnc, last4: d.last4 || '', model: isModel(d.model) ? d.model : DEFAULT_MODEL, models: MODELS,
        serverKey: !!process.env.ANTHROPIC_API_KEY, canStore: secretBox.available(),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.post('/', async (req, res) => {
    try {
      const apiKey = String((req.body && req.body.apiKey) || '').trim();
      const model = isModel(req.body && req.body.model) ? req.body.model : DEFAULT_MODEL;
      if (!KEY_RE.test(apiKey)) return res.status(400).json({ ok: false, error: 'Key "sk-ant-" se shuru honi chahiye (console.anthropic.com se banao).' });
      if (!secretBox.available()) return res.status(500).json({ ok: false, error: 'Server par SENTINEL_ENC_KEY set nahi hai, isliye key safe store nahi ho sakti.' });
      try { await call({ apiKey, model, messages: [{ role: 'user', content: 'Reply with: ok' }], maxTokens: 8 }); }
      catch (e) { return res.status(400).json({ ok: false, error: friendly(e) }); }
      await docRef(getDb(), req.verifiedUid).set({ keyEnc: secretBox.encrypt(apiKey), last4: apiKey.slice(-4), model, savedAt: Date.now() });
      res.json({ ok: true, last4: apiKey.slice(-4), model });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  r.post('/model', async (req, res) => {
    try {
      const model = req.body && req.body.model;
      if (!isModel(model)) return res.status(400).json({ ok: false, error: 'Model list mein nahi hai' });
      await docRef(getDb(), req.verifiedUid).set({ model }, { merge: true });
      res.json({ ok: true, model });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  r.post('/test', async (req, res) => {
    try {
      const c = await resolve(getDb(), req.verifiedUid);
      if (!c) return res.status(400).json({ ok: false, error: 'Koi Claude key nahi hai — pehle key connect karo.' });
      const t0 = Date.now();
      await call({ ...c, messages: [{ role: 'user', content: 'Reply with: ok' }], maxTokens: 8 });
      res.json({ ok: true, source: c.source, model: c.model, ms: Date.now() - t0 });
    } catch (e) { res.status(400).json({ ok: false, error: friendly(e) }); }
  });

  r.delete('/', async (req, res) => {
    try { await docRef(getDb(), req.verifiedUid).delete(); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  return r;
}

module.exports = { createRouter, resolve, call, MODELS, DEFAULT_MODEL };
