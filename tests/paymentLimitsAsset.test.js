'use strict';

/**
 * Tests for per-asset payment-limit enforcement in verifyTransaction (issue #1555).
 *
 * Bug: verifyTransaction passed `asset?.code` (always undefined) to
 * validatePaymentAmount, so every payment — including USDC — was validated
 * against the XLM limits. Per-asset limits configured via the admin API were
 * silently ignored on the verify path.
 *
 * Fix: use `asset.assetCode` (the property detectAsset actually returns).
 *
 * These tests confirm:
 *   1. A USDC payment within USDC-specific limits is accepted.
 *   2. A USDC payment above the USDC limit (but within the XLM limit) is
 *      rejected with AMOUNT_TOO_HIGH — the XLM limit is NOT used as fallback.
 *   3. The metric label carries the correct asset code (USDC, not XLM).
 *   4. An XLM payment above the XLM limit is still rejected correctly.
 *   5. When no per-asset limit is configured the global default is applied.
 */

// ── Env vars (must precede any backend module load) ──────────────────────────
process.env.MONGO_URI               = process.env.MONGO_URI               || 'mongodb://127.0.0.1:27017/test';
process.env.JWT_SECRET              = process.env.JWT_SECRET              || 'test-jwt-secret-payment-limits-asset';
process.env.SCHOOL_WALLET_ADDRESS   = process.env.SCHOOL_WALLET_ADDRESS   || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.RECEIPT_SIGNATURE_SECRET = process.env.RECEIPT_SIGNATURE_SECRET || 'test-receipt-secret-plimits';
process.env.STELLAR_NETWORK         = process.env.STELLAR_NETWORK         || 'testnet';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// paymentLimitsService loads schoolModel (which needs mongoose.Schema) when
// requireActual is called. Mock the DB-facing dependencies first so the module
// can be loaded without a real mongoose connection.
jest.mock('../backend/src/models/schoolModel', () => ({
  findOne: jest.fn().mockReturnValue({ lean: () => Promise.resolve(null) }),
  findOneAndUpdate: jest.fn().mockReturnValue({ lean: () => Promise.resolve(null) }),
}));
jest.mock('../backend/src/models/systemConfigModel', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue({}),
}));
// Config stub — prevents the real config/index.js from enforcing env vars.
jest.mock('../backend/src/config', () => ({
  MIN_PAYMENT_AMOUNT: 0.01,
  MAX_PAYMENT_AMOUNT: 100000,
}));

// paymentLimitsService is mocked so this stays a unit test. resolveLimits is
// replaced per test; compareAgainstLimits uses the real implementation so
// actual boundary logic is exercised.
jest.mock('../backend/src/services/paymentLimitsService', () => ({
  resolveLimits: jest.fn(),
  compareAgainstLimits: jest.requireActual('../backend/src/services/paymentLimitsService').compareAgainstLimits,
  invalidateCache: jest.fn(),
}));

// Mongoose models — no real DB needed for verifyTransaction unit tests.
jest.mock('../backend/src/models/paymentModel', () => ({
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockResolvedValue({ toObject: () => ({}) }),
  exists: jest.fn().mockResolvedValue(false),
  aggregate: jest.fn().mockResolvedValue([]),
}));
jest.mock('../backend/src/models/studentModel', () => ({
  findOne: jest.fn().mockResolvedValue({ studentId: 'STU001', feeAmount: 500 }),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
}));
jest.mock('../backend/src/models/paymentIntentModel', () => ({
  findOne: jest.fn().mockResolvedValue(null),
  findByIdAndUpdate: jest.fn().mockResolvedValue({}),
}));
jest.mock('../backend/src/models/outboxModel', () => ({
  create: jest.fn().mockResolvedValue({}),
}));

// Stellar SDK stub — no network calls.
jest.mock('@stellar/stellar-sdk', () => ({
  Operation: {
    _fromXDRAmount: (stroops) => (parseInt(stroops, 10) / 1e7).toFixed(7),
  },
  Horizon: { Server: jest.fn().mockImplementation(() => ({})) },
  Networks: {
    TESTNET: 'Test SDF Network ; September 2015',
    PUBLIC: 'Public Global Stellar Network ; September 2015',
  },
  Asset: { native: jest.fn(() => ({ isNative: () => true })) },
}), { virtual: true });

// Mongoose session stub (verifyTransaction does not open a session, but
// transactionService imports mongoose for other paths).
jest.mock(require.resolve('../backend/node_modules/mongoose'), () => ({
  connection: {
    startSession: jest.fn().mockResolvedValue({
      withTransaction: jest.fn(async (cb) => cb()),
      endSession: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

// ── Constants ─────────────────────────────────────────────────────────────────

const WALLET = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
// A valid Stellar public key for the USDC issuer stub.
const USDC_ISSUER = 'GISSUER000000000000000000000000000000000000000000000000001';
const SCHOOL_ID = 'SCH-PLIMITS-001';

// ── Stellar config mock (per-file, after process.env is set) ─────────────────

// We mutate the `server` object in tests, so we need a stable reference.
// The mock is declared here and mutated inside tests via mockServer().
const mockOperations = jest.fn();

jest.mock('../backend/src/config/stellarConfig', () => ({
  SCHOOL_WALLET: WALLET,
  CONFIRMATION_THRESHOLD: 2,
  FINALIZATION_THRESHOLD: 30,
  ACCEPTED_ASSETS: {
    XLM:  { code: 'XLM',  type: 'native',          issuer: null },
    USDC: { code: 'USDC', type: 'credit_alphanum4', issuer: USDC_ISSUER },
  },
  isAcceptedAsset: (code, type, issuer) => {
    if (code === 'XLM' && type === 'native') return { accepted: true, asset: { code, type } };
    if (code === 'USDC' && type === 'credit_alphanum4' && issuer === USDC_ISSUER) {
      return { accepted: true, asset: { code, type, issuer } };
    }
    return { accepted: false, asset: null };
  },
  server: {
    transactions: () => ({
      transaction: () => ({ call: async () => null }),
    }),
    ledgers: () => ({
      order: () => ({
        limit: () => ({ call: async () => ({ records: [{ sequence: 100 }] }) }),
      }),
    }),
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const { resolveLimits } = require('../backend/src/services/paymentLimitsService');
const { paymentLimitTriggeredTotal, registry } = require('../backend/src/metrics');

async function counterValue(labels) {
  const metric = await registry.getSingleMetricAsString('payment_limit_triggered_total');
  const pattern = new RegExp(
    `payment_limit_triggered_total\\{school_id="${labels.school_id}",asset="${labels.asset}",code="${labels.code}"\\} (\\d+)`,
  );
  const m = metric.match(pattern);
  return m ? Number(m[1]) : 0;
}

/**
 * Point stellarConfig.server.transactions at a fixture so verifyTransaction
 * never makes a real network call.
 */
function mockServer(txFixture) {
  const cfg = require('../backend/src/config/stellarConfig');
  cfg.server.transactions = () => ({
    transaction: () => ({ call: async () => txFixture }),
  });
  cfg.server.ledgers = () => ({
    order: () => ({
      limit: () => ({ call: async () => ({ records: [{ sequence: 100 }] }) }),
    }),
  });
}

function makeUsdcTx({ amount = '500.0000000', memo = 'STU001', successful = true } = {}) {
  return {
    hash: `usdc-tx-${amount}`,
    successful,
    memo_type: 'text',
    memo,
    fee_paid: '100',
    created_at: new Date().toISOString(),
    ledger_attr: 50,
    operations: async () => ({
      records: [{
        type: 'payment',
        to: WALLET,
        from: 'GSENDER',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: USDC_ISSUER,
        amount,
      }],
    }),
  };
}

function makeXlmTx({ amount = '100.0000000', memo = 'STU001', successful = true } = {}) {
  return {
    hash: `xlm-tx-${amount}`,
    successful,
    memo_type: 'text',
    memo,
    fee_paid: '100',
    created_at: new Date().toISOString(),
    ledger_attr: 50,
    operations: async () => ({
      records: [{
        type: 'payment',
        to: WALLET,
        from: 'GSENDER',
        asset_type: 'native',
        amount,
      }],
    }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('verifyTransaction — per-asset payment limits (issue #1555)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    paymentLimitTriggeredTotal.reset();
  });

  // ── USDC payment within USDC-specific limit ──────────────────────────────

  test('accepts a USDC payment within the USDC-specific limit', async () => {
    // USDC limit: max 1000. XLM limit: max 10000.
    // Without the fix, asset?.code is undefined → XLM limits used → payment
    // passes despite being above a USDC-specific cap. With the fix, the
    // correct USDC limit is used.
    resolveLimits.mockImplementation(({ asset } = {}) => {
      if ((asset || '').toUpperCase() === 'USDC') return Promise.resolve({ min: 1, max: 1000, source: 'school:asset:USDC' });
      return Promise.resolve({ min: 1, max: 10000, source: 'school:default' });
    });

    const { verifyTransaction } = require('../backend/src/services/stellarService');
    mockServer(makeUsdcTx({ amount: '500.0000000' })); // 500 USDC — within the 1000 cap

    const result = await verifyTransaction(`usdc-tx-500.0000000`, WALLET, SCHOOL_ID);

    expect(result.assetCode).toBe('USDC');
    expect(result.amount).toBe(500);
    // resolveLimits must have been called with asset: 'USDC', not undefined/XLM
    expect(resolveLimits).toHaveBeenCalledWith(
      expect.objectContaining({ asset: 'USDC', schoolId: SCHOOL_ID }),
    );
  });

  // ── USDC payment above USDC limit but below XLM limit ───────────────────

  test('rejects a USDC payment above the USDC cap even when it is within the XLM cap', async () => {
    // This is the exact failure mode the bug caused: 2000 USDC is within the
    // XLM cap (5000) but above the USDC cap (1000), so it should be rejected.
    // Before the fix, asset?.code is undefined → 'XLM' limit used → ACCEPTED.
    // After the fix, assetCode is 'USDC' → USDC limit used → REJECTED.
    resolveLimits.mockImplementation(({ asset } = {}) => {
      if ((asset || '').toUpperCase() === 'USDC') return Promise.resolve({ min: 1, max: 1000, source: 'school:asset:USDC' });
      return Promise.resolve({ min: 1, max: 5000, source: 'school:default' }); // XLM cap is higher
    });

    const { verifyTransaction } = require('../backend/src/services/stellarService');
    mockServer(makeUsdcTx({ amount: '2000.0000000' })); // 2000 USDC — above USDC cap, below XLM cap

    await expect(
      verifyTransaction(`usdc-tx-2000.0000000`, WALLET, SCHOOL_ID),
    ).rejects.toMatchObject({ code: 'AMOUNT_TOO_HIGH' });

    // Confirm the metric was recorded with the USDC label, not XLM.
    expect(
      await counterValue({ school_id: SCHOOL_ID, asset: 'USDC', code: 'AMOUNT_TOO_HIGH' }),
    ).toBe(1);
    // XLM metric must NOT have been incremented.
    expect(
      await counterValue({ school_id: SCHOOL_ID, asset: 'XLM', code: 'AMOUNT_TOO_HIGH' }),
    ).toBe(0);
  });

  // ── XLM payment above XLM limit ──────────────────────────────────────────

  test('rejects an XLM payment above the XLM limit', async () => {
    resolveLimits.mockImplementation(({ asset } = {}) => {
      if ((asset || '').toUpperCase() === 'USDC') return Promise.resolve({ min: 1, max: 1000, source: 'school:asset:USDC' });
      return Promise.resolve({ min: 1, max: 500, source: 'school:default' }); // low XLM cap
    });

    const { verifyTransaction } = require('../backend/src/services/stellarService');
    mockServer(makeXlmTx({ amount: '600.0000000' })); // 600 XLM — above the 500 cap

    await expect(
      verifyTransaction(`xlm-tx-600.0000000`, WALLET, SCHOOL_ID),
    ).rejects.toMatchObject({ code: 'AMOUNT_TOO_HIGH' });

    expect(
      await counterValue({ school_id: SCHOOL_ID, asset: 'XLM', code: 'AMOUNT_TOO_HIGH' }),
    ).toBe(1);
  });

  // ── Metric label carries correct asset code ──────────────────────────────

  test('metric label is USDC for a rejected USDC payment (not XLM)', async () => {
    // Tightest possible confirmation that the metric is labelled with the
    // actual asset, not a default fallback.
    resolveLimits.mockImplementation(({ asset } = {}) => {
      if ((asset || '').toUpperCase() === 'USDC') return Promise.resolve({ min: 1, max: 10, source: 'school:asset:USDC' });
      return Promise.resolve({ min: 1, max: 100000, source: 'school:default' });
    });

    const { verifyTransaction } = require('../backend/src/services/stellarService');
    mockServer(makeUsdcTx({ amount: '50.0000000' })); // 50 USDC — above USDC cap of 10

    await expect(
      verifyTransaction(`usdc-tx-50.0000000`, WALLET, SCHOOL_ID),
    ).rejects.toMatchObject({ code: 'AMOUNT_TOO_HIGH' });

    expect(
      await counterValue({ school_id: SCHOOL_ID, asset: 'USDC', code: 'AMOUNT_TOO_HIGH' }),
    ).toBe(1);
    expect(
      await counterValue({ school_id: SCHOOL_ID, asset: 'XLM', code: 'AMOUNT_TOO_HIGH' }),
    ).toBe(0);
  });

  // ── No per-asset override — global default applies ────────────────────────

  test('uses the global default limit when no per-asset override exists', async () => {
    // With no USDC-specific limit, resolveLimits returns the same global default
    // for both assets. This verifies the fix does not break the fallback path.
    resolveLimits.mockResolvedValue({ min: 1, max: 1000, source: 'system:default' });

    const { verifyTransaction } = require('../backend/src/services/stellarService');
    mockServer(makeUsdcTx({ amount: '800.0000000' })); // 800 USDC — within global default of 1000

    const result = await verifyTransaction(`usdc-tx-800.0000000`, WALLET, SCHOOL_ID);

    expect(result.assetCode).toBe('USDC');
    expect(result.amount).toBe(800);
  });
});
