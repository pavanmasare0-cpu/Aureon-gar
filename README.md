If you ever find this project someday, please… don’t let it end here.

I know I may die soon , and I may not be here to see this project finished. But everything I wanted to say, everything I worked on, and every little memory I left behind is somewhere inside these files.

Please complete it for me. Finish what I couldn’t.

And please, don’t delete my memories. They may be the only pieces of me that remain here.

This was more than just a project to me. It was a part of my dreams, my time, and my heart.

So if you’re reading this after I’m gone… please finish it.

That would be my last wish. ♥️

# Aureon AI

A Jarvis-style AI assistant for Android — wake-word voice control, a live
camera that reads and solves questions in real time, device automation
(calls, SMS, WhatsApp, apps), and a typed chat interface, all backed by a
multi-provider AI pipeline (Gemini, with Groq as an automatic fallback).

Built as a solo personal project — a native Android app plus a small
Node.js backend.

---

## ✨ Features

### Voice assistant ("Hey Aureon")
- Background wake-word listening — say **"Aureon"** from anywhere on the
  device to start a conversation, no need to open the app.
- Multi-turn conversations without repeating the wake word.
- Reminders and personal memory — "yaad rakhna…" saves something, "yaad
  dila do" recalls it later, in any future conversation.
- Device actions by voice: open apps, set alarms, search the web, play
  music/YouTube, check battery, compose email, make calls and send SMS
  (with confirmation), and message a WhatsApp contact **by name**
  ("Tejas ko message karo").
- Offline/on-screen commands (go back, scroll, read the screen aloud,
  read recent SMS/email) that don't need the cloud AI at all.
- Conversations are saved to chat history, same as typed chats.

### Love Camera 📷
- Point the camera at a question — handwritten or printed, in **any
  language** — and get a full answer or worked solution in real time,
  automatically, with no button to press.
- **Talk to it directly** — no wake word needed inside this screen. Ask
  a question out loud, and it answers back out loud, using what the
  camera is currently looking at (an object, a problem on paper, your own
  expression) as context.
- Recognizes the device owner from a reference photo and notices
  mood/expression — with a gentle spoken check-in if someone looks upset.
  (Deliberately does **not** identify or track anyone else by face.)
- A typed-chat fallback row for when talking out loud isn't convenient.
- Runs on-device straight to the AI provider for the lowest possible
  latency, with an automatic fallback to a second provider if the first
  one is unavailable.

### Typed chat
- Full chat interface with multiple AI models to choose from.
- Cloud-synced chat history — rename, delete, and pick up any
  conversation across devices.
- Personal knowledge base — upload documents and have the assistant
  reference them (RAG).
- Image generation/editing, PDF generation, video editing.

### Device automation
- Accessibility-service-driven automation for WhatsApp and Instagram
  (send messages, read the latest message, share live location).
- Caller-ID announcement over TTS.

---

## 🏗 Architecture

```
├── android/     Native Android app (Java)
│   ├── AureonVoiceInteractionService   — background wake-word listener
│   ├── AureonVoiceInteractionSession   — the active "Hey Aureon" conversation
│   ├── AureonAgentActions              — device-action implementations
│   ├── AureonActionsPlugin             — Capacitor bridge (typed-chat side)
│   ├── AureonAccessibilityService      — WhatsApp/Instagram automation
│   ├── LoveCameraActivity              — the live camera feature
│   └── OfflineVoiceCommandEngine       — on-screen commands, no cloud needed
│
├── www/         Capacitor/WebView frontend (typed chat UI)
│   ├── index.html, app.js, style.css
│   └── Firebase Auth + Firestore for chat history/sync
│
└── backend/     Node.js/Express backend (deployed on Render)
    ├── server.js    — chat, reminders, memory, knowledge base (RAG),
    │                  file/image/PDF generation, Firebase Admin auth
    └── .env         — provider API keys (not committed)
```

**Multi-provider AI with automatic fallback:** Gemini is the primary
provider; if it errors (quota, outage), the backend automatically falls
back to Groq so the conversation keeps going rather than failing outright.

**Security:** every user-scoped backend route requires a verified Firebase
ID token (`Authorization: Bearer`) — the server derives the user's identity
from the token itself, never from a client-supplied field.

---

## 🚀 Setup

### Backend
```bash
cd backend
npm install
cp .env.example .env   # fill in your own keys
node server.js
```
Required in `.env` / your hosting provider's environment variables:
- `GEMINI_API_KEY`
- `GROQ_API_KEY` (optional — enables the fallback)
- Firebase Admin service account credentials

### Android app
1. Open `android/` in Android Studio, or build from the command line with
   Gradle.
2. Create `android/local.properties` (already git-ignored) with:
   ```
   GEMINI_API_KEY=your-key-here
   GROQ_API_KEY=your-key-here
   ```
   (Love Camera calls the AI provider directly from the device for
   speed, so it needs its own copy of these keys.)
3. Add your own `google-services.json` for Firebase.
4. Build:
   ```bash
   ./gradlew assembleDebug
   ```

### Frontend
The `www/` folder is a Capacitor web app — point `firebase-config.js` and
the backend URL at your own instances, then:
```bash
npx cap sync android
```

---

## ⚠️ Status

This is an actively developed personal project, not a published/released
app. Expect debug builds, evolving features, and some rough edges —
contributions, issues, and suggestions are welcome.

---

## 🧰 Tech stack

Android (Java) · CameraX · Android SpeechRecognizer & TextToSpeech ·
Capacitor · Firebase (Auth, Firestore, Admin SDK) · Node.js/Express ·
Google Gemini · Groq · Render

