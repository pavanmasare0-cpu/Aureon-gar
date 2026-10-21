> **v9 update:** the full, integrated upgrade (SOC, firewall policy, threat intel, Windows endpoint agent, roles, backup/recovery, self-test) is described in `ENTERPRISE-V9-README.md`.

# Aureon Sentinel — Enterprise Hardening Upgrade (starter kit)

This ZIP preserves the supplied `Upgrade-1-security.zip` project and adds `enterprise-hardening/`, a small, testable set of defensive Node.js/Express building blocks.

## Included
- Security response headers and request IDs.
- Bounded, single-process rate limiter with standard response headers.
- Role guard example (must follow real authentication middleware).
- Production configuration validation and cryptographically random secret generator.
- Structured audit logging with basic sensitive-field redaction and newline sanitization.
- Express integration example and Node built-in tests.
- Original Aureon Security, Sentinel dashboard, Android phone-guard plugin and setup docs are retained.

## Run tests
Requires Node.js 20+:

```bash
cd enterprise-hardening
npm test
npm run check
```

## Integrate carefully
1. Back up the current application and run the tests.
2. Review `enterprise-hardening/examples/express-app.js`; do not replace your existing server blindly.
3. Mount request security before routes and before expensive parsing where possible. Keep the JSON parser limit small and suitable for your app.
4. Put `requireRole('admin')` only after verified authentication middleware. It does not authenticate a user itself.
5. Configure Express proxy trust only for the actual trusted proxy topology. Do not trust arbitrary `X-Forwarded-For` headers.
6. Set `AUREON_SESSION_SECRET` to a securely generated secret (never commit it). In production, the example fails closed if it is missing or too short.
7. Use shared Redis/gateway/WAF rate limiting for multiple server instances. The included memory limiter is not distributed and can be reset by restarting the process.
8. Send audit logs to a restricted, durable central log service in production. The included stdout logger is a starter only.

## Important limitations
This is **not** a finished Microsoft Defender replacement, kernel-level firewall, certified antivirus, production EDR, bank-grade product, or guarantee against compromise. The Windows Firewall/WFP enforcement, signed endpoint agent, distributed rate limiting, durable tamper-resistant audit storage, formal threat model, full auth/session integration, fuzzing, load tests, independent penetration test and incident-response validation still require implementation and verification. Never claim the product is secure solely because these starter tests pass.

## Suggested next engineering milestones
1. Audit all existing routes and authentication middleware; require deny-by-default authorization.
2. Add integration tests for every protected route, sessions, CSRF (where cookie auth is used), CORS, and secret rotation.
3. Use a shared rate-limit store and edge DDoS/WAF protection for public deployments.
4. Implement actual Windows firewall management through supported Windows APIs in a separately privileged, signed component. Keep the web API unprivileged and require explicit policy validation.
5. Build a safe scanner test corpus and measure false positives/false negatives.
6. Add signed updates, least-privilege service isolation, backup restoration drills, SBOM/dependency monitoring and independent penetration testing.
