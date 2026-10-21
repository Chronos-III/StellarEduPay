'use strict';

const crypto = require('crypto');
const Student = require('../models/studentModel');
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

async function generateStudentId(maxAttempts = 5, schoolId = null) {
  for (let i = 0; i < maxAttempts; i++) {
    // Use crypto.randomInt (CSPRNG) instead of Math.random for security
    // Increased suffix from 6 to 8 characters for better collision resistance
    const suffix = Array.from({ length: 8 }, () => CHARS[crypto.randomInt(36)]).join('');
    const id = `STU-${suffix}`;
    const query = schoolId ? { schoolId, studentId: id } : { studentId: id };
    if (!await Student.exists(query)) return id;
  }
  throw Object.assign(
    new Error(`Failed to generate unique student ID after ${maxAttempts} attempts`),
    { code: 'STUDENT_ID_GENERATION_FAILED' },
  );
}

module.exports = { generateStudentId };
