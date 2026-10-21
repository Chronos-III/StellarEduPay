'use strict';

/**
 * emailWebhookMetrics.js — Prometheus metrics for inbound email provider
 * (bounce/complaint) webhooks. Issue #1537.
 *
 *   email_webhook_rejections_total{provider, reason}
 *     Counter. Incremented for every rejected webhook call (bad/missing
 *     signature, disallowed SNS topic, secret in query string, …). Rejected
 *     attempts are logged, never stored.
 */

const { registry } = require('./index');
const client = require('prom-client');

const emailWebhookRejectionsTotal = new client.Counter({
  name: 'email_webhook_rejections_total',
  help: 'Rejected email provider (bounce/complaint) webhook calls by provider and reason',
  labelNames: ['provider', 'reason'],
  registers: [registry],
});

/**
 * @param {string} provider  'ses' | 'sendgrid' | 'unknown'
 * @param {string} reason    stable rejection reason code
 */
function recordEmailWebhookRejection(provider, reason) {
  emailWebhookRejectionsTotal.inc({ provider: provider || 'unknown', reason: reason || 'UNKNOWN' });
}

module.exports = {
  emailWebhookRejectionsTotal,
  recordEmailWebhookRejection,
};
