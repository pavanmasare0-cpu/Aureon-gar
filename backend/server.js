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
// Two kinds of failures get handled automatically, with no manual fix ever
// needed:
//  1. PERMANENT unavailability (model retired/deprecated/restricted) —
//     the model gets blacklisted in memory so it's never picked again.
//  2. TEMPORARY overload ("high demand") — we just try a different model
//     for this one request, without blacklisting, since it may recover.

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

function rankCandidates(candidates) {
  // "latest" alias first (Google keeps it pointed at their current pick),
  // then stable flash models sorted newest-first, then anything else flash,
  // then whatever's left.
  const latestAlias = candidates.filter(name => /^gemini-flash-latest$/i.test(name));
  const stableFlash = candidates
    .filter(name => /flash/i.test(name) && !/preview|exp|thinking|live|translate/i.test(name) && !/^gemini-flash-latest$/i.test(name))
    .sort((a, b) => extractVersion(b) - extractVersion(a));
  const otherFlash = candidates.filter(name => /flash/i.test(name) && !latestAlias.includes(name) && !stableFlash.includes(name));
  const rest = candidates.filter(name => !latestAlias.includes(name) && !stableFlash.includes(name) && !otherFlash.includes(name));

  return [...latestAlias, ...stableFlash, ...otherFlash, ...rest];
}

async function resolveModelList(forceRefresh = false) {
  const isFresh = Date.now() - cachedAt < MODEL_CACHE_MS;
  if (cachedGeminiModel && isFresh && !forceRefresh) {
    return cachedGeminiModel;
  }
  const candidates = await fetchCandidateModels();
  cachedGeminiModel = rankCandidates(candidates);
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
        contents: messages.map(m => {
          const parts = [{ text: m.content || '' }];
          if (m.image && m.image.data && m.image.mimeType) {
            parts.push({ inlineData: { mimeType: m.image.mimeType, data: m.image.data } });
          }
          return { role: m.role === 'assistant' ? 'model' : 'user', parts };
        })
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

  let ranked = await resolveModelList();
  let lastErr;
  const triedThisCall = new Set();

  for (let attempt = 0; attempt < 4; attempt++) {
    const model = ranked.find(name => !triedThisCall.has(name));
    if (!model) break;
    triedThisCall.add(model);

    try {
      return await callGeminiWithModel(model, messages);
    } catch (err) {
      lastErr = err;
      const msg = err.message || '';

      const isPermanentIssue = /not found|no longer available|unsupported|deprecated|is not supported/i.test(msg);
      const isTemporaryOverload = /high demand|overloaded|try again later|quota|rate limit/i.test(msg);

      if (isPermanentIssue) {
        console.warn(`Gemini model "${model}" permanently unavailable, blacklisting:`, msg);
        blacklistedModels.add(model);
        ranked = await resolveModelList(true);
      } else if (isTemporaryOverload) {
        console.warn(`Gemini model "${model}" temporarily overloaded, trying next candidate:`, msg);
        // don't blacklist — just move on to the next candidate this call
      } else {
        // Unrelated error (bad request, auth issue, etc.) — don't keep retrying.
        throw err;
      }
    }
  }

  throw lastErr || new Error('All Gemini models failed.');
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
