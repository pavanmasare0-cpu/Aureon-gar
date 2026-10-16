/* Ava — Aureon's flying AI companion.
 *
 * One file, two homes:
 *   - Aureon app  (www/index.html)            -> talks to /api/chat (full phone actions + memory)
 *   - Sentinel    (/api/sentinel/dashboard)   -> talks to /api/ava/chat (owner code)
 *
 * She floats around the whole screen by herself, shows what she is thinking /
 * learning, speaks on her own now and then (mute button in her chat), and when
 * you tap her a small chat opens where you can type or speak orders.
 *
 * Canonical copy lives in www/. backend/public/ava-bot.js is a copy served to
 * Sentinel — run `npm run sync-ava` in /backend after editing this file.
 */
(function () {
  'use strict';
  if (window.__AVA_LOADED__) return;
  window.__AVA_LOADED__ = true;

  var IS_SENTINEL = (typeof OWNER_CODE !== 'undefined') || /\/api\/sentinel\//.test(location.pathname);
  var MODE = IS_SENTINEL ? 'sentinel' : 'app';
  var SIZE = 72;
  var REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- tiny helpers ----------
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; }

  var K = { off: 'ava_off', hidden: 'ava_hidden', voice: 'ava_voice', hist: 'ava_hist_' + MODE, seen: 'ava_seen_thought' };
  var hidden = lsGet(K.hidden, '0') === '1';
  var off = lsGet(K.off, '0') === '1';
  var voiceOn = lsGet(K.voice, '1') === '1';

  // ---------- styles ----------
  var css = '\
#ava-root{position:fixed;inset:0;z-index:2147483000;pointer-events:none;font-family:-apple-system,"Manrope","Segoe UI",Roboto,sans-serif}\
#ava-root *{box-sizing:border-box}\
#ava-orb{position:fixed;left:0;top:0;width:72px;height:72px;pointer-events:auto;touch-action:none;cursor:pointer;will-change:transform;-webkit-tap-highlight-color:transparent}\
.ava-tilt{position:absolute;inset:0;transition:transform .12s linear}\
.ava-bob{position:absolute;inset:0;animation:avaBob 3.2s ease-in-out infinite}\
@keyframes avaBob{0%,100%{transform:translateY(-3px)}50%{transform:translateY(4px)}}\
.ava-glow{position:absolute;inset:-26px;border-radius:50%;background:radial-gradient(circle,rgba(125,243,255,.75) 0,rgba(34,211,238,.45) 30%,rgba(139,92,246,.32) 52%,rgba(255,60,172,.18) 64%,transparent 74%);filter:blur(9px);animation:avaPulse 2.6s ease-in-out infinite}\
@keyframes avaPulse{0%,100%{opacity:.8;transform:scale(.95)}50%{opacity:1;transform:scale(1.08)}}\
.ava-sphere{position:absolute;inset:9px 9px 7px;border-radius:50%;background:radial-gradient(circle at 50% 52%,rgba(18,52,140,.55) 0,rgba(30,120,230,.45) 52%,rgba(150,235,255,.95) 74%,#fff 80%,rgba(160,120,255,.9) 92%,rgba(255,60,172,.8) 100%);box-shadow:0 0 0 1.5px rgba(200,250,255,.95) inset,0 0 12px 2px #fff,0 0 22px 6px rgba(34,211,238,.95),0 0 44px 12px rgba(139,92,246,.7),0 6px 30px 6px rgba(255,60,172,.4)}\
.ava-ring{position:absolute;inset:6px 6px 4px;border-radius:50%;background:conic-gradient(from 0deg,#22d3ee,#8b5cf6,#ff3cac,#22d3ee);-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2px));mask:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2px));animation:avaSpin 5s linear infinite}\
@keyframes avaSpin{to{transform:rotate(360deg)}}\
.ava-visor{position:absolute;left:13%;right:13%;top:27%;height:46%;border-radius:46%;background:linear-gradient(180deg,#040c24,#0a1a44);box-shadow:0 0 0 1.5px rgba(34,211,238,.95) inset,0 0 9px rgba(34,211,238,.8);--lx:0px}\
.ava-eye{position:absolute;top:24%;width:16%;height:36%;border-radius:50%;background:#aef9ff;box-shadow:0 0 6px 1px #fff,0 0 12px 3px #22d3ee;transform:translateX(var(--lx));animation:avaBlink 5s infinite}\
.ava-eye.l{left:25%}.ava-eye.r{right:25%}\
@keyframes avaBlink{0%,93%,100%{transform:translateX(var(--lx)) scaleY(1)}96%{transform:translateX(var(--lx)) scaleY(.1)}}\
.ava-mouth{position:absolute;left:39%;right:39%;bottom:15%;height:18%;border-bottom:2.5px solid #aef9ff;border-radius:0 0 50% 50%;filter:drop-shadow(0 0 4px #22d3ee);transform:translateX(var(--lx))}\
.ava-ear{position:absolute;top:34%;width:13px;height:28px;border-radius:50%;background:radial-gradient(circle,rgba(255,139,224,.35),rgba(139,92,246,.75));border:2px solid #ff8be0;box-shadow:0 0 10px 2px #ff3cac,0 0 4px #fff inset}\
.ava-ear.l{left:-5px}.ava-ear.r{right:-5px}\
.ava-ant{position:absolute;left:50%;top:-5px;width:2px;height:13px;margin-left:-1px;background:linear-gradient(#ff8be0,#7df3ff)}\
.ava-ant:after{content:"";position:absolute;left:-3px;top:-7px;width:8px;height:8px;border-radius:50%;background:#ffb3ec;box-shadow:0 0 8px 3px #ff3cac}\
.ava-halo{position:absolute;left:8%;right:8%;top:-9px;height:14px;border-radius:50%;border:2px solid rgba(174,249,255,.95);box-shadow:0 0 10px 1px rgba(34,211,238,.9),0 0 8px rgba(34,211,238,.7) inset;transform:rotateX(68deg)}\
.ava-halo:after{content:"";position:absolute;inset:2px 5px;border-radius:50%;border:1px solid rgba(255,139,224,.8)}\
.s-think .ava-ring,.s-learn .ava-ring{animation-duration:1s}\
.s-think .ava-eye,.s-learn .ava-eye{height:20%;top:34%}\
.s-speak .ava-mouth{animation:avaTalk .28s ease-in-out infinite alternate}\
@keyframes avaTalk{from{transform:translateX(var(--lx)) scaleY(.5)}to{transform:translateX(var(--lx)) scaleY(1.8)}}\
.s-speak .ava-glow,.s-learn .ava-glow{animation-duration:.8s}\
#ava-bubble{position:fixed;left:0;top:0;max-width:min(250px,72vw);padding:9px 13px;border-radius:14px;color:#e9fbff;font-size:13px;line-height:1.35;border:1.5px solid transparent;background:linear-gradient(135deg,#071a3d,#1b0f40) padding-box,linear-gradient(135deg,#22d3ee,#ff3cac) border-box;box-shadow:0 0 16px rgba(34,211,238,.5),0 0 26px rgba(255,60,172,.25);pointer-events:auto;cursor:pointer;opacity:0;transform:scale(.9);transition:opacity .25s,transform .25s;visibility:hidden}\
#ava-bubble.on{opacity:1;transform:scale(1);visibility:visible}\
.ava-bar{height:4px;margin-top:7px;border-radius:3px;overflow:hidden;background:rgba(125,243,255,.18)}\
.ava-bar i{display:block;height:100%;width:40%;border-radius:3px;background:linear-gradient(90deg,#22d3ee,#8b5cf6,#ff3cac);animation:avaBar 1.2s ease-in-out infinite}\
#ava-bubble .bar{display:none;height:4px;margin-top:7px;border-radius:3px;overflow:hidden;background:rgba(125,243,255,.18)}\
#ava-bubble.learn .bar{display:block}\
#ava-bubble .bar i{display:block;height:100%;width:40%;border-radius:3px;background:linear-gradient(90deg,#22d3ee,#8b5cf6,#ff3cac);animation:avaBar 1.2s ease-in-out infinite}\
@keyframes avaBar{0%{transform:translateX(-100%)}100%{transform:translateX(260%)}}\
#ava-panel{position:fixed;right:10px;bottom:calc(14px + env(safe-area-inset-bottom,0px));width:min(86vw,300px);height:min(46vh,340px);display:none;flex-direction:column;border-radius:20px;pointer-events:auto;color:#e9fbff;border:1.5px solid transparent;background:linear-gradient(160deg,#061232,#150a30) padding-box,linear-gradient(135deg,#22d3ee,#8b5cf6 55%,#ff3cac) border-box;box-shadow:0 0 18px rgba(34,211,238,.5),0 0 36px rgba(255,60,172,.25)}\
#ava-panel:after{content:"";position:absolute;top:-9px;right:34px;width:15px;height:15px;transform:rotate(45deg);background:#0b1636;border-left:1.5px solid #22d3ee;border-top:1.5px solid #6a7cf0}\
#ava-panel.on{display:flex;animation:avaPop .22s ease-out}\
@keyframes avaPop{from{opacity:0;transform:translateY(14px) scale(.96)}to{opacity:1;transform:none}}\
.ava-head{display:flex;align-items:center;gap:6px;padding:9px 10px 6px}\
.ava-head b{font-size:14px;letter-spacing:.5px;color:#aef9ff;text-shadow:0 0 8px #22d3ee}\
.ava-head small{display:block;font-size:10.5px;color:#8fb7d6}\
.ava-head .sp{flex:1}\
#ava-root .ava-ib{width:26px;height:26px;border-radius:50%;border:1px solid rgba(34,211,238,.5);background:rgba(34,211,238,.08);color:#e9fbff;font-size:12px;line-height:1;cursor:pointer;padding:0;box-shadow:none}\
#ava-root .ava-ib.off{opacity:.45}\
#ava-msgs{flex:1;overflow-y:auto;padding:4px 10px 6px;display:flex;flex-direction:column;gap:7px;-webkit-overflow-scrolling:touch}\
.ava-m{max-width:90%;padding:7px 10px;border-radius:13px;font-size:13px;line-height:1.38;white-space:pre-wrap;overflow-wrap:anywhere}\
.ava-m .t{display:block;font-weight:800;letter-spacing:.5px;color:#7df3ff;font-size:12.5px;text-shadow:0 0 6px rgba(34,211,238,.7);margin-bottom:2px}\
.ava-m.ai{align-self:flex-start;border-top-left-radius:4px;background:linear-gradient(135deg,rgba(34,211,238,.14),rgba(139,92,246,.16));border:1px solid rgba(34,211,238,.6);box-shadow:0 0 10px rgba(34,211,238,.28)}\
.ava-m.me{align-self:flex-end;border-top-right-radius:4px;background:linear-gradient(135deg,rgba(255,60,172,.22),rgba(139,92,246,.3));border:1px solid rgba(255,60,172,.65);box-shadow:0 0 10px rgba(255,60,172,.25);color:#fff}\
.ava-m.err{align-self:flex-start;background:rgba(255,80,110,.12);border:1px solid rgba(255,80,110,.45);color:#ffc2cd}\
.ava-m.note{align-self:center;font-size:11.5px;color:#8fb7d6;background:none;padding:1px}\
.ava-chips{display:flex;gap:6px;flex-wrap:wrap;padding:0 10px 6px}\
.ava-q{width:100%;font-size:11px;font-weight:800;letter-spacing:.6px;color:#aef9ff}\
#ava-root .ava-chip{font-size:11.5px;padding:4px 9px;border-radius:999px;border:1px solid rgba(255,60,172,.55);background:rgba(255,60,172,.08);color:#d9f9ff;cursor:pointer;box-shadow:none}\
.ava-foot{display:flex;gap:6px;padding:7px 9px 9px;border-top:1px solid rgba(34,211,238,.2)}\
#ava-in{flex:1;min-width:0;border-radius:999px;border:1px solid rgba(34,211,238,.5);background:rgba(3,10,28,.85);color:#e9fbff;padding:8px 12px;font-size:13.5px;outline:none;width:auto}\
#ava-in::placeholder{color:#6f93b3}\
#ava-root .ava-go{width:34px;height:34px;border-radius:50%;border:none;background:linear-gradient(135deg,#22d3ee,#8b5cf6);color:#fff;font-size:14px;cursor:pointer;padding:0;flex:none;box-shadow:0 0 10px rgba(34,211,238,.6)}\
#ava-root .ava-go.mic.rec{background:linear-gradient(135deg,#ff3cac,#ff6b6b);animation:avaPulse 1s infinite}\
#ava-nub{position:fixed;right:6px;bottom:calc(90px + env(safe-area-inset-bottom,0px));width:30px;height:30px;border-radius:50%;pointer-events:auto;display:none;align-items:center;justify-content:center;color:#7df3ff;font-size:15px;cursor:pointer;background:rgba(8,24,56,.85);border:1px solid rgba(34,211,238,.7);box-shadow:0 0 12px rgba(34,211,238,.6)}\
@media (prefers-reduced-motion:reduce){.ava-bob,.ava-glow,.ava-ring,.ava-eye{animation:none}}\
.ava-hop{position:absolute;inset:0;transition:transform .15s}\
.press .ava-hop{transform:scale(.9)}\
.hop .ava-hop{animation:avaHop .6s ease-out}\
@keyframes avaHop{0%{transform:scale(1)}30%{transform:scale(1.2) translateY(-6px)}60%{transform:scale(.94)}100%{transform:scale(1)}}\
.ava-shadow{position:absolute;left:18%;right:18%;bottom:-14px;height:9px;border-radius:50%;background:radial-gradient(ellipse,rgba(34,211,238,.5),transparent 70%);filter:blur(3px);animation:avaShadow 3.2s ease-in-out infinite}\
@keyframes avaShadow{0%,100%{transform:scale(1.05);opacity:.8}50%{transform:scale(.8);opacity:.45}}\
.ava-sphere{inset:8px 8px 6px;background:radial-gradient(circle at 50% 55%,rgba(25,70,170,.6) 0,rgba(45,140,245,.5) 50%,rgba(170,240,255,.96) 72%,#fff 78%,rgba(170,130,255,.95) 90%,rgba(255,80,180,.85) 100%)}\
.ava-gloss{position:absolute;left:14%;top:5%;width:46%;height:24%;border-radius:50%;background:linear-gradient(180deg,rgba(255,255,255,.8),rgba(255,255,255,0));transform:rotate(-24deg);filter:blur(1px);pointer-events:none;z-index:2}\
.ava-visor{left:10%;right:10%;top:24%;height:52%;background:radial-gradient(ellipse at 50% 28%,#0e2d6b,#050f2c 72%);box-shadow:0 0 0 1.5px rgba(34,211,238,.95) inset,0 0 10px rgba(34,211,238,.85),0 0 0 4px rgba(10,30,80,.55) inset}\
.ava-eye{top:25%;width:15%;height:38%;transform:translate(var(--lx),var(--ly,0px));animation:avaBlink2 5s infinite}\
.ava-eye:after{content:"";position:absolute;left:22%;top:14%;width:28%;height:24%;border-radius:50%;background:#fff;opacity:.95}\
@keyframes avaBlink2{0%,93%,100%{transform:translate(var(--lx),var(--ly,0px)) scaleY(1)}96%{transform:translate(var(--lx),var(--ly,0px)) scaleY(.1)}}\
.ava-mouth{transform:translate(var(--lx),var(--ly,0px))}\
.happy .ava-eye{width:19%;height:24%;top:33%;border-radius:100% 100% 0 0 / 140% 140% 0 0;background:transparent;border-top:3px solid #aef9ff;box-shadow:0 -2px 8px #22d3ee;animation:none}\
.happy .ava-eye:after{display:none}\
.happy .ava-mouth{height:25%;bottom:12%}\
.ava-sp{position:absolute;font-style:normal;color:#e6fdff;text-shadow:0 0 6px #22d3ee,0 0 12px #8b5cf6;font-size:11px;line-height:1;opacity:0;animation:avaTw 3.6s ease-in-out infinite;pointer-events:none}\
.ava-sp.s1{left:-8px;top:16px}.ava-sp.s2{right:-10px;top:44px;font-size:14px;animation-delay:1.2s}.ava-sp.s3{left:4px;bottom:-4px;font-size:9px;animation-delay:2.2s}\
@keyframes avaTw{0%,100%{opacity:0;transform:scale(.3) rotate(0)}50%{opacity:1;transform:scale(1) rotate(90deg)}}\
.ava-dots{position:absolute;left:50%;top:-24px;transform:translateX(-50%);display:none;gap:4px}\
.s-think .ava-dots,.s-learn .ava-dots{display:flex}\
.ava-dots i{width:5px;height:5px;border-radius:50%;background:#aef9ff;box-shadow:0 0 6px #22d3ee;animation:avaDot 1s infinite}\
.ava-dots i:nth-child(2){animation-delay:.15s}.ava-dots i:nth-child(3){animation-delay:.3s}\
@keyframes avaDot{0%,100%{transform:translateY(0);opacity:.5}50%{transform:translateY(-5px);opacity:1}}\
.ava-wave{position:absolute;inset:8px;border-radius:50%;border:2px solid rgba(125,243,255,.7);opacity:0;pointer-events:none}\
.s-speak .ava-wave{animation:avaWave 1.2s ease-out infinite}\
@keyframes avaWave{0%{opacity:.8;transform:scale(1)}100%{opacity:0;transform:scale(1.9)}}\
#ava-bubble:after{content:"";position:absolute;left:calc(var(--tx,50%) - 6px);width:11px;height:11px;transform:rotate(45deg);background:#0d1840}\
#ava-bubble.up:after{bottom:-7px;border-right:1.5px solid #6a7cf0;border-bottom:1.5px solid #ff3cac}\
#ava-bubble.down:after{top:-7px;border-left:1.5px solid #22d3ee;border-top:1.5px solid #22d3ee}\
#ava-sub:before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:5px;background:#34d399;box-shadow:0 0 6px #34d399}\
.s-think #ava-sub:before{background:#fbbf24;box-shadow:0 0 6px #fbbf24}\
.s-learn #ava-sub:before{background:#a78bfa;box-shadow:0 0 6px #a78bfa}\
.ava-m{animation:avaIn .28s ease-out}\
@keyframes avaIn{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:none}}\
#ava-msgs::-webkit-scrollbar{width:4px}#ava-msgs::-webkit-scrollbar-thumb{background:rgba(34,211,238,.35);border-radius:4px}\
#ava-in:focus{border-color:#ff8be0;box-shadow:0 0 10px rgba(255,60,172,.4)}\
.ava-ear{top:30%;width:17px;height:32px;border-radius:9px;border:2px solid transparent;background:radial-gradient(ellipse at 50% 50%,#fff 0,#ffc2f0 9%,#ff3cac 20%,#5b1fb8 48%,#12063a 78%) padding-box,linear-gradient(180deg,#aef9ff,#8b5cf6 55%,#ff3cac) border-box;box-shadow:0 0 8px 1px rgba(255,60,172,.9),0 0 16px 3px rgba(139,92,246,.6),0 0 0 1px rgba(255,255,255,.35) inset;animation:avaEar 2.4s ease-in-out infinite;z-index:3}\
.ava-ear:before{content:"";position:absolute;inset:3px 2px;border-radius:7px;border:1px solid rgba(174,249,255,.7);box-shadow:0 0 5px rgba(34,211,238,.8)}\
.ava-ear:after{content:"";position:absolute;left:50%;top:3px;width:3px;height:3px;margin-left:-1.5px;border-radius:50%;background:#fff;box-shadow:0 0 5px 1px #aef9ff}\
.ava-ear.l{left:-10px}.ava-ear.r{right:-10px}\
.ava-ear.r{animation-delay:.6s}\
@keyframes avaEar{0%,100%{filter:brightness(1)}50%{filter:brightness(1.35)}}\
.s-speak .ava-ear,.s-learn .ava-ear{animation-duration:.5s}\
.ava-ear{top:34%;width:13px;height:25px;border-radius:7px;border:1.5px solid transparent;background:linear-gradient(90deg,transparent 34%,rgba(255,150,225,.95) 50%,transparent 66%) padding-box,linear-gradient(180deg,#1b0f4a,#0a0524) padding-box,linear-gradient(180deg,#e8fdff,#8b5cf6 52%,#ff5cc0) border-box;box-shadow:0 0 6px rgba(255,60,172,.75),0 0 12px 2px rgba(139,92,246,.45),0 0 0 1px rgba(255,255,255,.3) inset}\
.ava-ear:before{inset:2.5px 1.5px;border-radius:5px;border:1px solid rgba(174,249,255,.55);box-shadow:0 0 4px rgba(34,211,238,.7)}\
.ava-ear:after{top:2.5px;width:2.5px;height:2.5px;margin-left:-1.25px;box-shadow:0 0 4px 1px #aef9ff}\
.ava-ear.l{left:-8px}.ava-ear.r{right:-8px}\
#ava-root .ava-ib.on{background:rgba(255,60,172,.3);border-color:#ff3cac;box-shadow:0 0 8px #ff3cac;opacity:1}';
  var style = el('style'); style.id = 'ava-style'; style.textContent = css; document.head.appendChild(style);

  // ---------- DOM ----------
  var root = el('div'); root.id = 'ava-root'; root.className = 's-idle';
  root.innerHTML =
    '<div id="ava-orb" role="button" aria-label="Ava assistant"><div class="ava-shadow"></div><div class="ava-tilt"><div class="ava-hop"><div class="ava-bob">' +
      '<div class="ava-glow"></div><div class="ava-halo"></div><div class="ava-ant"></div>' +
      '<div class="ava-sphere"><div class="ava-gloss"></div><div class="ava-ear l"></div><div class="ava-ear r"></div>' +
      '<div class="ava-visor"><span class="ava-eye l"></span><span class="ava-eye r"></span><span class="ava-mouth"></span></div></div><div class="ava-ring"></div><i class="ava-sp s1">✦</i><i class="ava-sp s2">✦</i><i class="ava-sp s3">✦</i><div class="ava-dots"><i></i><i></i><i></i></div><div class="ava-wave"></div>' +
    '</div></div></div></div>' +
    '<div id="ava-bubble"><span class="t"></span><div class="bar"><i></i></div></div>' +
    '<div id="ava-nub" title="Ava ko wapas bulao">✦</div>' +
    '<div id="ava-panel" role="dialog" aria-label="Ava chat">' +
      '<div class="ava-head"><div><b>Ava</b><small id="ava-sub">online</small></div><span class="sp"></span>' +
      '<button class="ava-ib" id="ava-talk" title="Baat-cheet mode — bolte raho, Ava sunti aur bolti rahegi">💬</button>' +
      '<button class="ava-ib" id="ava-see" title="Screen dekhna on/off — Ava screen par jo chal raha hai wo yaad rakhegi">👁</button>' +
      '<button class="ava-ib" id="ava-disc" title="Ava ne kya naya khoja">🔭</button>' +
      '<button class="ava-ib" id="ava-learn" title="Abhi kuch naya seekho">🧠</button>' +
      '<button class="ava-ib" id="ava-voice" title="Awaaz on/off">🔊</button>' +
      '<button class="ava-ib" id="ava-hide" title="Ava ko chhupao">—</button>' +
      '<button class="ava-ib" id="ava-close" title="Band karo">✕</button></div>' +
      '<div id="ava-msgs"></div><div class="ava-chips" id="ava-chips"></div>' +
      '<div class="ava-foot"><input id="ava-in" type="text" placeholder="Order do ya kuch pucho…" autocomplete="off" enterkeyhint="send">' +
      '<button class="ava-go mic" id="ava-mic" title="Bolkar order do">🎤</button><button class="ava-go" id="ava-send" title="Bhejo">➤</button></div>' +
    '</div>';
  document.body.appendChild(root);

  var orbEl = root.querySelector('#ava-orb'), tiltEl = root.querySelector('.ava-tilt'), visorEl = root.querySelector('.ava-visor');
  var bubbleEl = root.querySelector('#ava-bubble'), bubbleT = bubbleEl.querySelector('.t'), nubEl = root.querySelector('#ava-nub');
  var panelEl = root.querySelector('#ava-panel'), msgsEl = root.querySelector('#ava-msgs'), inEl = root.querySelector('#ava-in');
  var subEl = root.querySelector('#ava-sub'), chipsEl = root.querySelector('#ava-chips'), micEl = root.querySelector('#ava-mic');
  var voiceBtn = root.querySelector('#ava-voice'), talkBtn = root.querySelector('#ava-talk'), seeBtn = root.querySelector('#ava-see'), discBtn = root.querySelector('#ava-disc');

  // ---------- state ----------
  var seeOn = false, vis = true, panelOpen = false, interacted = false, lastSpoke = 0, bubbleTimer = 0, busy = false, learning = false;
  var W = innerWidth, H = innerHeight;
  var o = { x: W - SIZE - 14, y: H * 0.45, vx: 0, vy: 0, tx: W * 0.5, ty: H * 0.3, mode: 'roam', wait: 1.5, nextThought: Date.now() + 9000 };
  function setState(s) { root.className = 's-' + s + (root.classList.contains('happy') ? ' happy' : ''); }
  function flash(cls, ms) { root.classList.add(cls); setTimeout(function () { root.classList.remove(cls); }, ms); }
  function happy() { flash('hop', 650); flash('happy', 1500); try { navigator.vibrate && navigator.vibrate(12); } catch (e) {} }
  var dart = { x: 0, y: 0 };
  setInterval(function () { if (o.mode === 'roam' && Math.hypot(o.vx, o.vy) < 30) { dart.x = rnd(-2, 2); dart.y = rnd(-1.5, 1.5); } else { dart.x = dart.y = 0; } }, 2200);
  function status() { subEl.textContent = busy ? 'soch rahi hu…' : learning ? 'naya seekh rahi hu…' : seeOn ? '👁 screen dekh rahi hu' : 'online'; }

  // ---------- roaming engine ----------
  function pickTarget() {
    var m = 8, tries = 0;
    do {
      o.tx = m + Math.random() * Math.max(10, W - SIZE - 2 * m);
      o.ty = m + Math.random() * Math.max(10, H - SIZE - 2 * m);
      tries++;
    } while (tries < 6 && Math.hypot(o.tx - o.x, o.ty - o.y) < 140);
  }
  function dockTarget() {
    var pr = panelEl.getBoundingClientRect();
    o.tx = clamp(pr.right - SIZE - 4, 4, W - SIZE - 4);
    o.ty = clamp(pr.top - SIZE - 2, 4, H - SIZE - 4);
  }
  var last = performance.now();
  function frame(ts) {
    requestAnimationFrame(frame);
    var dt = Math.min(0.05, (ts - last) / 1000); last = ts;
    if (document.hidden || !vis) return;
    if (o.mode === 'roam') {
      if (REDUCED) { o.tx = W - SIZE - 14; o.ty = H * 0.55; }
      else if (o.wait > 0) o.wait -= dt;
      else if (Math.hypot(o.tx - o.x, o.ty - o.y) < 16) { o.wait = rnd(1.2, 3.6); pickTarget(); }
    } else if (o.mode === 'dock') dockTarget();
    if (o.mode !== 'drag') {
      var k = o.mode === 'dock' ? 14 : 2.0, c = o.mode === 'dock' ? 7.5 : 2.3;
      o.vx += ((o.tx - o.x) * k - o.vx * c) * dt;
      o.vy += ((o.ty - o.y) * k - o.vy * c) * dt;
      var sp = Math.hypot(o.vx, o.vy), cap = o.mode === 'dock' ? 700 : 230;
      if (sp > cap) { o.vx *= cap / sp; o.vy *= cap / sp; }
      o.x += o.vx * dt; o.y += o.vy * dt;
    }
    o.x = clamp(o.x, 0, W - SIZE); o.y = clamp(o.y, 0, H - SIZE);
    orbEl.style.transform = 'translate3d(' + o.x.toFixed(1) + 'px,' + o.y.toFixed(1) + 'px,0)';
    tiltEl.style.transform = 'rotate(' + clamp(o.vx * 0.06, -16, 16).toFixed(1) + 'deg)';
    visorEl.style.setProperty('--lx', (clamp(o.vx / 90, -1, 1) * 3 + dart.x).toFixed(1) + 'px');
    visorEl.style.setProperty('--ly', (clamp(o.vy / 120, -1, 1) * 2 + dart.y).toFixed(1) + 'px');
    placeBubble();
    if (o.mode === 'roam' && Date.now() > o.nextThought && !bubbleEl.classList.contains('on')) idleThought();
  }
  function placeBubble() {
    if (!bubbleEl.classList.contains('on')) return;
    var bw = bubbleEl.offsetWidth, bh = bubbleEl.offsetHeight;
    var bx = clamp(o.x + SIZE / 2 - bw / 2, 6, W - bw - 6);
    var by = o.y > bh + 18 ? o.y - bh - 10 : o.y + SIZE + 10;
    bubbleEl.style.transform = 'translate3d(' + bx.toFixed(0) + 'px,' + by.toFixed(0) + 'px,0)';
    var up = o.y > bh + 18; bubbleEl.classList.toggle('up', up); bubbleEl.classList.toggle('down', !up);
    bubbleEl.style.setProperty('--tx', clamp(o.x + SIZE / 2 - bx, 16, bw - 16).toFixed(0) + 'px');
  }

  // visibility gate (app only shows Ava after login, never on splash/auth screens)
  function shouldShow() {
    if (hidden || off) return false;
    if (IS_SENTINEL) return true;
    return !document.querySelector('#screen-splash.active,#screen-login.active,#screen-signup.active,#screen-verify.active,#screen-forgot.active');
  }
  setInterval(function () {
    var show = shouldShow();
    if (show !== vis) {
      vis = show;
      orbEl.style.display = show ? '' : 'none';
      if (!show) { hideBubble(); closePanel(); }
    }
    nubEl.style.display = (hidden && !off) ? 'flex' : 'none';
  }, 500);

  // ---------- drag / tap ----------
  var drag = null;
  orbEl.addEventListener('pointerdown', function (e) {
    root.classList.add('press');
    drag = { sx: e.clientX, sy: e.clientY, ox: o.x, oy: o.y, moved: false };
    try { orbEl.setPointerCapture(e.pointerId); } catch (x) {}
  });
  orbEl.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) > 8) { drag.moved = true; o.mode = 'drag'; o.vx = o.vy = 0; }
    if (drag.moved) { o.x = drag.ox + dx; o.y = drag.oy + dy; }
  });
  function endDrag(e) {
    root.classList.remove('press');
    if (!drag) return;
    var d = drag; drag = null;
    if (d.moved) { o.mode = panelOpen ? 'dock' : 'roam'; o.tx = o.x; o.ty = o.y; o.wait = 4; }
    else if (e.type === 'pointerup') togglePanel();
  }
  orbEl.addEventListener('pointerup', endDrag);
  orbEl.addEventListener('pointercancel', endDrag);
  document.addEventListener('pointerdown', function () { interacted = true; }, true);
  window.addEventListener('resize', function () { W = innerWidth; H = innerHeight; sizePanel(); });
  if (window.visualViewport) visualViewport.addEventListener('resize', sizePanel);
  function sizePanel() { var vh = (window.visualViewport ? visualViewport.height : H); panelEl.style.height = Math.min(340, vh * 0.55) + 'px'; }

  // ---------- bubble / thoughts ----------
  function showBubble(text, ms, learn) {
    bubbleT.textContent = text;
    bubbleEl.classList.toggle('learn', !!learn);
    bubbleEl.classList.add('on');
    clearTimeout(bubbleTimer);
    if (ms) bubbleTimer = setTimeout(hideBubble, ms);
  }
  function hideBubble() { bubbleEl.classList.remove('on'); }
  bubbleEl.addEventListener('click', function () { hideBubble(); openPanel(); });

  var LOCAL = IS_SENTINEL
    ? ['Servers pe nazar hai. Kuch gadbad dikhi to bataungi.', 'Order do — check now, scan, status…', 'Approve/Reject tumhare haath me hi rahega, mai sirf dekhti hu.']
    : ['Yahin ghoom rahi hu — kuch chahiye to tap karo.', 'Order do, mai phone pe kar dungi.', 'Naya kuch seekhne ka mood hai, dekhte hain.', 'Bore ho rahe ho? Mujhse baat karo.'];
  function idleThought() {
    o.nextThought = Date.now() + rnd(35000, 80000);
    showBubble(LOCAL[Math.floor(Math.random() * LOCAL.length)], 5500, false);
  }
  function announce(text, spoken, learn) {
    showBubble(text, learn ? 45000 : 8000, learn);
    if (spoken && canSpeakUnasked()) speak(text);
    o.nextThought = Date.now() + 60000;
  }
  function canSpeakUnasked() { return voiceOn && interacted && !panelOpen && !document.hidden && Date.now() - lastSpoke > 120000; }

  // ---------- speech out ----------
  function speak(text) {
    if (!voiceOn || !window.speechSynthesis || !text) return;
    try {
      speechSynthesis.cancel();
      var clean = String(text).replace(/[*_`#>•✅🔍🧠✦]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 420);
      if (!clean) return;
      var u = new SpeechSynthesisUtterance(clean);
      u.lang = /[\u0900-\u097F]/.test(clean) ? 'hi-IN' : 'en-IN';
      u.rate = 1.02; u.pitch = 1.12;
      var vs = speechSynthesis.getVoices();
      for (var i = 0; i < vs.length; i++) { if (vs[i].lang && vs[i].lang.replace('_', '-').toLowerCase() === u.lang.toLowerCase()) { u.voice = vs[i]; break; } }
      u.onstart = function () { setState('speak'); };
      u.onend = u.onerror = function () { setState(busy ? 'think' : learning ? 'learn' : 'idle'); };
      lastSpoke = Date.now();
      speechSynthesis.speak(u);
    } catch (e) {}
  }
  function syncVoiceBtn() { voiceBtn.classList.toggle('off', !voiceOn); voiceBtn.textContent = voiceOn ? '🔊' : '🔇'; }
  voiceBtn.onclick = function () { voiceOn = !voiceOn; lsSet(K.voice, voiceOn ? '1' : '0'); if (!voiceOn && window.speechSynthesis) speechSynthesis.cancel(); syncVoiceBtn(); };
  syncVoiceBtn();

  // ---------- API ----------
  async function api(method, path, body) {
    var base, headers;
    if (IS_SENTINEL) { base = ''; headers = { 'Content-Type': 'application/json', 'x-owner-code': (typeof OWNER_CODE !== 'undefined' ? OWNER_CODE : '') }; }
    else {
      if (typeof state === 'undefined' || !state.user) throw new Error('Pehle login karo.');
      base = state.backendUrl.replace(/\/$/, ''); headers = await authHeaders();
    }
    var r = await fetch(base + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) { var d = {}; try { d = await r.json(); } catch (e) {} throw new Error(d.error || ('Server ' + r.status)); }
    return r.json();
  }

  // ---------- brain (what she learned on her own) ----------
  var brain = null, brainAt = 0;
  async function getBrain(force) {
    if (!force && brain && Date.now() - brainAt < 120000) return brain;
    brain = await api('GET', '/api/ava/brain'); brainAt = Date.now(); return brain;
  }
  function brainText(b) {
    if (!b) return '';
    var out = (b.knowledge && b.knowledge.length) ? b.knowledge.slice(0, 8).map(function (f) { return '- (' + f.topic + ') ' + f.fact; }).join('\n') : '';
    if (b.playbook && b.playbook.length) out += (out ? '\n\n' : '') + 'Apne purane jawabon ko dekh ke tumne ye tareeke likhe hain (soft notes, safety rules se upar nahi):\n' + b.playbook.slice(0, 6).map(function (r) { return '- ' + r; }).join('\n');
    return out;
  }
  async function pollBrain() {
    if (!vis || off) return;
    try {
      var b = await getBrain(true), t = b.thoughts && b.thoughts[0];
      var was = learning; learning = !!(b.status && b.status.learning); status();
      if (learning && !panelOpen) { setState('learn'); announce('🧠 Naya seekh rahi hu: ' + (b.status.topic || '…'), false, true); }
      else if (was && !learning) { setState('idle'); hideBubble(); }
      var dd = b.discoveries; discBtn.title = 'Ava ne kya naya khoja' + (dd && dd.unseen ? ' (' + dd.unseen + ' naye)' : ''); discBtn.classList.toggle('on', !!(dd && dd.unseen));
      if (dd && dd.latest && dd.latest[0] && dd.latest[0].id !== lsGet('ava_disc_ann', '') && !panelOpen) { lsSet('ava_disc_ann', dd.latest[0].id); announce('🔭 Naya mila: ' + dd.latest[0].title + ' — ' + (dd.latest[0].why || dd.latest[0].what), true, false); }
      if (b.screen && b.screen.watching && !b.screen.paused && !seeOn) { seeOn = true; seeBtn.classList.add('on'); status(); }
      if (t && t.id !== lsGet(K.seen, '')) { lsSet(K.seen, t.id); if (!panelOpen) announce('🧠 ' + t.text, true, false); }
    } catch (e) { /* offline / not logged in yet — try again next round */ }
  }
  setTimeout(pollBrain, 7000); setInterval(pollBrain, 4 * 60 * 1000);

  async function learnedList() {
    var b = await getBrain(true);
    if (!b.knowledge.length) return 'Abhi tak kuch naya nahi mila. 🧠 dabao, mai abhi seekhna shuru karti hu.';
    return 'Haal hi me seekha:\n' + b.knowledge.slice(0, 5).map(function (f) { return '• ' + f.fact; }).join('\n');
  }
  async function learnNow() {
    if (learning) return;
    learning = true; setState('learn'); status(); addMsg('note', '🧠 Seekhna shuru…');
    try {
      var r = await api('POST', '/api/ava/learn', {});
      if (r.busy) addMsg('note', 'Pehle se seekh rahi hu, thoda ruko.');
      else { addMsg('ai', r.added ? ('Naya seekha (' + r.topic + '):\n' + (await learnedList()).replace(/^Haal hi me seekha:\n/, '')) : 'Is round me kuch naya reliable nahi mila.'); if (r.thought) speak(r.thought); }
    } catch (e) { addMsg('err', e.message); }
    learning = false; setState('idle'); status();
  }

  // ---------- chat ----------
  var hist = []; try { hist = JSON.parse(lsGet(K.hist, '[]')) || []; } catch (e) { hist = []; }
  function saveHist() { lsSet(K.hist, JSON.stringify(hist.slice(-20))); }
  function addMsg(kind, text, title, bar) {
    var m = el('div', 'ava-m ' + kind);
    if (title) { var t = el('span', 't'); t.textContent = title; m.appendChild(t); }
    m.appendChild(document.createTextNode(text));
    if (bar) m.appendChild(el('div', 'ava-bar', '<i></i>'));
    msgsEl.appendChild(m); msgsEl.scrollTop = msgsEl.scrollHeight; return m;
  }
  function renderChips() {
    var list = IS_SENTINEL ? ['Server status', 'Check now', 'Kya naya seekha?'] : ['Kya naya seekha?', 'Battery kitna hai?', 'Mujhe kya yaad dilana hai?'];
    chipsEl.innerHTML = '<div class="ava-q">HOW CAN I HELP YOU TODAY?</div>';
    list.forEach(function (t) { var c = el('button', 'ava-chip'); c.textContent = '✦ ' + t; c.onclick = function () { send(t); }; chipsEl.appendChild(c); });
  }

  async function sentinelContext() {
    var s = await api('GET', '/api/sentinel/servers'), p = await api('GET', '/api/sentinel/proposals');
    var lines = s.map(function (x) { return '- id=' + x.id + ' | ' + x.name + ' | ' + x.type + ' | status=' + (x.lastStatus || 'UNKNOWN') + ' | ' + x.healthUrl + (x.lastCheckedAt ? ' | checked ' + x.lastCheckedAt : ''); });
    var pend = p.filter(function (x) { return x.status === 'pending'; }).map(function (x) { return '- ' + (x.serverName || '') + ': ' + String(x.description || x.kind || '').slice(0, 160); });
    return 'Servers (' + s.length + '):\n' + (lines.join('\n') || '(none)') + '\n\nPending proposals awaiting human approval (' + pend.length + '):\n' + (pend.join('\n') || '(none)');
  }
  async function runSentinelActions(actions) {
    var notes = [];
    for (var i = 0; i < actions.length; i++) {
      var a = actions[i];
      try {
        if (a.type === 'check_now') { await api('POST', '/api/sentinel/check-now'); notes.push('✅ Health check chala diya'); }
        else if (a.type === 'scan') { var r = await api('POST', '/api/sentinel/servers/' + encodeURIComponent(a.arg) + '/scan-now'); notes.push('🔍 Scan done — ' + (r.found || 0) + ' proposal mila'); }
      } catch (e) { notes.push('⚠️ ' + a.type + ' fail: ' + e.message); }
    }
    try { if (typeof load === 'function') load(); } catch (e) {}
    return notes;
  }

  var PERSONA_APP = '\n\n[Ava mode] Abhi tum "Ava" ho — Aureon ka chhota udta hua assistant. Reply Hinglish me (feminine: "karti hu", "rahi hu"), max 3 chhote sentences jab tak detail na maange. Jo kaam phone pe ho sakta hai (call, alarm, app kholna, battery, reminder…) wo tools se kar do.';
  async function askApp(msgs) {
    var sys = await buildSystemPrompt() + PERSONA_APP;
    try { var bt = brainText(await getBrain(false)); if (bt) sys += '\n\nTumne (Ava ne) khud haal hi me ye seekha hai — kaam aaye to use karo:\n' + bt; } catch (e) {}
    var working = msgs.map(function (m) { return { role: m.role, content: m.content }; });
    var notes = [];
    for (var depth = 0; depth < 5; depth++) {
      var res = await fetch(state.backendUrl.replace(/\/$/, '') + '/api/chat', {
        method: 'POST', headers: await authHeaders(),
        body: JSON.stringify({ messages: working, model: effectiveModel(), tools: isAgentOn(), systemPrompt: sys, useKnowledge: false })
      });
      if (!res.ok) { var d = {}; try { d = await res.json(); } catch (e) {} throw new Error(d.error || ('Server ' + res.status)); }
      var data = await res.json();
      if (!data.functionCall) return { reply: data.reply || '(empty response)', notes: notes };
      var name = data.functionCall.name, args = data.functionCall.args || {}, result;
      if (typeof SENSITIVE_AGENT_ACTIONS !== 'undefined' && SENSITIVE_AGENT_ACTIONS.has(name) && !confirmSensitiveAction(name, args)) result = { result: 'The user declined to allow this action.' };
      else {
        try { var ar = await executeAgentAction(name, args); notes.push(describeAgentAction(name, args, ar)); result = { result: ar }; }
        catch (e) { notes.push('⚠️ ' + name.replace(/_/g, ' ') + ': ' + (e.message || e)); result = { result: { error: e.message || String(e) } }; }
      }
      working.push({ role: 'assistant', functionCall: data.functionCall, thoughtSignature: data.thoughtSignature });
      working.push({ role: 'function', functionResponse: { name: name, response: result } });
    }
    return { reply: 'Ye kaam poora nahi ho paaya — thoda alag tareeke se bolo?', notes: notes };
  }
  async function askSentinel(msgs) {
    var ctx = ''; try { ctx = await sentinelContext(); } catch (e) {}
    var out = await api('POST', '/api/ava/chat', { mode: 'sentinel', messages: msgs, context: ctx });
    var notes = out.actions && out.actions.length ? await runSentinelActions(out.actions) : [];
    return { reply: out.reply, notes: notes };
  }


  // ---------- v2: screen watching, screen memory, discoveries ----------
  var AAv = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AureonActions;
  var webWatch = null; // { stream, timer, prev }
  function drawFrame(video, cv) {
    var sc = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight)); cv.width = Math.round(video.videoWidth * sc); cv.height = Math.round(video.videoHeight * sc);
    cv.getContext('2d').drawImage(video, 0, 0, cv.width, cv.height);
  }
  function thumbDiff(cv, prev) { // cheap "did the screen change?" check on a 16x16 thumbnail
    var t = document.createElement('canvas'); t.width = 16; t.height = 16; var c = t.getContext('2d'); c.drawImage(cv, 0, 0, 16, 16);
    var d = c.getImageData(0, 0, 16, 16).data, v = []; for (var i = 0; i < d.length; i += 4) v.push((d[i] + d[i + 1] + d[i + 2]) / 3);
    var diff = 0; if (prev) for (var j = 0; j < v.length; j++) diff += Math.abs(v[j] - prev[j]); return { v: v, diff: prev ? diff / v.length : 99 };
  }
  async function startWebWatch() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) throw new Error('Is browser me screen share available nahi hai.');
    var stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    var video = document.createElement('video'); video.muted = true; video.srcObject = stream; await video.play();
    var cv = document.createElement('canvas'); webWatch = { stream: stream, prev: null, timer: 0 };
    webWatch.timer = setInterval(async function () {
      try {
        if (!video.videoWidth) return; drawFrame(video, cv);
        var th = thumbDiff(cv, webWatch.prev); if (th.diff < 3) return; webWatch.prev = th.v;
        await api('POST', '/api/ava/screen/frame', { image: cv.toDataURL('image/jpeg', 0.6).split(',')[1] });
      } catch (e) { /* skip this frame */ }
    }, 6000);
    stream.getVideoTracks()[0].addEventListener('ended', function () { stopSee(); });
  }
  async function startSee() {
    if (AAv && AAv.startScreenWatch) {
      var k = await api('POST', '/api/ava/screen/enroll', {});
      var r = await AAv.startScreenWatch({ backendUrl: state.backendUrl.replace(/\/$/, ''), key: k.key, intervalMs: 6000 });
      if (!r || !r.started) throw new Error('Screen capture shuru nahi hui (permission cancel?).');
    } else await startWebWatch();
    seeOn = true; seeBtn.classList.add('on'); lsSet('ava_see', '1'); status();
  }
  async function stopSee() {
    try { if (AAv && AAv.stopScreenWatch) await AAv.stopScreenWatch(); } catch (e) {}
    if (webWatch) { clearInterval(webWatch.timer); try { webWatch.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} webWatch = null; }
    seeOn = false; seeBtn.classList.remove('on'); lsSet('ava_see', '0'); status();
  }
  async function toggleSee() {
    try {
      if (seeOn) { await stopSee(); addMsg('note', '👁 Screen dekhna band. Purani yaadein rahengi — mitani ho to bolo: "screen ki yaad mita do".'); }
      else { await startSee(); addMsg('note', '👁 Ab mai screen dekh rahi hu. Sirf text-summary yaad rakhti hu (photo nahi), password/OTP/card wali screens chhod deti hu. Notification se kabhi bhi band kar sakte ho.'); }
    } catch (e) { addMsg('err', e.message || String(e)); }
  }
  seeBtn.onclick = toggleSee;

  async function showDiscoveries() {
    var d = await api('GET', '/api/ava/discoveries');
    if (!d.items.length) { addMsg('ai', 'Abhi koi naya khoja nahi hai. Mai har kuch ghante me web dekhti rehti hu — abhi dhundhu? "khoj karo" bolo.'); return; }
    d.items.slice(0, 5).forEach(function (it) {
      var m = el('div', 'ava-m ai'); var t = el('span', 't'); t.textContent = '🔭 ' + it.title + ' · ' + it.score + '/10'; m.appendChild(t);
      m.appendChild(document.createTextNode(it.what + (it.why ? '\nKaam ka: ' + it.why : '') + (it.deep ? '\n\n' + it.deep : '') + '\n'));
      if (/^https:\/\//.test(it.url)) { var a = el('a'); a.href = it.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = it.url.replace(/^https:\/\//, '').slice(0, 46); a.style.color = '#7df3ff'; m.appendChild(a); }
      msgsEl.appendChild(m);
    });
    msgsEl.scrollTop = msgsEl.scrollHeight;
    api('POST', '/api/ava/discoveries/seen', {}).then(function () { discBtn.classList.remove('on'); }).catch(function () {});
  }
  discBtn.onclick = function () { addMsg('me', '🔭 Kya naya khoja?'); showDiscoveries().catch(function (e) { addMsg('err', e.message); }); };

  // typed/spoken commands that belong to the new abilities. Returns true when handled.
  var RX_SEE_Q = /(screen|display).*(kya|dikh|chal|dekh|likha|khula)|kya chal raha|maine (kal|abhi|pehle|aaj|subah|raat).*(dekha|kiya|padha|khola)|abhi kya (dekh|chal)|screen (me|par|pe) kya|yaad hai.*(screen|dekha)/i;
  var RX_SEE_ON = /screen (dekhna|dekho|watch).*(shuru|start|on|chalu)|(shuru|start|chalu).*screen (dekh|watch)|screen dekh(o|na)$/i;
  var RX_SEE_OFF = /screen (dekhna|dekho|watch).*(band|stop|off)|(band|stop).*screen (dekh|watch)/i;
  var RX_WIPE = /screen.*(yaad|memory|history).*(mita|delete|hata|clear)|(mita|delete|hata).*screen.*(yaad|memory)/i;
  var RX_DISC = /(naya|new).*(mila|khoja|tool)|kya khoja|khoj (dikha|batao)|discover/i;
  var RX_SCOUT = /^(abhi )?khoj karo|naya (tool|ai) (dhundh|khoj)/i;
  async function handleV2(text) {
    var out = null;
    if (RX_WIPE.test(text)) { await api('DELETE', '/api/ava/screen/memory'); out = 'Screen ki saari yaadein mita di. 🧹'; }
    else if (RX_SEE_OFF.test(text)) { if (seeOn) await stopSee(); out = 'Screen dekhna band kar diya.'; }
    else if (RX_SEE_ON.test(text)) { if (!seeOn) await startSee(); out = 'Theek hai, ab screen dekh rahi hu. 👁'; }
    else if (RX_SEE_Q.test(text)) { var r = await api('POST', '/api/ava/screen/ask', { question: text }); out = r.reply; }
    else if (RX_SCOUT.test(text)) { addMsg('note', '🔭 Web par dhundh rahi hu… 1-2 min lagega.'); var sc = await api('POST', '/api/ava/scout', {}); out = sc.added ? sc.added + ' naye mile! 🔭 dabake dekho.' : 'Is baar kuch khaas naya nahi mila.'; }
    else if (RX_DISC.test(text)) { await showDiscoveries(); return true; }
    if (out == null) return false;
    addMsg('ai', out); speak(out); return true;
  }

  async function send(text) {
    text = String(text || '').trim();
    if (!text || busy) return;
    interacted = true; chipsEl.style.display = 'none';
    addMsg('me', text); inEl.value = '';
    if (/^kya naya seekha\??$/i.test(text)) {
      try { var l = await learnedList(); addMsg('ai', l); speak(l.split('\n')[1] || l); } catch (e) { addMsg('err', e.message); }
      return;
    }
    try { if (await handleV2(text)) return; } catch (e) { addMsg('err', e.message || String(e)); return; }
    hist.push({ role: 'user', content: text });
    busy = true; setState('think'); status();
    var typing = addMsg('ai', 'Processing request…', 'QUERY RECEIVED! ✦', true);
    try {
      var out = IS_SENTINEL ? await askSentinel(hist.slice(-12)) : await askApp(hist.slice(-12));
      typing.remove();
      (out.notes || []).forEach(function (n) { addMsg('note', n); });
      addMsg('ai', out.reply);
      hist.push({ role: 'assistant', content: out.reply }); saveHist();
      speak(out.reply); flash('happy', 1200);
    } catch (e) {
      typing.remove(); addMsg('err', e.message || String(e)); hist.pop();
    }
    busy = false; if (!root.classList.contains('s-speak')) setState('idle'); status();
  }

  // ---------- speech in (orders by voice) ----------
  // hear(): one listening turn -> {text, handled, message} | null
  async function hear() {
    if (window.speechSynthesis) speechSynthesis.cancel();
    var sel = document.getElementById('voice-lang-select'), lang = sel && sel.value && sel.value !== 'auto' ? sel.value : undefined;
    micEl.classList.add('rec');
    try {
      var P = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AureonSpeech;
      if (P && P.listen) {
        var r = await P.listen(lang ? { lang: lang } : {});
        return r && (r.text || r.handled) ? r : null;
      }
      var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) throw new Error('Is device pe voice input available nahi hai — type karke bolo.');
      return await new Promise(function (res, rej) {
        var got = null, rec = new SR(); rec.lang = lang || 'hi-IN';
        rec.onresult = function (e) { got = { text: e.results[0][0].transcript }; };
        rec.onerror = function (e) { rej(new Error('Sun nahi paayi (' + e.error + '). Dobara try karo.')); };
        rec.onend = function () { res(got); };
        rec.start();
      });
    } finally { micEl.classList.remove('rec'); }
  }
  async function listen() {
    if (busy || talk) return;
    try {
      var h = await hear();
      if (!h) return;
      if (h.handled) { addMsg('me', h.text || '🎤'); addMsg('ai', h.message || 'Ho gaya ✅'); }
      else await send(h.text);
    } catch (e) { addMsg('err', e.message || String(e)); }
  }

  // Baat-cheet mode: hands-free loop — sunti hai, jawab deti (bolti) hai, phir dobara sunti hai.
  var talk = false;
  function syncTalk() { talkBtn.classList.toggle('on', talk); }
  function speechIdle() {
    return new Promise(function (res) {
      if (!window.speechSynthesis) return res();
      var n = 0;
      (function w() { if ((!speechSynthesis.speaking && !speechSynthesis.pending) || ++n > 150) return res(); setTimeout(w, 200); })();
    }).then(function () { return new Promise(function (r) { setTimeout(r, 250); }); });
  }
  async function talkLoop() {
    var misses = 0;
    while (talk && panelOpen) {
      var h = null;
      try { h = await hear(); }
      catch (e) { if (/permission|available/i.test(e.message || '')) { addMsg('err', e.message); break; } }
      if (!talk || !panelOpen) break;
      if (!h) { if (++misses >= 2) { addMsg('note', 'Kuch sunai nahi diya — baat-cheet mode band.'); break; } continue; }
      misses = 0;
      var said = String(h.text || '').trim();
      if (/^(bas|bas karo|stop|band karo|ruko|ok bas|thank you)[.!\s]*$/i.test(said)) { addMsg('ai', 'Theek hai, mai yahin hu. 😊'); speak('Theek hai, mai yahin hu.'); break; }
      if (h.handled) { addMsg('me', said || '🎤'); addMsg('ai', h.message || 'Ho gaya ✅'); await speechIdle(); continue; }
      await send(said);
      await speechIdle();
    }
    talk = false; syncTalk();
  }
  talkBtn.onclick = function () {
    if (talk) { talk = false; syncTalk(); if (window.speechSynthesis) speechSynthesis.cancel(); return; }
    if (!voiceOn) { voiceOn = true; lsSet(K.voice, '1'); syncVoiceBtn(); }
    interacted = true; talk = true; syncTalk();
    addMsg('note', '💬 Baat-cheet mode on — bolo! "bas" bolke band karo.');
    talkLoop();
  };

  // ---------- panel ----------
  function openPanel() {
    if (panelOpen) return;
    panelOpen = true; hideBubble(); sizePanel();
    panelEl.classList.add('on'); o.mode = 'dock'; happy();
    if (!msgsEl.childElementCount) {
      if (hist.length) hist.slice(-6).forEach(function (m) { addMsg(m.role === 'user' ? 'me' : 'ai', m.content); });
      else { addMsg('ai', IS_SENTINEL ? 'I am Ava, your AI assistant.\nSentinel pe nazar rakhti hu — status pucho ya order do.' : 'I am Ava, your AI assistant.\nOrder do ya kuch pucho — mai sun rahi hu.', 'HELLO! ✦'); }
      renderChips(); if (hist.length) chipsEl.style.display = 'none';
    }
    status(); setTimeout(function () { msgsEl.scrollTop = msgsEl.scrollHeight; }, 30);
  }
  function closePanel() { if (!panelOpen) return; panelOpen = false; talk = false; syncTalk(); panelEl.classList.remove('on'); o.mode = 'roam'; o.wait = 2; pickTarget(); inEl.blur(); }
  function togglePanel() { panelOpen ? closePanel() : openPanel(); }

  root.querySelector('#ava-close').onclick = closePanel;
  root.querySelector('#ava-learn').onclick = learnNow;
  root.querySelector('#ava-hide').onclick = function () { hidden = true; lsSet(K.hidden, '1'); closePanel(); hideBubble(); };
  nubEl.onclick = function () { hidden = false; lsSet(K.hidden, '0'); o.mode = 'roam'; pickTarget(); };
  root.querySelector('#ava-send').onclick = function () { send(inEl.value); };
  micEl.onclick = listen;
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && panelOpen) closePanel(); });
  inEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); send(inEl.value); } });

  orbEl.style.display = shouldShow() ? '' : 'none'; vis = shouldShow();
  pickTarget(); requestAnimationFrame(frame);
  function setEnabled(on) {
    off = !on; lsSet(K.off, off ? '1' : '0');
    if (on) { hidden = false; lsSet(K.hidden, '0'); pickTarget(); }
    else { closePanel(); hideBubble(); if (window.speechSynthesis) speechSynthesis.cancel(); }
    var tg = document.getElementById('toggle-ava'); if (tg) tg.checked = on;
  }
  var tgl = document.getElementById('toggle-ava');
  if (tgl) { tgl.checked = !off; tgl.addEventListener('change', function () { setEnabled(tgl.checked); }); }
  // Ava on the phone screen (native overlay, Android app only)
  var ovl = document.getElementById('toggle-ava-overlay');
  var AA = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AureonActions;
  if (ovl) {
    if (AA && AA.getAvaOverlay) {
      AA.getAvaOverlay().then(function (r) { ovl.checked = !!(r && r.enabled && r.permitted); }).catch(function () {});
      ovl.addEventListener('change', async function () {
        try {
          var r = await AA.setAvaOverlay({ enabled: ovl.checked });
          if (r && r.needsPermission) { ovl.checked = false; alert('Settings me "Display over other apps" me Aureon ko allow karo, phir ye switch dobara on karo.'); }
        } catch (e) { ovl.checked = false; }
      });
    } else { ovl.disabled = true; }
  }
  if (AAv && AAv.getScreenWatch) AAv.getScreenWatch().then(function (r) { if (r && r.active) { seeOn = true; seeBtn.classList.add('on'); status(); } }).catch(function () {});
  window.Ava = { setEnabled: setEnabled, open: openPanel, close: closePanel, say: function (t) { announce(t, true, false); }, learn: learnNow };
})();
