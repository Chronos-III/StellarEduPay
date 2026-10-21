'use strict';

// ── Env vars must be set BEFORE any backend module is required ────────────────
process.env.MONGO_URI               = process.env.MONGO_URI               || 'mongodb://127.0.0.1:27017/test';
process.env.JWT_SECRET              = process.env.JWT_SECRET              || 'test-jwt-secret-for-mfa-policy-tests-32chars!';
process.env.SCHOOL_WALLET_ADDRESS   = process.env.SCHOOL_WALLET_ADDRESS   || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.RECEIPT_SIGNATURE_SECRET = process.env.RECEIPT_SIGNATURE_SECRET || 'test-receipt-secret-mfa-policy';
process.env.STELLAR_NETWORK         = process.env.STELLAR_NETWORK         || 'testnet';

/**
 * Tests for issue #1553 — school-level MFA shared secret replaced with
 * per-user MFA policy.
 *
 * Key behaviours verified:
 *  1. School.requireMfa=true + user has no personal MFA → mfaSetupPending token
 *  2. School.requireMfa=true + user HAS personal MFA → normal login, no pending
 *  3. School.requireMfa=false (default) + no user MFA → normal login (optional)
 *  4. The old shared school.mfaSecret fallback is NOT invoked — a valid shared
 *     secret in the DB does not gate login.
 *  5. School model exposes requireMfa field and it defaults to false.
 */

const mongoose = require('../backend/node_modules/mongoose');
const bcrypt = require('../backend/node_modules/bcryptjs');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongoServer;
const TEST_DB = 'mfa_policy_test';
const USE_EXTERNAL_MONGO = !!process.env.MONGO_URI;

// Minimal stubs for dependencies used inside authController
jest.mock('../backend/src/utils/logger', () => ({
  error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(),
  child: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }),
}));
jest.mock('../backend/src/services/alertService', () => ({ sendAdminAlert: jest.fn() }));

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-jwt-secret-for-mfa-policy-tests-32chars!';
  process.env.ADMIN_USERNAME = 'superadmin';
  process.env.ADMIN_PASSWORD = 'superpassword';

  if (USE_EXTERNAL_MONGO) {
    const baseUri = process.env.MONGO_URI.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);
    await mongoose.connect(baseUri, { serverSelectionTimeoutMS: 15000 });
  } else {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  }
}, 30000);

afterAll(async () => {
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

beforeEach(async () => {
  const School = require('../backend/src/models/schoolModel');
  const User   = require('../backend/src/models/userModel');
  // School model is not tenant-scoped (no tenantScope plugin), no filter restriction needed
  await School.deleteMany({});
  await User.deleteMany({});
}, 30000);

afterEach(() => {
  // Do NOT call jest.resetModules() here — it would cause the mongoose instance
  // to lose its connection on subsequent test runs (the reconnected model would
  // use a different mongoose instance than the one connected in beforeAll).
  delete process.env.REQUIRE_MFA;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function createSchool({ requireMfa = false } = {}) {
  const School = require('../backend/src/models/schoolModel');
  return School.create({
    schoolId: 'SCH-MFA-POLICY',
    name: 'MFA Policy Test School',
    slug: 'mfa-policy-test',
    stellarAddress: 'GCRBBZAIZ6FR25RUV4FDU4SJH6EHXAKUM3SGXKASZ3P3KLJK6YPRYB47',
    requireMfa,
  });
}

async function createUser({ schoolId, hasMfa = false } = {}) {
  const User = require('../backend/src/models/userModel');
  const passwordHash = await bcrypt.hash('correctpassword', 1);

  let mfaSecret = null;
  let mfaEnabled = false;

  if (hasMfa) {
    // Encrypt a real TOTP secret
    const { encryptMfaSecret } = require('../backend/src/controllers/mfaController');
    const speakeasy = require('speakeasy');
    const generated = speakeasy.generateSecret();
    mfaSecret = encryptMfaSecret(generated.base32);
    mfaEnabled = true;
  }

  return User.create({
    email: 'staff@school.test',
    passwordHash,
    schoolId,
    roles: ['staff'],
    isActive: true,
    mfaEnabled,
    mfaSecret,
    mfaBackupCodes: [],
  });
}

/**
 * Invoke handleLogin directly with a minimal req/res mock.
 * Returns { status, body, cookies }.
 */
async function callLogin({ email, password, mfaCode } = {}) {
  const { handleLogin } = require('../backend/src/controllers/authController');

  const cookies = {};
  const body = {};
  let status = 200;

  const req = {
    body: { email, password, ...(mfaCode ? { mfaCode } : {}) },
    ip: '127.0.0.1',
    headers: {},
  };
  const res = {
    status(code) { status = code; return this; },
    json(data) { Object.assign(body, data); return this; },
    cookie(name, val) { cookies[name] = val; return this; },
  };

  await handleLogin(req, res);
  return { status, body, cookies };
}

// ── Tests: School model ───────────────────────────────────────────────────────

describe('School model — requireMfa field (issue #1553)', () => {
  test('requireMfa defaults to false', async () => {
    const school = await createSchool();
    expect(school.requireMfa).toBe(false);
  });

  test('requireMfa can be set to true', async () => {
    const school = await createSchool({ requireMfa: true });
    expect(school.requireMfa).toBe(true);
  });

  test('mfaSecret field still exists for legacy transition', async () => {
    const School = require('../backend/src/models/schoolModel');
    const schemaPaths = School.schema.paths;
    expect(schemaPaths).toHaveProperty('mfaSecret');
  });
});

// ── Tests: login with requireMfa policy ──────────────────────────────────────

describe('handleLogin — requireMfa school policy (issue #1553)', () => {
  test('school.requireMfa=true + user has no MFA → mfaSetupPending token issued', async () => {
    const school = await createSchool({ requireMfa: true });
    await createUser({ schoolId: school.schoolId, hasMfa: false });

    const { status, body } = await callLogin({
      email: 'staff@school.test',
      password: 'correctpassword',
    });

    expect(status).toBe(200);
    // The response should signal that MFA setup is required
    expect(body.mfaSetupRequired).toBe(true);
  });

  test('school.requireMfa=true + user has personal MFA → normal login (no setup pending)', async () => {
    const school = await createSchool({ requireMfa: true });
    const user = await createUser({ schoolId: school.schoolId, hasMfa: true });

    // For this test we need to supply the TOTP code — get it from the stored secret
    const { decryptMfaSecret } = require('../backend/src/controllers/mfaController');
    const speakeasy = require('speakeasy');
    const secret = decryptMfaSecret(user.mfaSecret);
    const mfaCode = speakeasy.totp({ secret, encoding: 'base32' });

    const { status, body } = await callLogin({
      email: 'staff@school.test',
      password: 'correctpassword',
      mfaCode,
    });

    expect(status).toBe(200);
    // No MFA setup required — user already enrolled
    expect(body.mfaSetupRequired).toBeFalsy();
  });

  test('school.requireMfa=false + user has no MFA → normal login allowed (MFA optional)', async () => {
    const school = await createSchool({ requireMfa: false });
    await createUser({ schoolId: school.schoolId, hasMfa: false });

    const { status, body } = await callLogin({
      email: 'staff@school.test',
      password: 'correctpassword',
    });

    expect(status).toBe(200);
    expect(body.mfaSetupRequired).toBeFalsy();
  });

  test('global REQUIRE_MFA env + user has no MFA → mfaSetupPending regardless of school policy', async () => {
    process.env.REQUIRE_MFA = 'true';
    const school = await createSchool({ requireMfa: false });
    await createUser({ schoolId: school.schoolId, hasMfa: false });

    const { status, body } = await callLogin({
      email: 'staff@school.test',
      password: 'correctpassword',
    });

    expect(status).toBe(200);
    expect(body.mfaSetupRequired).toBe(true);
  });

  test('shared school mfaSecret does NOT gate login — it is no longer a second factor', async () => {
    // Create a school that still has the old shared mfaSecret in the DB (legacy)
    const School = require('../backend/src/models/schoolModel');
    const { encryptMfaSecret } = require('../backend/src/controllers/mfaController');
    const speakeasy = require('speakeasy');
    const generated = speakeasy.generateSecret();

    const school = await School.create({
      schoolId: 'SCH-LEGACY-MFA',
      name: 'Legacy MFA School',
      slug: 'legacy-mfa-school',
      stellarAddress: 'GBL4WH6KTTBXFYPZTWC3ZUVDLMAKT6A7T5PHHC63AMR3HQDNOXKU5ESM',
      mfaEnabled: true,
      mfaSecret: encryptMfaSecret(generated.base32),
      requireMfa: false,  // policy NOT requiring per-user MFA
    });

    const User = require('../backend/src/models/userModel');
    const passwordHash = await bcrypt.hash('correctpassword', 1);
    await User.create({
      email: 'legacy@school.test',
      passwordHash,
      schoolId: school.schoolId,
      roles: ['staff'],
      isActive: true,
      mfaEnabled: false,
      mfaSecret: null,
    });

    // Login WITHOUT any mfaCode — should succeed because the shared school
    // secret is no longer used as a second factor (issue #1553 fix).
    const { handleLogin } = require('../backend/src/controllers/authController');
    const cookies = {};
    const body = {};
    let status = 200;
    const req = {
      body: { email: 'legacy@school.test', password: 'correctpassword' },
      ip: '127.0.0.1', headers: {},
    };
    const res = {
      status(code) { status = code; return this; },
      json(data) { Object.assign(body, data); return this; },
      cookie(name, val) { cookies[name] = val; return this; },
    };
    await handleLogin(req, res);

    // Login should succeed — shared secret no longer gates login
    expect(status).toBe(200);
    // No requiresMfa challenge from shared secret
    expect(body.requiresMfa).toBeFalsy();
  });
});
