# 🚀 Aureon AI — Starter App: Get Running

This is a **working MVP**: real chat UI (Golden + White theme, quick actions, model
switcher, settings) that builds straight into an installable Android APK, plus a real
backend that calls OpenAI / Claude / Gemini. It is the foundation — RAG, voice output,
image generation, agents, etc. get added on top of this in later passes (see
`FEATURES.md` for the full list, build phase by phase).

## 1. Push this into your GitHub repo
Copy `www/`, `backend/`, `capacitor.config.json`, `package.json` into your repo root
(alongside `README.md` / `FEATURES.md` you already have), then commit + push.

## 2. In Codespaces — install & run the backend
```bash
cd backend
npm install
cp .env.example .env
# open .env and paste in at least one API key (OpenAI, Claude, or Gemini)
npm start
```
This starts the backend on port 3000. Make port `3000` **Public** in the PORTS tab
(same way you did for 8080 earlier) and copy its URL.

## 3. Wire the frontend to your backend
No build step needed — `www/` is plain HTML/CSS/JS. Just note the backend URL from
step 2; you'll paste it into the app's Settings screen once it's installed on your
phone (⚙ icon → Backend URL → Save).

## 4. Add the Android platform & build the APK
```bash
cd ..                     # back to project root
npm install
npx cap add android
npx cap sync android
cd android
JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./gradlew clean assembleDebug
```
APK will be at `android/app/build/outputs/apk/debug/app-debug.apk` — serve it over
`python3 -m http.server 8080` and install on your phone like before.

## 5. First run on your phone
1. Open the app → tap ⚙ (Settings)
2. Paste your backend's public Codespaces URL (from step 2) into **Backend URL** → Save
3. Go back, type a message → it calls your backend → backend calls the AI model → reply shows in chat

## What's already working
- Home dashboard with quick actions, recent chats (saved on-device)
- Full chat screen: send, streaming-style typing indicator, model switcher (OpenAI / Claude / Gemini / Local placeholder)
- Settings sheet: backend URL, streaming toggle, auto-language toggle
- Voice input button (device speech-to-text, where supported)
- Backend proxy: keeps your API keys server-side, never inside the APK

## What to add next (pick one, tell me and I'll build it into this same project)
- File upload + analysis
- Personal knowledge base / RAG
- Image understanding & generation
- AI memory (persisted per-user preferences)
- Auth + cloud sync (so chats follow you across devices)
- Text-to-speech playback of AI replies

Every time you want a new feature, keep working in this same Codespace — add the
code, `npx cap sync android`, rebuild the APK.
