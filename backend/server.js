// Aureon AI — backend chat proxy (MVP)
// Keeps API keys server-side. The Android app never sees them.

const express = require('express');
const cors = require('cors');
require('dotenv').config();
const admin = require('firebase-admin');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const PDFDocument = require('pdfkit');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

const PORT = process.env.PORT || 3000;

// ---- Firebase Admin (server-side Firestore access for Knowledge/RAG) ----
// Requires FIREBASE_SERVICE_ACCOUNT env var: paste the full JSON from
// Firebase Console → Project Settings → Service Accounts → Generate new
// private key, as a single-line string.
let db = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    console.log('Firebase Admin initialized — Knowledge/RAG endpoints active.');
  } catch (err) {
    console.error('Failed to initialize Firebase Admin (check FIREBASE_SERVICE_ACCOUNT):', err.message);
  }
} else {
  console.warn('FIREBASE_SERVICE_ACCOUNT not set — Knowledge/RAG endpoints will return an error until configured.');
}

function requireDb(res) {
  if (!db) {
    res.status(503).json({ error: 'Knowledge base not configured on the server yet (missing FIREBASE_SERVICE_ACCOUNT).' });
    return false;
  }
  return true;
}

// ==================== Phase 6: Agent tools (function calling) ====================
// Each tool maps to a native action the Android app performs on-device
// (see android AureonActionsPlugin.java). The backend never executes these
// itself — it only tells Gemini which tools exist and relays the model's
// chosen tool call back to the app, which runs it and reports the result
// back in a follow-up request.
const AGENT_TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'get_battery',
        description: "Get the phone's current battery percentage and whether it is charging.",
        parameters: { type: 'OBJECT', properties: {} }
      },
      {
        name: 'open_app',
        description: 'Open an app already installed on the phone.',
        parameters: {
          type: 'OBJECT',
          properties: { app_name: { type: 'STRING', description: 'Name of the app, e.g. YouTube, WhatsApp, Camera, Chrome' } },
          required: ['app_name']
        }
      },
      {
        name: 'make_call',
        description: 'Place a phone call to a number. Sensitive — the app will always ask the user to confirm before dialing.',
        parameters: {
          type: 'OBJECT',
          properties: { number: { type: 'STRING', description: 'Phone number to call' } },
          required: ['number']
        }
      },
      {
        name: 'send_sms',
        description: 'Send a text message (SMS) to a number. Sensitive — the app will always ask the user to confirm before sending.',
        parameters: {
          type: 'OBJECT',
          properties: {
            number: { type: 'STRING' },
            message: { type: 'STRING' }
          },
          required: ['number', 'message']
        }
      },
      {
        name: 'set_alarm',
        description: "Set an alarm on the phone's clock app.",
        parameters: {
          type: 'OBJECT',
          properties: {
            hour: { type: 'NUMBER', description: '0-23, 24-hour format' },
            minute: { type: 'NUMBER', description: '0-59' },
            label: { type: 'STRING' }
          },
          required: ['hour', 'minute']
        }
      },
      {
        name: 'search_web',
        description: 'Search Google for a query in the browser.',
        parameters: {
          type: 'OBJECT',
          properties: { query: { type: 'STRING' } },
          required: ['query']
        }
      },
      {
        name: 'open_url',
        description: 'Open a specific URL/website in the browser.',
        parameters: {
          type: 'OBJECT',
          properties: { url: { type: 'STRING' } },
          required: ['url']
        }
      },
      {
        name: 'play_music',
        description: 'Search for and play a song or music.',
        parameters: {
          type: 'OBJECT',
          properties: { query: { type: 'STRING' } },
          required: ['query']
        }
      },
      {
        name: 'compose_email',
        description: 'Open the phone\'s email app with a new message pre-filled (recipient, subject, body). Does not send it automatically — the user still taps send themselves.',
        parameters: {
          type: 'OBJECT',
          properties: {
            to: { type: 'STRING', description: 'Recipient email address, optional' },
            subject: { type: 'STRING' },
            body: { type: 'STRING' }
          },
          required: ['subject', 'body']
        }
      },
      {
        name: 'send_whatsapp_message',
        description: 'Open WhatsApp on a chat with the given phone number (or a saved contact name), with a message pre-filled. Does not send it automatically — the user still taps the Send button themselves.',
        parameters: {
          type: 'OBJECT',
          properties: {
            number: { type: 'STRING', description: 'Phone number with country code, e.g. 91XXXXXXXXXX. Omit if giving contact_name instead.' },
            contact_name: { type: 'STRING', description: 'Saved contact name to look up a number for, e.g. "Pavan". Omit if giving number directly.' },
            message: { type: 'STRING' }
          },
          required: ['message']
        }
      },
      {
        name: 'send_instagram_message',
        description: 'Send an Instagram DM to a contact by name. Sensitive — the app will always ask the user to confirm the exact message before it actually sends. Requires the user to have enabled Aureon\'s Accessibility Service.',
        parameters: {
          type: 'OBJECT',
          properties: {
            contact_name: { type: 'STRING', description: 'Instagram username or display name to message, e.g. "Pavan"' },
            message: { type: 'STRING' }
          },
          required: ['contact_name', 'message']
        }
      },
      {
        name: 'read_instagram_message',
        description: 'Open a contact\'s Instagram DM chat and read back whatever message text is visible there. Not sensitive (nothing is sent or changed) — runs immediately without asking the user to confirm. Requires the user to have enabled Aureon\'s Accessibility Service. The returned text may include a few recent messages and UI labels, not just a single isolated message — summarize the relevant part for the user.',
        parameters: {
          type: 'OBJECT',
          properties: {
            contact_name: { type: 'STRING', description: 'Instagram username or display name whose chat to open, e.g. "Preeti"' }
          },
          required: ['contact_name']
        }
      },
      {
        name: 'send_whatsapp_live_location',
        description: 'EXPERIMENTAL. Shares real-time live location with a contact via WhatsApp, fully automated including the final Send tap. Sensitive — the app will always ask the user to confirm before it actually sends, because unlike a normal message this completes the send with no further human tap. Requires the user to have enabled Aureon\'s Accessibility Service. May fail partway through on some WhatsApp versions/languages — if it does, tell the user which step failed based on the error.',
        parameters: {
          type: 'OBJECT',
          properties: {
            contact_name: { type: 'STRING', description: 'WhatsApp contact name to share live location with, e.g. "Pavan"' },
            duration: { type: 'STRING', description: 'How long to share for — one of "15 minutes", "1 hour", "8 hours". Defaults to "15 minutes" if not specified.' }
          },
          required: ['contact_name']
        }
      }
    ]
  }
];

async function callOpenAI(messages, systemPrompt) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set in backend/.env');
  const chatMessages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages: chatMessages })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'OpenAI request failed');
  return data.choices[0].message.content;
}

async function callClaude(messages, systemPrompt) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in backend/.env');
  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
  };
  if (systemPrompt) body.system = systemPrompt;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
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

async function callGeminiWithModel(modelName, messages, systemPrompt, useTools) {
  const payload = {
    contents: messages.map(m => {
      // A turn where Aureon (the model) previously requested a tool call.
      if (m.functionCall) {
        return { role: 'model', parts: [{ functionCall: m.functionCall }] };
      }
      // A turn carrying the result of a tool call the app just ran.
      if (m.functionResponse) {
        return { role: 'user', parts: [{ functionResponse: m.functionResponse }] };
      }
      const parts = [{ text: m.content || '' }];
      if (m.image && m.image.data && m.image.mimeType) {
        parts.push({ inlineData: { mimeType: m.image.mimeType, data: m.image.data } });
      }
      return { role: m.role === 'assistant' ? 'model' : 'user', parts };
    })
  };
  if (systemPrompt) {
    payload.systemInstruction = { parts: [{ text: systemPrompt }] };
  }
  if (useTools) {
    payload.tools = AGENT_TOOLS;
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }
  );
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error?.message || 'Gemini request failed');
    err.status = res.status;
    throw err;
  }
  const candidate = data.candidates && data.candidates[0];
  const parts = (candidate && candidate.content && candidate.content.parts) || [];
  const callPart = parts.find(p => p.functionCall);
  if (callPart) {
    return { functionCall: callPart.functionCall };
  }
  const text = parts.map(p => p.text || '').join('').trim();
  if (text) return text;

  // Gemini sometimes comes back with no usable content at all (safety
  // filtering, an empty candidate, etc). Surface something the person can
  // actually read instead of silently returning '' up the chain.
  const finishReason = candidate && candidate.finishReason;
  if (finishReason === 'SAFETY' || finishReason === 'RECITATION') {
    return "Sorry, I can't answer that one — it got blocked by a safety filter. Try rephrasing?";
  }
  return "Sorry, I didn't get a proper response that time — try asking again.";
}

async function callGemini(messages, systemPrompt, useTools) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set in backend/.env');

  let ranked = await resolveModelList();
  let lastErr;
  const triedThisCall = new Set();

  for (let attempt = 0; attempt < 4; attempt++) {
    const model = ranked.find(name => !triedThisCall.has(name));
    if (!model) break;
    triedThisCall.add(model);

    try {
      return await callGeminiWithModel(model, messages, systemPrompt, useTools);
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
      } else {
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

// ==================== Phase 5: Personal Knowledge (RAG) ====================

async function embedText(text) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set — needed for embeddings too.');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { parts: [{ text }] } })
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Embedding request failed');
  return data.embedding.values;
}

function chunkText(text, chunkSize = 1200, overlap = 150) {
  const chunks = [];
  let start = 0;
  const clean = text.replace(/\s+/g, ' ').trim();
  while (start < clean.length) {
    const end = Math.min(start + chunkSize, clean.length);
    chunks.push(clean.slice(start, end));
    start += chunkSize - overlap;
  }
  return chunks.filter(c => c.trim().length > 20);
}

async function extractText(mimeType, buffer) {
  if (mimeType === 'application/pdf') {
    const data = await pdfParse(buffer);
    return data.text;
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  if (mimeType.startsWith('text/')) {
    return buffer.toString('utf-8');
  }
  throw new Error(`Unsupported file type for text extraction: ${mimeType}`);
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Upload a document: extract text -> chunk -> embed each chunk -> store in Firestore
app.post('/api/knowledge/upload', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { uid, filename, mimeType, dataBase64 } = req.body;
    if (!uid || !filename || !mimeType || !dataBase64) {
      return res.status(400).json({ error: 'uid, filename, mimeType, and dataBase64 are required' });
    }
    const buffer = Buffer.from(dataBase64, 'base64');
    const text = await extractText(mimeType, buffer);
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Could not extract any text from this file.' });
    }
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      return res.status(400).json({ error: 'File text was too short to index.' });
    }

    const embeddedChunks = [];
    for (const chunk of chunks) {
      const embedding = await embedText(chunk);
      embeddedChunks.push({ text: chunk, embedding });
    }

    const docRef = db.collection('users').doc(uid).collection('knowledge').doc();
    await docRef.set({
      filename,
      mimeType,
      chunkCount: embeddedChunks.length,
      chunks: embeddedChunks,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ id: docRef.id, filename, chunkCount: embeddedChunks.length });
  } catch (err) {
    console.error('Knowledge upload failed:', err);
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

app.get('/api/knowledge/list', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: 'uid is required' });
    const snap = await db.collection('users').doc(uid).collection('knowledge').orderBy('createdAt', 'desc').get();
    const files = snap.docs.map(d => ({
      id: d.id,
      filename: d.data().filename,
      chunkCount: d.data().chunkCount
    }));
    res.json({ files });
  } catch (err) {
    console.error('Knowledge list failed:', err);
    res.status(500).json({ error: err.message || 'Could not list files' });
  }
});

app.delete('/api/knowledge/:docId', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { uid } = req.query;
    const { docId } = req.params;
    if (!uid) return res.status(400).json({ error: 'uid is required' });
    await db.collection('users').doc(uid).collection('knowledge').doc(docId).delete();
    res.json({ ok: true });
  } catch (err) {
    console.error('Knowledge delete failed:', err);
    res.status(500).json({ error: err.message || 'Could not delete file' });
  }
});

// Retrieve the most relevant chunks across all of a user's uploaded documents
async function retrieveRelevantContext(uid, query, topK = 5) {
  if (!db) return '';
  const snap = await db.collection('users').doc(uid).collection('knowledge').get();
  if (snap.empty) return '';

  const allChunks = [];
  snap.forEach(doc => {
    const data = doc.data();
    (data.chunks || []).forEach(c => allChunks.push({ filename: data.filename, text: c.text, embedding: c.embedding }));
  });
  if (allChunks.length === 0) return '';

  const queryEmbedding = await embedText(query);
  const scored = allChunks.map(c => ({ ...c, score: cosineSimilarity(queryEmbedding, c.embedding) }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topK).filter(c => c.score > 0.4);
  if (top.length === 0) return '';

  return top.map(c => `[From "${c.filename}"]: ${c.text}`).join('\n\n');
}

// ==================== PDF generation ====================
// Turns AI-written (or user-supplied) text into a downloadable PDF.
app.post('/api/generate-pdf', async (req, res) => {
  try {
    const { title = 'Aureon Document', content = '' } = req.body;
    if (!content.trim()) return res.status(400).json({ error: 'content is required' });

    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(chunks);
      res.json({ filename: `${title.replace(/[^a-z0-9]/gi, '_')}.pdf`, dataBase64: pdfBuffer.toString('base64') });
    });

    doc.fontSize(20).font('Helvetica-Bold').text(title, { align: 'left' });
    doc.moveDown();
    doc.fontSize(12).font('Helvetica').text(content, { align: 'left', lineGap: 4 });
    doc.end();
  } catch (err) {
    console.error('PDF generation failed:', err);
    res.status(500).json({ error: err.message || 'Could not generate PDF' });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { messages, model = 'gemini', systemPrompt, uid, useKnowledge, tools } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    let finalSystemPrompt = systemPrompt || '';
    if (useKnowledge && uid && db) {
      try {
        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user' && m.content);
        const context = lastUserMsg ? await retrieveRelevantContext(uid, lastUserMsg.content) : '';
        if (context) {
          finalSystemPrompt += `\n\nThe user has uploaded documents. Here are the most relevant excerpts for their question — use them to answer if relevant, and mention which document info came from:\n\n${context}`;
        }
      } catch (ragErr) {
        console.warn('Knowledge retrieval failed, continuing without it:', ragErr.message);
      }
    }

    const provider = PROVIDERS[model] || PROVIDERS.openai;
    const reply = await provider(messages, finalSystemPrompt, !!tools);

    // Gemini may respond with a tool call instead of text — hand it back to
    // the app as-is so it can run the matching native action and report the
    // result in a follow-up request.
    if (reply && typeof reply === 'object' && reply.functionCall) {
      return res.json({ functionCall: reply.functionCall });
    }
    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Something went wrong' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/', (req, res) => res.send('Aureon AI backend is running. POST to /api/chat.'));

app.listen(PORT, () => console.log(`Aureon AI backend running on port ${PORT}`));
