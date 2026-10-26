// www/lang-ui.js — Reply language: Auto / Hinglish / English (Settings > General). Applies to Aureon chat and Ava (via x-ava-lang header).
(function () {
  var KEY = 'aureon_reply_lang';
  function get() { try { var v = localStorage.getItem(KEY); return v === 'hinglish' || v === 'english' ? v : 'auto'; } catch (e) { return 'auto'; } }
  window.aureonReplyLangRule = function () {
    var v = get();
    if (v === 'english') return '\n\nLANGUAGE RULE (user setting): Always reply in simple, clear English, even if the user writes Hinglish or Hindi. Keep code and code comments in English.';
    if (v === 'hinglish') return '\n\nLANGUAGE RULE (user setting): Always reply in natural Hinglish (Hindi written in English letters, mixed with English words), even if the user writes in English. Keep code and code comments in English.';
    return '';
  };
  var AKEY = 'aureon_auto_fix';   // Auto test & fix: 'on' (default) or 'off'
  window.aureonAutoFix = function () { try { return localStorage.getItem(AKEY) !== 'off'; } catch (e) { return true; } };
  function init() {
    var af = document.getElementById('auto-fix-select');
    if (af) { af.value = window.aureonAutoFix() ? 'on' : 'off'; af.addEventListener('change', function () { try { localStorage.setItem(AKEY, af.value); } catch (e) { /* storage blocked */ } }); }
    var sel = document.getElementById('reply-lang-select');
    if (!sel) return;
    sel.value = get();
    sel.addEventListener('change', function () { try { localStorage.setItem(KEY, sel.value); } catch (e) { /* storage blocked */ } });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
