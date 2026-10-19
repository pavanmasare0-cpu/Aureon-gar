# Ava Bank Domain — integration foundation

The original `backend/ava-self.js` has been preserved. Banking functionality is added separately in `backend/banking-core.js` and `backend/banking-schema.sql`.

## Bank permission status

`BANK_PARTNER_PERMISSION.json` is an onboarding/configuration checklist. It deliberately says `NOT_GRANTED` and keeps live transfers disabled. **Real bank permission cannot be created by changing source code**; it must be issued by a bank or authorized payment provider after business onboarding and approval. Do not claim approval or enable live transfers until the provider has explicitly authorized the product.

## Current foundation
- Transfer request validation using integer paise amounts
- Idempotency-key validation (in-memory only; production must use database uniqueness and provider-side idempotency)
- Authentication, fresh step-up verification, KYC and eligibility gates
- Audit event hooks that avoid storing banking secrets
- PostgreSQL starter schema for accounts, beneficiaries and transfer records
- Provider adapter boundary; no UPI/IMPS/NEFT/RTGS rail is implemented here

## Safety defaults
- `AVA_BANK_LIVE_ENABLED` is off unless explicitly set to `true`.
- Enabling the environment variable alone is **not** sufficient for live money movement. A real provider adapter, provider approval, secure production controls, and compliance review are required.
- Never store bank passwords, PINs, CVVs, OTPs, or raw payment credentials.
- Never treat a local database balance as real funds.

## Next steps for legitimate live integration
1. Contact a regulated bank/payment provider and obtain written approval for your exact business model.
2. Complete provider onboarding and compliance requirements.
3. Use provider-issued credentials and official API/SDK documentation; keep secrets in a secrets manager or protected environment variables.
4. Implement signed webhook verification, transaction state transitions, reversals/refunds, reconciliation, durable idempotency and a double-entry ledger.
5. Complete sandbox tests, required certification and an independent security review before any live customer transactions.
