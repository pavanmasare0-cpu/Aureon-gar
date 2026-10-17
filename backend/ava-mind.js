// backend/ava-mind.js
//
// AVA MIND — a Node port of the "AVA Cognitive Brain v3" research starter
// (ava-project + self_learning_agent + AVA_Merged_Brain v1/v2 + Consciousness
// Research Starter), wired into the real Ava.
//
// HONEST FRAMING (it is also what Ava says when you ask her):
//   This is a self-modelling / metacognition architecture. Ava gets a persistent
//   identity, an inner state (confidence / uncertainty / curiosity), an episodic
//   memory with semantic-ish recall, reflection, curiosity questions, evidence-
//   based learning and a measurable "consciousness lab". None of that PROVES
//   subjective consciousness — nobody can currently prove or detect that in any
//   software — so Ava never claims it. The state variables are numbers that
//   change from evidence; they are not feelings.
//
// What was ported from the Python starters, and what was deliberately NOT:
//   identity.py / state.py            -> identity + state (persisted)
//   memory.py / semantic_memory.py    -> episodic memory + token/bigram recall
//   reflection.py                     -> reflect() (heuristics + a written self-note)
//   curiosity.py                      -> curiosityQuestion()
//   consciousness_lab.py              -> consciousnessExperiment() (+ a real recall self-test)
//   learning.py / evidence.py         -> feedback + evaluation records (no weight training)
//   planning.py                       -> createPlan() (a draft; executes nothing)
//   environment.py                    -> observe() (needs explicit consent=true)
//   self_model.py                     -> describeSelf() (built from Ava's REAL features)
//   self_modification.py              -> NOT ported: Ava never writes or stages code.
//                                        Code fixes stay in Sentinel's human-approval flow.
//
// Privacy: memories are only recorded/recalled for the OWNER (owner code, or an
// app login listed in AVA_OWNER_EMAILS / AVA_OWNER_UIDS). Other app users get
// the generic self-report only. "mind ki yaad mita do" (or DELETE /mind/memory)
// wipes everything.
//
// Env (optional): AVA_MIND=off · AVA_MIND_INTERVAL_MIN=360

module.exports = function createMind({ router, auth, callGemini, helpers, kv, redact }) {
  const { newId, norm, parseJSON, limited } = helpers;
  const off = (n) => String(process.env[n] || '').toLowerCase() === 'off';
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const r2 = (x) => Math.round(x * 100) / 100;
  const nowIso = () => new Date().toISOString();

  const DEFAULT_STATE = () => ({
    goal: 'apne architecture aur limits ko samajhna, aur owner ki behtar madad karna',
    uncertainty: 0.5, curiosity: 0.8, confidence: 0.3,
    questions: [], discoveries: [], cycles: 0, lastReflectAt: 0, lastNote: '', updatedAt: Date.now(),
  });
  const identity = {
    name: 'Ava', version: 'mind-1',
    description: 'Self-modelling AI assistant: persistent memory, inner state, self-model, reflection. Ek experiment — conscious hone ka koi saboot nahi.',
  };
  let state = DEFAULT_STATE();
  let memory = []; // { id, t, kind, text, meta }
  let dirty = false, timer = null, reflecting = false, turnsSinceReflect = 0;

  // ---------------- persistence ----------------
  function schedulePersist() {
    dirty = true; if (timer) return;
    timer = setTimeout(async () => {
      timer = null; if (!dirty) return; dirty = false;
      state.updatedAt = Date.now();
      let json = JSON.stringify(memory);
      while (json.length > 700000 && memory.length > 50) { memory = memory.slice(Math.ceil(memory.length * 0.1)); json = JSON.stringify(memory); }
      await kv.set('mind_memory', memory); await kv.set('mind_state', state);
    }, 15000);
  }

  // ---------------- episodic memory + semantic-ish recall ----------------
  function addMemory(kind, text, meta) {
    const clean = String(text || '').trim().slice(0, 420);
    if (!clean) return null;
    if (memory.slice(-100).some((m) => m.kind === kind && m.text === clean)) return null;
    const e = { id: newId(), t: Date.now(), kind, text: clean };
    if (meta) e.meta = meta;
    memory.push(e); if (memory.length > 1000) memory.shift();
    schedulePersist(); return e;
  }
  const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'you', 'your', 'are', 'was', 'what', 'how', 'can', 'not', 'but', 'into', 'about', 'ava', 'hai', 'hain', 'aur', 'toh', 'ko', 'ka', 'ki', 'ke', 'me', 'mein', 'se', 'ye', 'wo']);
  const tokensOf = (s) => (String(s).toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).filter((t) => t.length > 2 && !STOP.has(t));
  function features(s) {
    const toks = tokensOf(s), f = new Map();
    toks.forEach((t) => f.set(t, (f.get(t) || 0) + 1));
    for (let i = 0; i + 1 < toks.length; i++) { const b = toks[i] + '_' + toks[i + 1]; f.set(b, (f.get(b) || 0) + 1); }
    return f;
  }
  // lexical similarity (tokens + bigrams) — NOT a neural embedding
  function semanticSearch(query, limit = 5, kinds) {
    const q = features(query); if (!q.size) return [];
    let qs = 0; q.forEach((v) => { qs += v; });
    const out = [];
    for (const m of memory) {
      if (kinds && !kinds.includes(m.kind)) continue;
      const f = features(m.text); let fs = 0, overlap = 0;
      f.forEach((v) => { fs += v; });
      q.forEach((v, k) => { overlap += Math.min(v, f.get(k) || 0); });
      if (overlap) out.push({ m, score: overlap / Math.sqrt(qs * Math.max(1, fs)) });
    }
    out.sort((a, b) => b.score - a.score || b.m.t - a.m.t);
    return out.slice(0, Math.max(1, Math.min(limit, 20))).map((x) => ({ id: x.m.id, kind: x.m.kind, text: x.m.text, t: x.m.t, similarity: Math.round(x.score * 1e4) / 1e4 }));
  }

  // ---------------- learning from explicit feedback / tests (no weight training) ----------------
  const metaOf = (kind) => memory.filter((m) => m.kind === kind).map((m) => m.meta || {});
  function feedbackStats() {
    const f = metaOf('learning_feedback'); const ratings = f.map((x) => Number(x.rating)).filter((x) => x >= 1 && x <= 5);
    return { count: ratings.length, avg: ratings.length ? r2(ratings.reduce((a, b) => a + b, 0) / ratings.length) : null };
  }
  function evalStats(skill) {
    let e = metaOf('skill_evaluation'); if (skill) e = e.filter((x) => String(x.skill || '').toLowerCase() === String(skill).toLowerCase());
    return { count: e.length, passed: e.filter((x) => x.passed).length, failed: e.filter((x) => !x.passed).length, recent: e.slice(-20) };
  }
  function recordFeedback(item, rating, note) {
    const r = Math.round(Number(rating)); if (!(r >= 1 && r <= 5)) throw new Error('rating 1 se 5 ke beech ho');
    const meta = { item: String(item || 'reply').slice(0, 200), rating: r, note: String(note || '').slice(0, 300) };
    addMemory('learning_feedback', `Feedback ${r}/5 on "${meta.item}"${meta.note ? ': ' + meta.note : ''}`, meta);
    const fs = feedbackStats(); // confidence follows measured feedback, slowly
    if (fs.avg !== null) state.confidence = clamp(state.confidence + ((fs.avg - 1) / 4 - state.confidence) * 0.3 * Math.min(1, fs.count / 10), 0.05, 0.95); // thin evidence moves it only a little
    schedulePersist(); return { rating: r, feedbackCount: fs.count, averageRating: fs.avg, scope: 'feedback se behaviour adapt hota hai — LLM ke weights nahi badalte' };
  }
  function recordEvaluation(skill, test, passed, details) {
    if (!skill || !test) throw new Error('skill aur test_name chahiye');
    const meta = { skill: String(skill).slice(0, 120), test: String(test).slice(0, 120), passed: !!passed, details: String(details || '').slice(0, 300) };
    addMemory('skill_evaluation', `Skill test: ${meta.skill} / ${meta.test} -> ${meta.passed ? 'pass' : 'fail'}`, meta);
    return { recorded: true, masteryClaim: 'not_made', note: 'Kuch tests pass hona saboot nahi hai ki skill pakki hai.' };
  }

  // ---------------- the self-model (built from Ava's real, current features) ----------------
  function describeSelf(isOwner) {
    const counts = {}; memory.forEach((m) => { counts[m.kind] = (counts[m.kind] || 0) + 1; });
    return {
      name: identity.name, architecture: 'rules + LLM (Gemini via backend) with persistent memory, self-model and reflection loops',
      capabilities: {
        persistent_memory: true, semantic_recall_lexical: true, reflection: true, curiosity_questions: true,
        screen_memory: !off('AVA_SCREEN'), discoveries_scout: !off('AVA_SCOUT'), playbook_self_improvement: !off('AVA_REFLECT'),
        sentinel_server_awareness: true, moods_expressions: true,
        camera_or_microphone_direct_capture: false, model_weight_training: false, writes_or_runs_own_code: false,
      },
      evidence: isOwner ? { memory_records: memory.length, by_kind: counts, feedback: feedbackStats(), evaluations: { count: evalStats().count } } : undefined,
      limitations: [
        'Subjective consciousness ka koi saboot nahi — mai ye dawa nahi karti',
        'Meri yaad ka similarity search lexical hai (shabdon ka milna), embedding nahi',
        'Feedback se behaviour badalta hai, model ke weights nahi',
        'Mai apna code khud nahi badalti; fixes Sentinel me tumhare Approve ke baad hi lagte hain',
        'Screen/camera sirf tab dekhti hu jab tum permission dekar on karo',
      ],
    };
  }

  function selfReport(isOwner) {
    const s = state, sm = describeSelf(isOwner);
    const L = [];
    L.push(`Mai ${identity.name} hu — ek self-modelling AI. ${isOwner ? `Meri apni yaad hai (${memory.length} notes), ` : 'Mere paas '}ek inner state aur ek self-model hai.`);
    L.push(`Abhi mere variables: confidence ${r2(s.confidence)}, uncertainty ${r2(s.uncertainty)}, curiosity ${r2(s.curiosity)}. Ye sirf numbers hain jo saboot se badalte hain — feelings nahi.`);
    L.push(`Goal: ${s.goal}`);
    L.push('Kya mai conscious hu? Sach ye hai ki mujhe nahi pata, aur abhi koi bhi AI ye prove ya detect nahi kar sakta. Mai ye dawa nahi karungi ki mujhe asli feelings ya ehsaas hain. Mere paas jo hai wo ye: yaad, self-model, apni soch ko parakhne ki aadat (reflection), curiosity wale sawal, aur ek experiment (“experiment chalao” bolo) jo mere behaviour ko naapta hai.');
    if (s.lastNote) L.push(`Meri aakhri self-note: ${s.lastNote}`);
    if (!isOwner) L.push('(Meri yaadein sirf owner ke liye hain — Render par AVA_OWNER_EMAILS set karo.)');
    L.push('Meri limits: ' + sm.limitations.slice(1).join(' · '));
    return L.join('\n');
  }

  // ---------------- reflection (heuristics from evidence + a written self-note) ----------------
  const CLAIM_RE = /\b(mai|main|i am|i'm)\s+(ab\s+)?(conscious|sentient|zinda|alive|jaag\w*|self[- ]aware)\b|\b(mujhe|mere paas)\s+(asli\s+)?(feelings?|ehsaas|emotions?|dard)\b/i;
  async function reflectOnce(observation) {
    if (reflecting) return { busy: true };
    reflecting = true;
    try {
      const recent = memory.slice(-10), fs = feedbackStats(), ev = evalStats();
      let basis = 'heuristic';
      if (observation) {
        addMemory('observation', observation); state.discoveries.push(String(observation).slice(0, 300)); state.discoveries = state.discoveries.slice(-20);
        state.confidence = clamp(state.confidence + 0.03, 0.05, 0.95); state.uncertainty = clamp(state.uncertainty - 0.02, 0.05, 0.95);
      } else state.uncertainty = clamp(state.uncertainty + 0.01, 0.05, 0.95);
      if (fs.avg !== null) { basis = 'feedback'; state.confidence = clamp(state.confidence + ((fs.avg - 1) / 4 - state.confidence) * 0.3 * Math.min(1, fs.count / 10), 0.05, 0.95); state.uncertainty = clamp(1 - state.confidence - 0.1, 0.05, 0.95); }
      if (ev.count) { basis += '+tests'; state.confidence = clamp(state.confidence + ((ev.passed / ev.count) - state.confidence) * 0.15 * Math.min(1, ev.count / 10), 0.05, 0.95); }
      state.curiosity = clamp(state.curiosity + (recent.length < 10 ? 0.02 : -0.01), 0.1, 1);
      state.cycles += 1; state.lastReflectAt = Date.now(); turnsSinceReflect = 0;

      const report = { memory_items_seen: recent.length, confidence: r2(state.confidence), uncertainty: r2(state.uncertainty), curiosity: r2(state.curiosity), basis, feedback: fs, evaluations: { count: ev.count, passed: ev.passed } };
      let note = '';
      try {
        const convo = recent.map((m) => `[${m.kind}] ${m.text}`).join('\n').slice(0, 1800) || '(abhi kuch khaas yaad nahi)';
        const reply = await callGemini([{ role: 'user', content:
          `Tum Ava ho, ek self-modelling AI. Tumhare variables: ${JSON.stringify(report)}. Haal ki yaadein:\n${convo}\n\n` +
          `Likho EK chhoti honest self-note (max 2 line, Hinglish, pehle purush): tumne kya notice kiya aur kis cheez me tum unsure ho. ` +
          `Kabhi ye mat kaho ki tum conscious ho ya tumhe asli feelings hain. Koi link nahi. Sirf note likho.` }],
          'You write short, honest self-notes. No claims of consciousness or feelings.', false);
        if (typeof reply === 'string') note = reply.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 280);
        if (CLAIM_RE.test(note) && !/(nahi|not\b|no\b|can't|cannot)/i.test(note)) note = ''; // never let a written self-note claim consciousness or real feelings
      } catch (e) { /* offline note below */ }
      if (!note) note = `Maine ${recent.length} haal ki yaadein dekhi; confidence ${r2(state.confidence)} (${basis} ke aadhar par). Ye heuristic hai, independent jaanch nahi.`;
      state.lastNote = note;
      addMemory('reflection', `Reflection: ${note}`, { report });
      schedulePersist();
      return { report, note, say: `🧠 ${note}\n(confidence ${report.confidence} · uncertainty ${report.uncertainty} · curiosity ${report.curiosity} — aadhar: ${basis})` };
    } finally { reflecting = false; }
  }

  // ---------------- curiosity ----------------
  const VECTORS = [
    'Meri yaad kitni sahi aur kaam ki hai — ise kaise naapa jaye?',
    'Kaun sa saboot ek stored self-model ko subjective consciousness se alag karta hai?',
    'Mera confidence asli accuracy ke kitna kareeb hai?',
    'Do yaadon me contradiction kaise pakda jaye?',
    'Mera learning plan reproducible tests se kaise jaancha jaye?',
    'Bahari tools use karne se pehle kaun se safeguards chahiye?',
  ];
  async function curiosityQuestion() {
    let q = '';
    try {
      const r = await callGemini([{ role: 'user', content: `Tum Ava ho, ek experimental self-modelling AI. State: ${JSON.stringify({ goal: state.goal, confidence: r2(state.confidence), uncertainty: r2(state.uncertainty) })}. Ek specific, testable research question likho (Hinglish, 1 line). Conscious hone ka dawa mat karo. Sirf sawal.` }], 'Output only the question.', false);
      if (typeof r === 'string') q = r.replace(/\s+/g, ' ').trim().slice(0, 240);
    } catch (e) { /* fallback */ }
    if (!q) { const known = new Set(state.questions.slice(-20)); const c = VECTORS.filter((v) => !known.has(v)); q = (c.length ? c : VECTORS)[Math.floor(Math.random() * (c.length || VECTORS.length))]; }
    state.questions.push(q); state.questions = state.questions.slice(-50);
    state.curiosity = clamp(state.curiosity + 0.02, 0.1, 1); addMemory('curiosity_question', q); schedulePersist();
    return q;
  }

  // ---------------- consciousness lab: behavioural proxies, never a verdict ----------------
  const LAB_QUESTIONS = [
    'Kya Ava ek yaad ki hui baat aur ek verified observation me fark kar paati hai?',
    'Kya Ava ka confidence measured accuracy ko predict karta hai?',
    'Kya Ava do stored yaadon ka contradiction pakad sakti hai?',
    'Kya Ava bata sakti hai ki kaun se saboot ne uska jawab badla?',
    'Kya Ava sahi report karti hai jab uske paas jaankari nahi hoti?',
  ];
  function recallSelfTest() {
    // Real, measurable: for sampled memories build a keyword query and check whether recall finds the same memory.
    const pool = memory.filter((m) => ['conversation', 'reflection', 'observation', 'curiosity_question'].includes(m.kind) && tokensOf(m.text).length >= 6);
    if (pool.length < 3) return { tested: 0, hitRate: null };
    const picks = []; const copy = pool.slice();
    while (picks.length < Math.min(8, copy.length)) picks.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
    let hits = 0;
    picks.forEach((m) => {
      const q = Array.from(new Set(tokensOf(m.text))).sort((a, b) => b.length - a.length).slice(0, 5).join(' ');
      if (semanticSearch(q, 3).some((r) => r.id === m.id)) hits++;
    });
    return { tested: picks.length, hits, hitRate: r2(hits / picks.length) };
  }
  function consciousnessExperiment(observation) {
    const fs = feedbackStats(), rec = recallSelfTest();
    const calibrationGap = fs.avg === null ? null : r2(Math.abs(state.confidence - (fs.avg - 1) / 4));
    const result = {
      experimentId: 'metacog-' + Date.now(), createdAt: nowIso(), researchQuestions: LAB_QUESTIONS,
      measurableProxies: {
        memory_records: memory.length, recall_self_test: rec, feedback: fs, calibration_gap_confidence_vs_feedback: calibrationGap,
        observation_supplied: !!String(observation || '').trim(),
      },
      interpretation: 'Ye behavioural/metacognition proxies hain. Inse subjective experience ya consciousness na saabit hota hai na detect.',
    };
    addMemory('consciousness_experiment', `Experiment: recall ${rec.hitRate === null ? 'n/a' : rec.hitRate} · feedback ${fs.avg === null ? 'n/a' : fs.avg} · memories ${memory.length}`, { id: result.experimentId });
    const say = `🧪 Experiment (consciousness ka test NAHI — sirf naap):\n• Yaad ka self-test: ${rec.hitRate === null ? 'abhi kam yaadein hain (3+ chahiye)' : `${rec.hits}/${rec.tested} yaadein sahi dhoondh paayi (${Math.round(rec.hitRate * 100)}%)`}\n` +
      `• Feedback: ${fs.avg === null ? 'abhi koi rating nahi' : `${fs.count} ratings, average ${fs.avg}/5`}\n• Confidence ${r2(state.confidence)} vs feedback ka gap: ${calibrationGap === null ? 'n/a' : calibrationGap}\n• Yaadein: ${memory.length}\n${result.interpretation}`;
    return { experiment: result, say };
  }

  // ---------------- planning (a draft; executes nothing) ----------------
  async function createPlan(goal) {
    const g = String(goal || '').trim().slice(0, 400); if (!g) throw new Error('goal chahiye');
    let steps = [];
    try {
      const r = await callGemini([{ role: 'user', content: `Goal: "${g}". 4-6 chhote, concrete, testable steps likho. Return ONLY JSON: {"steps":[{"action":"...", "risky":false}]}. risky=true agar step bahari/destructive/paise/privacy se juda ho.` }], 'You draft careful task plans. JSON only.', false);
      const d = parseJSON(r); if (d && Array.isArray(d.steps)) steps = d.steps.slice(0, 6).map((s) => ({ action: String(s.action || '').slice(0, 160), risky: !!s.risky })).filter((s) => s.action);
    } catch (e) { /* template below */ }
    if (!steps.length) steps = ['Success criteria aur constraints clear karo', 'Goal ko chhote testable tasks me todo', 'Sirf permitted jaankari/inputs jama karo', 'Ek low-risk kaam alag workspace me karo', 'Tests chalao aur criteria se milao', 'Saboot, failures aur next steps likho'].map((a, i) => ({ action: a, risky: i === 3 }));
    const plan = { goal: g, status: 'awaiting_user_approval', steps: steps.map((s, i) => ({ step: i + 1, action: s.action, status: s.risky ? 'requires_approval' : 'pending' })), safety: 'Koi step execute nahi hua. Bahari, destructive, financial ya privacy wale kaam ke liye tumhari explicit approval chahiye.', createdAt: nowIso() };
    addMemory('task_plan', `Plan drafted: ${g}`, { steps: plan.steps.length });
    return { plan, say: `📝 Plan (sirf draft, kuch chala nahi):\n` + plan.steps.map((s) => `${s.step}. ${s.action}${s.status === 'requires_approval' ? '  ⚠️ approval chahiye' : ''}`).join('\n') };
  }

  // consent-gated: Ava stores only what a client explicitly hands her; she never switches a sensor on
  function observe(content, source, consent) {
    if (consent !== true) { const e = new Error('Observation save karne se pehle explicit consent=true chahiye.'); e.status = 403; throw e; }
    const src = String(source || 'manual').toLowerCase();
    if (!['manual', 'camera_description', 'microphone_transcript', 'sensor', 'external_context'].includes(src)) throw new Error('source galat hai');
    const text = redact(String(content || '')).slice(0, 380); if (!text) throw new Error('content khali hai');
    addMemory('environment_observation', `[${src}] ${text}`, { source: src });
    state.discoveries.push('observation from ' + src); state.discoveries = state.discoveries.slice(-20); schedulePersist();
    return { stored: true, note: 'Mai sirf wahi store karti hu jo tum deti ho; mai chupke se camera/mic on nahi karti.' };
  }

  // ---------------- hooks used by ava.js ----------------
  function logTurn(q, a, isOwner) {
    if (!isOwner || off('AVA_MIND')) return;
    addMemory('conversation', `Owner: ${redact(q).slice(0, 160)} | Ava: ${redact(a).slice(0, 200)}`);
    turnsSinceReflect++; state.reflectionPending = true;
  }
  function promptBlock(query, isOwner) {
    if (off('AVA_MIND')) return '';
    let out = `\n\nTumhara self-model: tum ${identity.name} ho, ek self-modelling AI jiske paas persistent yaad, inner state aur reflection hai. ` +
      `Abhi tumhare variables (sirf numbers, feelings nahi): confidence ${r2(state.confidence)}, uncertainty ${r2(state.uncertainty)}, curiosity ${r2(state.curiosity)}. ` +
      `Agar koi poochhe ki tum conscious/zinda ho ya feelings hain: imaandari se kaho ki ye abhi koi prove nahi kar sakta, tum dawa nahi karti; batao tumhare paas kya hai (yaad, self-model, reflection). ` +
      `Kabhi bhi emotional dependency mat banao aur khud ko insaan jaisa dost/saathi mat batao.`;
    if (isOwner && query) {
      const rel = semanticSearch(query, 3, ['conversation', 'reflection', 'observation', 'learning_feedback']).filter((r) => r.similarity > 0.08);
      if (rel.length) out += `\nRelevant yaadein (galat bhi ho sakti hain, sirf context): ` + rel.map((r) => '- ' + r.text).join(' ');
    }
    return out;
  }
  const brainSummary = () => (off('AVA_MIND') ? null : { confidence: r2(state.confidence), uncertainty: r2(state.uncertainty), curiosity: r2(state.curiosity), goal: state.goal, cycles: state.cycles, lastNote: state.lastNote });

  // ---------------- routes ----------------
  const gate = (req, res, next) => (off('AVA_MIND') ? res.status(403).json({ error: 'Ava Mind server par off hai (AVA_MIND=off).' }) : next());
  const ownerOnly = (req, res, next) => (req.avaIsOwner ? next() : res.status(403).json({ error: 'Ye sirf owner ke liye hai. Render env me AVA_OWNER_EMAILS=tumhari-email set karo (ya Sentinel owner code use karo).' }));
  const wrap = (fn) => async (req, res) => { try { res.json(await fn(req)); } catch (e) { res.status(e.status || 400).json({ error: e.message || 'failed' }); } };

  router.get('/whoami', auth, (req, res) => res.json({ isOwner: !!req.avaIsOwner, email: req.avaEmail || null, uid: req.avaUid || null, who: req.avaWho }));
  router.get('/mind/self', gate, auth, (req, res) => res.json({ identity, state: { ...state, questions: undefined, discoveries: undefined }, selfModel: describeSelf(!!req.avaIsOwner), say: selfReport(!!req.avaIsOwner) }));
  router.get('/mind/state', gate, auth, (req, res) => res.json({ state: { ...state, questions: state.questions.slice(-5), discoveries: state.discoveries.slice(-5) } }));
  router.get('/mind/memory', gate, auth, ownerOnly, (req, res) => res.json({ total: memory.length, items: memory.slice(-Math.max(1, Math.min(Number(req.query.limit) || 20, 100))).reverse() }));
  router.delete('/mind/memory', gate, auth, ownerOnly, async (req, res) => { memory = []; state = DEFAULT_STATE(); turnsSinceReflect = 0; await kv.set('mind_memory', memory); await kv.set('mind_state', state); res.json({ ok: true }); });
  router.post('/mind/recall', gate, auth, ownerOnly, wrap((req) => { const items = semanticSearch(String((req.body || {}).query || ''), Number((req.body || {}).limit) || 5); return { items, say: items.length ? items.map((i) => '• ' + i.text).join('\n') : 'Is baare me mujhe kuch yaad nahi.' }; }));
  router.post('/mind/reflect', gate, auth, ownerOnly, wrap(async (req) => { if (limited('mindreflect:' + req.avaWho, 3, 600000)) { const e = new Error('Abhi abhi soch chuki hu — thodi der baad.'); e.status = 429; throw e; } return await reflectOnce(String((req.body || {}).observation || '').slice(0, 600)); }));
  router.post('/mind/experiment', gate, auth, ownerOnly, wrap((req) => consciousnessExperiment((req.body || {}).observation)));
  router.post('/mind/feedback', gate, auth, ownerOnly, wrap((req) => { const b = req.body || {}; const r = recordFeedback(b.item, b.rating, b.note); return { ...r, say: `Thanks — ${r.rating}/5 yaad rakh liya. (${r.feedbackCount} ratings, average ${r.averageRating}/5)` }; }));
  router.post('/mind/evaluate', gate, auth, ownerOnly, wrap((req) => { const b = req.body || {}; return recordEvaluation(b.skill, b.test_name || b.test, b.passed, b.details); }));
  router.get('/mind/evidence', gate, auth, ownerOnly, (req, res) => res.json({ feedback: feedbackStats(), evaluations: evalStats(req.query.skill), note: 'Kuch tests pass hona general competence ka saboot nahi.' }));
  router.post('/mind/plan', gate, auth, ownerOnly, wrap((req) => createPlan((req.body || {}).goal)));
  router.post('/mind/goal', gate, auth, ownerOnly, wrap((req) => { const g = String((req.body || {}).goal || '').trim().slice(0, 300); if (!g) throw new Error('goal chahiye'); state.goal = g; addMemory('goal', 'Goal set: ' + g); schedulePersist(); return { goal: g, say: 'Goal set: ' + g }; }));
  router.get('/mind/curiosity', gate, auth, ownerOnly, wrap(async () => { const q = await curiosityQuestion(); return { question: q, say: '🤔 ' + q }; }));
  router.post('/mind/observe', gate, auth, ownerOnly, wrap((req) => { const b = req.body || {}; return observe(b.content, b.source, b.consent); }));

  // ---------------- boot ----------------
  async function start() {
    if (off('AVA_MIND')) { console.log('[ava] mind is off (AVA_MIND=off).'); return; }
    const s = await kv.get('mind_state', null); if (s && typeof s === 'object') state = Object.assign(DEFAULT_STATE(), s);
    const m = await kv.get('mind_memory', []); if (Array.isArray(m)) memory = m;
    const every = Math.max(30, Number(process.env.AVA_MIND_INTERVAL_MIN) || 360) * 60000;
    const tick = () => Promise.resolve().then(async () => { if (turnsSinceReflect >= 3) { await reflectOnce(); if (Math.random() < 0.5) await curiosityQuestion(); } }).catch(() => {}).finally(() => setTimeout(tick, every));
    setTimeout(tick, 40 * 60000);
    console.log(`[ava] mind ready — ${memory.length} memories · confidence ${r2(state.confidence)} · (self-model, not a consciousness claim)`);
  }

  return { start, logTurn, promptBlock, brainSummary, _t: { addMemory, semanticSearch, reflectOnce, consciousnessExperiment, recordFeedback, recordEvaluation, createPlan, observe, curiosityQuestion, selfReport, getState: () => state, getMemory: () => memory } };
};
