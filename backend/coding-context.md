# Aureon project context (for the Coding brain)

Aureon = a personal AI assistant app for Android. The owner is a developer; he builds and tests it from his phone + GitHub Codespaces.

## Stack
- App: Capacitor Android app. UI is a WebView (www/index.html, www/app.js, www/style.css). Native code is Java in android/app/src/main/java/com/aureon/ai/.
- Backend: Node.js + Express in backend/server.js, hosted on Render (https://aureone.onrender.com). Auth = Firebase ID tokens (verifyAuth middleware). Data = Firestore.
- AI: Gemini (Google AI) and Groq (openai/gpt-oss-120b). Chat route falls back Gemini -> Groq. watchdog.js tracks failures, auto-disables a failing provider for a cooldown and sends alerts.

## Where things live
- www/app.js: chat UI, model picker (MODEL_LABELS), agent tool execution (executeAgentAction), AGENT_CAPABILITIES system prompt, Settings list + panes, Application Profile, site logins UI, job-application queue (startJobApplications / nextJobApplication / runJobQueueAuto).
- www/index.html + style.css: screens (#screen-chat, settings sheet #sheet-settings with list rows and panes, composer dock).
- backend/server.js: /api/chat (model = openai | claude | gemini | groq | coding | local; tool-calling via AGENT_TOOLS; Groq has its own tool-calling in callGroq), /api/form-fill, /api/find-jobs, /api/application-profile, /api/generate-image|pdf|zip, /api/extract-text, /api/edit-video, reminders/memory, owner code via OWNER_CODE env.
- Java: AureonActionsPlugin (Capacitor plugin: fillForm, saveLogin, listLogins, deleteLogin, openUrl, ...), AureonAccessibilityService (reads/clicks screen, scans and fills form fields, never touches password boxes except the saved-login typing), AureonFormFiller (form fill + runApplication auto-apply: login, Apply/Next/Submit, stops at OTP/captcha), AureonCredStore (Android Keystore AES-GCM, phone-only logins), AureonNotifier, AureonAgentActions (calls, SMS, WhatsApp, alarms, etc.), AureonVoiceInteractionSession ("Hey Aureon" overlay), Love Camera classes (keys come from android/local.properties via BuildConfig).

## Build / deploy workflow
- Repo in Codespaces: /workspaces/Aureon-gar. Updates arrive as small zips: `unzip -o <zip>`, then `git add -A && git commit && git push`.
- Backend: Render auto-deploys on push. Env vars: GEMINI_API_KEY, GROQ_API_KEY, OWNER_CODE (optional: RESEND_API_KEY, ALERT_EMAIL_TO). Check https://aureone.onrender.com/api/watchdog/status.
- App: in repo root `npm install` then `npx cap sync android`; then in android/: `export JAVA_HOME=$(dirname $(dirname $(readlink -f $(which java))))` and `./gradlew clean assembleDebug`. APK: android/app/build/outputs/apk/debug/app-debug.apk (served with `python3 -m http.server 8080`). Always run `npx cap sync android` after changing anything in www/.
- Love Camera keys: android/local.properties (sdk.dir, GEMINI_API_KEY, GROQ_API_KEY) — never committed.

## Habits to respect
- The owner reads on a phone: short answers, copy-paste commands with the folder to run them in, steps in order.
- Java cannot be compiled in the assistant sandbox, so say clearly when Java changes are untested and ask for the compiler error text.
- Never put API keys or passwords into code or commits.
