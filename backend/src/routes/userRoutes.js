'use strict';

const express = require('express');
const router = express.Router();
const { requireAdminAuth, requireSchoolAuth } = require('../middleware/auth');
const {
  createUser,
  listUsers,
  getUser,
  updateUser,
  deleteUser,
  createSchoolUser,
  listSchoolUsers,
  updateSchoolUser,
  setPassword,
  requestPasswordReset,
  resetPassword,
} = require('../controllers/userController');

// ── Super-admin endpoints ──────────────────────────────────────────────────────
router.post('/admin/users', requireAdminAuth, createUser);
router.get('/admin/users', requireAdminAuth, listUsers);
router.get('/admin/users/:userId', requireAdminAuth, getUser);
router.patch('/admin/users/:userId', requireAdminAuth, updateUser);
router.delete('/admin/users/:userId', requireAdminAuth, deleteUser);

// ── School-owner endpoints ─────────────────────────────────────────────────────
router.post('/schools/:schoolId/users', requireSchoolAuth(['owner']), createSchoolUser);
router.get('/schools/:schoolId/users', requireSchoolAuth(['owner', 'staff', 'read_only']), listSchoolUsers);
router.patch('/schools/:schoolId/users/:userId', requireSchoolAuth(['owner']), updateSchoolUser);

// ── Public password flows ──────────────────────────────────────────────────────
router.post('/users/set-password', setPassword);
router.post('/users/request-password-reset', requestPasswordReset);
router.post('/users/reset-password', resetPassword);

module.exports = router;
