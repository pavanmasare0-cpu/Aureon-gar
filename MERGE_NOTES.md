# Aureon AI — Merge Notes (read this first)

Ye 28 patch zips ka merged version hai, plus ek naya feature: Instagram DM
via voice, with confirmation. Neeche exactly likha hai kya kiya, kya
verify karna hai, aur kya abhi tak missing hai.

## ⚠️ Pehle ye karo (zaroori)

1. **Leaked Gemini API key rotate karo.** Original zip ke `backend/.env`
   mein ek real key thi — is package mein `.env` hata diya hai (sirf
   `.env.example` hai), lekin agar wo purani key kahin aur use ki hai to
   Google AI Studio se turant revoke/rotate karo.
2. `cd backend && npm install && cp .env.example .env` — apni keys daalo.
3. Root mein `npm install` → `npx cap sync android`.
4. Backend abhi bhi **bina authentication ke** hai (koi bhi jo backend URL
   jaanta hai wo `/api/chat` call kar sakta hai) — ye is merge mein fix
   nahi kiya gaya, scope se bahar tha. Pehle wali conversation mein iska
   fix bataya tha — wo alag se karna hoga.

## Kya merge kiya (file-by-file)

| File | Source |
|---|---|
| `backend/server.js` | `aureon-openapp-fix-patch.zip` (latest) + naya `send_instagram_message` tool added |
| `www/app.js` | `aureon-openapp-fix-patch.zip` (latest) + naya Instagram case/confirm/prompt added |
| `www/index.html`, `www/style.css` | `aureon-phase6-fix2-patch.zip` (latest) |
| `AureonVoiceInteractionSession.java` | `aureon-continuous-conversation-patch.zip` (latest) |
| `AureonVoiceInteractionService.java` | `aureon-wakeword-everyone-fix.zip` (latest) |
| `OfflineVoiceCommandEngine.java`, `AureonSpeechPlugin.java` | `aureon-phase6-fix2-patch.zip` (latest) |
| `AureonAccessibilityService.java` | `aureon-phase6-fix2-patch.zip` + naye `clickTextWithRetry`/`waitForText` helpers added |
| `AureonActionsPlugin.java`, `AureonAgentActions.java` | `aureon-openapp-fix-patch.zip` (latest) + naya Instagram/contact-lookup code added |
| `AndroidManifest.xml` | **Manually merged** — accessibility service (phase6) + queries block (openapp-fix) dono saath. Voice-keyboard service jaan-boojh kar drop kiya (naye feature se conflict karta tha, use nahi ho raha tha) |
| `MainActivity.java` | **Manually merged** — dono plugins (`AureonSpeechPlugin` + `AureonActionsPlugin`) register hote hain, dono permission-prompts (accessibility + contacts) saath hain |

## Naya feature: Instagram message + contact-name WhatsApp

- `www/app.js` ka AI ab `send_instagram_message` tool bhi call kar sakta hai
  — ye pehle chat UI mein confirm dialog dikhayega ("Aureon wants to send
  this Instagram DM to Pavan: '...'. Allow this?") — sirf "OK" karne par
  hi actual send hota hai
- `sendWhatsappMessage` ab `contact_name` bhi accept karta hai (number ke
  bajaye), aur Android Contacts se number dhoondh leta hai — WhatsApp
  message abhi bhi sirf **pre-filled draft** kholta hai, khud send nahi
  karta (user ka apna tap zaroori hai — extra safety layer)
- Instagram DM automation `AureonAccessibilityService` use karta hai (open
  Instagram → search contact → open chat → type → tap Send) — **isko
  poora automate karke bhi actual "Send" tap karta hai**, kyunki chat UI
  ka confirm dialog pehle hi user se poochh chuka hota hai

## ⚠️ Kya untested/fragile hai (zaroor manually test karo)

- **Instagram automation UI-label-dependent hai.** Maine "Direct"/"Messages"/
  "Search"/"Send" jaise labels use kiye hain jo Instagram ki current UI
  match karte hain — lekin Instagram apni UI/labels update karta rehta hai,
  aur maine ise kisi real device pe test nahi kiya (is environment mein
  Android build/run possible nahi tha). Pehli baar chalane se pehle:
  1. Settings → Accessibility → Aureon → ON karo
  2. Ek test contact pe try karo pehle, real Pavan pe nahi
  3. Agar koi step fail ho (`step_failed` status milega), wahi jagah UI
     label update karni padegi `AureonActionsPlugin.java` mein
- **Offline voice mode** ("Hey Aureon" system overlay, bina internet ke)
  mein Instagram messaging abhi add nahi hui — sirf in-app chat (jab AI se
  baat karte ho) mein kaam karega. `OfflineVoiceCommandEngine.java` mein
  WhatsApp-by-contact-name already tha, Instagram add nahi kiya (scope
  bada ho jata warna)
- Full Android build is sandboxed environment mein nahi ho saka (koi
  network/Gradle nahi tha) — isliye **compile karke dekhna khud padega**
  Codespace mein: `cd android && ./gradlew clean assembleDebug`

## Round 2 — "baaki sab" (skipping Permission Setup / Agent Loop / Screen
Understanding for now, as asked)

- **Stop/Cancel voice command** — "stop", "cancel", "ruk jao", "रुको",
  "बंद करो", "थांबा" ab turant TTS + listening dono cancel kar dete hain,
  bina cloud/agent-loop ke — `AureonVoiceInteractionSession.java` mein
- **YouTube — real search+play** — pehle sirf app open hota tha; ab
  `play_youtube` (online, chat/AI se) aur "youtube pe X bajao"/"play X on
  youtube" (offline, seedha bola bhi) — dono YouTube app mein directly
  search karke video kholte hain (`AureonActionsPlugin.doPlayYoutube`)
- Baaki sab jo checklist mein tha — General Phone Automation (back, home,
  scroll, type, click, notifications, quick-settings, wifi/bluetooth
  settings, generic "open X") aur Offline mode — **already patches mein
  the**, is round mein sirf verify kiya, naya nahi likhna pada

## Jaan-boojh kar NAHI banaya (safety reason)

- **Payment automation** — koi payment/UPI integration is app mein hai hi
  nahi, aur ek voice assistant ko automatically payment confirm karne
  dena (misheard command → galat paisa transfer) ek real financial-harm
  risk hai. Agar future mein payment feature add karna ho, to us par bhi
  yahi confirm-gate pattern (jaisa call/SMS/Instagram pe hai) lagana —
  lekin abhi ke liye ye jaan-boojh kar chhoda gaya hai
- **Delete actions** — koi file/message/data-delete action nahi bana
  kyunki koi existing delete-capable action hi nahi tha jise gate karna
  ho; agar aisa feature banega to usse bhi confirm-required list mein
  turant daalna

## Round 3 — tumhare "aureon-jarvis-3features.zip" se transplant

Wo upload poora project nahi tha (gradlew/package.json/capacitor.config
missing), isliye uska naya code isi full project mein transplant kiya:

- **`read_instagram_message`** — kisi contact ka Instagram chat khol ke
  jo bhi text screen pe dikh raha hai wo padh ke wapas bata deta hai
  (non-sensitive, confirm nahi mangta — kuch send/change nahi hota)
- **`send_whatsapp_live_location`** — EXPERIMENTAL — WhatsApp live location
  poora automate, confirm ke baad Send tak khud tap karta hai. Fragile hai
  (WhatsApp ke exact button labels pe depend karta hai) — fail hone par
  exact step batayega kahan atka

## Testing checklist

- [ ] `read_instagram_message` — Pavan ka last message sahi padh raha hai
- [ ] `send_whatsapp_live_location` — confirm dialog aata hai, "OK" karne
      par actually location share hoti hai (fail ho to error mein exact
      step milega)Dono `www/app.js`, `backend/server.js` mein wire ho chuke hain, confirm-gate
pattern (`SENSITIVE_AGENT_ACTIONS`) mein live-location bhi shamil hai.



- [ ] "Stop" bolne par turant TTS ruk jata hai, listening cancel hoti hai
- [ ] "Youtube pe [song] bajao" bolne par YouTube app mein hi khulta/chalta
      hai (kisi aur music app mein nahi)
- [ ] `npm run build:apk` clean compile hota hai (koi syntax error nahi)
- [ ] App khulte hi Accessibility + Contacts permission prompt aata hai
- [ ] "WhatsApp pe Pavan ko bhejo — I'm coming" → sahi contact resolve hota
      hai, WhatsApp pre-filled khulta hai
- [ ] "Instagram mein Pavan ko message karo — kaise ho" → confirm dialog
      aata hai → "OK" par Instagram khulke actually message chala jaata hai
- [ ] Confirm dialog mein "Cancel" karne par kuch send nahi hota
- [ ] Accessibility off ho to clear error message aata hai ("enable karo")
