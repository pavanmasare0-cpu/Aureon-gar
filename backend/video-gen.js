// backend/video-gen.js — AI video generation (Gemini API / Veo). Saari Gemini keys use hoti hain: ek fail ya limit ho to agli key.
//   POST /api/generate-video            {prompt, aspectRatio?: "16:9"|"9:16"}  -> {jobId}
//   GET  /api/generate-video/:id        -> {status: "running"|"done"|"error", error?}
//   GET  /api/generate-video/:id/file   -> video/mp4
// Env (optional): VEO_MODELS = comma list, default: veo-3.1-generate-preview,veo-3.0-generate-001,veo-3.0-fast-generate-001,veo-2.0-generate-001
// Note: Veo aksar sirf paid/billing-enabled Google key par chalta hai. Free key par 403/429 aa sakta hai.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { geminiKeys } = require('./keys');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const models = () => String(process.env.VEO_MODELS || 'veo-3.1-generate-preview,veo-3.0-generate-001,veo-3.0-fast-generate-001,veo-2.0-generate-001').split(',').map((s) => s.trim()).filter(Boolean);
const jobs = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 200);

async function startOnAnyKey(prompt, aspectRatio) {
  const keys = geminiKeys();
  if (!keys.length) throw new Error('GEMINI_API_KEY set nahi hai');
  let lastErr = null;
  for (const model of models()) {
    let modelMissing = false;
    for (let i = 0; i < keys.length; i++) {
      try {
        const r = await fetch(`${BASE}/models/${model}:predictLongRunning`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keys[i] },
          body: JSON.stringify({ instances: [{ prompt }], parameters: { aspectRatio } }),
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.name) return { key: keys[i], keyNo: i + 1, model, opName: d.name };
        lastErr = new Error(`${model} key#${i + 1}: ${r.status} ${short(d.error && d.error.message)}`);
        if (r.status === 404) { modelMissing = true; break; }   // ye model hi nahi hai -> agla model
      } catch (e) { lastErr = e; }
    }
    if (modelMissing) continue;
  }
  throw lastErr || new Error('Video start nahi hua');
}

function findUri(op) {
  const r = op && op.response;
  if (!r) return null;
  const a = r.generateVideoResponse && r.generateVideoResponse.generatedSamples;
  if (a && a[0] && a[0].video && a[0].video.uri) return a[0].video.uri;
  const b = r.generatedVideos; if (b && b[0] && b[0].video && b[0].video.uri) return b[0].video.uri;
  const c = r.videos; if (c && c[0] && (c[0].uri || c[0].gcsUri)) return c[0].uri || c[0].gcsUri;
  return null;
}

async function runJob(job) {
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < 8 * 60 * 1000) {
      await sleep(8000);
      const r = await fetch(`${BASE}/${job.opName}`, { headers: { 'x-goog-api-key': job.key } });
      const op = await r.json().catch(() => ({}));
      if (!r.ok) { if (r.status >= 500) continue; throw new Error(`poll ${r.status}: ${short(op.error && op.error.message)}`); }
      if (!op.done) continue;
      if (op.error) throw new Error(short(op.error.message) || 'Video generation fail hua');
      const uri = findUri(op);
      if (!uri) throw new Error('Video ban gaya par link nahi mila (safety filter ho sakta hai). Prompt badal ke dekho.');
      const v = await fetch(uri, { headers: { 'x-goog-api-key': job.key }, redirect: 'follow' });
      if (!v.ok) throw new Error('Video download fail: ' + v.status);
      const file = path.join(os.tmpdir(), `aureon-video-${job.id}.mp4`);
      fs.writeFileSync(file, Buffer.from(await v.arrayBuffer()));
      job.file = file; job.status = 'done';
      try { if (global.__brain) global.__brain.recordFor(job.uid, 6, 'AI video bana (' + job.model + ')', { kind: 'video' }); } catch (e) { /* brain is optional */ }
      setTimeout(() => { try { fs.unlinkSync(file); } catch (e) { /* ok */ } jobs.delete(job.id); }, 30 * 60 * 1000).unref();
      return;
    }
    throw new Error('Video bahut der laga raha hai (8 min), baad me try karo.');
  } catch (e) {
    job.status = 'error'; job.error = short(e.message);
    try { if (global.__brain) global.__brain.recordOnce('video-fail', 5, 3, 'Video nahi bana: ' + job.error.slice(0, 90), { kind: 'video' }); } catch (e2) { /* brain is optional */ }
  }
}

module.exports = function createVideoRouter({ express, verifyAuth }) {
  const router = express.Router();
  router.post('/', verifyAuth, express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const prompt = String((req.body && req.body.prompt) || '').trim();
      if (!prompt) return res.status(400).json({ error: 'prompt is required' });
      const aspectRatio = req.body.aspectRatio === '9:16' ? '9:16' : '16:9';
      const mine = [...jobs.values()].filter((j) => j.uid === req.verifiedUid && j.status === 'running').length;
      if (mine >= 2) return res.status(429).json({ error: 'Pehle wale 2 video abhi ban rahe hain, thoda ruko.' });
      const s = await startOnAnyKey(prompt, aspectRatio);
      const job = { id: crypto.randomBytes(8).toString('hex'), uid: req.verifiedUid, status: 'running', ...s };
      jobs.set(job.id, job);
      runJob(job);
      res.json({ jobId: job.id });
    } catch (e) {
      console.error('Video start failed:', e.message);
      res.status(502).json({ error: 'Video start nahi hua. ' + short(e.message) + ' (Veo ke liye billing wali Gemini key chahiye hoti hai.)' });
    }
  });
  router.get('/:id', verifyAuth, (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j || j.uid !== req.verifiedUid) return res.status(404).json({ error: 'job nahi mila' });
    res.json({ status: j.status, error: j.error || null });
  });
  router.get('/:id/file', verifyAuth, (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j || j.uid !== req.verifiedUid || j.status !== 'done' || !j.file) return res.status(404).json({ error: 'video ready nahi hai' });
    res.setHeader('Content-Type', 'video/mp4');
    fs.createReadStream(j.file).pipe(res);
  });
  return router;
};
