'use strict';

/**
 * Migration 031 — Backfill WebhookEndpoint.signatureVersions.
 *
 * Issue #1539: deliveries used to carry both the deprecated V1 signature
 * (X-StellarEduPay-Signature) and V2 (X-StellarEduPay-Signature-V2)
 * unconditionally. Endpoints now choose which versions they receive via
 * `signatureVersions`. New endpoints default to ['v2']; every endpoint that
 * existed before this change keeps today's behaviour, ['v1', 'v2'], until it
 * opts out via PUT /api/webhook-endpoints/:id or V1 reaches its sunset date
 * (WEBHOOK_V1_SUNSET, default 2027-02-28).
 *
 * Idempotent: only documents without a signatureVersions field are touched.
 *
 * Rollback:
 *   down() removes signatureVersions from documents still on exactly
 *   ['v1', 'v2'] (i.e. those this migration backfilled and that never opted
 *   out). Endpoints that changed their setting keep it.
 */

const VERSION = '031_backfill_webhook_signature_versions';

async function up() {
  const mongoose = require('mongoose');
  const endpoints = mongoose.connection.collection('webhookendpoints');

  const result = await endpoints.updateMany(
    { signatureVersions: { $exists: false } },
    { $set: { signatureVersions: ['v1', 'v2'] } }
  );

  await endpoints.createIndex({ signatureVersions: 1, isActive: 1 });

  console.log(`[Migration 031] Backfilled signatureVersions on ${result.modifiedCount} webhook endpoint(s).`);
}

async function down() {
  const mongoose = require('mongoose');
  const endpoints = mongoose.connection.collection('webhookendpoints');

  const result = await endpoints.updateMany(
    { signatureVersions: { $all: ['v1', 'v2'], $size: 2 } },
    { $unset: { signatureVersions: '' } }
  );

  try {
    await endpoints.dropIndex('signatureVersions_1_isActive_1');
  } catch (_) {
    // Index may not exist — nothing to drop.
  }

  console.log(`[Migration 031] Rolled back. Removed signatureVersions from ${result.modifiedCount} webhook endpoint(s).`);
}

module.exports = { version: VERSION, up, down };
