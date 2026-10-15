/* Aureon theme manager — Nebula Aurora / Cyberpunk Neon / Classic Gold */
(function () {
  var KEY = 'aureon_theme';
  var NAMES = { nebula: 'Nebula Aurora', ocean: 'Deep Ocean', cyber: 'Cyberpunk Neon', emerald: 'Emerald Intelligence', light: 'White + Electric Purple', classic: 'Classic Gold' };
  function get() { try { return localStorage.getItem(KEY) || 'nebula'; } catch (e) { return 'nebula'; } }
  function apply(t) {
    if (!NAMES[t]) t = 'nebula';
    var r = document.documentElement;
    if (t === 'classic') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', t);
    try { localStorage.setItem(KEY, t); } catch (e) {}
    document.querySelectorAll('.theme-opt').forEach(function (b) { b.classList.toggle('on', b.dataset.theme === t); });
    var sub = document.getElementById('sub-theme'); if (sub) sub.textContent = NAMES[t];
  }
  window.AureonTheme = { get: get, apply: apply };
  document.querySelectorAll('.theme-opt').forEach(function (b) { b.addEventListener('click', function () { apply(b.dataset.theme); }); });
  var s = document.getElementById('btn-drawer-settings');
  if (s) s.addEventListener('click', function () { setTimeout(function () { apply(get()); }, 0); });
  apply(get());
})();
