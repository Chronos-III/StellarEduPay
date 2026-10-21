'use strict';

/**
 * Issue #1554 — Automated regression test: every authenticated, state-changing
 * (non-GET) route must include auditContext middleware so mutations are
 * attributed to an actor in the tamper-evident audit trail.
 *
 * Strategy: load each Express router directly (no HTTP server needed), walk its
 * internal `stack` to enumerate every non-GET route definition, and assert that
 * `auditContext` is present in the middleware chain for all routes outside the
 * explicit public allow-list.
 *
 * The allow-list covers routes where:
 *   - No authenticated actor exists at call time (login, refresh, public intents)
 *   - The request is not a state mutation (read-only GETs are skipped by design)
 *   - The endpoint uses its own documented audit mechanism (provider webhooks)
 */

// ── Env vars must be set BEFORE any backend module is required ────────────────
// Route files transitively load controllers which load config/index.js, which
// validates required env vars on require(). Set them here so the module graph
// can resolve without errors.
process.env.MONGO_URI               = process.env.MONGO_URI               || 'mongodb://127.0.0.1:27017/test';
process.env.JWT_SECRET              = process.env.JWT_SECRET              || 'test-jwt-secret-for-audit-coverage-tests';
process.env.SCHOOL_WALLET_ADDRESS   = process.env.SCHOOL_WALLET_ADDRESS   || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.RECEIPT_SIGNATURE_SECRET = process.env.RECEIPT_SIGNATURE_SECRET || 'test-receipt-secret-for-audit-coverage';
process.env.STELLAR_NETWORK         = process.env.STELLAR_NETWORK         || 'testnet';

const { auditContext } = require('../backend/src/middleware/auditContext');

// ── Public / intentionally un-audited endpoints (allow-list) ─────────────────
// Key format: "<METHOD> <path pattern>"  (Express-style path, not regex)
const AUDIT_EXEMPT = new Set([
  // Authentication — no actor yet
  'POST /login',
  'POST /refresh',
  'POST /logout',
  // Public payment flow — unauthenticated callers
  'POST /intent',
  'POST /submit',
  'POST /verify',
  // Provider webhook — authenticated inside the controller (SNS/SendGrid sig)
  'POST /webhooks/:provider',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Flatten an Express Router's internal layer stack into a list of
 * { method, path, fns } records.  Handles nested routers recursively.
 */
function flattenRouter(router, prefix = '') {
  const results = [];

  const stack = router?.stack ?? router?.router?.stack ?? [];

  for (const layer of stack) {
    if (!layer.route && layer.handle?.stack) {
      // Nested router (e.g. router.use('/path', subRouter))
      const subPath = (layer.regexp?.source ?? '').includes('^\\/')
        ? prefix + (layer.path ?? '')
        : prefix;
      results.push(...flattenRouter(layer.handle, subPath));
      continue;
    }

    if (!layer.route) continue;

    const route = layer.route;
    const routePath = prefix + (route.path || '');

    for (const routeLayer of route.stack) {
      const method = routeLayer.method?.toUpperCase();
      if (!method) continue;

      results.push({
        method,
        path: routePath,
        fns: routeLayer.handle
          ? [routeLayer.handle]
          : (routeLayer.fns ?? []),
        // The route itself has the full middleware chain
        routeFns: route.stack.map(l => l.handle).filter(Boolean),
      });
    }
  }
  return results;
}

function hasAuditContext(fns) {
  return fns.some(fn => fn === auditContext);
}

// ── Per-router test factory ───────────────────────────────────────────────────

function describeRouterAuditCoverage(label, routerFactory) {
  describe(`${label} — every authenticated mutation has auditContext (#1554)`, () => {
    let routes;

    beforeAll(() => {
      const router = routerFactory();
      routes = flattenRouter(router);
    });

    test('no missing auditContext on non-GET authenticated routes', () => {
      const missing = [];

      for (const { method, path: routePath, routeFns } of routes) {
        if (method === 'GET') continue;

        const key = `${method} ${routePath}`;
        if (AUDIT_EXEMPT.has(key)) continue;

        if (!hasAuditContext(routeFns)) {
          missing.push(key);
        }
      }

      if (missing.length > 0) {
        fail(
          `The following routes are missing auditContext middleware:\n` +
          missing.map(r => `  ${r}`).join('\n') +
          `\n\nAdd auditContext after the auth middleware on each route.`
        );
      }
    });
  });
}

// ── Run for each router ───────────────────────────────────────────────────────

describeRouterAuditCoverage(
  'studentRoutes',
  () => require('../backend/src/routes/studentRoutes'),
);

describeRouterAuditCoverage(
  'feeAdjustmentRoutes',
  () => require('../backend/src/routes/feeAdjustmentRoutes'),
);

describeRouterAuditCoverage(
  'paymentRoutes',
  () => require('../backend/src/routes/paymentRoutes'),
);

describeRouterAuditCoverage(
  'retryQueueRoutes',
  () => require('../backend/src/routes/retryQueueRoutes'),
);

describeRouterAuditCoverage(
  'emailRoutes',
  () => require('../backend/src/routes/emailRoutes'),
);

describeRouterAuditCoverage(
  'authRoutes',
  () => require('../backend/src/routes/authRoutes'),
);
