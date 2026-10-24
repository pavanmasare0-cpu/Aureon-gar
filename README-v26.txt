Aureon v26 FINAL = v25 + Ava Project page + Zip/Photo + research/verify + design skill + bugfixes
Zip extract: repo root me  unzip -o Aureon-v26-final.zip -d .

Ava Desk (backend/, Render auto-redeploy, APK nahi chahiye):
- Naya "Project" tab: side panel (naam, tagline, status, live progress, Features, files/lines/AI calls, Dhyaan/bugs, final-check badge, reference photo), Ava se chat, project form (App/Project zip, Android APK, UI design), brief 6000 akshar, Photo + Zip upload (72px thumbnail), Demo image (PNG download), Laptop preview (sandbox), Clone, Zip download.
- Home sidebar me "Ava ka project" row + Code panel me "Project page" button (dashboard confusion hatane ke liye).
- Chat sirf padhti hai (kuch change/deploy nahi), 60 msg/ghanta. Upgrade tab ka "Abhi upgrade likho" sirf proposal banata hai (Approve ke baad lagta hai).
- Build pipeline: attachments padho -> research -> plan -> features -> files -> final check (VERIFY_REPORT.md) -> README -> demo screen (AVA_DEMO=off se band).
- Download buttons (Code/Zip/APK): page khud fetch karke save karta hai (Chrome "Needs authorisation" fix).
- UI/UX skill: backend/design-skill.js -> Ava ke project/UI prompts me.
- llm-text.js: GEMINI_API_KEY / _KEYS / _1..9, GROQ same, models auto-shift.

Aureon app (www/ — APK REBUILD chahiye):
- Owner code: apna input box + native Chrome-open (prompt/window.open ki jagah).
- style.css: focus ring, reduced-motion, 44px targets, chat image max 240px.

Render env: GEMINI_API_KEY (photo + research), GROQ_API_KEY (fallback), SENTINEL_OWNER_CODE, SENTINEL_ENC_KEY.
Test: cd backend && node --test tests/security.test.js test/ava-jail-gate.test.js

UPDATE (live panel + variant details):
- "Ava ka Code — live" ab kabhi purane failed APK par nahi atakta: sabse naya healthy item auto-follow hota hai (tumne khud kuch chuna ho to wahi pinned rehta hai).
- Panel ab batata hai Ava abhi kya kar rahi hai: headline + live log; AI quota khatam ho to wajah, kitni baar try hua, kab, aur "har 10 min me retry". Kuch na kar rahi ho to "abhi kuch nahi kar rahi + pichla kaam".
- Failed APK ka poora error dikhta hai (pehle 140 akshar par kat jata tha) + quota ka hint.
- Variant cards: description, sandbox ✓/✗, lines/functions/files, date, Details button. Details me: ye kya hai, limits, tumne kya bola, check result, code ka naksha (function names + pehli 30 lines). Personas (Kiddo/Classic/Shadow/Pro) ke liye bhi Details.
- backend/ava-self.js: /state me jailInfo (queue attempts, lastError, lastTry).

UPDATE 2 (stop/resume, remove APK, live bug hunt, coding knowledge):
- Project ko beech me rok sakte ho (Roko / Project page ⏹ Roko): checkpoint bacha rehta hai. Card/side panel me "▶ Wahin se" (jahan ruka wahin se, jo files ban chuki wo dobara nahi likhi jaati) aur "🔁 Naye sire se" (same brief se naya build). Resume ko hourly budget ka naya slot nahi lagta.
- Failed "New app / star" APK entries ab hat sakti hain: har card par ✕ + "🧹 Failed APK saaf karo (N)". Sirf list se hatta hai (GitHub par jo ban chuka hai wo waisa hi).
- Ava ka final check ab LIVE BUG HUNT bhi karta hai: broken imports, galat named imports, HTML me missing/duplicate ids aur links, package.json galat paths, failing tests, phir AI code review. Har fix ke baad tests dobara chalte hain — fix se test toote to fix wapas (rollback). VERIFY_REPORT.md me "Bug hunt" section, Project page par 🐞 badge. AVA_BUGHUNT=off se band.
- backend/code-skill.js: coding knowledge Ava ke engineer prompt me aur Aureon Coding-mode chat prompt me (dono ek hi source se).
- Aureon chat: /api/chat reply ke code blocks server par syntax-check hote hain (code-check.verifyAndFix), galti mile to ek baar auto-fix (aureon-chat-verify patch server.js me laga hai).
- backend/apk-maker.js: DELETE /jobs/:id aur POST /jobs/clear-failed (2FA stepUp + audit).
- Env (optional): AVA_PROJECT_PER_HOUR, AVA_UI_PER_HOUR (default 2 / 3).
