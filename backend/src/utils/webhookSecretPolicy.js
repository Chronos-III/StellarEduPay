'use strict';

/**
 * Webhook signing-secret policy — Issue #1538.
 *
 * Per-endpoint HMAC secrets are either generated server-side (preferred) or
 * supplied by the integrator. Caller-supplied secrets must be long enough and
 * carry enough estimated entropy that they cannot be guessed or brute-forced
 * (e.g. "secret": "a" is rejected).
 */

const crypto = require('crypto');

// 32 random bytes → 64 hex characters (256 bits). Used for generated secrets.
const GENERATED_SECRET_BYTES = 32;

// Minimum length of a caller-supplied secret, in characters.
const MIN_SECRET_LENGTH = 32;

// Maximum length accepted, to bound HMAC key handling and storage.
const MAX_SECRET_LENGTH = 512;

// Minimum estimated entropy (bits) of a caller-supplied secret. The estimate
// is the empirical Shannon entropy per character multiplied by the length —
// a conservative lower bound that rejects repetitive or low-variety strings
// ("aaaa…", "abababab…") while accepting any randomly generated hex, base64
// or base64url secret of MIN_SECRET_LENGTH characters or more.
const MIN_SECRET_ENTROPY_BITS = 128;

/**
 * Generate a new random webhook signing secret (64 hex characters).
 *
 * @returns {string}
 */
function generateWebhookSecret() {
  return crypto.randomBytes(GENERATED_SECRET_BYTES).toString('hex');
}

/**
 * Estimate the total entropy (in bits) of a string from its character
 * frequency distribution.
 *
 * @param {string} value
 * @returns {number}
 */
function estimateEntropyBits(value) {
  if (!value) return 0;
  const counts = new Map();
  for (const ch of value) counts.set(ch, (counts.get(ch) || 0) + 1);
  const len = value.length;
  let perChar = 0;
  for (const count of counts.values()) {
    const p = count / len;
    perChar -= p * Math.log2(p);
  }
  return perChar * len;
}

/**
 * Validate a caller-supplied webhook secret.
 *
 * @param {*} secret
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateWebhookSecretStrength(secret) {
  if (typeof secret !== 'string') {
    return { valid: false, reason: 'secret must be a string' };
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    return { valid: false, reason: `secret must be at least ${MIN_SECRET_LENGTH} characters` };
  }
  if (secret.length > MAX_SECRET_LENGTH) {
    return { valid: false, reason: `secret must be at most ${MAX_SECRET_LENGTH} characters` };
  }
  if (/\s/.test(secret)) {
    return { valid: false, reason: 'secret must not contain whitespace' };
  }
  if (estimateEntropyBits(secret) < MIN_SECRET_ENTROPY_BITS) {
    return {
      valid: false,
      reason: 'secret is too predictable; omit it to have a strong secret generated for you',
    };
  }
  return { valid: true };
}

module.exports = {
  generateWebhookSecret,
  validateWebhookSecretStrength,
  estimateEntropyBits,
  MIN_SECRET_LENGTH,
  MAX_SECRET_LENGTH,
  MIN_SECRET_ENTROPY_BITS,
};
