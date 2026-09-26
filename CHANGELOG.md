# Changelog

## 0.3.1 (unreleased)

### Added

- `parseWebhookEvent()`: parses a verified webhook body and checks the envelope. Types for the
  envelope (`WebhookEvent`, `DominaiteWebhookEvent`) and for `payment.*`, `agreement.*` and
  `charge.*` data.
- Webhook envelopes carry `apiVersion` (a date, currently `2026-09-25`), and `agreement.*` and
  `charge.*` data carry an integer `sequence` for ordering out-of-order deliveries. Both are
  optional in the types so payloads from a gateway that does not send them yet still parse. The
  README documents the ordering rule.
- `createRefund(transactionId, { amount?, reason?, idempotencyKey })` and
  `getRefund(transactionId, refundId)`. The Idempotency-Key is required and signed, as on a
  charge. Omit `amount` to refund everything still refundable; the SDK then sends no `amount`
  key. The create answers 202 once the refund is queued; read the outcome with `getRefund()` or
  wait for `payment.refunded`. A failed refund sends no webhook.
- `Refund`, `RefundStatus`, `CreateRefundParams`, and `REFUND_STATUSES`, `REFUND_ERROR_CODES` and
  `REFUND_FAILURE_CODES`, pinned against the contract. A failed refund is a result with
  `failureCode`, not an exception; `amount`, `failureCode`, `failureMessage` and `completedAt`
  read absent as null.
- `RefundError` (extends `ApiError`) for the refund route codes, with `retryable` set for
  `REFUND_NOT_FOUND` and `DUPLICATE_REQUEST`. `ErrorCodes` gains `PAYMENT_NOT_FOUND`,
  `REFUND_NOT_FOUND`, `PAYMENT_NOT_REFUNDABLE`, `REFUND_AMOUNT_EXCEEDED` and `REFUND_FAILED`.
- `storedPaymentMethod` on `payment.*` webhook data, the same `StoredPaymentMethod` as on the
  status read. Null or absent when no card was saved, and it can be null even when one was: the
  status read is the source of truth.

## 0.3.0

### Breaking

- `idempotencyKey` is required on `createCheckoutSession`, `createCheckoutSessionWithRetry` and
  `chargePaymentMethod`. The SDK no longer makes up a random key; a missing or empty key throws
  `TypeError` before anything is sent.
- An idempotency key must be 1 to 100 visible ASCII characters (0x21 to 0x7E). Keys with spaces,
  control characters or non-ASCII letters, previously accepted up to 100 code points, now throw
  `TypeError`.

  **Migration:** pass a key derived from the order, e.g.
  `idempotencyKey: orderIdempotencyKey({ scope: 'checkout', orderId, amountMinor, currency })`.
  For charges, derive it from what you are charging for (the billing period, the order).
- A reply carrying `STOREFRONT_NOT_WHITELISTED`, `STOREFRONT_INACTIVE` or `STOREFRONT_MISMATCH`
  now throws `StorefrontError`. It extends `ApiError`, so existing `ApiError` handling still
  catches it; a charge that used to throw `ChargeError` for these codes throws `StorefrontError`.

### Added

- `orderIdempotencyKey()`: builds `{scope}-{orderId}-{amountMinor}-{CURRENCY}`. Same order and
  amount replays the same session; a changed amount gets a new key.
- `ErrorCodes`: named constants for the storefront codes and the replay and availability codes.
- `StorefrontError` and `STOREFRONT_ERROR_CODES`, in the contract's order (`STOREFRONT_MISMATCH`
  400, `STOREFRONT_INACTIVE` 409, `STOREFRONT_NOT_WHITELISTED` 409) and pinned against its
  `storefrontErrorCodes`. None is retryable and none is a session refusal.
- `toMinorUnits()` and `CURRENCY_EXPONENTS`: decimal string to integer minor units with the
  gateway's exponent (HUF is whole forints, unlike ISO 4217), no floating point. An unknown
  currency is an error, and ISK, KRW, OMR, JOD and TND are refused as not supported.
- `isPaid()` and `isTerminal()` status helpers.
- Contract refresh (gateway contract 2026-09-16): a stored payment method can be `retired`, and
  carries `retiredReason` (`hard_decline`, `chargeback` or `source_sale_reversed`, null on every
  other card). `STORED_PAYMENT_METHOD_RETIRED_REASONS` and the `StoredPaymentMethodRetiredReason`
  type list them. A retired card is not chargeable and never becomes active again.

### Changed

- Docs: a clean replay of a still-open session returns the ORIGINAL session (same
  `transactionId` and cashier fields), as the gateway does. The old text said a replay never
  returns the session.
- `createCheckoutSessionWithRetry` also retries `PAYMENT_PROCESSING_UNAVAILABLE` when it arrives
  as an HTTP 200 refusal, under the same key, like the 503 form it already retried.
