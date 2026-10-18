# v13 — top black strip fix (cumulative: includes v11 + v12)
- **Pehli screen ke upar ka kala patta**: cutout mode ab Android 11+ par `ALWAYS` (pehle `SHORT_EDGES`, jo kuch phones — Oppo/Realme/Vivo — ignore karte hain). `MainActivity.java` + naya `res/values-v30/styles.xml` (theme me bhi `always`). Jo hissa phone phir bhi bahar chhode wo ab pure kala nahi, app jaisa dark (#0B0B14).
- Agar phir bhi patta dikhe: phone Settings -> Display me camera-cutout / full-screen display option me Aureon ko full screen allow karo (phone-dependent).
- APK **dobara build + install** karni padegi (ye native change hai, sirf Render redeploy se nahi hoga).
