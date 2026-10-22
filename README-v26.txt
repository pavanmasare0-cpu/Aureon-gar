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
Test: cd backend && node --test tests/security.test.js test/ava-guard.test.js test/ava-jail-gate.test.js
