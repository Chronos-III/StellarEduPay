'use strict';

/**
 * Migration 030 — Encrypt existing plaintext WebhookEndpoint.secret values.
 *
 * Issue #1538: School.webhookSecret has been encrypted at rest since #75
 * (migration 021), but the per-endpoint HMAC secret used by the multi-endpoint
 * webhook system (WebhookEndpoint.secret) was stored in plaintext. Anyone with
 * read access to the webhookendpoints collection (a leaked backup, a read-only
 * DB user) could forge signed deliveries to every integrator.
 *
 * This migration encrypts every endpoint's `secret` (and `previousSecret`, the
 * rotation-overlap secret) with AES-256-GCM, reusing webhookSecretEncryption —
 * the same helper and WEBHOOK_SECRET_ENCRYPTION_KEY that protect
 * School.webhookSecret, so key rotation (scripts/rotate-webhook-encryption-key.js)
 * covers both collections.
 *
 * Idempotent: values already encrypted (prefixed with "enc:") are skipped.
 *
 * Prerequisites:
 *   Set WEBHOOK_SECRET_ENCRYPTION_KEY to a 64-char hex string before running.
 *   If the key is not set, the migration is a no-op (logged as skipped) and
 *   secrets stay plaintext — set the key and re-run.
 *
 * Rollback:
 *   down() decrypts every encrypted value back to plaintext. Only run it if
 *   you are reverting the feature entirely.
 */

const VERSION = '030_encrypt_webhook_endpoint_secrets';

const SECRET_FIELDS = ['secret', 'previousSecret'];

function _crypto() {
  return require('../src/services/webhookSecretEncryption');
}

async function up() {
  const mongoose = require('mongoose');
  const { encryptWebhookSecret, isEncryptionEnabled, isEncrypted } = _crypto();

  if (!isEncryptionEnabled()) {
    console.log('[Migration 030] WEBHOOK_SECRET_ENCRYPTION_KEY is not set. Skipping encryption.');
    console.log('[Migration 030] Set the key and re-run to encrypt webhook endpoint secrets at rest.');
    return;
  }

  const endpoints = mongoose.connection.collection('webhookendpoints');
  const cursor = endpoints.find({
    $or: SECRET_FIELDS.map((f) => ({ [f]: { $type: 'string' } })),
  });

  let encrypted = 0;
  let skipped = 0;

  for await (const ep of cursor) {
    const set = {};
    for (const field of SECRET_FIELDS) {
      const value = ep[field];
      if (typeof value === 'string' && value.length > 0 && !isEncrypted(value)) {
        set[field] = encryptWebhookSecret(value);
      }
    }
    if (Object.keys(set).length > 0) {
      await endpoints.updateOne({ _id: ep._id }, { $set: set });
      encrypted++;
    } else {
      skipped++;
    }
  }

  console.log(`[Migration 030] Webhook endpoints: ${encrypted} encrypted, ${skipped} already encrypted.`);
}

async function down() {
  const mongoose = require('mongoose');
  const { decryptWebhookSecret, isEncryptionEnabled, isEncrypted } = _crypto();

  if (!isEncryptionEnabled()) {
    console.log('[Migration 030] WEBHOOK_SECRET_ENCRYPTION_KEY is not set. Cannot decrypt.');
    return;
  }

  const endpoints = mongoose.connection.collection('webhookendpoints');
  const cursor = endpoints.find({
    $or: SECRET_FIELDS.map((f) => ({ [f]: { $regex: '^enc:' } })),
  });

  let decrypted = 0;
  let failed = 0;

  for await (const ep of cursor) {
    const set = {};
    let ok = true;
    for (const field of SECRET_FIELDS) {
      const value = ep[field];
      if (!isEncrypted(value)) continue;
      const plaintext = decryptWebhookSecret(value);
      // decryptWebhookSecret returns the input unchanged when it cannot decrypt.
      if (isEncrypted(plaintext)) {
        ok = false;
        break;
      }
      set[field] = plaintext;
    }
    if (!ok) {
      failed++;
      continue;
    }
    if (Object.keys(set).length > 0) {
      await endpoints.updateOne({ _id: ep._id }, { $set: set });
      decrypted++;
    }
  }

  console.log(`[Migration 030] Rolled back. Decrypted ${decrypted} webhook endpoint(s).`);
  if (failed > 0) {
    throw new Error(
      `[Migration 030] ${failed} webhook endpoint(s) could not be decrypted with the configured key(s).`
    );
  }
}

module.exports = { version: VERSION, up, down };
