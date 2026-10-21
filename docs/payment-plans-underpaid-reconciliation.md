# Payment Plans and Underpaid Reconciliation

Two subsystems disagree about what a "short" payment means.

## The two views of a partial payment

`classifyFeePayment` (`backend/src/utils/money.js`) compares a student's
cumulative total against `Student.feeAmount`. Anything below it is `partial`,
which is the correct reading for a student paying their fee in one go.

A student on a payment plan (`backend/src/models/paymentPlanModel.js`) pays a
schedule of installments instead. Every installment is below the total fee by
design, so the cumulative classification marks each one `partial` until the
final payment lands.

## What the running code does

Partial payments are **accepted and recorded as `SUCCESS`** — funds have
already arrived on-chain. The `Payment.feeValidationStatus` field records
`partial` for any payment below the total fee, including plan installments.
This field describes the payment against the total fee and is what the balance,
receipt, and reporting code reads.

The `Payment` model carries an `underpaidReconciliation` sub-document
(`status`, `appliedCredit`, `creditAppliedAt`, `creditAppliedBy`,
`refundTxHash`, `refundInitiatedAt`, `refundCompletedAt`, `refundNote`) that
is populated by the refund service when a refund is processed.

A plan holder's installment is credited immediately toward the student's
cumulative balance; the remaining shortfall is reflected in the student's
`remainingBalance`.

`evaluateUnderpayment(payment)` in
`backend/src/services/underpaidReconciliationService.js` is the single place
that decision is made:

| Student state | Benchmark | `basis` |
|---|---|---|
| Active payment plan with installments | the next unpaid installment's `amount` | `installment` |
| Active plan whose installments are all settled | the final installment's `amount` | `installment` |
| No plan, or a `completed` / `cancelled` plan | `Student.feeAmount`, via the existing classification | `fee` |

A plan holder's payment is underpaid only when it falls below the installment
it is paying. A payment at or above that amount is intentional.

## Where the rule is enforced

- `getPendingUnderpaidPayments` filters covered installments out of the
  listing, so they never enter the reconciliation queue an operator works
  through.
- `applyPartialCredit` and `initiateRefund` both throw if the payment turns out
  to be a covered installment, so a direct call by ID cannot bypass the
  listing filter.

## The `feeValidationStatus` vocabulary

`Payment.feeValidationStatus` is one of `valid`, `partial`, `underpaid`,
`overpaid`, `unknown`. The two "short" values have distinct, fixed meanings:

| Value | Meaning |
|---|---|
| `partial` | The student's cumulative total is below `Student.feeAmount`. This is the normal state of every installment on a payment plan, and of any accepted part-payment. |
| `underpaid` | A payment below the expected **installment** amount where an active plan exists (the #1379 semantics). Only `evaluateUnderpayment` may assign it. |
| `valid` | Cumulative total equals the fee (or the installment, for a plan holder). |
| `overpaid` | Cumulative total exceeds the fee. |
| `unknown` | The payment could not be classified (e.g. missing fee or amount). |

`partial` is never a synonym for `underpaid`. A plan holder's installment is
`partial` against the total fee and `valid` against its installment; it is
`underpaid` only when it falls short of the installment it is paying.

### One classifier

`classifyFeePayment` (`backend/src/utils/money.js`) is the only function that
assigns `feeValidationStatus`. Every writer — the verify path,
`updateStudentBalance`, `stellarService.syncPaymentsForSchool`,
`transactionPollingService.processTransaction` (poller and stream), and any
future caller — must route through it (directly, or via
`evaluateUnderpayment` for the installment case). Writers must not hard-code
`'partial'` or `'underpaid'`; doing so is what made reports, dashboards and
rollups undercount part-payments.

### Readers

Report and rollup aggregations bucket `valid`, `partial`, `underpaid`,
`overpaid` and `unknown` separately, and the buckets must sum to
`paymentCount`. The underpaid reconciliation queue and the UI's "underpaid"
filters read `underpaid` only; "partial" filters read `partial`.

### Migrating historical rows

Rows written before this vocabulary was unified may carry `underpaid` where
`partial` is meant (poller/stream) or `partial` where `underpaid` is meant
(plan installments below their installment amount). Migration re-derives the
value with `classifyFeePayment` / `evaluateUnderpayment` from the stored
amounts rather than guessing from the old string.

## Report totals are per asset

`Payment.assetCode` is one of `stellarConfig.ACCEPTED_ASSETS` (`XLM`,
`USDC`). Amounts in different assets are never added together. Every
aggregation in `reportService` (daily reports, per-class totals, the dashboard,
analytics, metrics rollups and the reconciliation report) groups by
`assetCode` and returns:

- `totals: { XLM: '<exact string>', USDC: '<exact string>' }` — one entry per
  asset present, as exact decimal strings;
- `totalFiat` — the sum of `fiatSnapshot` values, in the reporting currency;
- `fiatCoverage` — the percentage of payments that carry a `fiatSnapshot`, so
  a `totalFiat` computed from partial coverage is visibly incomplete.

The CSV export emits one row per asset and carries a bumped `schemaVersion`;
integrators must read `totals` per asset instead of a single `Total Amount`
column.

## What this deliberately does not change

- `Payment.feeValidationStatus` still records `partial` for an installment.
  That field describes the payment against the total fee, which remains true
  and is what the balance, receipt, and reporting code reads. Only the
  reconciliation workflow's interpretation of it changed.
- Plans in `completed` or `cancelled` state confer no exemption. Only `active`
  plans are consulted, so a cancelled plan cannot be used to dodge
  reconciliation of a genuinely short payment.

## When changing this

`evaluateUnderpayment` is the only sanctioned entry point for the installment
question, and `classifyFeePayment` the only sanctioned entry point for the
cumulative one. A new caller that wants to know whether a payment is short
must go through one of them rather than comparing against `feeAmount` or an
installment amount directly, or the bug returns in that caller.

Covered by `tests/underpaidReconciliationPaymentPlans.test.js`, the report
bucket-sum tests, and the mixed-asset report fixtures.
