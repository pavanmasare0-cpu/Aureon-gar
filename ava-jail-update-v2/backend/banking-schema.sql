-- PostgreSQL starter schema. Run only after review and migration planning.
-- Store provider tokens in a secret manager, never in these tables.
CREATE TABLE IF NOT EXISTS bank_accounts (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  provider_account_ref TEXT NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL CHECK (status IN ('pending','active','restricted','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider_account_ref)
);

CREATE TABLE IF NOT EXISTS bank_beneficiaries (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  provider_beneficiary_ref TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_verification','verified','blocked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider_beneficiary_ref)
);

CREATE TABLE IF NOT EXISTS bank_transfers (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  from_account_id UUID NOT NULL REFERENCES bank_accounts(id),
  beneficiary_id UUID NOT NULL REFERENCES bank_beneficiaries(id),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL CHECK (status IN (
    'pending_review','submitted','processing','succeeded','failed',
    'reversed','live_transfers_disabled'
  )),
  provider_reference TEXT,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS bank_transfers_user_created_idx
  ON bank_transfers (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bank_transfers_provider_ref_idx
  ON bank_transfers (provider_reference) WHERE provider_reference IS NOT NULL;

-- Production follow-up: immutable audit table, webhook inbox with unique event IDs,
-- reconciliation jobs, ledger with balanced double-entry postings, retention rules,
-- RLS policies, encryption/key rotation, and monitored alerting.
