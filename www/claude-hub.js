/* Aureon — Claude Connector + Claude Code (skills) settings panes.
   Needs app.js globals: state (backendUrl, model), authHeaders(), MODEL_LABELS. */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  function base() { return String((typeof state !== 'undefined' && state.backendUrl) || 'https://aureone.onrender.com').replace(/\/$/, ''); }

  async function api(path, method, body) {
    var h = await authHeaders();
    var res = await fetch(base() + path, { method: method || 'GET', headers: h, body: body ? JSON.stringify(body) : undefined });
    var j = await res.json().catch(function () { return {}; });
    if (!res.ok && !j.error) j.error = 'Server error (' + res.status + ')';
    j._status = res.status;
    return j;
  }
  function say(id, text, bad) {
    var el = $(id); if (!el) return;
    el.textContent = text || '';
    el.style.color = bad ? 'var(--danger, #ff6b6b)' : '';
  }
  function needLogin() { return typeof state === 'undefined' || !state.user; }

  /* ---------------- Claude Connector ---------------- */
  async function loadClaude() {
    if (needLogin()) { say('cc-status', 'Pehle sign in karo.', true); return; }
    say('cc-status', 'Check ho raha hai…');
    var j = await api('/api/connectors/claude');
    if (j.error) { say('cc-status', j.error, true); return; }
    var sel = $('cc-model');
    sel.textContent = '';
    (j.models || []).forEach(function (m) {
      var o = document.createElement('option'); o.value = m.id; o.textContent = m.label; if (m.id === j.model) o.selected = true; sel.appendChild(o);
    });
    var sub = $('sub-claude');
    if (j.connected) { say('cc-status', 'Connected: key ...' + j.last4 + ' (teri apni key)'); if (sub) sub.textContent = 'Connected · ...' + j.last4; }
    else if (j.serverKey) { say('cc-status', 'Teri key nahi hai, abhi server ki default key use ho rahi hai.'); if (sub) sub.textContent = 'Server key use ho rahi hai'; }
    else { say('cc-status', 'Koi key nahi. Neeche apni sk-ant-... key daalo.'); if (sub) sub.textContent = 'Apni Anthropic key jodo'; }
    if (!j.canStore) say('cc-msg', 'Server par SENTINEL_ENC_KEY set nahi hai — key save nahi ho payegi.', true);
  }

  async function saveClaude() {
    if (needLogin()) return say('cc-msg', 'Pehle sign in karo.', true);
    var key = $('cc-key').value.trim();
    if (!key) {   // no new key typed: just change the model
      var m = await api('/api/connectors/claude/model', 'POST', { model: $('cc-model').value });
      say('cc-msg', m.ok ? 'Model badal diya.' : m.error, !m.ok); return;
    }
    say('cc-msg', 'Key test ho rahi hai…');
    var j = await api('/api/connectors/claude', 'POST', { apiKey: key, model: $('cc-model').value });
    if (j.ok) { $('cc-key').value = ''; say('cc-msg', 'Claude connect ho gaya ✓'); loadClaude(); }
    else say('cc-msg', j.error, true);
  }
  async function testClaude() {
    if (needLogin()) return say('cc-msg', 'Pehle sign in karo.', true);
    say('cc-msg', 'Test ho raha hai…');
    var j = await api('/api/connectors/claude/test', 'POST');
    say('cc-msg', j.ok ? 'Chal raha hai ✓ (' + j.model + ', ' + j.ms + ' ms, ' + (j.source === 'user' ? 'teri key' : 'server key') + ')' : j.error, !j.ok);
  }
  async function removeClaude() {
    if (needLogin()) return;
    var j = await api('/api/connectors/claude', 'DELETE');
    say('cc-msg', j.ok ? 'Key hata di.' : j.error, !j.ok); loadClaude();
  }

  /* ---------------- Claude Code (skills) ---------------- */
  function renderSkills(list) {
    var box = $('cs-list'); box.textContent = '';
    var cnt = $('cs-count'); if (cnt) cnt.textContent = list.length ? '(' + list.length + ')' : '';
    var sub = $('sub-claudecode'); if (sub) sub.textContent = list.length ? list.length + ' skill installed' : 'Skills install karo';
    if (!list.length) { var e = document.createElement('div'); e.className = 'card-sub'; e.textContent = 'Abhi koi skill nahi. Upar GitHub link daalo.'; box.appendChild(e); return; }
    list.forEach(function (s) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--border-gold, rgba(255,255,255,.12))';
      var txt = document.createElement('div'); txt.style.cssText = 'flex:1;min-width:0';
      var n = document.createElement('div'); n.style.cssText = 'font-weight:600;font-size:14px'; n.textContent = s.name;
      var d = document.createElement('div'); d.style.cssText = 'font-size:12px;opacity:.75;line-height:1.4;margin-top:2px;overflow-wrap:anywhere'; d.textContent = s.description || '(description nahi hai)';
      var src = document.createElement('div'); src.style.cssText = 'font-size:11px;opacity:.5;margin-top:2px;overflow-wrap:anywhere'; src.textContent = s.source || '';
      txt.appendChild(n); txt.appendChild(d); txt.appendChild(src);
      var del = document.createElement('button'); del.textContent = '✕'; del.setAttribute('aria-label', 'Remove ' + s.name);
      del.style.cssText = 'background:none;border:0;color:inherit;font-size:16px;padding:6px 8px;opacity:.7';
      del.addEventListener('click', async function () {
        var j = await api('/api/skills/' + encodeURIComponent(s.name), 'DELETE');
        if (j.ok) loadSkills(); else say('cs-msg', j.error || 'Hata nahi paaya', true);
      });
      row.appendChild(txt); row.appendChild(del); box.appendChild(row);
    });
  }
  async function loadSkills() {
    if (needLogin()) { say('cs-msg', 'Pehle sign in karo.', true); return; }
    var j = await api('/api/skills');
    if (j.error) { say('cs-msg', j.error, true); return; }
    renderSkills(j.skills || []);
  }
  async function installSkill() {
    if (needLogin()) return say('cs-msg', 'Pehle sign in karo.', true);
    var url = $('cs-url').value.trim();
    if (!/^https:\/\/github\.com\//i.test(url)) return say('cs-msg', 'Sirf https://github.com/... ka link chalega.', true);
    say('cs-msg', 'Install ho rahi hai…');
    var j = await api('/api/skills/install', 'POST', { url: url });
    if (j.ok) { $('cs-url').value = ''; say('cs-msg', (j.installed || []).length + ' skill install ho gayi ✓'); loadSkills(); }
    else say('cs-msg', j.error, true);
  }
  function useClaudeCode() {
    state.model = 'claudecode';
    try { localStorage.setItem('aureon_model', 'claudecode'); } catch (e) { /* blocked */ }
    var pill = $('model-pill'); if (pill && typeof MODEL_LABELS !== 'undefined') pill.textContent = MODEL_LABELS.claudecode;
    say('cs-msg', 'Claude Code mode chalu ✓ — ab chat mein likho.');
  }

  function wire() {
    if (!$('cc-save') || $('cc-save').dataset.wired) return;
    $('cc-save').dataset.wired = '1';
    $('cc-save').addEventListener('click', saveClaude);
    $('cc-test').addEventListener('click', testClaude);
    $('cc-remove').addEventListener('click', removeClaude);
    $('cs-install').addEventListener('click', installSkill);
    $('cs-use').addEventListener('click', useClaudeCode);
    $('cs-url').addEventListener('keydown', function (e) { if (e.key === 'Enter') installSkill(); });
    document.querySelectorAll('.list-row[data-open="claude"]').forEach(function (b) { b.addEventListener('click', loadClaude); });
    document.querySelectorAll('.list-row[data-open="claudecode"]').forEach(function (b) { b.addEventListener('click', loadSkills); });
  }
  document.addEventListener('DOMContentLoaded', wire);
  if (document.readyState !== 'loading') wire();
})();
