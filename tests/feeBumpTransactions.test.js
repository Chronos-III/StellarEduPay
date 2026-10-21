'use strict';

// ── Env vars must be set BEFORE any backend module is required ────────────────
process.env.MONGO_URI               = process.env.MONGO_URI               || 'mongodb://127.0.0.1:27017/test';
process.env.JWT_SECRET              = process.env.JWT_SECRET              || 'test-jwt-secret-for-feebump-tests';
process.env.SCHOOL_WALLET_ADDRESS   = process.env.SCHOOL_WALLET_ADDRESS   || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.RECEIPT_SIGNATURE_SECRET = process.env.RECEIPT_SIGNATURE_SECRET || 'test-receipt-secret-feebump';
process.env.STELLAR_NETWORK         = process.env.STELLAR_NETWORK         || 'testnet';

/**
 * Tests for fee-bump transaction handling (issue #1556).
 *
 * Horizon's fee-bump transaction record shape (real API response):
 *
 *   {
 *     hash: '<outer-hash>',          ← fee-bump envelope hash
 *     successful: true,
 *     memo_type: 'text',             ← memo lives on the TOP-LEVEL record
 *     memo: 'STU001',
 *     fee_bump_transaction: { hash, signatures },
 *     inner_transaction: {           ← only hash / signatures / max_fee
 *       hash: '<inner-hash>',
 *       signatures: [...],
 *       max_fee: '...',
 *     },
 *     operations: async () => ...    ← operations() also on TOP-LEVEL record
 *   }
 *
 * The previous code read memo_type and memo from inner_transaction (which
 * has neither), causing fee-bumped payments to be silently dropped.
 */

const mongoose = require('../backend/node_modules/mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Student = require('../backend/src/models/studentModel');
const Payment = require('../backend/src/models/paymentModel');
const FeeStructure = require('../backend/src/models/feeStructureModel');
const School = require('../backend/src/models/schoolModel');

let mongoServer;
const schoolId = 'SCH-TEST-FB-001';
const walletAddress = 'GAHZQLURQFZGUHVG5U53OO7S5U6CV75RTYWVVA4K2U3O6NCC7BBE5VH6';
const TEST_DB = 'fee_bump_tx_test';
const USE_EXTERNAL_MONGO = !!process.env.MONGO_URI;

beforeAll(async () => {
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
  await Student.deleteMany({ schoolId: schoolId });
  await Payment.deleteMany({ schoolId: schoolId });
  await FeeStructure.deleteMany({ schoolId: schoolId });
  // School model is not tenant-scoped (no tenantScope plugin), no filter restriction needed
  await School.deleteMany({});

  await School.create({
    schoolId,
    name: 'Fee Bump Test School',
    slug: 'fee-bump-test',
    stellarAddress: walletAddress,
  });

  await FeeStructure.create({
    schoolId,
    className: 'Grade 5A',
    feeAmount: 250,
    isActive: true,
  });

  await Student.create({
    schoolId,
    studentId: 'STU001',
    name: 'Alice Johnson',
    class: 'Grade 5A',
    feeAmount: 250,
  });
}, 30000);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a Horizon-accurate fee-bump transaction fixture.
 *
 * In real Horizon responses:
 *  - memo_type, memo, and operations() are on the TOP-LEVEL record.
 *  - inner_transaction only contains { hash, signatures, max_fee }.
 *
 * @param {object} opts
 * @param {string}  opts.outerHash  - fee-bump envelope hash (what Horizon indexes)
 * @param {string}  opts.innerHash  - inner transaction hash
 *  @param {string} opts.memoType   - 'text' | 'id' | 'hash' | 'return' | 'none'
 * @param {string|null} opts.memo   - memo value
 * @param {string}  opts.to         - destination wallet
 * @param {string}  opts.amount     - payment amount string
 * @param {string}  opts.assetType  - 'native' | 'credit_alphanum4' | 'credit_alphanum12'
 * @param {string|null} opts.assetCode  - null for native
 * @param {boolean} opts.successful
 */
function makeFeeBumpTx({
  outerHash = 'FEEBUMP_OUTER_HASH_AAA',
  innerHash = 'INNER_TX_HASH_BBB',
  memoType = 'text',
  memo = 'STU001',
  to = walletAddress,
  amount = '250.0000000',
  assetType = 'native',
  assetCode = null,
  successful = true,
} = {}) {
  const payOp = { type: 'payment', to, asset_type: assetType, amount };
  if (assetCode) payOp.asset_code = assetCode;

  return {
    hash: outerHash,
    successful,
    // ── Top-level fields (the correct place for memo + ops) ──────────────────
    memo_type: memoType === 'none' ? 'none' : memoType,
    memo: memoType === 'none' ? null : memo,
    operations: async () => ({ records: [payOp] }),
    // ── Fee-bump specific fields ──────────────────────────────────────────────
    fee_bump_transaction: { hash: outerHash, signatures: [] },
    // inner_transaction intentionally does NOT have memo_type, memo or operations()
    inner_transaction: {
      hash: innerHash,
      signatures: [],
      max_fee: '10000',
    },
    created_at: new Date().toISOString(),
    ledger_attr: 50000,
    fee_paid: '100',
  };
}

/**
 * Build a regular (non-fee-bump) transaction fixture for comparison.
 */
function makeRegularTx({
  hash = 'REGULAR_TX_HASH_CCC',
  memoType = 'text',
  memo = 'STU001',
  to = walletAddress,
  amount = '250.0000000',
  assetType = 'native',
  successful = true,
} = {}) {
  return {
    hash,
    successful,
    memo_type: memoType === 'none' ? 'none' : memoType,
    memo: memoType === 'none' ? null : memo,
    operations: async () => ({
      records: [{ type: 'payment', to, asset_type: assetType, amount }],
    }),
    created_at: new Date().toISOString(),
    ledger_attr: 50001,
    fee_paid: '100',
  };
}

// ── Tests: extractValidPayment ────────────────────────────────────────────────

describe('extractValidPayment — fee-bump transactions (issue #1556)', () => {
  test('reads memo and operations from top-level record, not inner_transaction', async () => {
    const { extractValidPayment } = require('../backend/src/services/stellarService');

    const tx = makeFeeBumpTx({ memo: 'STU001', memoType: 'text' });
    const result = await extractValidPayment(tx, walletAddress);

    expect(result).not.toBeNull();
    expect(result.memo).toBe('STU001');
    expect(result.memoType).toBe('text');
    expect(result.asset.assetCode).toBe('XLM');
  });

  test('exposes innerHash for traceability', async () => {
    const { extractValidPayment } = require('../backend/src/services/stellarService');

    const tx = makeFeeBumpTx({
      outerHash: 'OUTER_HASH_XYZ',
      innerHash: 'INNER_HASH_XYZ',
      memo: 'STU001',
    });
    const result = await extractValidPayment(tx, walletAddress);

    expect(result).not.toBeNull();
    // outer hash is what Horizon uses as the canonical identifier
    expect(result.innerHash).toBe('INNER_HASH_XYZ');
  });

  test('returns null when top-level memo_type is none (no memo on fee-bump)', async () => {
    const { extractValidPayment } = require('../backend/src/services/stellarService');

    const tx = makeFeeBumpTx({ memoType: 'none', memo: null });
    const result = await extractValidPayment(tx, walletAddress);

    expect(result).toBeNull();
  });

  test('returns null for failed fee-bump transaction', async () => {
    const { extractValidPayment } = require('../backend/src/services/stellarService');

    const tx = makeFeeBumpTx({ successful: false });
    const result = await extractValidPayment(tx, walletAddress);

    expect(result).toBeNull();
  });

  test('handles regular (non-fee-bump) transactions identically', async () => {
    const { extractValidPayment } = require('../backend/src/services/stellarService');

    const tx = makeRegularTx({ memo: 'STU001' });
    const result = await extractValidPayment(tx, walletAddress);

    expect(result).not.toBeNull();
    expect(result.memo).toBe('STU001');
    // Regular tx has no inner_transaction → innerHash is null
    expect(result.innerHash).toBeNull();
  });
});

// ── Tests: verifyTransaction ──────────────────────────────────────────────────

describe('verifyTransaction — fee-bump transactions (issue #1556)', () => {
  let stellarConfig;
  let origTransactions;

  beforeEach(() => {
    stellarConfig = require('../backend/src/config/stellarConfig');
    origTransactions = stellarConfig.server.transactions;
  });

  afterEach(() => {
    // Restore the original transactions function after each test
    stellarConfig.server.transactions = origTransactions;
  });

  function mockServer(txFixture) {
    // Mutate the existing server object so the destructured binding in
    // stellarService.js also sees the change (replaceProperty would not work
    // because stellarService already holds a reference to server, not stellarConfig)
    stellarConfig.server.transactions = () => ({
      transaction: () => ({
        call: async () => txFixture,
      }),
    });
    stellarConfig.server.ledgers = () => ({
      order: () => ({
        limit: () => ({
          call: async () => ({ records: [{ sequence: 100 }] }),
        }),
      }),
    });
  }

  test('verifies a fee-bump transaction and returns the outer hash', async () => {
    const { verifyTransaction } = require('../backend/src/services/stellarService');

    const tx = makeFeeBumpTx({
      outerHash: 'OUTER_FEEBUMP_VERIFY',
      innerHash: 'INNER_VERIFY_HASH',
      memo: 'STU001',
    });
    mockServer(tx);

    const result = await verifyTransaction('OUTER_FEEBUMP_VERIFY', walletAddress, schoolId);

    expect(result.hash).toBe('OUTER_FEEBUMP_VERIFY');
    expect(result.innerHash).toBe('INNER_VERIFY_HASH');
    expect(result.memo).toBe('STU001');
    expect(result.amount).toBe(250);
    expect(result.feeValidation.status).toBe('valid');
  });

  test('throws MISSING_MEMO when top-level memo is absent on a fee-bump tx', async () => {
    const { verifyTransaction } = require('../backend/src/services/stellarService');

    const tx = makeFeeBumpTx({ memoType: 'none', memo: null });
    mockServer(tx);

    await expect(verifyTransaction(tx.hash, walletAddress, schoolId))
      .rejects.toMatchObject({ code: 'MISSING_MEMO' });
  });

  test('throws TX_FAILED for a fee-bump that did not succeed', async () => {
    const { verifyTransaction } = require('../backend/src/services/stellarService');

    const tx = makeFeeBumpTx({ successful: false });
    mockServer(tx);

    await expect(verifyTransaction(tx.hash, walletAddress, schoolId))
      .rejects.toMatchObject({ code: 'TX_FAILED' });
  });

  test('throws INVALID_DESTINATION when payment target does not match wallet', async () => {
    const { verifyTransaction } = require('../backend/src/services/stellarService');

    const tx = makeFeeBumpTx({ to: 'GDIFFERENT_WALLET_ADDRESS_HERE' });
    mockServer(tx);

    await expect(verifyTransaction(tx.hash, walletAddress, schoolId))
      .rejects.toMatchObject({ code: 'INVALID_DESTINATION' });
  });
});
