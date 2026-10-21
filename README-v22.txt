Aureon v22 (backend only; Render redeploy YES, APK rebuild NO)
- ava-desk.html/.js : Ava Studio (Pura project, Best UI chuno), prototype queue, auto-prototype setting
- ava-studio.js     : NEW multi-pass project builder + UI tournament (/api/sentinel/ava-studio)
- boss-orders.js    : NEW owner priority order queue (/api/sentinel/boss), from boss-failover-proxy
- ava-self.js       : jail queue + auto prototype cycle (from ava-jail-update-v3), higher limits, pro-quality prompt
- ava-jail-gate.js  : min 120 lines per prototype
- sentinel-dashboard.js : mounts studio + boss
Optional Render env: BOSS_ALLOWED_HOSTS, BOSS_API_KEYS, BOSS_MAX_ATTEMPTS
