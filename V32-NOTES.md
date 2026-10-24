# v32 — live check
backend/tools/live-check.js : asli deployed server par Apps & Automation ka test (fake nahi).
Chalane ka tareeka:
  AUREON_EMAIL=tumhari@email AUREON_PASSWORD='password' node backend/tools/live-check.js
Optional: AUREON_URL=https://aureone.onrender.com (default), --keep (test app/automations delete na karo)
Ye sirf apna "LiveCheck ..." wala data banata hai aur end me delete kar deta hai.
