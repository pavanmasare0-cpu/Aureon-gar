// Aureon AI — backend chat proxy (MVP)
// Keeps API keys server-side. The Android app never sees them.

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.PORT || 3000;

// ---- Provider adapters ----
// Each adapter takes the chat history and returns a plain string reply.

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
// Instead of a hardcoded model name that Google can retire at any time, we
// ask Gemini's own ListModels endpoint which models are currently available
// and pick a suitable one. Cached for an hour so we're not calling it on
// every message; if a request ever fails because the cached model got
// retired mid-cache, we refresh the list and retry once automatically.

let cachedGeminiModel = null;
let cachedAt = 0;
const MODEL_CACHE_MS = 60 * 60 * 1000; // 1 hour

async function resolveGeminiModel(forceRefresh = false) {
  const isFresh = Date.now() - cachedAt < MODEL_CACHE_MS;
  if (cachedGeminiModel && isFresh && !forceRefresh) {
    return cachedGeminiModel;
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Could not list Gemini models');

  const models = (data.models || []).filter(m =>
    (m.supportedGenerationMethods || []).includes('generateContent')
  );

  // Prefer a "flash" model that isn't a preview/experimental/thinking variant
  // (those tend to be less stable / higher latency / not meant for general use).
  const preferred = models.find(m =>
    /flash/i.test(m.name) &&
    !/preview|exp|thinking|live|translate/i.test(m.name)
  );

  const chosen = preferred || models.find(m => /flash/i.test(m.name)) || models[0];

  if (!chosen) throw new Error('No usable Gemini model found for this API key.');

  // m.name looks like "models/gemini-3.6-flash" — strip the "models/" prefix.
  cachedGeminiModel = chosen.name.replace(/^models\//, '');
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

  const model = await resolveGeminiModel();

  try {
    return await callGeminiWithModel(model, messages);
  } catch (err) {
    // If the cached model just got retired/renamed, refresh the list and
    // retry once with whatever's newly available — no manual fix needed.
    const looksLikeModelIssue =
      /not found|no longer available|unsupported|deprecated/i.test(err.message || '');
    if (looksLikeModelIssue) {
      const freshModel = await resolveGeminiModel(true);
      return await callGeminiWithModel(freshModel, messages);
    }
    throw err;
  }
}

function callLocal(messages) {
  // Placeholder for a local/offline model (e.g. via Ollama running on your own server).
  // Wire this up when you add Local AI mode.
  const last = messages[messages.length - 1]?.content || '';
  return Promise.resolve(`[local model placeholder] You said: ${last}`);
}

const PROVIDERS = { openai: callOpenAI, claude: callClaude, gemini: callGemini, local: callLocal };

// ---- Routes ----
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
