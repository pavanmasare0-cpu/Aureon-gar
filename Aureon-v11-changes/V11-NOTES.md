# v11 — kya badla (merged)
1. **Sentinel login:** session cookie `SameSite=Strict` -> `Lax` (app se khulne par Chrome Strict cookie redirect ke baad nahi bhejta tha, sahi code par bhi "Cannot GET"). Code compare ab spaces/quotes ignore karta hai. (`backend/dash-auth.js`)
2. **Keyboard bug:** full-screen mein `adjustResize` kaam nahi karta tha; ab `aureonKeyboardResize()` keyboard ki height ke hisaab se content chhota karta hai. (`MainActivity.java`)
3. **Multi photo:** ➕ dabane par bottom sheet (Claude app jaisi): Photos (gallery, tap se kai photos) / Files (pdf, zip, doc, video). (`www/index.html`, `www/app.js`)

Deploy: push -> Render redeploy; `npx cap sync android`; APK rebuild.
