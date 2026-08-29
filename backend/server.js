// Aureon AI — backend chat proxy (MVP)
// Keeps API keys server-side. The Android app never sees them.

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.PORT || 3000;

async function callOpenAI(messages) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set in backend/.env');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'OpenAI request failed');
  return data.choices[0].message.content;
}

async function callClaude(messages) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in backend/.env');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Claude request failed');
  return data.content.map(c => c.text || '').join('');
}

// ---- Gemini: self-healing model selection ----
// We don't hardcode a model name (Google retires/restricts them over time).
// Instead:
//  1. Prefer "gemini-flash-latest" — an alias Google itself keeps pointed at
//     whatever their current recommended flash model is.
//  2. If that's unavailable, ask ListModels and pick the highest-numbered
//     flash model that supports generateContent.
//  3. If a chosen model fails at call-time (retired, or blocked for this
//     account even though ListModels still shows it), blacklist it in
//     memory for this process and pick the next best candidate — no manual
//     fix ever needed.

let cachedGeminiModel = null;
let cachedAt = 0;
const MODEL_CACHE_MS = 60 * 60 * 1000; // 1 hour
const blacklistedModels = new Set();

function extractVersion(name) {
  const match = name.match(/gemini-(\d+(?:\.\d+)?)/i);
  return match ? parseFloat(match[1]) : -1;
}

async function fetchCandidateModels() {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Could not list Gemini models');

  return (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''))
    .filter(name => !blacklistedModels.has(name));
}

async function resolveGeminiModel(forceRefresh = false) {
  const isFresh = Date.now() - cachedAt < MODEL_CACHE_MS;
  if (cachedGeminiModel && isFresh && !forceRefresh && !blacklistedModels.has(cachedGeminiModel)) {
    return cachedGeminiModel;
  }

  const candidates = await fetchCandidateModels();

  // 1. Prefer the "latest" alias if it's present and not blacklisted.
  const latestAlias = candidates.find(name => /^gemini-flash-latest$/i.test(name));
  if (latestAlias) {
    cachedGeminiModel = latestAlias;
    cachedAt = Date.now();
    return cachedGeminiModel;
  }

  // 2. Otherwise, pick a stable flash model, preferring the highest version
  //    number and excluding preview/experimental/thinking/live/translate variants.
  const stableFlash = candidates
    .filter(name => /flash/i.test(name) && !/preview|exp|thinking|live|translate/i.test(name))
    .sort((a, b) => extractVersion(b) - extractVersion(a));

  const fallbackFlash = candidates.filter(name => /flash/i.test(name));

  const chosen = stableFlash[0] || fallbackFlash[0] || candidates[0];

  if (!chosen) throw new Error('No usable Gemini model found for this API key.');

  cachedGeminiModel = chosen;
  cachedAt = Date.now();
  return cachedGeminiModel;
}

async function callGeminiWithModel(modelName, messages) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
      })
    }
  );
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error?.message || 'Gemini request failed');
    err.status = res.status;
    throw err;
  }
  return data.candidates[0].content.parts[0].text;
}

async function callGemini(messages) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set in backend/.env');

  let model = await resolveGeminiModel();
  let lastErr;

  // Try up to 3 distinct models before giving up, blacklisting each failure
  // that looks like a model-availability problem (not a real request error).
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await callGeminiWithModel(model, messages);
    } catch (err) {
      lastErr = err;
      const looksLikeModelIssue =
        /not found|no longer available|unsupported|deprecated|is not supported/i.test(err.message || '');
      if (!looksLikeModelIssue) throw err;

      console.warn(`Gemini model "${model}" unavailable, blacklisting and retrying:`, err.message);
      blacklistedModels.add(model);
      model = await resolveGeminiModel(true);
    }
  }

  throw lastErr;
}

function callLocal(messages) {
  const last = messages[messages.length - 1]?.content || '';
  return Promise.resolve(`[local model placeholder] You said: ${last}`);
}

const PROVIDERS = { openai: callOpenAI, claude: callClaude, gemini: callGemini, local: callLocal };

app.post('/api/chat', async (req, res) => {
  try {
    const { messages, model = 'gemini' } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }
    const provider = PROVIDERS[model] || PROVIDERS.openai;
    const reply = await provider(messages);
    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Something went wrong' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/', (req, res) => res.send('Aureon AI backend is running. POST to /api/chat.'));

app.listen(PORT, () => console.log(`Aureon AI backend running on port ${PORT}`));
