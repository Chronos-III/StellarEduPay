'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const User = require('../models/userModel');
const logger = require('../utils/logger').child('UserController');
const { logAudit } = require('../services/auditService');
const { sendEmail } = require('../services/emailService');
const { revokeAllUserSessions } = require('../services/sessionStore');

// ── Password policy ────────────────────────────────────────────────────────────
const MIN_PASSWORD_LENGTH = 12;

function validatePassword(password) {
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    return { valid: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  return { valid: true };
}

// ── Token generation and storage ───────────────────────────────────────────────
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ── Super-admin endpoints: /api/admin/users ────────────────────────────────────

async function createUser(req, res) {
  const { email, schoolId, roles } = req.body;

  if (!email || !schoolId || !roles || !Array.isArray(roles) || roles.length === 0) {
    return res.status(400).json({
      error: 'email, schoolId, and roles are required.',
      code: 'VALIDATION_ERROR',
    });
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Validate roles
  const validRoles = ['super_admin', 'owner', 'staff', 'read_only'];
  const invalidRoles = roles.filter(r => !validRoles.includes(r));
  if (invalidRoles.length > 0) {
    return res.status(400).json({
      error: `Invalid roles: ${invalidRoles.join(', ')}`,
      code: 'INVALID_ROLES',
    });
  }

  // Check if user already exists
  const existing = await User.findOne({ email: normalizedEmail });
  if (existing) {
    return res.status(409).json({
      error: 'User with this email already exists.',
      code: 'USER_EXISTS',
    });
  }

  // Generate invitation token
  const invitationToken = generateToken();
  const invitationTokenHash = hashToken(invitationToken);
  const invitationExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  // Create user with temporary password (invitation flow)
  const tempPasswordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);

  const user = new User({
    email: normalizedEmail,
    passwordHash: tempPasswordHash,
    schoolId,
    roles,
    isActive: false, // inactive until password is set
    invitationToken: invitationTokenHash,
    invitationExpires,
  });

  await user.save();

  // Send invitation email
  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const invitationLink = `${baseUrl}/set-password?token=${invitationToken}`;

  try {
    await sendEmail({
      to: normalizedEmail,
      subject: 'You have been invited to join the school management system',
      html: `
        <p>You have been invited to join as a user with roles: ${roles.join(', ')}.</p>
        <p>Click the link below to set your password and activate your account:</p>
        <p><a href="${invitationLink}">${invitationLink}</a></p>
        <p>This link will expire in 7 days.</p>
      `,
    });
  } catch (err) {
    logger.warn('[UserController] Failed to send invitation email', { error: err.message, email: normalizedEmail });
  }

  await logAudit({
    schoolId: req.admin?.schoolId || 'system',
    action: 'user_created',
    performedBy: req.admin?.userId || 'super_admin',
    targetId: user._id.toString(),
    targetType: 'user',
    details: { email: normalizedEmail, schoolId, roles },
    result: 'success',
    ipAddress: req.ip,
    userAgent: req.headers?.['user-agent'],
  });

  return res.status(201).json({
    message: 'User created. Invitation email sent.',
    userId: user._id,
    email: user.email,
    invitationExpires,
  });
}

async function listUsers(req, res) {
  const { schoolId, role, isActive } = req.query;

  const filter = {};
  if (schoolId) filter.schoolId = schoolId;
  if (role) filter.roles = role;
  if (isActive !== undefined) filter.isActive = isActive === 'true';

  const users = await User.find(filter).select('-passwordHash -invitationToken -resetToken').sort({ createdAt: -1 });

  return res.json({ users });
}

async function getUser(req, res) {
  const { userId } = req.params;

  const user = await User.findById(userId).select('-passwordHash -invitationToken -resetToken');
  if (!user) {
    return res.status(404).json({ error: 'User not found.', code: 'NOT_FOUND' });
  }

  return res.json({ user });
}

async function updateUser(req, res) {
  const { userId } = req.params;
  const { roles, isActive } = req.body;

  const user = await User.findById(userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found.', code: 'NOT_FOUND' });
  }

  const updates = {};
  if (roles !== undefined) {
    const validRoles = ['super_admin', 'owner', 'staff', 'read_only'];
    const invalidRoles = roles.filter(r => !validRoles.includes(r));
    if (invalidRoles.length > 0) {
      return res.status(400).json({
        error: `Invalid roles: ${invalidRoles.join(', ')}`,
        code: 'INVALID_ROLES',
      });
    }
    updates.roles = roles;
  }
  if (isActive !== undefined) updates.isActive = isActive;

  await User.findByIdAndUpdate(userId, { $set: updates });

  // Deactivating a user must invalidate every existing session and refresh token.
  if (isActive === false) {
    await revokeAllUserSessions(userId);
  }

  await logAudit({
    schoolId: user.schoolId || 'system',
    action: 'user_updated',
    performedBy: req.admin?.userId || 'super_admin',
    targetId: userId,
    targetType: 'user',
    details: updates,
    result: 'success',
    ipAddress: req.ip,
    userAgent: req.headers?.['user-agent'],
  });

  return res.json({ message: 'User updated successfully.' });
}

async function deleteUser(req, res) {
  const { userId } = req.params;

  const user = await User.findById(userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found.', code: 'NOT_FOUND' });
  }

  await User.findByIdAndDelete(userId);

  // Deleting a user must invalidate every existing session and refresh token.
  await revokeAllUserSessions(userId);

  await logAudit({
    schoolId: user.schoolId || 'system',
    action: 'user_deleted',
    performedBy: req.admin?.userId || 'super_admin',
    targetId: userId,
    targetType: 'user',
    details: { email: user.email },
    result: 'success',
    ipAddress: req.ip,
    userAgent: req.headers?.['user-agent'],
  });

  return res.json({ message: 'User deleted successfully.' });
}

// ── School-owner endpoints: /api/schools/:schoolId/users ───────────────────────

async function createSchoolUser(req, res) {
  const { schoolId } = req.params;
  const { email, roles } = req.body;

  // Ensure the requesting user is managing their own school
  if (req.user?.schoolId && req.user.schoolId !== schoolId) {
    return res.status(403).json({
      error: 'You can only create users for your own school.',
      code: 'FORBIDDEN',
    });
  }

  if (!email || !roles || !Array.isArray(roles) || roles.length === 0) {
    return res.status(400).json({
      error: 'email and roles are required.',
      code: 'VALIDATION_ERROR',
    });
  }

  const normalizedEmail = email.trim().toLowerCase();

  // School owners cannot grant super_admin
  if (roles.includes('super_admin')) {
    return res.status(403).json({
      error: 'School owners cannot grant super_admin role.',
      code: 'FORBIDDEN',
    });
  }

  const validRoles = ['owner', 'staff', 'read_only'];
  const invalidRoles = roles.filter(r => !validRoles.includes(r));
  if (invalidRoles.length > 0) {
    return res.status(400).json({
      error: `Invalid roles for school users: ${invalidRoles.join(', ')}`,
      code: 'INVALID_ROLES',
    });
  }

  // Check if user already exists
  const existing = await User.findOne({ email: normalizedEmail });
  if (existing) {
    return res.status(409).json({
      error: 'User with this email already exists.',
      code: 'USER_EXISTS',
    });
  }

  // Generate invitation token
  const invitationToken = generateToken();
  const invitationTokenHash = hashToken(invitationToken);
  const invitationExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const tempPasswordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);

  const user = new User({
    email: normalizedEmail,
    passwordHash: tempPasswordHash,
    schoolId,
    roles,
    isActive: false,
    invitationToken: invitationTokenHash,
    invitationExpires,
  });

  await user.save();

  // Send invitation email
  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const invitationLink = `${baseUrl}/set-password?token=${invitationToken}`;

  try {
    await sendEmail({
      to: normalizedEmail,
      subject: 'You have been invited to join the school management system',
      html: `
        <p>You have been invited to join as a user with roles: ${roles.join(', ')}.</p>
        <p>Click the link below to set your password and activate your account:</p>
        <p><a href="${invitationLink}">${invitationLink}</a></p>
        <p>This link will expire in 7 days.</p>
      `,
    });
  } catch (err) {
    logger.warn('[UserController] Failed to send invitation email', { error: err.message, email: normalizedEmail });
  }

  await logAudit({
    schoolId,
    action: 'user_created',
    performedBy: req.user?.userId || req.admin?.userId,
    targetId: user._id.toString(),
    targetType: 'user',
    details: { email: normalizedEmail, schoolId, roles },
    result: 'success',
    ipAddress: req.ip,
    userAgent: req.headers?.['user-agent'],
  });

  return res.status(201).json({
    message: 'User invited successfully.',
    userId: user._id,
    email: user.email,
    invitationExpires,
  });
}

async function listSchoolUsers(req, res) {
  const { schoolId } = req.params;

  // Ensure the requesting user is managing their own school
  if (req.user?.schoolId && req.user.schoolId !== schoolId) {
    return res.status(403).json({
      error: 'You can only view users for your own school.',
      code: 'FORBIDDEN',
    });
  }

  const users = await User.find({ schoolId }).select('-passwordHash -invitationToken -resetToken').sort({ createdAt: -1 });

  return res.json({ users });
}

async function updateSchoolUser(req, res) {
  const { schoolId, userId } = req.params;
  const { roles, isActive } = req.body;

  const user = await User.findById(userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found.', code: 'NOT_FOUND' });
  }

  // Ensure the user belongs to the school
  if (user.schoolId !== schoolId) {
    return res.status(403).json({
      error: 'User does not belong to this school.',
      code: 'FORBIDDEN',
    });
  }

  // Ensure the requesting user is managing their own school
  if (req.user?.schoolId && req.user.schoolId !== schoolId) {
    return res.status(403).json({
      error: 'You can only manage users for your own school.',
      code: 'FORBIDDEN',
    });
  }

  const updates = {};
  if (roles !== undefined) {
    // School owners cannot grant super_admin
    if (roles.includes('super_admin')) {
      return res.status(403).json({
        error: 'School owners cannot grant super_admin role.',
        code: 'FORBIDDEN',
      });
    }

    const validRoles = ['owner', 'staff', 'read_only'];
    const invalidRoles = roles.filter(r => !validRoles.includes(r));
    if (invalidRoles.length > 0) {
      return res.status(400).json({
        error: `Invalid roles: ${invalidRoles.join(', ')}`,
        code: 'INVALID_ROLES',
      });
    }
    updates.roles = roles;
  }
  if (isActive !== undefined) updates.isActive = isActive;

  await User.findByIdAndUpdate(userId, { $set: updates });

  // Deactivating a user must invalidate every existing session and refresh token.
  if (isActive === false) {
    await revokeAllUserSessions(userId);
  }

  await logAudit({
    schoolId,
    action: 'user_updated',
    performedBy: req.user?.userId || req.admin?.userId,
    targetId: userId,
    targetType: 'user',
    details: updates,
    result: 'success',
    ipAddress: req.ip,
    userAgent: req.headers?.['user-agent'],
  });

  return res.json({ message: 'User updated successfully.' });
}

// ── Password flows ─────────────────────────────────────────────────────────────

async function setPassword(req, res) {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({
      error: 'token and password are required.',
      code: 'VALIDATION_ERROR',
    });
  }

  const validation = validatePassword(password);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error, code: 'WEAK_PASSWORD' });
  }

  const tokenHash = hashToken(token);
  const user = await User.findOne({
    invitationToken: tokenHash,
    invitationExpires: { $gt: new Date() },
  });

  if (!user) {
    return res.status(400).json({
      error: 'Invalid or expired invitation token.',
      code: 'INVALID_TOKEN',
    });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  await User.findByIdAndUpdate(user._id, {
    $set: { passwordHash, isActive: true },
    $unset: { invitationToken: '', invitationExpires: '' },
  });

  await logAudit({
    schoolId: user.schoolId || 'system',
    action: 'password_set',
    performedBy: user._id.toString(),
    targetId: user._id.toString(),
    targetType: 'user',
    details: { email: user.email },
    result: 'success',
    ipAddress: req.ip,
    userAgent: req.headers?.['user-agent'],
  });

  return res.json({ message: 'Password set successfully. You can now log in.' });
}

async function requestPasswordReset(req, res) {
  const { email } = req.body;

  if (!email) {
    // Generic response to avoid account enumeration
    return res.json({ message: 'If an account exists with that email, a password reset link has been sent.' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const user = await User.findOne({ email: normalizedEmail, isActive: true });

  if (!user) {
    // Generic response to avoid account enumeration
    return res.json({ message: 'If an account exists with that email, a password reset link has been sent.' });
  }

  // Generate reset token
  const resetToken = generateToken();
  const resetTokenHash = hashToken(resetToken);
  const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await User.findByIdAndUpdate(user._id, {
    $set: { resetToken: resetTokenHash, resetExpires },
  });

  // Send reset email
  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const resetLink = `${baseUrl}/reset-password?token=${resetToken}`;

  try {
    await sendEmail({
      to: normalizedEmail,
      subject: 'Password Reset Request',
      html: `
        <p>You requested a password reset.</p>
        <p>Click the link below to reset your password:</p>
        <p><a href="${resetLink}">${resetLink}</a></p>
        <p>This link will expire in 1 hour.</p>
        <p>If you did not request this, please ignore this email.</p>
      `,
    });
  } catch (err) {
    logger.warn('[UserController] Failed to send password reset email', { error: err.message, email: normalizedEmail });
  }

  await logAudit({
    schoolId: user.schoolId || 'system',
    action: 'password_reset_requested',
    performedBy: user._id.toString(),
    targetId: user._id.toString(),
    targetType: 'user',
    details: { email: normalizedEmail },
    result: 'success',
    ipAddress: req.ip,
    userAgent: req.headers?.['user-agent'],
  });

  return res.json({ message: 'If an account exists with that email, a password reset link has been sent.' });
}

async function resetPassword(req, res) {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({
      error: 'token and password are required.',
      code: 'VALIDATION_ERROR',
    });
  }

  const validation = validatePassword(password);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error, code: 'WEAK_PASSWORD' });
  }

  const tokenHash = hashToken(token);
  const user = await User.findOne({
    resetToken: tokenHash,
    resetExpires: { $gt: new Date() },
  });

  if (!user) {
    return res.status(400).json({
      error: 'Invalid or expired reset token.',
      code: 'INVALID_TOKEN',
    });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  await User.findByIdAndUpdate(user._id, {
    $set: { passwordHash },
    $unset: { resetToken: '', resetExpires: '' },
  });

  // A password reset is typically performed because the account is compromised:
  // every pre-existing session and refresh token must be revoked.
  await revokeAllUserSessions(user._id.toString());

  await logAudit({
    schoolId: user.schoolId || 'system',
    action: 'password_reset',
    performedBy: user._id.toString(),
    targetId: user._id.toString(),
    targetType: 'user',
    details: { email: user.email },
    result: 'success',
    ipAddress: req.ip,
    userAgent: req.headers?.['user-agent'],
  });

  return res.json({ message: 'Password reset successfully. You can now log in with your new password.' });
}

module.exports = {
  // Super-admin endpoints
  createUser,
  listUsers,
  getUser,
  updateUser,
  deleteUser,

  // School-owner endpoints
  createSchoolUser,
  listSchoolUsers,
  updateSchoolUser,

  // Password flows
  setPassword,
  requestPasswordReset,
  resetPassword,
};
