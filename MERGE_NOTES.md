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

## Round 5 — 5 reported problems, real fixes

1. **Voice atak jaana** — confirmed bug: speech-error hone par kabhi retry
   nahi hota tha. Ab error par khud retry karta hai (max 4x), aur
   consecutive listen-error count reset ho jaata hai successful result par.
   `startListening()` ab purana recognizer bhi destroy karta hai naya
   banane se pehle (leak fix).
2. **Response slow** — code mein koi obvious per-request bug nahi mila
   (model list 1 hour cache hoti hai, normal request sirf 1 API call
   karta hai). Asli wajah **Render free-tier cold start (~50s)** hai jab
   service idle rehke so jaati hai — code se fix nahi ho sakta, paid plan
   par upgrade karne se hi consistently fast hoga.
3. **Photo bahut bada dikhna** — FIXED. `.image-preview-thumb` ka koi CSS
   size constraint nahi tha, ab 56x56px fixed hai.
4. **Zip read na hona** — FIXED. `extractText()` mein zip support hi nahi
   tha pehle (koi size-limit ka masla nahi tha, feature hi missing thi).
   Ab `adm-zip` se zip ke andar ke `.txt/.pdf/.docx` files padhta hai.
   Upload limit `15mb` se `100mb` badhaya. **Important:** bade files ke
   liye Firestore storage ko bhi refactor kiya — chunks ab ek subcollection
   mein store hote hain (pehle sab ek document mein the, jo Firestore ke
   1MiB-per-document limit se badi files par crash ho jaata). Delete
   endpoint bhi update kiya taaki subcollection properly clear ho.
5. **PDF na bann na** — code mein `pdfkit` sahi se installed/imported hai,
   koi bug nahi mila static review mein. Agar abhi bhi fail ho, backend ko
   seedha test karo:
   ```
   curl -s https://aureone.onrender.com/api/generate-pdf -H "Content-Type: application/json" -d '{"title":"test","content":"hello"}'
   ```
   Agar isme `dataBase64` field ke saath JSON aaye → backend theek hai,
   masla frontend mein hai. Agar error aaye → uska exact message batao.

## Round 6 — teeno naye requests

1. **Natural/casual Hinglish phrasing samajhna** ("are Instagram pe Preeti
   ko text bhejo") — already kaam karta tha, kyunki ye cloud AI (LLM) tak
   jaata hai jo natural language khud samajhta hai, koi rigid regex nahi.
   System prompt mein explicitly clarify kar diya ki filler words
   ("are"/"yaar"/"bhai") ko command ka part na samjhe.

2. **Voice se Instagram/Live-location bilkul kaam nahi karte the** — REAL
   bug mila: `AureonAgentActions.java` mein poora code already tha
   (sendInstagramMessage, readInstagramMessage, sendWhatsappLiveLocation,
   youtubeSearch), lekin voice ke dispatch switch mein wire hi nahi kiya
   gaya tha — sirf in-app chat se hi kaam karte the. Ab dono jagah kaam
   karenge.

3. **Voice confirm ("haan/nahi") sensitive actions se pehle** — Instagram
   message aur WhatsApp live-location bhejne se pehle ab Aureon bolke
   poochega ("Confirm — ... bhejun? Haan ya nahi bolo"), aur sirf "haan"
   sunne par hi actually bhejta hai. Unclear jawab 2 baar aane par safe
   default "nahi" leta hai.

4. **Popup ek baar khule, phir hidden rehke background mein sunta rahe** —
   Ab pehle exchange ke baad `hide()` call hoti hai (Android
   VoiceInteractionSession ka public API) — session/listening chalta rehta
   hai, lekin overlay screen pe nahi dikhta. Agla command bologe to seedha
   action ho jayega (jaise WhatsApp khulna) bina popup dikhe. "Stop"/"cancel"
   bolne par ab session properly `finish()` hoti hai (pehle sirf pause hoti
   thi, band nahi hoti thi).

⚠️ **Test zaroor karo:** `hide()`/`finish()` calls Android's
VoiceInteractionSession API se hain — inka exact real-device behavior
(kya recognizer sach mein hidden state mein bhi chalta rehta hai bina
issue ke) verify nahi ho saka is sandboxed environment mein, real phone
pe hi confirm hoga.

## Round 7 — "thought_signature" error fix

Real Gemini API bug mila: naye "thinking" models (jo backend khud select
karta hai) ko function-call ke baad agle turn mein Gemini ka diya hua
`thought_signature` field **exactly wapas** bhejna zaroori hai — warna
"Didn't catch that... Function call is missing a thought_signature" error
aata hai, khaaskar 2nd+ tool-call (jaise open_app ke baad koi aur action)
pe.

**Fix 3 jagah:**
- `backend/server.js` — Gemini se mila `thoughtSignature` ab capture karke
  `/api/chat` response mein bhi bhejta hai, aur agle request mein turn
  banate waqt wapas include karta hai
- `www/app.js` — jab bhi `functionCall` wala assistant-turn messages array
  mein push hota hai, `thoughtSignature` bhi saath jaata hai
- `AureonVoiceInteractionSession.java` — same fix, dono jagah (normal
  action aur confirm-ke-baad-wala sensitive action path)

## Round 8 — tumhari uploaded "aureon-round6-patch-v3.zip"

Ye poora project nahi tha (sirf source files, gradlew/package.json wagera
missing — jaise pehle wale uploads) — isliye seedha use nahi ho sakta tha.
Maine ise round7 (latest) ke saath compare kiya:

- `AureonAgentActions.java`, `AureonActionsPlugin.java`, `backend/server.js`,
  `www/app.js` — inme koi naya nahi tha, sirf mera thoughtSignature fix
  missing tha (jo already round7 mein hai)
- **Asli naya cheez `OfflineVoiceCommandEngine.java` mein thi** — 3 genuinely
  useful naye offline (bina internet ke bhi chalne wale) features:
  1. **Recent SMS padhna** — "recent message padho" bolne par offline hi
     latest SMS padh ke bata deta hai (contact name lookup ke saath)
  2. **Email check karna** — mail app khol ke accessibility se jo screen pe
     dikhta hai wo padh leta hai
  3. **One-time location bhejna** — "Pavan ko location bhejo" bolne par
     current GPS location ka Maps link WhatsApp pe bhej deta hai (ye
     **live-location se alag hai** — sirf ek baar ka "abhi yahan hoon" link,
     continuous tracking nahi)

Teeno already merge ho chuke hain is zip mein — `MainActivity.java` aur
`AndroidManifest.xml` mein 3 naye permissions bhi add ho gaye
(READ_SMS, ACCESS_FINE_LOCATION, ACCESS_COARSE_LOCATION).

Code quality achhi thi — proper permission checks, cursor cleanup,
graceful fallback messages — bina kisi change ke merge ho gaya.

## Round 9 — build fix

Real Java compile error tha (`javac` FAILED): `AureonVoiceInteractionSession.java`
line 544 — `args` variable lambda ke andar capture ho rahi thi, lekin usse
pehle reassign kiya gaya tha (`if (args == null) args = new JSONObject();`)
— Java lambdas ko "effectively final" variables chahiye. Fix: `fName`/`fArgs`
naam ke final copies banaye, lambda unhe use karta hai ab.

## Round 10 — PDF confusion fix

**Bug nahi tha, confusing UX tha:** PDF generation asal mein pehle se
kaam karta hai — jab bhi message mein "pdf" word ho, reply ke **neeche
automatically ek "Save as PDF" button** aa jaata hai (`userAskedForPdf()`
check). Lekin AI ko iske baare mein pata hi nahi tha (ye AI ka tool call
nahi hai, sirf app ka apna UI hai), isliye jab user chat mein "PDF bana
do" bolta tha, AI khud confuse hoke keh deta tha "mera paas PDF tool
nahi hai" aur Notes-app copy-paste jaisa unrelated workaround sujhata
tha — jabki button waqai reply ke neeche already ban chuka hota tha.

**Fix:** System prompt (`AGENT_CAPABILITIES`) mein explicitly bata diya
ki ye feature exist karta hai — ab AI "PDF bana do" sunte hi "neeche
button se save kar lena" bolega, confusing manual instructions nahi
dega.

## Round 11 — chat horizontal scroll bug

Screenshot mein dikha: chat bubble screen se bahar chala gaya tha, poora
screen sideways scroll ho raha tha, sirf text ka left edge dikh raha tha.

**Fix:** `.msg` bubble mein `overflow-wrap: break-word` aur `word-break:
break-word` missing tha — lamba unbroken text (jaise koi URL ya bina-space
wala token) bubble ki 82% max-width se bahar overflow ho jaata tha aur
poori screen ko sideways scroll karva deta tha. `.messages` container aur
`html, body` mein bhi `overflow-x: hidden` add kiya safety-net ke taur pe.

## Round 12 — screen-control features

**Already kaam karta tha (check kiya, confirm ho gaya):**
- "Scroll" / "scroll up/down" — poora offline
- "Back" / "go back" — poora offline

**Naya add kiya:**
- **"3 dots" / "menu" click** — accessibility icon ki shakal "dekh" nahi
  sakti (ye camera nahi hai), sirf uska accessible label match kar sakti
  hai. Isliye "3 dots" bolne par ab common labels try karta hai ("More
  options", "More", "Menu", etc.) jo zyada apps use karte hain
- **Bina prefix ke naam bolke click** — "click Pavan" bolna zaroori nahi,
  ab sirf "Pavan" bolne se bhi (agar screen pe wo text dikh raha ho)
  click ho jayega. **Safety:** ye sirf tab try hota hai jab (1) koi aur
  command match na ho, (2) sirf 1-4 words wali chhoti phrase ho (poora
  sentence nahi), (3) Accessibility ON ho — taaki normal baat-cheet galti
  se kisi button ko na dabade

⚠️ **Ek honest limitation:** "3 dots" ka click **guarantee nahi hai** —
depend karta hai us app ne apne button ko kya accessible-label diya hai.
Kuch apps mein match ho jayega, kuch mein nahi (jaise agar unka label
"Options" ki jagah kuch bilkul alag ho) — real device pe test karke
dekhna hoga.

## Round 13 — Chat-attach PDF/DOCX/ZIP read na hona

**Real bug mila:** Jab PDF/DOCX/ZIP seedha chat mein attach karte the
(Knowledge-upload button se nahi, seedha attach icon se), file ka sirf
**naam** bhejta tha AI ko — content kabhi nikala hi nahi jaata tha
(code mein comment tak tha "we can't extract text client-side yet").
Isliye AI sach mein "main padh nahi paya" bol raha tha.

**Fix:**
- Naya lightweight backend endpoint `/api/extract-text` — Knowledge-upload
  wala hi extraction engine (PDF/DOCX/ZIP sab) use karta hai, lekin
  Firestore mein kuch save nahi karta, sirf text wapas deta hai (one-off
  chat-read ke liye, permanent knowledge-base ke liye nahi)
- `www/app.js` — ab PDF/DOCX/ZIP attach karte hi backend se text
  automatically nikal ke message ke saath AI ko bhejta hai
- Zip bhi isi fix se cover ho gaya (kyunki same `extractText()` function
  reuse hota hai jisme zip support pehle se hai)

## Round 14 — "message read nahi ho raha" bug

**Real bug mila:** SMS/message-read, email-read, aur screen-read — teeno
commands **exact-match** (`equalsAny`) use kar rahe the — matlab tumhe
LITERALLY "recent message" ya "read screen" jaisa exact phrase bolna
padta tha, koi bhi extra/alag word (jaise "message padho", "koi message
aaya kya") match hi nahi hota tha, aur Aureon chup reh jaata tha.

**Fix:** Teeno ko `containsAny` (loose match) mein badla, aur natural
Hinglish variants add kiye:
- Message: "message padho", "koi message", "naya message", "last message"
- Email: "email padho", "email check", "naya email", "koi email"  
- Screen: "screen padho", "ye padho", "kya likha hai", "isko padho"

## Round 15 — 2 naye uploads se merge (dusre AI se)

### 1. `aureon-orb-redesign-patch.zip`
Naya **`AureonEnergyOrbView.java`** — custom-drawn animated orb (purple/gold
glowing sphere, sparkles, rotation) jo plain yellow circle ki jagah
overlay mein wire kiya. Exact reference-video jaisa nahi hai (wo asli
video-render tha, code se replicate karna practical nahi), lekin
static circle se kaafi behtar/premium dikhega. `aureon_voice_overlay.xml`
aur `AureonVoiceInteractionSession.java` mein wire kiya (start/stop
animation lifecycle ke saath, memory-leak-safe).

**Bug jo maine merge karte waqt pakda aur fix kiya:** Ek galat `@Override`
annotation field declaration ke upar aa gaya tha (compile error), fix kiya.

### 2. `aureon-round6-patch-v5.zip`
- **Naya: Caller-ID feature** (`AureonCallReceiver.java`) — jo humne
  discuss kiya tha! Call aane par offline hi contact ka naam (ya number)
  bol deta hai. Manifest + MainActivity mein permissions (READ_PHONE_STATE,
  READ_CALL_LOG) bhi wire ki
- **Naya (EXPERIMENTAL): Call answer/decline by voice** — "call uthao"/
  "call katao" bolne par Accessibility se on-screen Answer/Decline button
  tap karne ki koshish karta hai. ⚠️ **Bahut phone-dependent hai** — kuch
  phones ka call-screen simple tappable button use karta hai (kaam karega),
  kuch swipe-gesture use karte hain (kaam nahi karega). Real Default-Dialer
  API abhi bhi nahi hai (wo possible hi nahi hai normal app ke liye)
- **Behtar message/email matching** — pehle (round14) mera fix tha
  phrase-list wala, is patch ka approach zyada flexible hai (do alag
  boolean check — "message/sms mention hua" + "read/check/padho jaisa
  kuch bola" — dono true ho to match) — isko adopt kiya, zyada natural
  phrasing cover karega
- Baaki sab (backend, app.js, style.css) us patch mein purana tha (mera
  round7-14 wala already aage tha) — kuch naya nahi tha unme

⚠️ **Test priority:** Caller-ID (naya, simple, high-confidence) pehle test
karo. Call-answer/decline (naya, experimental, phone-dependent) is baar
kaam kare ya na kare — dono normal hai, real-device result hi bata payega.

## Round 16 — Caller-ID reliability improve (v6 upload se)

**Real problem jo fix hua:** Static `BroadcastReceiver` (manifest-declared)
akela ColorOS/Realme jaise aggressive OEM phones pe **kabhi-kabhi kaam
nahi karta** — OS use app ke background mein hi kill/limit kar deta hai,
chahe Autostart/Battery-unrestricted ON ho.

**Fix:** Ek naya **foreground service** (`AureonCallListenerService`)
add kiya jo apna khud ka low-priority notification rakhke background
mein zinda rehta hai, aur uske andar ek dynamically-registered receiver
hai jo static receiver se zyada reliably chalta hai in phones pe. Dono
paths (static receiver + naya service) ab shared logic
(`AureonCallAnnouncer`) use karte hain — jo bhi pehle fire ho, kaam ho
jaata hai.

- Naye files: `AureonCallAnnouncer.java`, `AureonCallListenerService.java`
- Manifest: naya `<service>` (Android 14+ `specialUse` foreground-service
  type ke saath, jo sahi/updated Android requirement hai) +
  `FOREGROUND_SERVICE_SPECIAL_USE` permission
- `MainActivity.java`: app open hote hi service start hoti hai

Baaki files (backend, app.js, style.css, offline-engine) us upload mein
purane the (round7-15 ke fixes wahan nahi the) — kuch naya nahi liya
unse.

## Round 17 — Alarm naam bolna (smart workaround mila!)

**Maine pehle bataya tha:** "Alarm baje tab Aureon naam bole" ke liye
poora naya alarm-system banana padega (bada rewrite), kyunki Aureon
alarm ko Clock app ko handoff kar deta hai, uska control nahi rakhta.

**Ye galat nikla — behtar tareeka mil gaya.** `AureonAccessibilityService`
already system-wide chalti hai (lock screen ke upar bhi) — usi mein ek
naya check add kiya gaya: jab bhi screen pe "Snooze" word dikhe (jo
LAGBHAG SAB Android alarm-clock apps mein hota hai, chahe koi bhi brand
ho), Aureon samajh jaata hai "ye alarm-ringing screen hai" aur turant
screen ka text (jisme alarm ka naam bhi hota hai) TTS se bol deta hai.

**Koi naya rewrite nahi chahiye tha** — Clock-app-handoff wala existing
system waisa hi raha, bas Accessibility Service ko thoda smart bana diya.

⚠️ **Limitation:** Name-extraction crude hai (bas "snooze"/"dismiss"
words hata deta hai baaki text se) — agar screen pe time/date bhi ho to
wo bhi bol sakta hai naam ke saath. 15-second cooldown hai taaki baar-baar
na bole ek hi alarm ke liye.
