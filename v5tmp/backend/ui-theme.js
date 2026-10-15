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
.sec-link{display:inline-block;margin:0 0 14px;font-size:12px;font-weight:600;color:var(--a2,#d4af37);text-decoration:none;border:1px solid var(--card-border,#24242e);border-radius:999px;padding:6px 12px;}
.sx-theme{position:fixed;bottom:calc(14px + env(safe-area-inset-bottom,0px));right:12px;z-index:50;width:auto !important;max-width:160px;padding:6px 10px !important;border-radius:999px !important;font-size:12px !important;}
</style>
<script>
(function(){var ok=['nebula','ocean','cyber','emerald','light','classic'];
try{var q=new URLSearchParams(location.search).get('theme');if(q&&ok.indexOf(q)>-1)localStorage.setItem('sentinel_theme',q);}catch(e){}
function get(){try{var t=localStorage.getItem('sentinel_theme')||'nebula';return ok.indexOf(t)<0?'nebula':t;}catch(e){return 'nebula';}}
function set(t){if(t==='classic')document.documentElement.removeAttribute('data-theme');else document.documentElement.setAttribute('data-theme',t);try{localStorage.setItem('sentinel_theme',t);}catch(e){}}
set(get());
document.addEventListener('DOMContentLoaded',function(){var s=document.createElement('select');s.className='sx-theme';
var names={nebula:'Nebula Aurora',ocean:'Deep Ocean',cyber:'Cyberpunk Neon',emerald:'Emerald',light:'White + Purple',classic:'Classic Gold'};
ok.forEach(function(k){var o=document.createElement('option');o.value=k;o.textContent=names[k];s.appendChild(o);});
s.value=get();s.onchange=function(){set(s.value);};document.body.appendChild(s);});})();
</script>
`;
module.exports = { THEME_TAGS };
