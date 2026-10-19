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
