'use strict';

/**
 * Webhook signature-version policy — Issue #1539.
 *
 * Outbound deliveries can carry two signatures:
 *   v1 — X-StellarEduPay-Signature     (deprecated; body only, replayable)
 *   v2 — X-StellarEduPay-Signature-V2  (timestamp.deliveryId.rawBody)
 *
 * Each WebhookEndpoint chooses which versions it receives via its
 * `signatureVersions` field. On top of that, V1 is never emitted after the
 * WEBHOOK_V1_SUNSET date (default 2027-02-28, inclusive), so removing V1 is a
 * configuration date rather than a future code change.
 */

const DEFAULT_V1_SUNSET = '2027-02-28';

// Versions sent to the legacy single-URL path (School.webhookUrl), which has
// no per-endpoint configuration. Keeps the historical dual-signing behaviour
// until the sunset date.
const LEGACY_SIGNATURE_VERSIONS = Object.freeze(['v1', 'v2']);

/**
 * Parse WEBHOOK_V1_SUNSET. Accepts a YYYY-MM-DD date (V1 is still sent for
 * the whole of that UTC day) or a full ISO-8601 timestamp.
 *
 * @param {string} [raw]
 * @returns {Date} the first instant at which V1 is no longer emitted
 */
function parseV1Sunset(raw = process.env.WEBHOOK_V1_SUNSET || DEFAULT_V1_SUNSET) {
  const value = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const day = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(day.getTime())) throw new Error(`Invalid WEBHOOK_V1_SUNSET: ${value}`);
    return new Date(day.getTime() + 24 * 60 * 60 * 1000);
  }
  const ts = new Date(value);
  if (Number.isNaN(ts.getTime())) {
    throw new Error(`Invalid WEBHOOK_V1_SUNSET: ${value} (expected YYYY-MM-DD or ISO-8601)`);
  }
  return ts;
}

/**
 * @param {Date} [now]
 * @returns {boolean} true once V1 signatures must no longer be emitted
 */
function isV1Sunset(now = new Date()) {
  return now.getTime() >= parseV1Sunset().getTime();
}

/**
 * Resolve the signature versions actually emitted for a delivery.
 *
 * @param {string[]|null|undefined} requested  endpoint.signatureVersions
 *                                             (null → legacy default)
 * @param {Date} [now]
 * @returns {string[]} subset of ['v1','v2'], never empty — falls back to v2
 */
function resolveSignatureVersions(requested, now = new Date()) {
  const base = Array.isArray(requested) && requested.length > 0
    ? requested
    : LEGACY_SIGNATURE_VERSIONS;
  let versions = [...new Set(base.filter((v) => v === 'v1' || v === 'v2'))];
  if (isV1Sunset(now)) versions = versions.filter((v) => v !== 'v1');
  if (versions.length === 0) versions = ['v2'];
  return versions.sort();
}

/**
 * Metric label for a delivery's signature set, e.g. 'v1+v2', 'v2', 'none'.
 *
 * @param {string[]} versions
 * @param {boolean} signed
 * @returns {string}
 */
function signatureVersionLabel(versions, signed) {
  if (!signed || !versions || versions.length === 0) return 'none';
  return [...versions].sort().join('+');
}

module.exports = {
  DEFAULT_V1_SUNSET,
  LEGACY_SIGNATURE_VERSIONS,
  parseV1Sunset,
  isV1Sunset,
  resolveSignatureVersions,
  signatureVersionLabel,
};
