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
.ava-head{display:flex;align-items:center;gap:4px;padding:7px 8px 4px}\
.ava-head b{font-size:12.5px;letter-spacing:.5px;color:#aef9ff;text-shadow:0 0 8px #22d3ee}\
.ava-head small{display:block;font-size:9.5px;color:#8fb7d6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:112px}\
.ava-head .sp{flex:1}\
#ava-root .ava-ib{width:22px;height:22px;border-radius:50%;border:1px solid rgba(34,211,238,.5);background:rgba(34,211,238,.08);color:#e9fbff;font-size:10.5px;line-height:1;cursor:pointer;padding:0;box-shadow:none;flex:none}\
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
#ava-root .ava-ib.on{background:rgba(255,60,172,.3);border-color:#ff3cac;box-shadow:0 0 8px #ff3cac;opacity:1}\
.ava-tilt{transition:transform .12s linear,filter .35s}\
.mood-angry .ava-tilt{filter:url(#avaF-angry)}.mood-sad .ava-tilt{filter:url(#avaF-sad)}.mood-shy .ava-tilt{filter:url(#avaF-shy)}\
.mood-angry .ava-sphere{animation:avaShake .12s linear infinite}\
@keyframes avaShake{0%,100%{transform:translateX(-1.3px)}50%{transform:translateX(1.3px)}}\
.mood-angry .ava-eye,.mood-sad .ava-eye{overflow:hidden}\
.mood-angry .ava-eye:before,.mood-sad .ava-eye:before{content:"";position:absolute;left:-35%;right:-35%;top:-4%;height:50%;background:#0a1d52;z-index:2}\
.mood-angry .ava-eye.l:before{transform:rotate(26deg)}.mood-angry .ava-eye.r:before{transform:rotate(-26deg)}\
.mood-sad .ava-eye.l:before{transform:rotate(-22deg)}.mood-sad .ava-eye.r:before{transform:rotate(22deg)}\
.mood-angry .ava-mouth,.mood-sad .ava-mouth{border-bottom:0;border-top:2.5px solid #aef9ff;border-radius:50% 50% 0 0;bottom:14%;left:40%;right:40%}\
.mood-sad .ava-mouth{animation:avaWob .7s ease-in-out infinite alternate}\
@keyframes avaWob{from{transform:translate(var(--lx),var(--ly,0px)) scaleX(.85)}to{transform:translate(var(--lx),var(--ly,0px)) scaleX(1.1)}}\
.mood-shy .ava-eye{width:19%;height:24%;top:33%;border-radius:100% 100% 0 0 / 140% 140% 0 0;background:transparent;border-top:3px solid #aef9ff;box-shadow:0 -2px 8px #22d3ee;animation:none}\
.mood-shy .ava-eye:after{display:none}.mood-shy .ava-mouth{left:44%;right:44%;height:10%}\
.ava-blush{position:absolute;top:54%;width:20%;height:24%;border-radius:50%;background:radial-gradient(circle,rgba(255,92,150,.9),rgba(255,92,150,0) 70%);opacity:0;transition:opacity .3s}\
.ava-blush.l{left:3%}.ava-blush.r{right:3%}.mood-shy .ava-blush{opacity:1}\
.ava-tear{position:absolute;top:60%;width:7%;height:12%;border-radius:50% 50% 60% 60%/60% 60% 40% 40%;background:#bfe9ff;box-shadow:0 0 5px #7dd3fc;opacity:0}\
.ava-tear.l{left:30%}.ava-tear.r{right:30%}\
.mood-sad .ava-tear{animation:avaTear 1.3s ease-in infinite}.mood-sad .ava-tear.r{animation-delay:.55s}\
@keyframes avaTear{0%{opacity:0;transform:translateY(0)}15%{opacity:1}100%{opacity:0;transform:translateY(20px)}}\
.ava-ico{position:absolute;right:-8px;top:-10px;font-size:19px;line-height:1;opacity:0;pointer-events:none;transition:opacity .2s}\
.mood-angry .ava-ico,.mood-sad .ava-ico,.mood-shy .ava-ico{opacity:1;animation:avaIco .9s ease-in-out infinite alternate}\
@keyframes avaIco{from{transform:scale(.9) rotate(-8deg)}to{transform:scale(1.18) rotate(8deg)}}\
html.ava-panel,html.ava-panel body{background:transparent!important;background-image:none!important}\
html.ava-panel::before,html.ava-panel::after,html.ava-panel body::before,html.ava-panel body::after{display:none!important;content:none!important}\
html.ava-panel body>*:not(#ava-root){display:none!important}';
  var style = el('style'); style.id = 'ava-style'; style.textContent = css; document.head.appendChild(style);

  // ---------- DOM ----------
  var root = el('div'); root.id = 'ava-root'; root.className = 's-idle';
  root.innerHTML =
    '<div id="ava-orb" role="button" aria-label="Ava assistant"><div class="ava-shadow"></div><div class="ava-tilt"><div class="ava-hop"><div class="ava-bob">' +
      '<div class="ava-glow"></div><div class="ava-halo"></div><div class="ava-ant"></div>' +
      '<div class="ava-sphere"><div class="ava-gloss"></div><div class="ava-ear l"></div><div class="ava-ear r"></div>' +
      '<div class="ava-visor"><span class="ava-eye l"></span><span class="ava-eye r"></span><span class="ava-mouth"></span><i class="ava-blush l"></i><i class="ava-blush r"></i><i class="ava-tear l"></i><i class="ava-tear r"></i></div></div><div class="ava-ring"></div><i class="ava-sp s1">✦</i><i class="ava-sp s2">✦</i><i class="ava-sp s3">✦</i><div class="ava-dots"><i></i><i></i><i></i></div><div class="ava-wave"></div>' +
    '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><filter id="avaF-angry"><feColorMatrix type="matrix" values="0 0.9 0.45 0 0  0.25 0 0 0 0  0.12 0 0 0 0  0 0 0 1 0"/></filter><filter id="avaF-sad"><feColorMatrix type="matrix" values="0.45 0.3 0.1 0 0  0.2 0.55 0.15 0 0  0.25 0.35 0.5 0 0  0 0 0 1 0"/></filter><filter id="avaF-shy"><feColorMatrix type="matrix" values="0.35 0.8 0.2 0 0  0.25 0.3 0.2 0 0  0.5 0.45 0.6 0 0  0 0 0 1 0"/></filter></svg>' +
    '</div></div></div><div class="ava-ico"></div></div>' +
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
  var icoEl = root.querySelector('.ava-ico');
  var voiceBtn = root.querySelector('#ava-voice'), talkBtn = root.querySelector('#ava-talk'), seeBtn = root.querySelector('#ava-see'), discBtn = root.querySelector('#ava-disc');

  // ---------- state ----------
  var mood = 'none', moodTimer = 0, lastMoodSay = 0;
  var seeOn = false, vis = true, panelOpen = false, interacted = false, lastSpoke = 0, bubbleTimer = 0, busy = false, learning = false;
  var W = innerWidth, H = innerHeight;
  var o = { x: W - SIZE - 14, y: H * 0.45, vx: 0, vy: 0, tx: W * 0.5, ty: H * 0.3, mode: 'roam', wait: 1.5, nextThought: Date.now() + 9000 };
  // ---------- phone-overlay panel mode ----------
  // When Ava's floating orb (over other apps) is tapped, Android opens a transparent
  // activity (AvaPanelActivity) that hosts this same page. In that mode we hide the
  // whole Aureon UI and show ONLY Ava's chat, so Aureon itself never "opens".
  var PANEL = false;
  var AAp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AureonActions;
  function closePanelMode() { try { AAp && AAp.closeAvaPanel && AAp.closeAvaPanel(); } catch (e) {} }
  function enterPanelMode() {
    if (PANEL) return;
    PANEL = true; hidden = false; off = false; vis = true; interacted = true;
    document.documentElement.classList.add('ava-panel');
    orbEl.style.display = ''; nubEl.style.display = 'none';
    W = innerWidth; H = innerHeight; o.x = W - SIZE - 14; o.y = H * 0.3;
    openPanel();
    window.addEventListener('pointerdown', function (e) { if (!root.contains(e.target)) closePanelMode(); }, true);
    // tell Android the Ava-only screen is ready (until now the window stays invisible, so Aureon never flashes)
    setTimeout(function () { try { AAp && AAp.avaPanelReady && AAp.avaPanelReady(); } catch (e) {} }, 250);
    try { var A0 = aaT(); if (A0) A0.getTeach().then(function (s0) { teach.recording = !!s0.recording; status(); }).catch(function () {}); } catch (e) {}
  }
  if (!IS_SENTINEL) {
    var panelTries = 0;
    (function detectPanel() {
      if (PANEL) return;
      AAp = AAp || (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AureonActions);
      if (window.__AVA_PANEL) { enterPanelMode(); return; }
      if (AAp && AAp.avaPanelMode) {
        try { AAp.avaPanelMode().then(function (r) { if (r && r.panel) enterPanelMode(); }).catch(function () {}); } catch (e) {}
      }
      if (++panelTries < 16) setTimeout(detectPanel, 400);
    })();
  }

  // ---------- moods: angry / sad (crying) / shy ----------
  // Triggered by what Ava sees on the screen (backend vision says angry|sad|shy) and by a few
  // chat words. Pure expression + a short remark - she never describes sensitive screens.
  var MOOD_ICO = { angry: '💢', sad: '💧', shy: '🙈' };
  var MOOD_SAY = {
    angry: ['Ye galat hai! 😠 Mujhe gussa aa raha hai.', 'Hmph! Aisa kuch dekhna theek nahi lag raha.', 'Ye sab bilkul sahi nahi hai 😤'],
    sad: ['Aww… mujhe rona aa raha hai 😢', 'Ye dekh ke dil bhar aaya… 💧', 'Bahut dukh hua ye dekh ke 😭'],
    shy: ['Hayyy… 🙈 mai nahi dekh rahi!', 'Ee… sharam aa rahi hai, aankhein band! 🙈', 'Uff! Mai udhar nahi dekhungi 😳']
  };
  function setMood(m, ms, line, speakIt) {
    clearTimeout(moodTimer);
    root.classList.remove('mood-angry', 'mood-sad', 'mood-shy');
    mood = MOOD_ICO[m] ? m : 'none';
    if (mood !== 'none') root.classList.add('mood-' + mood);
    icoEl.textContent = MOOD_ICO[mood] || '';
    if (mood === 'none') return;
    moodTimer = setTimeout(function () { setMood('none'); }, ms || 12000);
    var now = Date.now();
    if (line && now - lastMoodSay > 25000) {
      lastMoodSay = now;
      if (line === true) { var arr = MOOD_SAY[mood]; line = arr[Math.floor(Math.random() * arr.length)]; }
      showBubble(line, 7000);
      if (speakIt && voiceOn && !document.hidden) speak(line.replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu, ''));
    }
  }
  function onScreenMood(m) { if (MOOD_ICO[m]) setMood(m, 14000, true, true); }
  function reactMood(t) {
    t = String(t || '');
    if (/\b(gussa|angry)\b.*\b(dikhao|karo|show|ho ja)|\bgusse (me|mein) aao\b/i.test(t)) { setMood('angry', 9000, 'Hmph! 😠 Dekho, ab mai gusse me hu.'); return; }
    if (/\b(ro|roo|rona|cry|sad)\b.*\b(dikhao|karo|show|ke dikhao)/i.test(t)) { setMood('sad', 9000, 'Huhuhu… 😢 mujhe rona aa gaya.'); return; }
    if (/\b(sharma\w*|shy|blush)\b/i.test(t)) { setMood('shy', 9000, 'Hayyy… 🙈 sharam aa rahi hai.'); return; }
    if (/\b(gadh[aei]|bekar|bewakoof|pagal|nikamm?[ae]|stupid|idiot|useless|shut ?up|chup kar)\b/i.test(t)) setMood('angry', 7000, 'Hmph! 😠 Aise mat bolo, mujhe bura lagta hai.');
    else if (/\b(cute|pyaari|pyari|sundar|beautiful|love you|i love you|pretty)\b/i.test(t)) setMood('shy', 7000, 'Hayy 🙈 itni taareef mat karo…');
    else if (/\b(bye|alvida|goodbye|chhod ke ja)\b/i.test(t)) setMood('sad', 7000, 'Aww… jaa rahe ho? 😢 Jaldi aana.');
  }
  window.AvaBot = window.AvaBot || {}; window.AvaBot.mood = onScreenMood;
  setInterval(function () { // native screen-watch (other apps): ask the server what Ava last "felt"
    if (IS_SENTINEL || !seeOn || document.hidden || !(window.state && state.user)) return;
    api('GET', '/api/ava/screen/mood').then(function (r) { if (r && r.mood && r.mood !== 'none') onScreenMood(r.mood); }).catch(function () {});
  }, 7000);
  function setState(s) { root.className = 's-' + s + (root.classList.contains('happy') ? ' happy' : '') + (mood !== 'none' ? ' mood-' + mood : ''); }
  function flash(cls, ms) { root.classList.add(cls); setTimeout(function () { root.classList.remove(cls); }, ms); }
  function happy() { flash('hop', 650); flash('happy', 1500); try { navigator.vibrate && navigator.vibrate(12); } catch (e) {} }
  var dart = { x: 0, y: 0 };
  setInterval(function () { if (o.mode === 'roam' && Math.hypot(o.vx, o.vy) < 30) { dart.x = rnd(-2, 2); dart.y = rnd(-1.5, 1.5); } else { dart.x = dart.y = 0; } }, 2200);
  function status() { subEl.textContent = busy ? 'soch rahi hu…' : teach.recording ? '🎓 seekh rahi hu…' : learning ? 'naya seekh rahi hu…' : seeOn ? '👁 screen dekh rahi hu' : 'online'; }

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
    if (PANEL) return true;
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
    if (IS_SENTINEL) { base = ''; headers = { 'Content-Type': 'application/json', 'x-csrf': '1', 'x-owner-code': (typeof OWNER_CODE !== 'undefined' ? OWNER_CODE : '') }; }
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
    if (b.sentinel && b.sentinel.total) out += (out ? '\n\n' : '') + 'Owner ke servers abhi (Sentinel): health ' + b.sentinel.score + '/100, ' + (b.sentinel.down.length ? 'DOWN: ' + b.sentinel.down.join(', ') : 'sab up') + ', ' + b.sentinel.pending + ' fix approval ke liye pending.';
    if (b.mind) out += (out ? '\n\n' : '') + 'Tumhara inner state (sirf variables, feelings nahi): confidence ' + b.mind.confidence + ', uncertainty ' + b.mind.uncertainty + ', curiosity ' + b.mind.curiosity + '. Tum conscious hone ka dawa nahi karti — koi poochhe to imaandari se batao ki ye abhi koi prove nahi kar sakta, aur batao tumhare paas kya hai (yaad, self-model, reflection).';
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
      if (b.sentinel && b.sentinel.total) {
        var sg = b.sentinel.down.join(','), prevSg = lsGet('ava_sent_sig', '');
        if (sg !== prevSg) {
          lsSet('ava_sent_sig', sg);
          if (sg && !panelOpen) announce('⚠️ Boss, ' + b.sentinel.down.join(', ') + ' down hai! Sentinel dekho.', true, false);
          else if (!sg && prevSg && !panelOpen) announce('✅ Sab servers wapas theek ho gaye.', true, false);
        }
      }
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
  function friendlyErr(m) {
    m = String(m || '');
    var quota = /RESOURCE_EXHAUSTED|rate.?limit|quota|\b429\b/i.test(m), badKey = /api key not valid|invalid api key|key\d?: API key/i.test(m);
    if (quota && badKey) return '⏳ Gemini ki limit khatam hai aur ek API key invalid hai (Render me GEMINI keys check karo). Thodi der baad try karo.';
    if (quota) return '⏳ AI ki limit abhi khatam hai (Gemini quota). Thodi der baad try karo.';
    if (badKey) return '🔑 AI ki API key me dikkat hai — Render me GEMINI keys check karo.';
    return m.length > 220 ? m.slice(0, 217) + '…' : m;
  }
  function addMsg(kind, text, title, bar) {
    if (kind === 'err') { try { console.warn('[ava]', text); } catch (e) {} text = friendlyErr(text); }
    var m = el('div', 'ava-m ' + kind);
    if (title) { var t = el('span', 't'); t.textContent = title; m.appendChild(t); }
    m.appendChild(document.createTextNode(text));
    if (bar) m.appendChild(el('div', 'ava-bar', '<i></i>'));
    msgsEl.appendChild(m); msgsEl.scrollTop = msgsEl.scrollHeight; return m;
  }
  function renderChips() {
    var list = IS_SENTINEL ? ['Lab me kya chal raha hai?', 'Mujhe ek app chahiye', 'Server status', 'Check now'] : ['Kya naya seekha?', 'Battery kitna hai?', 'Mujhe kya yaad dilana hai?'];
    chipsEl.innerHTML = '<div class="ava-q">HOW CAN I HELP YOU TODAY?</div>';
    list.forEach(function (t) { var c = el('button', 'ava-chip'); c.textContent = '✦ ' + t; c.onclick = function () { send(t); }; chipsEl.appendChild(c); });
  }

  async function soft(path) { try { return await api('GET', path); } catch (e) { return null; } }
  function cut(t, n) { t = String(t == null ? '' : t); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
  // Ava Lab ka live data (read-only GET) — taaki Ava ko pata ho lab me kya chal raha hai
  async function labContext() {
    var r = await Promise.all([soft('/api/sentinel/ava/state'), soft('/api/sentinel/ava/jail/list'), soft('/api/sentinel/ava-studio/list'), soft('/api/sentinel/ava-studio/status'), soft('/api/apk/jobs')]);
    var st = r[0], jail = Array.isArray(r[1]) ? r[1] : [], list = Array.isArray(r[2]) ? r[2] : [], sd = r[3], apk = Array.isArray(r[4]) ? r[4] : [];
    if (!st && !list.length && !sd) return '';
    var nav = document.querySelector('#nav button.on'), out = { screen: nav ? nav.getAttribute('data-v') : undefined };
    if (st) out.ava = { version: st.version, latest: st.latest, busy: !!st.busy, pendingJail: st.jailPending || 0, llm: st.llm, autoUpgrade: st.settings };
    if (st && st.proposals) out.proposals = st.proposals.slice(0, 8).map(function (p) { return { id: p.id, title: cut(p.title || p.goal, 90), status: p.status, risk: p.risk, file: p.file }; });
    if (st && st.history) out.history = st.history.slice(0, 5).map(function (h) { return { v: h.version, title: cut(h.title, 80), status: h.status }; });
    if (sd) out.job = { running: !!sd.running, kind: sd.kind, step: cut(sd.step, 140), done: sd.done, total: sd.total, lines: sd.lines, target: sd.target, error: cut(sd.error, 140), log: (sd.log || []).slice(-5).map(function (l) { return cut(l && l.m, 120); }) };
    out.projects = list.slice(0, 12).map(function (j) { return { id: j.id, title: cut(j.title, 60), kind: j.kind, status: j.status, tagline: cut(j.tagline || j.description, 110), features: (j.features || []).slice(0, 8).map(function (f) { return cut(f, 70); }), stats: j.stats, finalCheck: j.verify, notes: (j.notes || []).slice(-3).map(function (n) { return cut(n, 120); }), files: (j.files || []).slice(-8).map(function (f) { return f && f.path; }) }; })
      .concat(apk.filter(function (x) { return x.kind === 'generated'; }).slice(0, 4).map(function (x) { return { title: cut(x.name || 'App', 60), kind: 'apk', status: x.status }; }));
    out.prototypes = jail.slice(0, 10).map(function (j) { return { title: cut(j.title, 60), category: j.category, status: j.status, risk: j.risk }; });
    return cut(JSON.stringify(out), 4200);
  }
  async function sentinelContext() {
    var s = (await soft('/api/sentinel/servers')) || [], p = (await soft('/api/sentinel/proposals')) || [];
    var lines = s.map(function (x) { return '- id=' + x.id + ' | ' + x.name + ' | ' + x.type + ' | status=' + (x.lastStatus || 'UNKNOWN') + ' | ' + x.healthUrl + (x.lastCheckedAt ? ' | checked ' + x.lastCheckedAt : ''); });
    var pend = p.filter(function (x) { return x.status === 'pending'; }).map(function (x) { return '- ' + (x.serverName || '') + ': ' + String(x.description || x.kind || '').slice(0, 160); });
    var out = 'Servers (' + s.length + '):\n' + (lines.join('\n') || '(none)') + '\n\nPending proposals awaiting human approval (' + pend.length + '):\n' + (pend.join('\n') || '(none)');
    var lab = ''; try { lab = await labContext(); } catch (e) {}
    return cut(out, 3800) + (lab ? '\n\nAVA LAB LIVE DATA (json, read-only, taken now):\n' + lab : '');
  }
  // [[BRIEF type=project|apk|ui|upgrade]]...[[/BRIEF]] -> tappable card. Ava kabhi khud start nahi karti: Pavan form dekh ke Banao dabata hai.
  var RX_BRIEF = /\[\[BRIEF\s+type=(project|apk|ui|upgrade)\]\]([\s\S]*?)\[\[\/BRIEF\]\]/gi;
  function splitBriefs(text) { var briefs = []; var clean = String(text || '').replace(RX_BRIEF, function (a, t, b) { b = String(b).trim(); if (b) briefs.push({ type: t.toLowerCase(), text: b }); return ''; }).trim(); return { clean: clean || (briefs.length ? 'Ye brief taiyar hai 👇' : ''), briefs: briefs }; }
  function applyBrief(type, text) {
    function go(v) { var b = document.querySelector('#nav button[data-v="' + v + '"]'); if (b) b.click(); }
    var f = type === 'upgrade' ? document.getElementById('task') : document.getElementById('pjBrief');
    if (f) {
      go(type === 'upgrade' ? 'home' : 'proj'); f.value = text; var sel = document.getElementById('pjType'); if (type !== 'upgrade' && sel) sel.value = type;
      try { f.focus(); } catch (e) {} addMsg('note', type === 'upgrade' ? '✅ Upgrade box me bhar diya — Upgrade tum dabao.' : '✅ Project form me bhar diya — dekh ke "Ava ko banane do" tum dabao.'); return;
    }
    try { navigator.clipboard.writeText(text); addMsg('note', '📋 Form nahi mila (Ava Lab kholo) — brief copy kar diya.'); } catch (e) { addMsg('note', 'Form nahi mila — brief upar se copy kar lo.'); }
  }
  function addBriefCard(b) {
    var m = el('div', 'ava-m note'); m.appendChild(document.createTextNode(cut(b.text, 260)));
    var row = el('div'); row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px';
    var go = el('button', 'ava-chip'); go.style.minHeight = '44px'; go.textContent = b.type === 'upgrade' ? '⚡ Upgrade box me bharo' : '📝 Form me bharo (' + b.type + ')'; go.onclick = function () { applyBrief(b.type, b.text); };
    var cp = el('button', 'ava-chip'); cp.style.minHeight = '44px'; cp.textContent = '📋 Copy'; cp.onclick = function () { try { navigator.clipboard.writeText(b.text); } catch (e) {} };
    row.appendChild(go); row.appendChild(cp); m.appendChild(row); msgsEl.appendChild(m); msgsEl.scrollTop = msgsEl.scrollHeight; return m;
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
        var fr = await api('POST', '/api/ava/screen/frame', { image: cv.toDataURL('image/jpeg', 0.6).split(',')[1] });
        if (fr && fr.mood) onScreenMood(fr.mood);
      } catch (e) { /* skip this frame */ }
    }, 6000);
    stream.getVideoTracks()[0].addEventListener('ended', function () { stopSee(); });
  }
  async function startSee() {
    if (AAv && AAv.startScreenWatch) {
      var k = await api('POST', '/api/ava/screen/enroll', {});
      var r = await AAv.startScreenWatch({ backendUrl: state.backendUrl.replace(/\/$/, ''), key: k.key, intervalMs: 6000 });
      if (!r || !r.started) throw new Error('Screen capture shuru nahi hui' + (r && r.resultCode !== undefined ? ' (code ' + r.resultCode + (r.resultCode === 0 ? ' = Android popup cancel hua/aaya hi nahi' : '') + ')' : '') + '. Popup me "Start now" dabana hai; "Ava phone screen par" pehle off karke try karo.');
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
  var RX_SRV = /(mere|apne|meri|my) (\w+ )?servers?\b|sentinel.*(status|kaisa|kaise|haal)|\bsab servers\b/i;
  var RX_MIND_WIPE = /(mind|dimag|apni|inner).{0,20}(yaad|memory|yaadein).{0,15}(mita|delete|clear|reset)/i;
  var RX_MIND_EXP = /(experiment (chalao|karo|run)|(consciousness|chetna|self.?awareness|metacog\w*) ?(test|experiment|jaanch))/i;
  var RX_MIND_REFLECT = /(introspect|self.?reflect|reflect karo|soch ke bata|khud ko (jaanch|parakh)|apni soch (batao|dikhao))/i;
  var RX_MIND_PLAN = /^\s*(plan|yojana)\s+(bana|banao|banado|ready karo)\s*[:\-]?\s*/i;
  var RX_MIND_RECALL = /^\s*(yaad|recall)\s+(karo|kar)\s*[:\-]?\s*/i;
  var RX_MIND_FB = /^\s*(👍|👎)|(jawab|answer|reply).{0,12}(achha|accha|badhiya|sahi|galat|bekar|kharab)\s+(tha|thi)/i;
  var RX_MIND_SELF = /(tum|tu|aap|ava).{0,30}(conscious|chetan|zinda|alive|jeevit|mehsoos|astitva|existence|feel kar)|\bconscious(ness)?\b|chetna|apne baare (me|mein)|khud ke baare|kaun ho tum|kya ho tum|self.?model|inner state|tumhara (mann|dimag)/i;
  var RX_DISC = /(naya|new).*(mila|khoja|tool)|kya khoja|khoj (dikha|batao)|discover/i;
  var RX_SCOUT = /^(abhi )?khoj karo|naya (tool|ai) (dhundh|khoj)/i;
  async function handleV2(text) {
    var out = null;
    if (RX_WIPE.test(text)) { await api('DELETE', '/api/ava/screen/memory'); out = 'Screen ki saari yaadein mita di. 🧹'; }
    else if (RX_SEE_OFF.test(text)) { if (seeOn) await stopSee(); out = 'Screen dekhna band kar diya.'; }
    else if (RX_SEE_ON.test(text)) { if (!seeOn) await startSee(); out = 'Theek hai, ab screen dekh rahi hu. 👁'; }
    else if (RX_SEE_Q.test(text)) { var r = await api('POST', '/api/ava/screen/ask', { question: text }); out = r.reply; }
    else if (MOODTEST.test(text)) { var mm = /angry|gussa/i.test(text) ? 'angry' : /sad|rona/i.test(text) ? 'sad' : 'shy'; onScreenMood(mm); out = mm === 'angry' ? 'Hmph! 😠 (test: angry mood 14 sec)' : mm === 'sad' ? 'Aww… 😢 (test: sad mood 14 sec)' : 'Hayy 🙈 (test: shy mood 14 sec)'; }
    else if (RX_MIND_WIPE.test(text)) { await api('DELETE', '/api/ava/mind/memory'); out = 'Meri apni yaadein aur inner state reset kar diye. 🧹'; }
    else if (RX_MIND_EXP.test(text)) { var ex = await api('POST', '/api/ava/mind/experiment', {}); out = ex.say; }
    else if (RX_MIND_REFLECT.test(text)) { addMsg('note', '🧠 Soch rahi hu…'); var rf = await api('POST', '/api/ava/mind/reflect', {}); out = rf.say || 'Abhi kuch naya nahi.'; }
    else if (RX_MIND_PLAN.test(text) && text.replace(RX_MIND_PLAN, '').trim()) { var pl = await api('POST', '/api/ava/mind/plan', { goal: text.replace(RX_MIND_PLAN, '') }); out = pl.say; }
    else if (RX_MIND_RECALL.test(text) && text.replace(RX_MIND_RECALL, '').trim()) { var rc = await api('POST', '/api/ava/mind/recall', { query: text.replace(RX_MIND_RECALL, '') }); out = rc.say; }
    else if (RX_MIND_FB.test(text)) { var la = ''; for (var hi = hist.length - 1; hi >= 0; hi--) { if (hist[hi].role === 'assistant') { la = String(hist[hi].content).slice(0, 80); break; } } var good = /👍|achha|accha|badhiya|sahi/i.test(text); var fb = await api('POST', '/api/ava/mind/feedback', { item: la || 'last reply', rating: good ? 5 : 1, note: text.slice(0, 120) }); out = fb.say; }
    else if (RX_MIND_SELF.test(text)) { var sf = await api('GET', '/api/ava/mind/self'); out = sf.say; }
    else if (RX_SRV.test(text)) { var bb = await api('GET', '/api/ava/brain'); var ss = bb.sentinel; out = !ss || !ss.total ? 'Servers ki jaankari sirf owner ko milti hai (ya abhi koi server add nahi hai).' : 'Health ' + ss.score + '/100 · ' + ss.total + ' servers · ' + (ss.down.length ? '🔴 DOWN: ' + ss.down.join(', ') : '🟢 sab up') + ' · ' + ss.pending + ' fix approval ke liye' + (ss.avgUptime24 != null ? ' · uptime 24h ' + ss.avgUptime24 + '%' : '') + '.'; }
    else if (RX_SCOUT.test(text)) { addMsg('note', '🔭 Web par dhundh rahi hu… 1-2 min lagega.'); var sc = await api('POST', '/api/ava/scout', {}); out = sc.added ? sc.added + ' naye mile! 🔭 dabake dekho.' : 'Is baar kuch khaas naya nahi mila.'; }
    else if (RX_DISC.test(text)) { await showDiscoveries(); return true; }
    if (out == null) return false;
    addMsg('ai', out); speak(out); return true;
  }


  // ---------- teach Ava: watch what I do, remember it, repeat on command ----------
  // "seekho wifi band karna" -> I do the steps in other apps -> "bas" -> later: "wifi band karo"
  // (steps are recorded + replayed by the Aureon accessibility service; everything stays on the phone)
  var teach = { recording: false, name: '', pending: null, askName: false };
  var T_VERBS = /\b(karo|kar do|kardo|kar de|chalao|chala do|run|shuru karo|start karo)\b/g;
  var T_FILL = /\b(ava|ye|wo|woh|ab|please|plz|na|zara|mera|meri|mere|ko|ka|ki|ke|wala|wali)\b/g;
  function aaT() { AAp = AAp || (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AureonActions); return AAp && AAp.getTeach ? AAp : null; }
  function sayT(msg) { addMsg('ai', msg); try { speak(msg.replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu, '')); } catch (e) {} }
  function tnorm(x) { return String(x || '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim(); }
  function findMacro(list, q) {
    var qt = tnorm(q).replace(T_VERBS, ' ').replace(T_FILL, ' ').split(' ').filter(Boolean), best = null, bs = 0;
    if (!qt.length) return null;
    (list || []).forEach(function (m) {
      var nt = tnorm(m.name).replace(T_FILL, ' ').split(' ').filter(Boolean);
      if (!nt.length) return;
      var common = nt.filter(function (w) { return qt.indexOf(w) >= 0; }).length, sc = common / Math.max(nt.length, qt.length);
      if (common && sc > bs) { bs = sc; best = m; }
    });
    return bs >= 0.5 ? best : null;
  }
  async function startTeach(name) {
    var A = aaT(), r;
    try { r = await A.teachStart({ name: name }); } catch (e) { sayT('Seekh nahi paayi: ' + (e.message || e)); return true; }
    if (!r || !r.ok) {
      if (r && r.error === 'accessibility_off') {
        sayT('Seekhne ke liye Aureon ki Accessibility service on honi chahiye. Settings khol rahi hu: Accessibility → Installed/Downloaded apps → Aureon → ON. On karke mujhe dobara bolo.');
        try { await A.openAccessibilitySettings(); } catch (e) {}
      } else sayT('Seekh nahi paayi: ' + ((r && r.error) || 'pata nahi kyu'));
      return true;
    }
    teach.recording = true; teach.name = r.name || name; status();
    sayT('🎓 Theek hai, "' + teach.name + '" seekh rahi hu. Ab jo karna hai wo karo. Pura ho jaye to mujh par tap karke "bas" bolo. (Password aur banking apps record nahi karti.)');
    if (PANEL) setTimeout(closePanelMode, 2200);
    return true;
  }
  async function stopTeach(save) {
    var A = aaT(), r = {};
    try { r = await A.teachStop({ save: save }); } catch (e) {}
    teach.recording = false; status();
    if (!save) { sayT('Theek hai, rehne diya.'); return true; }
    if (r && r.ok) sayT('✅ Yaad kar liya: "' + r.name + '" — ' + r.steps + ' steps' + (r.apps && r.apps.length ? ' (' + r.apps.join(' → ') + ')' : '') + '. Ab bolo: "' + r.name + ' karo".' + (r.skippedSensitive ? ' (Banking/payment wale steps record nahi kiye.)' : ''));
    else sayT('Kuch record nahi hua — koi tap ya step dikha hi nahi. Dobara try karo?' + (r && r.skippedSensitive ? ' (Banking/payment app me record nahi karti.)' : ''));
    return true;
  }
  function pollMacro() {
    var n = 0, A = aaT();
    var iv = setInterval(async function () {
      n++; var st2;
      try { st2 = await A.getTeach(); } catch (e) { clearInterval(iv); return; }
      if (!st2.playing) { clearInterval(iv); sayT((st2.lastOk ? '✅ ' : '⚠️ ') + st2.lastMsg); } else if (n > 90) clearInterval(iv);
    }, 1500);
  }
  async function runMacro(name) {
    var A = aaT(), r;
    try { r = await A.macroPlay({ name: name }); } catch (e) { sayT('Chala nahi paayi: ' + (e.message || e)); return true; }
    if (!r || !r.ok) {
      if (r && r.error === 'accessibility_off') { sayT('Accessibility service band hai — Settings → Accessibility → Aureon → ON karo.'); try { await A.openAccessibilitySettings(); } catch (e) {} }
      else sayT('Chala nahi paayi: ' + ((r && r.error) || '?'));
      return true;
    }
    sayT('▶️ "' + name + '" shuru kar rahi hu…');
    if (PANEL) setTimeout(closePanelMode, 1200); else pollMacro();
    return true;
  }
  async function teachIntent(text) {
    if (IS_SENTINEL) return false;
    var A = aaT(); if (!A) return false;
    var low = tnorm(text), st;
    if (teach.askName) {
      teach.askName = false;
      if (/^(cancel|rehne do|nahi|nhi|mat)\b/.test(low)) { sayT('Theek hai, nahi seekhti.'); return true; }
      return await startTeach(String(text).trim());
    }
    if (teach.pending) {
      var pn = teach.pending; teach.pending = null;
      if (/^(haan|han|ha|haa|yes|ok|okay|chalao|kar do|karo|theek hai|ji|sure)\b/.test(low)) return await runMacro(pn);
      if (/^(nahi|nhi|no|cancel|mat|rehne do|ruko)\b/.test(low)) { sayT('Theek hai, nahi chalaungi.'); return true; }
    }
    try { st = await A.getTeach(); } catch (e) { return false; }
    teach.recording = !!st.recording; status();
    if (st.recording) {
      if (/^(bas|ho gaya|ho gya|done|stop|khatam|save|band karo|ruko|yaad kar lo)\b/.test(low)) return await stopTeach(true);
      if (/^(cancel|raddh|rehne do|mat seekho|chhodo)\b/.test(low)) return await stopTeach(false);
    }
    if (st.playing && /^(ruko|stop|bas|band|rok do)\b/.test(low)) { try { await A.macroStop(); } catch (e) {} sayT('Ruk gayi ✋'); return true; }
    var macros = st.macros || [];
    if (/\b(kya kya|konse|kaun se|kon se|kitne)\b.*\b(seekha|sikha|macro|process|kaam)\b|\b(mere|saare|sab) (macro|process|seekhe)\b/.test(low)) {
      sayT(macros.length ? 'Mujhe ye kaam aate hain:\n' + macros.map(function (m) { return '• ' + m.name + ' (' + m.steps + ' steps)'; }).join('\n') : 'Abhi mujhe koi kaam nahi sikhaya. Bolo: "seekho <kaam ka naam>".');
      return true;
    }
    var fm = low.match(/^(?:bhool ja|bhul ja|bhool jao|delete|hata do|mita do)\s+(.+)$/);
    if (fm) {
      var tgt = findMacro(macros, fm[1]);
      if (!tgt) { sayT('Is naam ka koi kaam mujhe yaad nahi.'); return true; }
      try { await A.macroDelete({ name: tgt.name }); } catch (e) {}
      sayT('"' + tgt.name + '" bhool gayi 🗑️'); return true;
    }
    var TRIG = /\b(seekho|sikho|sikhna|yaad rakho|yaad rakhna|yaad rakh lo|record karo)\b/g;
    if (!st.recording && TRIG.test(low) && !/\bkya\b|\?/.test(low) && low.length < 90) {
      var nm = low.replace(TRIG, ' ').replace(T_FILL, ' ').replace(/\b(jo|mai|main|settings|process|steps|karunga|karungi)\b/g, ' ').replace(/\s+/g, ' ').trim();
      if (!nm) { teach.askName = true; sayT('Is kaam ka naam kya rakhu? (jaise "wifi band karna")'); return true; }
      return await startTeach(nm);
    }
    if (!st.recording && macros.length && /\b(karo|kar do|kardo|kar de|chalao|chala do|run|shuru karo)\b/.test(low)) {
      var mm = findMacro(macros, low);
      if (mm) {
        teach.pending = mm.name;
        sayT('▶️ "' + mm.name + '" chalau? ' + mm.steps + ' steps' + (mm.apps && mm.apps.length ? ' (' + mm.apps.join(', ') + ')' : '') + '. "haan" bolo — beech me rokna ho to "ruko".');
        return true;
      }
    }
    return false;
  }

  async function send(text) {
    try { reactMood(text); } catch (e) {}
    text = String(text || '').trim();
    if (!text || busy) return;
    interacted = true; chipsEl.style.display = 'none';
    addMsg('me', text); inEl.value = '';
    if (/^kya naya seekha\??$/i.test(text)) {
      try { var l = await learnedList(); addMsg('ai', l); speak(l.split('\n')[1] || l); } catch (e) { addMsg('err', e.message); }
      return;
    }
    try { if (await teachIntent(text)) return; } catch (e) { try { console.warn('[ava] teach', e); } catch (e2) {} }
    try { if (await handleV2(text)) return; } catch (e) { addMsg('err', e.message || String(e)); return; }
    hist.push({ role: 'user', content: text });
    busy = true; setState('think'); status();
    var typing = addMsg('ai', 'Processing request…', 'QUERY RECEIVED! ✦', true);
    try {
      var out = IS_SENTINEL ? await askSentinel(hist.slice(-12)) : await askApp(hist.slice(-12));
      typing.remove();
      (out.notes || []).forEach(function (n) { addMsg('note', n); });
      var sp = IS_SENTINEL ? splitBriefs(out.reply) : { clean: out.reply, briefs: [] };
      addMsg('ai', sp.clean);
      sp.briefs.slice(0, 2).forEach(addBriefCard);
      hist.push({ role: 'assistant', content: sp.clean }); saveHist();
      speak(sp.clean); flash('happy', 1200);
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
  function closePanel() { if (PANEL) { closePanelMode(); return; } if (!panelOpen) return; panelOpen = false; talk = false; syncTalk(); panelEl.classList.remove('on'); o.mode = 'roam'; o.wait = 2; pickTarget(); inEl.blur(); }
  function togglePanel() { panelOpen ? closePanel() : openPanel(); }

  root.querySelector('#ava-close').onclick = closePanel;
  root.querySelector('#ava-learn').onclick = learnNow;
  root.querySelector('#ava-hide').onclick = function () { if (PANEL) { closePanelMode(); return; } hidden = true; lsSet(K.hidden, '1'); closePanel(); hideBubble(); };
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
  // Aureon's main chat tells Ava what the user typed/shared, so her expression reacts there too
  window.addEventListener('aureon:user-message', function (ev) {
    try {
      if (off) return; var d = ev.detail || {};
      if (d.text) reactMood(d.text);
      if (d.thumb && d.thumb.indexOf(',') > 0) api('POST', '/api/ava/mood/look', { image: d.thumb.split(',')[1] }).then(function (r) { if (r && r.mood && r.mood !== 'none') onScreenMood(r.mood); }).catch(function () {});
    } catch (e) { /* never break chat */ }
  });
  var MOODTEST = /^\s*(angry|gussa|sad|rona|shy|sharma)\w*\s+(ho jao|dikhao|karo)\s*$/i;
  if (AAv && AAv.getScreenWatch) AAv.getScreenWatch().then(function (r) { if (r && r.active) { seeOn = true; seeBtn.classList.add('on'); status(); } }).catch(function () {});
  window.Ava = { setEnabled: setEnabled, open: openPanel, close: closePanel, say: function (t) { announce(t, true, false); }, learn: learnNow };
})();
