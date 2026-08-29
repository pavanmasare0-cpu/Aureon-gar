// Aureon AI — backend chat proxy (MVP)
// Keeps API keys server-side. The Android app never sees them.

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

const PORT = process.env.PORT || 3000;

// ---- Attachment helper ----
// The app sends images as a data URL (e.g. "data:image/png;base64,AAAA...").
// Split that into the mime type + raw base64 payload each provider expects.
function parseDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) return null;
  return { mimeType: match[1], base64: match[2] };
}

// ---- Provider adapters ----
// Each adapter takes the chat history and returns a plain string reply.
// A message may optionally carry `image: { mimeType, dataUrl }` for vision requests.

async function callOpenAI(messages) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set in backend/.env');
  const formatted = messages.map(m => {
    if (m.image) {
      return {
        role: m.role,
        content: [
          { type: 'text', text: m.content || '' },
          { type: 'image_url', image_url: { url: m.image.dataUrl } }
        ]
      };
    }
    return { role: m.role, content: m.content };
  });
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages: formatted })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'OpenAI request failed');
  return data.choices[0].message.content;
}

async function callClaude(messages) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in backend/.env');
  const formatted = messages.map(m => {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (m.image) {
      const parsed = parseDataUrl(m.image.dataUrl);
      const content = [{ type: 'text', text: m.content || '' }];
      if (parsed) {
        content.push({ type: 'image', source: { type: 'base64', media_type: parsed.mimeType, data: parsed.base64 } });
      }
      return { role, content };
    }
    return { role, content: m.content };
  });
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
      messages: formatted
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Claude request failed');
  return data.content.map(c => c.text || '').join('');
}

async function callGemini(messages) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set in backend/.env');
  const contents = messages.map(m => {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts = [{ text: m.content || '' }];
    if (m.image) {
      const parsed = parseDataUrl(m.image.dataUrl);
      if (parsed) parts.push({ inline_data: { mime_type: parsed.mimeType, data: parsed.base64 } });
    }
    return { role, parts };
  });
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents })
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Gemini request failed');
  return data.candidates[0].content.parts[0].text;
}

function callLocal(messages) {
  // Placeholder for a local/offline model (e.g. via Ollama running on your own server).
  // Wire this up when you add Local AI mode.
  const last = messages[messages.length - 1];
  const note = last?.image ? ' (image attachments aren\'t supported by the local model yet)' : '';
  return Promise.resolve(`[local model placeholder] You said: ${last?.content || ''}${note}`);
}

const PROVIDERS = { openai: callOpenAI, claude: callClaude, gemini: callGemini, local: callLocal };

// ---- Routes ----
// Keep only the most recent image attachment in the conversation — older ones
// are replaced with a text note so payload size and token usage don't balloon
// as a chat grows.
function pruneOldImages(messages) {
  const lastImageIdx = messages.reduce((acc, m, i) => (m.image ? i : acc), -1);
  return messages.map((m, i) => {
    if (m.image && i !== lastImageIdx) {
      const { image, ...rest } = m;
      return { ...rest, content: `${m.content || ''} [an earlier image attachment, omitted here]`.trim() };
    }
    return m;
  });
}

app.post('/api/chat', async (req, res) => {
  try {
    const { messages, model = 'gemini' } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }
    const provider = PROVIDERS[model] || PROVIDERS.openai;
    const reply = await provider(pruneOldImages(messages));
    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Something went wrong' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/', (req, res) => res.send('Aureon AI backend is running. POST to /api/chat.'));

app.listen(PORT, () => console.log(`Aureon AI backend running on port ${PORT}`));
