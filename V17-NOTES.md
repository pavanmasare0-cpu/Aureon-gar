# Aureon v17 — Ava ko real code likhne par majboor karna

## Files (repo me wahi paths par rakho)
- backend/ava-jail-gate.js  (NEW) quality gate + Ava ke naye prompts. Ava ki EDITABLE list me nahi hai, to wo ise kamzor nahi kar sakti.
- backend/ava-self.js       jailGenerate ab gate use karta hai: draft -> gate -> real self-test -> max 2 repair rounds. Limit 8 -> 4/ghanta (har variant me 3 AI calls tak).
- www/ava-guard.js + backend/public/ava-guard.js  (NEW, same file) asli Ava Guard.
- www/index.html            ava-guard.js script (data-autostart).
- www/app.js                sendMessage me AvaGuard check.
- backend/test/*.test.js    run: node --test backend/test/*.test.js  (9 tests)

## Gate kya rokta hai
Chhota file (<80 real lines), <6 functions, TODO/placeholder/dummy, khali functions, fetch/require/eval/process,
window.__AVA_JAIL__.selfTest ka na hona, security tool me <6 detection patterns / koi state ya verdict na hona.
Phir selfTest sach me chalta hai (>=6 alag named cases, sab pass). Infinite loop 9s me kill.

## Ava Guard kya karta hai
inspect(): NFKC + invisible chars + HTML-entity/%XX/\uXXXX decode (3 layers) -> ~40 rules (XSS, SQLi, path, shell,
prompt-injection EN+Hinglish, forged [[ACTION tags, secrets, Luhn cards) -> allow/warn/block + score.
Guard: token-bucket rate limit, 3 blocks -> escalating lockout, blocked text dobara Send = override, secret auto-redact,
event log (text kabhi store nahi hota), shield button + panel. Password fields kabhi nahi padhta.
Helpers: escapeHTML, isSafeUrl, redact. Node me bhi chalta hai: require('./public/ava-guard.js').inspect(text).

## Honest limits
- Client-side guard seat-belt hai, wall nahi. Asli enforcement backend par: wahi file server par require karke inspect() chalao.
- Self-test usi AI ne likha hota hai: gate batata hai code chalta hai aur apne claims pass karta hai, design perfect hone ki guarantee nahi.
- vm perfect sandbox nahi. Layers: static bans, empty env, --permission, --disallow-code-generation-from-strings, timeout. Band karna ho: AVA_JAIL_RUN_TESTS=0.
- Abhi sirf main chat (sendMessage) me wired hai. home-input aur Sentinel dashboard fields me nahi.
- Chat me dev code paste karoge (<script>) to block+confirm aayega: dobara Send dabao.
