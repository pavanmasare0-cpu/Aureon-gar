// Shared theme (Nebula / Ocean / Cyber / Emerald / Light / Classic) for the
// Sentinel and Security dashboards. Pure CSS + a tiny script, no dependencies.
const THEME_TAGS = `<style id="sx-theme-css">
html[data-theme]{--stxt:#EEF0FF;--smut:#9AA3C7;--sbg2:rgba(255,255,255,.04);--scard:rgba(255,255,255,.06);}
html[data-theme="nebula"]{--a1:#8B5CF6;--a1rgb:139,92,246;--a2:#22D3EE;--a2rgb:34,211,238;--bg:#080B16;
 --bgfx:radial-gradient(ellipse 85% 40% at 12% 0%,rgba(139,92,246,.45),transparent 62%),radial-gradient(ellipse 70% 38% at 100% 34%,rgba(34,211,238,.18),transparent 62%),radial-gradient(ellipse 95% 40% at 50% 108%,rgba(52,211,153,.22),transparent 62%);}
html[data-theme="ocean"]{--a1:#2563EB;--a1rgb:37,99,235;--a2:#00E5FF;--a2rgb:0,229,255;--bg:#07111F;
 --bgfx:radial-gradient(ellipse 85% 40% at 12% 0%,rgba(37,99,235,.48),transparent 62%),radial-gradient(ellipse 70% 38% at 100% 34%,rgba(0,229,255,.16),transparent 62%),radial-gradient(ellipse 95% 40% at 50% 108%,rgba(147,197,253,.2),transparent 62%);}
html[data-theme="cyber"]{--a1:#A855F7;--a1rgb:168,85,247;--a2:#FF3CAC;--a2rgb:255,60,172;--bg:#090610;
 --bgfx:linear-gradient(rgba(168,85,247,.06) 1px,transparent 1px) 0 0/34px 34px,linear-gradient(90deg,rgba(168,85,247,.06) 1px,transparent 1px) 0 0/34px 34px,radial-gradient(ellipse 85% 40% at 10% 0%,rgba(168,85,247,.5),transparent 62%),radial-gradient(ellipse 70% 38% at 100% 40%,rgba(255,60,172,.24),transparent 62%),radial-gradient(ellipse 95% 36% at 50% 108%,rgba(56,189,248,.26),transparent 62%);}
html[data-theme="emerald"]{--a1:#10B981;--a1rgb:16,185,129;--a2:#2DD4BF;--a2rgb:45,212,191;--bg:#07130F;
 --bgfx:radial-gradient(ellipse 85% 40% at 12% 0%,rgba(16,185,129,.4),transparent 62%),radial-gradient(ellipse 70% 38% at 100% 34%,rgba(45,212,191,.18),transparent 62%),radial-gradient(ellipse 95% 40% at 50% 108%,rgba(110,231,183,.18),transparent 62%);}
html[data-theme="light"]{--a1:#7C3AED;--a1rgb:124,58,237;--a2:#0891B2;--a2rgb:8,145,178;--bg:#F8FAFC;
 --stxt:#0F172A;--smut:#5B6478;--sbg2:#FFFFFF;--scard:#FFFFFF;--ok:#16A34A;--danger:#DC2626;
 --bgfx:radial-gradient(ellipse 85% 40% at 12% 0%,rgba(167,139,250,.42),transparent 62%),radial-gradient(ellipse 70% 38% at 100% 34%,rgba(34,211,238,.18),transparent 62%);}
html[data-theme]{--gold:var(--a1);--gold-dim:rgba(var(--a1rgb),.5);--bg2:var(--sbg2);--card:var(--scard);--card-border:rgba(var(--a1rgb),.28);--text:var(--stxt);--muted:var(--smut);background:var(--bg);color:var(--stxt);}
html[data-theme="light"]{color-scheme:light;}
html[data-theme]::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;background:var(--bgfx);background-repeat:no-repeat;}
html[data-theme] body{background:transparent !important;color:var(--stxt);}
html[data-theme] h1{background:linear-gradient(90deg,var(--stxt) 10%,var(--a2));-webkit-background-clip:text;background-clip:text;color:transparent;}
html[data-theme] h2,html[data-theme] details summary{color:var(--a2);}
html[data-theme] .card,html[data-theme] .summary-chip,html[data-theme] form{background:var(--scard);border:1px solid rgba(var(--a1rgb),.28);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);box-shadow:0 0 18px rgba(var(--a1rgb),.12);}
html[data-theme] button{background:linear-gradient(135deg,var(--a2),var(--a1));color:#fff;box-shadow:0 0 14px rgba(var(--a1rgb),.45);}
html[data-theme] button.reject{background:transparent;color:var(--stxt);border:1px solid rgba(var(--a1rgb),.4);box-shadow:none;}
html[data-theme] button.ghost{background:transparent;color:var(--stxt);border:1px solid rgba(var(--a1rgb),.4);box-shadow:none;}
html[data-theme] button.danger{background:var(--danger);box-shadow:none;}
html[data-theme] input,html[data-theme] select,html[data-theme] pre{background:var(--sbg2);color:var(--stxt);border-color:rgba(var(--a1rgb),.3);}
html[data-theme] .ai-tag{color:var(--a2);background:rgba(var(--a2rgb),.12);border-color:rgba(var(--a2rgb),.35);}
html[data-theme="soc"]{--a1:#00FFA3;--a1rgb:0,255,163;--a2:#22D3EE;--a2rgb:34,211,238;--bg:#02060A;--stxt:#E6FFF6;--smut:#6F8F88;--scard:rgba(6,20,22,.72);--sbg2:rgba(0,255,163,.04);--danger:#FF4D6D;--ok:#00FFA3;--warn:#FFB020;
 --bgfx:linear-gradient(rgba(0,255,163,.045) 1px,transparent 1px) 0 0/38px 38px,linear-gradient(90deg,rgba(0,255,163,.045) 1px,transparent 1px) 0 0/38px 38px,radial-gradient(ellipse 70% 45% at 8% 0%,rgba(0,255,163,.22),transparent 65%),radial-gradient(ellipse 60% 40% at 100% 10%,rgba(34,211,238,.16),transparent 65%),radial-gradient(ellipse 80% 40% at 50% 115%,rgba(255,77,109,.14),transparent 65%);}
html[data-theme="soc"] body{font-family:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;padding-top:74px !important;}
html[data-theme="soc"]::after{content:"";position:fixed;left:0;right:0;top:-140px;height:140px;background:linear-gradient(transparent,rgba(0,255,163,.07),transparent);animation:sxscan 8s linear infinite;pointer-events:none;z-index:0;}
@keyframes sxscan{to{top:100%}}
@keyframes sxpulse{0%,100%{box-shadow:0 0 0 0 rgba(0,255,163,.7)}60%{box-shadow:0 0 0 7px rgba(0,255,163,0)}}
@keyframes sxalert{0%,100%{box-shadow:0 0 0 rgba(255,77,109,0)}50%{box-shadow:0 0 12px rgba(255,77,109,.8)}}
.sx-top{display:none}
html[data-theme="soc"] .sx-top{display:flex;position:fixed;top:0;left:0;right:0;z-index:60;align-items:center;justify-content:space-between;padding:calc(12px + env(safe-area-inset-top,0px)) 22px 12px;background:rgba(2,8,10,.82);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border-bottom:1px solid rgba(0,255,163,.28);box-shadow:0 0 30px rgba(0,255,163,.12);font-size:12px;letter-spacing:2px;text-transform:uppercase;}
.sx-top b{color:#00FFA3;letter-spacing:4px;font-size:14px;text-shadow:0 0 12px rgba(0,255,163,.8);}
.sx-top i{display:inline-block;width:9px;height:9px;border-radius:50%;background:#00FFA3;margin-right:8px;animation:sxpulse 1.8s infinite;}
.sx-top span{color:#6F8F88;margin-left:18px;}
html[data-theme="soc"] h1{font-size:26px;text-transform:uppercase;letter-spacing:3px;filter:drop-shadow(0 0 10px rgba(0,255,163,.45));}
html[data-theme="soc"] h2{text-transform:uppercase;letter-spacing:2.5px;font-size:12px;color:var(--a1);}
html[data-theme="soc"] h2::before{content:"▮";margin-right:8px;color:var(--a2);}
html[data-theme="soc"] #chips,html[data-theme="soc"] .summary-bar{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin:18px 0 8px;}
html[data-theme="soc"] #chips .chip,html[data-theme="soc"] .summary-chip{flex-direction:column;align-items:flex-start;gap:4px;padding:16px 18px;border-radius:4px;border:1px solid rgba(0,255,163,.22);border-left:3px solid var(--a1);background:linear-gradient(135deg,rgba(0,255,163,.09),rgba(6,20,22,.8));text-transform:uppercase;letter-spacing:1.5px;font-size:10px;color:var(--smut);box-shadow:0 0 22px rgba(0,255,163,.08),inset 0 0 26px rgba(0,255,163,.03);}
html[data-theme="soc"] #chips .chip b,html[data-theme="soc"] .summary-chip b{font-size:34px;line-height:1;letter-spacing:0;color:var(--a1);text-shadow:0 0 16px rgba(0,255,163,.6);}
html[data-theme="soc"] .card{position:relative;border-radius:4px;border:1px solid rgba(0,255,163,.18);transition:.2s;}
html[data-theme="soc"] .card:hover{border-color:rgba(0,255,163,.6);box-shadow:0 0 26px rgba(0,255,163,.22);transform:translateY(-1px);}
html[data-theme="soc"] .card::before,html[data-theme="soc"] .card::after{content:"";position:absolute;width:9px;height:9px;border:2px solid var(--a1);pointer-events:none;}
html[data-theme="soc"] .card::before{top:-1px;left:-1px;border-right:0;border-bottom:0;}
html[data-theme="soc"] .card::after{bottom:-1px;right:-1px;border-left:0;border-top:0;}
html[data-theme="soc"] .badge,html[data-theme="soc"] .apptag{border-radius:2px;letter-spacing:1px;}
html[data-theme="soc"] .HIGH,html[data-theme="soc"] .BLOCKED,html[data-theme="soc"] .ALERT{animation:sxalert 2s infinite;}
html[data-theme="soc"] button{border-radius:3px;text-transform:uppercase;letter-spacing:1.2px;font-size:11px;color:#02100B;background:linear-gradient(135deg,var(--a1),var(--a2));}
html[data-theme="soc"] button.ghost,html[data-theme="soc"] button.reject{color:var(--stxt);}
html[data-theme="soc"] input,html[data-theme="soc"] select{border-radius:3px;font-family:inherit;}
html[data-theme="soc"] ::-webkit-scrollbar{width:8px;height:8px}html[data-theme="soc"] ::-webkit-scrollbar-thumb{background:rgba(0,255,163,.3);border-radius:4px}
html[data-theme="soc"] .sx-theme{max-width:240px;background:rgba(2,12,12,.9);border:1px solid rgba(0,255,163,.35);color:#00FFA3;}
html[data-theme="soc"] .summary-chip .dot{margin-bottom:6px;box-shadow:0 0 10px currentColor;}
@media(min-width:1000px){html[data-theme="soc"] body{max-width:1560px !important;padding-left:32px !important;padding-right:32px !important;}html[data-theme="soc"] #chips .chip b,html[data-theme="soc"] .summary-chip b{font-size:44px;}html[data-theme="soc"] .columns{grid-template-columns:minmax(380px,1fr) 1.5fr !important;gap:30px !important;}html[data-theme="soc"] h1{font-size:32px;}}
.sec-link{display:inline-block;margin:0 0 14px;font-size:12px;font-weight:600;color:var(--a2,#d4af37);text-decoration:none;border:1px solid var(--card-border,#24242e);border-radius:999px;padding:6px 12px;}
.sx-theme{position:fixed;bottom:calc(14px + env(safe-area-inset-bottom,0px));right:12px;z-index:50;width:auto !important;max-width:160px;padding:6px 10px !important;border-radius:999px !important;font-size:12px !important;}
</style>
<script>
(function(){var ok=['soc','nebula','ocean','cyber','emerald','light','classic'];
try{var q=new URLSearchParams(location.search).get('theme');if(q&&ok.indexOf(q)>-1)localStorage.setItem('sentinel_theme',q);}catch(e){}
function get(){try{var t=localStorage.getItem('sentinel_theme')||'soc';return ok.indexOf(t)<0?'nebula':t;}catch(e){return 'soc';}}
function set(t){if(t==='classic')document.documentElement.removeAttribute('data-theme');else document.documentElement.setAttribute('data-theme',t);try{localStorage.setItem('sentinel_theme',t);}catch(e){}}
set(get());
document.addEventListener('DOMContentLoaded',function(){var s=document.createElement('select');s.className='sx-theme';
var names={soc:'Command Center (SOC)',nebula:'Nebula Aurora',ocean:'Deep Ocean',cyber:'Cyberpunk Neon',emerald:'Emerald',light:'White + Purple',classic:'Classic Gold'};
ok.forEach(function(k){var o=document.createElement('option');o.value=k;o.textContent=names[k];s.appendChild(o);});
s.value=get();s.onchange=function(){set(s.value);};document.body.appendChild(s);var tb=document.createElement('div');tb.className='sx-top';tb.innerHTML='<div><i></i><b>AUREON // SOC</b><span>Threat monitor</span></div><div id="sx-clk" style="color:#00FFA3"></div>';document.body.appendChild(tb);function tk(){var d=new Date();document.getElementById('sx-clk').textContent=d.toISOString().slice(0,10)+'  '+d.toISOString().slice(11,19)+' UTC';}tk();setInterval(tk,1000);});})();
</script>
`;
module.exports = { THEME_TAGS };
