Aureon v25 = v24 (Ava Desk/Studio/Boss/APK) + Sentinel Enterprise v9 (SOC, firewall, threat intel,
Windows endpoint agent, operators/RBAC, hash-chained audit, signed backup/recovery, schema validation).
- Stealth mode REMOVED (login page hamesha dikhega). Cookie SameSite=Lax, iframe SAMEORIGIN (desk ke liye).
- Viewer/analyst operator sirf padh sakta hai; Sentinel/Ava/Studio/Boss/APK me badlaav sirf admin.
Render env: SENTINEL_OWNER_CODE (pehle se), SENTINEL_ENC_KEY (naya, signed backup/operators ke liye).
Optional: SECURITY_THREAT_FEEDS=off. Test: node --test backend/tests/security.test.js
