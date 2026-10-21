'use strict';

/**
 * Reminder Controller
 *
 * Exposes admin endpoints to:
 *   POST /api/reminders/trigger  — manually fire a reminder run
 *   GET  /api/reminders/preview  — list students who would receive a reminder
 *   POST /api/reminders/opt-out  — opt a student's parent out of reminders
 *   GET  /api/reminders/unsubscribe — public confirmation page (no state change)
 *   POST /api/reminders/unsubscribe — public opt-out via token (incl. RFC 8058 one-click)
 *   POST /api/reminders/resubscribe — public undo of a token opt-out
 *   POST /api/students/:studentId/reminders/resubscribe — admin endpoint to re-enable reminders
 */

const Student = require('../models/studentModel');
const { processReminders } = require('../services/reminderService');
const { generateUnsubscribeToken, verifyUnsubscribeToken } = require('../utils/unsubscribeToken');
const config = require('../config');
const { escapeHtml } = require('../utils/escapeHtml');
const logger = require('../utils/logger').child('ReminderController');
const { logAudit } = require('../services/auditService');

const { REMINDER_COOLDOWN_HOURS, REMINDER_MAX_COUNT, JWT_SECRET } = config;

// Idempotency cache: per-school results cached for 60 seconds to deduplicate rapid requests
const IDEMPOTENCY_CACHE = new Map();
const IDEMPOTENCY_WINDOW_MS = 60 * 1000;

/**
 * POST /api/reminders/trigger
 * Manually trigger a reminder run for all schools (or a specific school via body).
 * Implements idempotency: rapid duplicate requests for the same school return cached result.
 */
async function triggerReminders(req, res, next) {
  try {
    const schoolId = req.schoolId || 'all-schools';
    const cacheKey = `reminder-trigger:${schoolId}`;
    const now = Date.now();

    // Check if a recent result exists in cache
    const cached = IDEMPOTENCY_CACHE.get(cacheKey);
    if (cached && (now - cached.timestamp) < IDEMPOTENCY_WINDOW_MS) {
      logger.info('Reminder trigger cache hit (deduplicated)', { schoolId, age: now - cached.timestamp });
      return res.json({ message: 'Reminder run complete (cached)', summary: cached.summary, deduped: true });
    }

    logger.info('Manual reminder trigger', { schoolId, triggeredBy: req.admin?.id || 'unknown' });
    const summary = await processReminders();

    // Cache the result for subsequent requests within the window
    IDEMPOTENCY_CACHE.set(cacheKey, { timestamp: now, summary });

    // Clean up old cache entries periodically
    if (IDEMPOTENCY_CACHE.size > 100) {
      for (const [key, val] of IDEMPOTENCY_CACHE.entries()) {
        if (now - val.timestamp > IDEMPOTENCY_WINDOW_MS) {
          IDEMPOTENCY_CACHE.delete(key);
        }
      }
    }

    res.json({ message: 'Reminder run complete', summary });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/reminders/preview
 * Returns the list of students who are currently eligible for a reminder,
 * without actually sending anything. Useful for admin review.
 */
async function previewReminders(req, res, next) {
  try {
    const { schoolId } = req; // injected by resolveSchool middleware

    const query = {
      feePaid:             false,
      parentEmail:         { $ne: null, $exists: true },
      reminderOptOut:      { $ne: true },
      parentEmailSuppressed: { $ne: true },
      reminderCount:       { $lt: REMINDER_MAX_COUNT },
    };

    if (schoolId) query.schoolId = schoolId;

    const cooldownCutoff = new Date(Date.now() - REMINDER_COOLDOWN_HOURS * 60 * 60 * 1000);

    // Students who have never been reminded OR whose cooldown has expired
    query.$or = [
      { lastReminderSentAt: null },
      { lastReminderSentAt: { $lte: cooldownCutoff } },
    ];

    const students = await Student.find(query)
      .select('studentId name class feeAmount remainingBalance parentEmail lastReminderSentAt reminderCount schoolId')
      .lean();

    res.json({
      count: students.length,
      cooldownHours: REMINDER_COOLDOWN_HOURS,
      maxReminders: REMINDER_MAX_COUNT,
      students,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/reminders/opt-out
 * Body: { studentId, optOut: true|false }
 * Allows a parent (or admin on their behalf) to opt out of reminders.
 */
async function setOptOut(req, res, next) {
  try {
    const { schoolId } = req;
    const { studentId, optOut } = req.body;

    if (!studentId || optOut === undefined) {
      return res.status(400).json({ error: 'studentId and optOut (boolean) are required', code: 'VALIDATION_ERROR' });
    }

    const student = await Student.findOneAndUpdate(
      { schoolId, studentId },
      { $set: { reminderOptOut: Boolean(optOut) } },
      { new: true }
    ).select('studentId name reminderOptOut');

    if (!student) {
      return res.status(404).json({ error: 'Student not found', code: 'NOT_FOUND' });
    }

    res.json({ studentId: student.studentId, name: student.name, reminderOptOut: student.reminderOptOut });
  } catch (err) {
    next(err);
  }
}

/**
 * Verify the unsubscribe token from the query string (or body) and load the
 * student it refers to. Sends the error response itself and returns null when
 * the token is missing/invalid or the student does not exist.
 */
async function resolveTokenStudent(req, res) {
  const token = req.query.token || (req.body && typeof req.body.token === 'string' ? req.body.token : undefined);

  if (!token || typeof token !== 'string') {
    res.status(400).json({ error: 'token query parameter is required', code: 'VALIDATION_ERROR' });
    return null;
  }

  const verification = verifyUnsubscribeToken(token, JWT_SECRET);
  if (!verification.valid) {
    res.status(400).json({ error: verification.error, code: 'INVALID_TOKEN' });
    return null;
  }

  const { studentId, schoolId } = verification;
  const student = await Student.findOne({ schoolId, studentId }).select('studentId name reminderOptOut');
  if (!student) {
    res.status(404).json({ error: 'Student not found', code: 'NOT_FOUND' });
    return null;
  }

  return { token, student, schoolId };
}

async function setTokenOptOut(schoolId, studentId, reminderOptOut) {
  return Student.findOneAndUpdate(
    { schoolId, studentId },
    { $set: { reminderOptOut } },
    { new: true }
  ).select('studentId name reminderOptOut');
}

function htmlPage(title, body) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 40px; max-width: 560px; }
    .success { color: green; }
    button { padding: 8px 16px; font-size: 14px; cursor: pointer; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * GET /api/reminders/unsubscribe?token=...
 * Public endpoint (no auth required).
 *
 * Issue #1542: GET must never change subscription state — email security
 * scanners (Safe Links, Mimecast, Proofpoint, …) pre-fetch every link in
 * inbound mail. This only renders a confirmation page; the opt-out itself is
 * performed by POST.
 */
async function unsubscribeViaToken(req, res, next) {
  try {
    const resolved = await resolveTokenStudent(req, res);
    if (!resolved) return;
    const { token, student } = resolved;

    // Escape all user-controlled values to prevent stored XSS. student.name is
    // fully attacker-controllable (set via POST /api/students, PUT, or CSV bulk
    // import) and this endpoint is public.
    const safeName      = escapeHtml(student.name);
    const safeStudentId = escapeHtml(student.studentId);
    const action        = `/api/reminders/unsubscribe?token=${encodeURIComponent(token)}`;

    const body = student.reminderOptOut
      ? `<h1>Already unsubscribed</h1>
<p>Fee reminders for student <strong>${safeName}</strong> (ID: ${safeStudentId}) are already turned off.</p>`
      : `<h1>Unsubscribe from fee reminders?</h1>
<p>You will stop receiving fee payment reminder emails for student <strong>${safeName}</strong> (ID: ${safeStudentId}).
Payment receipts and other school notices are not affected.</p>
<form method="POST" action="${escapeHtml(action)}">
  <button type="submit">Unsubscribe</button>
</form>`;

    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex');
    res.type('text/html').send(htmlPage('Unsubscribe from fee reminders', body));
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/reminders/unsubscribe?token=...
 * Public endpoint (no auth required) that performs the opt-out.
 *
 * Accepts:
 *   - RFC 8058 one-click requests from mailbox providers
 *     (application/x-www-form-urlencoded body "List-Unsubscribe=One-Click")
 *   - the confirmation form rendered by GET (returns an HTML page)
 *   - JSON/XHR requests from the frontend /unsubscribe page (returns JSON)
 */
async function confirmUnsubscribeViaToken(req, res, next) {
  try {
    const resolved = await resolveTokenStudent(req, res);
    if (!resolved) return;
    const { student, schoolId } = resolved;

    const updated = await setTokenOptOut(schoolId, student.studentId, true);
    logger.info('Reminder opt-out via unsubscribe token', {
      schoolId,
      studentId: student.studentId,
      oneClick: req.body?.['List-Unsubscribe'] === 'One-Click',
    });

    res.set('Cache-Control', 'no-store');

    if (req.body?.['List-Unsubscribe'] === 'One-Click') {
      return res.status(200).type('text/plain').send('Unsubscribed');
    }

    if (req.accepts(['json', 'html']) === 'html') {
      const safeName      = escapeHtml(updated.name);
      const safeStudentId = escapeHtml(updated.studentId);
      return res.type('text/html').send(htmlPage('Unsubscribed', `<h1 class="success">&#x2713; Unsubscribed</h1>
<p>You have been unsubscribed from fee reminders for student <strong>${safeName}</strong> (ID: ${safeStudentId}).</p>
<p>You can resubscribe at any time by contacting your school administrator.</p>`));
    }

    return res.json({ studentId: updated.studentId, name: updated.name, reminderOptOut: updated.reminderOptOut });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/reminders/resubscribe?token=...
 * Public endpoint (no auth required) backing the "undo" action on the
 * frontend /unsubscribe page. Uses the same signed token as unsubscribe.
 */
async function resubscribeViaToken(req, res, next) {
  try {
    const resolved = await resolveTokenStudent(req, res);
    if (!resolved) return;
    const { student, schoolId } = resolved;

    const updated = await setTokenOptOut(schoolId, student.studentId, false);
    logger.info('Reminder resubscribe via unsubscribe token', { schoolId, studentId: student.studentId });

    res.set('Cache-Control', 'no-store');
    return res.json({ studentId: updated.studentId, name: updated.name, reminderOptOut: updated.reminderOptOut });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/students/:studentId/reminders/resubscribe
 * Admin-only endpoint to re-enable reminders for a student.
 */
async function resubscribeReminders(req, res, next) {
  try {
    const { schoolId } = req;
    const { studentId } = req.params;

    const student = await Student.findOneAndUpdate(
      { schoolId, studentId },
      { $set: { reminderOptOut: false } },
      { new: true }
    ).select('studentId name reminderOptOut');

    if (!student) {
      return res.status(404).json({ error: 'Student not found', code: 'NOT_FOUND' });
    }

    await logAudit({
      schoolId,
      action: 'STUDENT_REMINDER_RESUBSCRIBED',
      performedBy: req.auditContext?.performedBy,
      ipAddress: req.auditContext?.ipAddress,
      userAgent: req.auditContext?.userAgent,
      targetId: studentId,
      targetType: 'student',
      details: { reminderOptOut: false },
    });

    res.json({ studentId: student.studentId, name: student.name, reminderOptOut: student.reminderOptOut });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  triggerReminders,
  previewReminders,
  setOptOut,
  unsubscribeViaToken,
  confirmUnsubscribeViaToken,
  resubscribeViaToken,
  resubscribeReminders,
};
