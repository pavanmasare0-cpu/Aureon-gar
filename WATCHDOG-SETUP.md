# Aureon Watchdog — Setup (one-time, ~5 min)

Do hisse hain: **backend watchdog** (Render pe, server-side problems pakadta
hai) aur **app watchdog** (phone pe, app crash pakadta hai) — dono ke
alerts same email pe aate hain.

## 1. MANDATORY — ek line MainActivity.java mein daalni hai

Ye is round ke zip mein nahi hai kyunki MainActivity.java is patch mein
shaamil nahi thi (sirf jo files badli unhi ko bheja). `MainActivity.java`
khol ke `onCreate()` ke **sabse upar** (super.onCreate() ke turant baad) ye
2 lines daal do:

```java
AureonCrashReporter.install(this);
AureonCrashReporter.reportPendingCrashIfAny(this);
```

Bina iske naya `AureonCrashReporter.java` file bani to hogi APK mein, lekin
kabhi activate nahi hogi — koi crash report nahi jayega.

## 2. Resend par free email-sending account banao (2 min)

Telegram ki jagah ab **email** use ho raha hai.

1. [resend.com](https://resend.com) pe free account banao (apni email se
   signup karo — wahi email jispe alerts chahiye)
2. Dashboard → **API Keys** → naya key banao, copy kar lo (kuch aisa
   dikhega: `re_123abc...`)
3. Free tier mein bina apna domain verify kiye, sirf **usi email pe** bhej
   sakte ho jisse account banaya tha — bas, owner ko khud ke alerts chahiye
   to ye perfect hai, kuch extra setup nahi chahiye.

## 3. Render mein 3 env vars add karo

Render dashboard → backend service → **Environment** tab → Add:

```
RESEND_API_KEY=<jo key Resend ne diya>
ALERT_EMAIL_TO=<tumhari email jispe alert aana chahiye>
ALERT_EMAIL_FROM=Aureon Watchdog <onboarding@resend.dev>
```

(`ALERT_EMAIL_FROM` optional hai — na do to ye default use hoga.)

Save karo — Render khud redeploy kar dega. Bas, ab backend AND app, dono
side ke problems tumhari email pe aayenge.

## 4. (Recommended) UptimeRobot — backend ko sone se bachana

Render free-tier backend 15 min idle rehne pe so jaata hai. Watchdog khud ye
nahi rok sakta (sota hua backend apna code bhi nahi chala sakta).

1. [uptimerobot.com](https://uptimerobot.com) pe free account banao
2. **+ New Monitor** → Monitor Type: `HTTP(s)`
3. URL: `https://aureone.onrender.com/health`
4. Monitoring Interval: `5 minutes`
5. Save

## Status check karna

Browser mein: `https://aureone.onrender.com/api/watchdog/status`
Uptime, provider health (Gemini/Groq theek hai ya "degraded"), aur recent
errors dikhenge — koi secret nahi isme, dekhna safe hai.

## Ye kya handle karta hai, kya nahi

**Backend side (`backend/watchdog.js`):**
- AI provider (Gemini) baar-baar fail ho raha ho → pattern-alert email (30
  min cooldown, spam nahi karega)
- Koi anjaan/naya error aaye (uncaught exception) → turant email, backend
  crash nahi hota, sirf wahi request fail hoti hai
- Backend internally hang ho jaye (apne hi /health ko 3 baar respond na
  kare) → turant email

**App side (`AureonCrashReporter.java`):**
- App kahin bhi crash ho (Love Camera, voice session, chat screen, kahin
  bhi) → crash disk pe save hota hai, agli baar app khulte hi backend ko
  bhejta hai → email aati hai
- App ka normal crash-behavior (system ka "app has stopped" dialog) waisa
  hi rehta hai — ye sirf ek side-channel report add karta hai, crash ko
  chhupata nahi

**Ye nahi karta** (jaanbhoojh kar): khud se code change karna, khud
redeploy karna, ya crash/bug ko khud "guess" karke fix karna. Structural
problem (naya Android version break kare, API format badal jaye) — uske
liye insaan dekhega; alert isliye hai taaki jaldi pata chal jaye, na ki
isliye ki koi insaan dekhne ki zaroorat hi na pade.
