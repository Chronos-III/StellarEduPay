'use strict';

const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: { type: String, required: true },
    // null schoolId = super-admin (break-glass only; prefer env super-admin)
    schoolId: { type: String, default: null, index: true },
    roles: [
      {
        type: String,
        enum: ['super_admin', 'owner', 'staff', 'read_only'],
      },
    ],
    isActive: { type: Boolean, default: true, index: true },
    mfaEnabled: { type: Boolean, default: false },
    mfaSecret: { type: String, default: null },
    mfaBackupCodes: [
      {
        hash: { type: String, required: true },
        used: { type: Boolean, default: false },
      },
    ],
    // Invitation flow
    invitationToken: { type: String, default: null },
    invitationExpires: { type: Date, default: null },
    // Password reset flow
    resetToken: { type: String, default: null },
    resetExpires: { type: Date, default: null },
  },
  { timestamps: true }
);

userSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.passwordHash;
    delete ret.mfaSecret;
    delete ret.mfaBackupCodes;
    delete ret.invitationToken;
    delete ret.resetToken;
    return ret;
  },
});

module.exports = mongoose.model('User', userSchema);
