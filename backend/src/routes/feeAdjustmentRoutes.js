'use strict';

const express = require('express');
const router = express.Router();
const {
  createRule,
  listRules,
  updateRule,
  deleteRule,
  getAffectedCount,
  dryRunRule,
  applyRule,
} = require('../controllers/feeAdjustmentController');
const { resolveSchool } = require('../middleware/schoolContext');
const { requireAdminAuth, requireSchoolAuth } = require('../middleware/auth');
const { auditContext } = require('../middleware/auditContext');

router.use(resolveSchool);

// ── CRUD ─────────────────────────────────────────────────────────────────────
router.post('/',      requireSchoolAuth(['owner']), auditContext, createRule);
router.get('/',       requireSchoolAuth(['owner', 'staff', 'read_only']), listRules);
router.put('/:id',    requireSchoolAuth(['owner']), auditContext, updateRule);
router.delete('/:id', requireSchoolAuth(['owner']), auditContext, deleteRule);

// #1355 — affected-student count shown in the delete confirmation modal
router.get('/:id/affected-count', requireSchoolAuth(['owner']), getAffectedCount);

// ── #901 Dry-run preview ─────────────────────────────────────────────────────
// POST /api/fee-adjustments/dry-run
// Simulate a rule against the current student cohort without persisting.
// Precedence: rules sorted by priority ASC (lower = higher precedence), then name.
router.post('/dry-run', requireSchoolAuth(['owner']), auditContext, dryRunRule);

// ── #902 Batch/transactional apply ───────────────────────────────────────────
// POST /api/fee-adjustments/:id/apply
// Apply an existing rule to matching students via bulkWrite inside a session.
router.post('/:id/apply', requireSchoolAuth(['owner']), auditContext, applyRule);

module.exports = router;
