'use strict';

const WebhookRetry = require('../models/webhookRetryModel');
const WebhookEndpoint = require('../models/webhookEndpointModel');
const School = require('../models/schoolModel');
const { parseV1Sunset, isV1Sunset } = require('../utils/webhookSignaturePolicy');
const logger = require('../utils/logger');
const { logAudit } = require('../services/auditService');

/**
 * GET /api/admin/webhooks/dlq
 * Lists exhausted webhook deliveries (status: failed). Supports ?page and ?limit.
 */
async function listDLQ(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      WebhookRetry.find({ status: 'failed' })
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      WebhookRetry.countDocuments({ status: 'failed' }),
    ]);

    res.json({ total, page, limit, items });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/webhooks/dlq/:id/retry
 * Re-queues a single exhausted delivery for immediate retry.
 * Resets attempt count so it gets a full retry budget again.
 * Only accepts deliveries in 'failed' state.
 */
async function retryDLQEntry(req, res, next) {
  try {
    const entry = await WebhookRetry.findById(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Webhook delivery not found' });
    if (entry.status !== 'failed') {
      return res.status(409).json({ error: 'Delivery is not in failed state', status: entry.status });
    }

    await WebhookRetry.updateOne(
      { _id: entry._id },
      {
        $set: {
          status: 'pending',
          attemptCount: 0,
          nextRetryAt: new Date(),
          lastError: null,
          leasedAt: null,
          leasedBy: null,
        },
      }
    );

    logger.info('DLQ entry re-queued by admin', { deliveryId: entry.deliveryId, url: entry.url });

    await logAudit({
      schoolId: 'system',
      action: 'webhook_dlq_retry',
      performedBy: req.auditContext?.performedBy || 'unknown',
      targetId: String(entry._id),
      targetType: 'webhook',
      details: {
        deliveryId: entry.deliveryId,
        url: entry.url,
        event: entry.event,
        previousAttemptCount: entry.attemptCount,
      },
      result: 'success',
      ipAddress: req.auditContext?.ipAddress,
      userAgent: req.auditContext?.userAgent,
    });

    res.json({ success: true, deliveryId: entry.deliveryId });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/webhooks/:id/replay — Issue #73
 *
 * Manual replay endpoint for any webhook delivery regardless of status.
 * Unlike /dlq/:id/retry (which only accepts 'failed' entries), this endpoint
 * accepts deliveries in any state and immediately re-queues them for delivery.
 *
 * Use cases:
 *   - Replay a 'failed' delivery after a receiver outage is resolved.
 *   - Force immediate re-delivery of a 'pending' delivery (e.g. stuck clock).
 *   - Re-deliver a 'succeeded' delivery when the receiver lost the event.
 *
 * By default, attemptCount is reset to 0 so the delivery gets a fresh
 * retry budget. Pass ?resetAttempts=false to preserve the current count
 * (useful when re-delivering a succeeded event without burning a retry slot).
 */
async function replayWebhook(req, res, next) {
  try {
    const entry = await WebhookRetry.findById(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Webhook delivery not found' });

    const resetAttempts = req.query.resetAttempts !== 'false'; // default: true

    const update = {
      $set: {
        status: 'pending',
        nextRetryAt: new Date(), // immediate
        lastError: null,
        leasedAt: null,
        leasedBy: null,
      },
    };

    if (resetAttempts) {
      update.$set.attemptCount = 0;
    }

    await WebhookRetry.updateOne({ _id: entry._id }, update);

    logger.info('Webhook replay triggered by admin', {
      deliveryId: entry.deliveryId,
      url: entry.url,
      previousStatus: entry.status,
      resetAttempts,
    });

    res.json({
      success: true,
      deliveryId: entry.deliveryId,
      previousStatus: entry.status,
      resetAttempts,
    });
  } catch (err) {
    next(err);
  }
}

// ── V1 signature sunset — Issue #1539 ────────────────────────────────────────

/**
 * Build the report of active endpoints still configured to receive the
 * deprecated V1 signature, grouped by school with the school's contact
 * addresses (used to send the promised advance-notice emails).
 */
async function _buildV1Report() {
  const endpoints = await WebhookEndpoint.find({ isActive: true, signatureVersions: 'v1' })
    .select('_id schoolId url description signatureVersions createdAt')
    .sort({ schoolId: 1, createdAt: 1 })
    .lean();

  const schoolIds = [...new Set(endpoints.map((e) => e.schoolId))];
  const schools = schoolIds.length
    ? await School.find({ schoolId: { $in: schoolIds } })
      .select('schoolId name adminEmail contactEmail')
      .lean()
    : [];
  const bySchool = new Map(schools.map((s) => [s.schoolId, s]));

  const grouped = new Map();
  for (const ep of endpoints) {
    if (!grouped.has(ep.schoolId)) {
      const school = bySchool.get(ep.schoolId) || {};
      grouped.set(ep.schoolId, {
        schoolId: ep.schoolId,
        schoolName: school.name || null,
        contactEmail: school.contactEmail || school.adminEmail || null,
        endpoints: [],
      });
    }
    grouped.get(ep.schoolId).endpoints.push({
      id: String(ep._id),
      url: ep.url,
      description: ep.description || null,
      signatureVersions: ep.signatureVersions,
      createdAt: ep.createdAt,
    });
  }

  const sunsetAt = parseV1Sunset();
  return {
    v1SunsetAt: sunsetAt.toISOString(),
    v1Sunset: isV1Sunset(),
    totalEndpoints: endpoints.length,
    totalSchools: grouped.size,
    schools: [...grouped.values()],
  };
}

/**
 * GET /api/admin/webhooks/v1-endpoints
 * Lists active webhook endpoints still receiving the deprecated V1 signature.
 */
async function listV1Endpoints(req, res, next) {
  try {
    res.json(await _buildV1Report());
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/webhooks/v1-endpoints/notify
 * Emails each affected school's contact address an advance notice that V1
 * signatures stop on the sunset date. Pass { "dryRun": true } to preview the
 * recipients without sending.
 */
async function notifyV1Endpoints(req, res, next) {
  try {
    const dryRun = req.body?.dryRun === true;
    const report = await _buildV1Report();
    const sunsetDate = report.v1SunsetAt.slice(0, 10);
    const { sendEmail } = require('../services/email');

    const results = [];
    for (const school of report.schools) {
      if (!school.contactEmail) {
        results.push({ schoolId: school.schoolId, status: 'skipped', reason: 'NO_CONTACT_EMAIL' });
        continue;
      }
      if (dryRun) {
        results.push({ schoolId: school.schoolId, status: 'dry_run', to: school.contactEmail });
        continue;
      }

      const urls = school.endpoints.map((e) => `  - ${e.url} (endpoint ${e.id})`).join('\n');
      try {
        await sendEmail({
          to: school.contactEmail,
          subject: `Action required: StellarEduPay V1 webhook signatures end after ${sunsetDate}`,
          category: 'webhook_v1_sunset_notice',
          text: [
            `Hello${school.schoolName ? ` ${school.schoolName}` : ''},`,
            '',
            'The following webhook endpoints still receive the deprecated V1 signature header',
            '(X-StellarEduPay-Signature):',
            '',
            urls,
            '',
            `V1 signatures will no longer be sent after ${sunsetDate}. Please verify the`,
            'X-StellarEduPay-Signature-V2 header instead (see docs/WEBHOOK_INTEGRATION.md),',
            'then opt out of V1 early with:',
            '',
            '  PUT /api/webhook-endpoints/:id  { "signatureVersions": ["v2"] }',
          ].join('\n'),
        });
        results.push({ schoolId: school.schoolId, status: 'sent', to: school.contactEmail });
      } catch (err) {
        logger.error('Failed to send V1 sunset notice', { schoolId: school.schoolId, error: err.message });
        results.push({ schoolId: school.schoolId, status: 'failed', reason: 'SEND_FAILED' });
      }
    }

    await logAudit({
      schoolId: 'system',
      action: 'webhook_v1_sunset_notice',
      performedBy: req.auditContext?.performedBy || 'unknown',
      targetId: 'webhook_v1_sunset',
      targetType: 'school',
      details: {
        dryRun,
        v1SunsetAt: report.v1SunsetAt,
        sent: results.filter((r) => r.status === 'sent').length,
        failed: results.filter((r) => r.status === 'failed').length,
        skipped: results.filter((r) => r.status === 'skipped').length,
      },
      result: 'success',
      ipAddress: req.auditContext?.ipAddress,
      userAgent: req.auditContext?.userAgent,
    });

    res.json({ dryRun, v1SunsetAt: report.v1SunsetAt, results });
  } catch (err) {
    next(err);
  }
}

module.exports = { listDLQ, retryDLQEntry, replayWebhook, listV1Endpoints, notifyV1Endpoints };
