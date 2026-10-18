# v12 — APK Studio + deploy watch (cumulative: includes v11)

## Kya naya
1. **📱 APK Studio** (`/api/apk/studio`, Sentinel dashboard ke header me link): jo app bolo (ecommerce, tracker, kuch bhi) -> Gemini poora app likhta hai -> GitHub Actions real APK banata hai -> download button.
   - Naye apps ka code alag branch `apk-apps` me jaata hai, isliye Render redeploy nahi hota.
   - "✏️ Badlao" se app me change, "📄 Source" se code download (khud edit karne ke liye).
   - "🔨 Build Aureon APK" = Aureon ki apni APK.
   - Sab kuch Sentinel wale owner lock (code/2FA) ke peeche.
2. **Deploy watch**: Sentinel me GitHub fix Approve karne ke baad server ko har 2 min ping karta hai (8 baar). Healthy = "deploy OK" mail. UP nahi aaya = **ROLLBACK proposal** (pichhla version) — tum Approve karte ho, auto-revert nahi.
3. **Ava** ko APK build / deploy-watch ki status line milti hai.

## Setup (ek baar)
1. GitHub -> Settings -> Developer settings -> Fine-grained token: repo select, **Contents: Read & write**, **Actions: Read & write**.
2. Render -> Environment: `GITHUB_TOKEN=<token>`, `APK_GH_REPO=owner/repo`.
3. Push karo (ye zip `.github/workflows/build-generated-apk.yml` bhi laata hai — wo **main** branch par hona zaruri hai).
4. Optional: GitHub secret `DEBUG_KEYSTORE_B64` (debug.keystore ka base64) — warna har build alag key se sign hota hai aur purani app ke upar update install nahi hota (pehle uninstall karna padega).

## Limits
Debug APK banti hai (install ke liye "unknown sources" allow karo). Generated app ek single-file web app hai (WebView me), localStorage me data — real payment/backend nahi.
