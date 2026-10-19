'use strict';

/**
 * Ava Bank Domain — safe banking integration boundary.
 *
 * IMPORTANT:
 * - This is a foundation, not a licensed banking/payment product.
 * - No real transfers are enabled by this module itself.
 * - Real-money movement must be provided by a regulated bank/payment partner
 *   and must pass that partner's KYC/AML, sanctions, fraud, consent and limits.
 * - Never collect/store online-banking passwords, card PINs, CVVs, OTPs or raw
 *   payment credentials in Ava.
 */
const crypto = require('crypto');

const LIVE_ENABLED = process.env.AVA_BANK_LIVE_ENABLED === 'true';

function cleanReference(value) {
  return String(value || '').trim().slice(0, 100);
}
function validAmount(amount) {
  return Number.isSafeInteger(amount) && amount > 0; // integer minor units, e.g. paise
}
function idempotencyKey(value) {
  const key = String(value || '');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) {
    const err = new Error('A valid idempotency key (16–128 chars) is required.');
    err.statusCode = 400;
    throw err;
  }
  return key;
}

/**
 * Creates a transfer service around a provider adapter supplied by the app.
 * provider must be a regulated partner adapter; this module does not implement
 * payment rails or simulate a successful real-world transfer.
 */
function createBankDomain({ provider, audit = () => {}, limits = {} } = {}) {
  const maxAmountMinor = Number.isSafeInteger(limits.maxAmountMinor)
    ? limits.maxAmountMinor : 100000; // default cap: ₹1,000 in paise
  const seen = new Map(); // process-local protection only; production must use a DB unique constraint.

  async function createTransfer(input, context = {}) {
    if (!input || typeof input !== 'object') {
      const e = new Error('Transfer details are required.'); e.statusCode = 400; throw e;
    }
    const key = idempotencyKey(input.idempotencyKey);
    const fromAccountRef = cleanReference(input.fromAccountRef);
    const toBeneficiaryRef = cleanReference(input.toBeneficiaryRef);
    const amountMinor = input.amountMinor;
    const currency = String(input.currency || 'INR').toUpperCase();

    if (!fromAccountRef || !toBeneficiaryRef || fromAccountRef === toBeneficiaryRef) {
      const e = new Error('Valid source account and different beneficiary references are required.');
      e.statusCode = 400; throw e;
    }
    if (!validAmount(amountMinor) || amountMinor > maxAmountMinor) {
      const e = new Error('Amount must be a positive integer in paise and within the configured limit.');
      e.statusCode = 400; throw e;
    }
    if (currency !== 'INR') {
      const e = new Error('Only INR is configured in this starter.'); e.statusCode = 400; throw e;
    }
    if (!context.userId || !context.authenticated || !context.stepUpVerified) {
      const e = new Error('Authenticated user and fresh step-up verification are required.');
      e.statusCode = 401; throw e;
    }
    if (!context.kycApproved || !context.eligibleForTransfers) {
      const e = new Error('Account is not eligible for transfers; complete partner KYC/eligibility checks.');
      e.statusCode = 403; throw e;
    }
    if (seen.has(key)) return seen.get(key);

    const transfer = {
      id: crypto.randomUUID(),
      status: 'pending_review',
      amountMinor,
      currency,
      fromAccountRef,
      toBeneficiaryRef,
      createdAt: new Date().toISOString(),
      userId: String(context.userId),
      providerReference: null
    };
    // Audit metadata only. Never pass secrets, OTPs, PINs or full account numbers.
    audit({ event: 'bank.transfer.requested', transferId: transfer.id,
      userId: transfer.userId, amountMinor, currency, at: transfer.createdAt });

    // Default is deliberately non-live. No fake success response is returned.
    if (!LIVE_ENABLED) {
      transfer.status = 'live_transfers_disabled';
      seen.set(key, transfer);
      return transfer;
    }
    if (!provider || typeof provider.createTransfer !== 'function') {
      const e = new Error('Live transfers require a configured regulated-provider adapter.');
      e.statusCode = 503; throw e;
    }

    // Provider adapter must independently enforce compliance, limits, fraud checks,
    // beneficiary verification, authorization and idempotency at its own boundary.
    const result = await provider.createTransfer({
      idempotencyKey: key, fromAccountRef, toBeneficiaryRef, amountMinor, currency,
      customerReference: transfer.id
    });
    transfer.status = result && result.status === 'accepted' ? 'submitted' : 'pending_review';
    transfer.providerReference = cleanReference(result && result.reference) || null;
    seen.set(key, transfer);
    audit({ event: 'bank.transfer.provider_result', transferId: transfer.id,
      status: transfer.status, at: new Date().toISOString() });
    return transfer;
  }

  return { createTransfer };
}

module.exports = { createBankDomain };
