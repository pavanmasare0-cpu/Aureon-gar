// backend/lessons.js — "Lessons": short rules Aureon learned from its own bugs (review rounds, failed tests, fix-and-rerun).
// Stored per user in Firestore: users/{uid}/lessons/{id}. The newest relevant ones are added to the Code-mode prompt so the same mistake is not repeated.
const crypto = require('crypto');
const MAX_TEXT = 220;
const STOP = new Set('the a an and or of to in is it for on with this that use using code function make write kaise kya hai ko se me mein ek aur ke ki ka'.split(' '));
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_+# ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
const idOf = (text) => crypto.createHash('sha1').update(String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).digest('hex').slice(0, 20);

module.exports = function createLessons({ express, verifyAuth, getDb }) {
  const cache = new Map();   // uid -> { at, list }
  const col = (uid) => getDb().collection('users').doc(uid).collection('lessons');

  async function listLessons(uid, limit = 300) {
    const c = cache.get(uid); if (c && Date.now() - c.at < 60 * 1000) return c.list;
    const snap = await col(uid).orderBy('createdAt', 'desc').limit(limit).get();
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    cache.set(uid, { at: Date.now(), list }); return list;
  }
  async function saveLesson(uid, text, source) {
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (!uid || text.length < 12) return null;
    const id = idOf(text);
    const ref = col(uid).doc(id);
    const doc = await ref.get();
    if (doc.exists) { await ref.set({ hits: (Number(doc.data().hits) || 1) + 1, lastSeen: Date.now() }, { merge: true }); cache.delete(uid); return { id, repeated: true }; }
    await ref.set({ text, source: source || 'review', hits: 1, createdAt: Date.now(), lastSeen: Date.now() });
    cache.delete(uid);
    try { if (global.__brain) global.__brain.recordFor(uid, 1, 'Naya lesson: ' + text, { kind: 'lesson' }); } catch (e) { /* brain is optional */ }
    return { id, repeated: false };
  }
  // The few lessons that fit this request best (word overlap) + the most repeated ones. Short block for the system prompt.
  async function promptBlock(uid, message, n = 8) {
    if (!uid) return '';
    let list; try { list = await listLessons(uid); } catch (e) { return ''; }
    if (!list.length) return '';
    const mw = new Set(words(message));
    const scored = list.map((l) => { const lw = words(l.text); const overlap = lw.filter((w) => mw.has(w)).length; return { l, s: overlap * 3 + Math.min(3, (l.hits || 1) - 1) + (list.indexOf(l) < 3 ? 1 : 0) }; })
      .sort((a, b) => b.s - a.s).slice(0, n).filter((x) => x.s > 0 || list.length <= n).map((x) => x.l);
    if (!scored.length) return '';
    let out = '\n\nLESSONS FROM YOUR OWN PAST BUGS (do not repeat these mistakes):\n' + scored.map((l) => '- ' + l.text).join('\n');
    return out.slice(0, 1800);
  }

  const router = express.Router();
  router.use(verifyAuth);
  router.get('/', async (req, res) => { try { cache.delete(req.verifiedUid); res.json({ ok: true, lessons: await listLessons(req.verifiedUid) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  router.post('/', async (req, res) => { try { const r = await saveLesson(req.verifiedUid, req.body && req.body.text, 'manual'); if (!r) return res.status(400).json({ ok: false, error: 'Lesson bahut chhota hai.' }); res.json({ ok: true, ...r }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  router.delete('/:id', async (req, res) => { try { await col(req.verifiedUid).doc(String(req.params.id).replace(/[^a-f0-9]/g, '')).delete(); cache.delete(req.verifiedUid); res.json({ ok: true }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  return { router, saveLesson, promptBlock, listLessons };
};
