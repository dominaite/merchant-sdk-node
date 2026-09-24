# Changelog

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
- `StorefrontError` and `STOREFRONT_ERROR_CODES`.
- `toMinorUnits()` and `CURRENCY_EXPONENTS`: decimal string to integer minor units with the
  gateway's exponent (HUF is whole forints, unlike ISO 4217), no floating point. An unknown
  currency is an error, and ISK, KRW, OMR, JOD and TND are refused as not supported.
- `isPaid()` and `isTerminal()` status helpers.

### Changed

- Docs: a clean replay of a still-open session returns the ORIGINAL session (same
  `transactionId` and cashier fields), as the gateway does. The old text said a replay never
  returns the session.
- `createCheckoutSessionWithRetry` also retries `PAYMENT_PROCESSING_UNAVAILABLE` when it arrives
  as an HTTP 200 refusal, under the same key, like the 503 form it already retried.
