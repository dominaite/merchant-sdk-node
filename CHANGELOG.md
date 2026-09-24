# Changelog

## 1.0.0

### Breaking

- `idempotencyKey` is required on `createCheckoutSession`, `createCheckoutSessionWithRetry` and
  `chargePaymentMethod`. The SDK no longer makes up a random key; a missing or empty key throws
  `TypeError` before anything is sent.

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
- `toMinorUnits()` and `CURRENCY_EXPONENTS`: decimal string to integer minor units with the ISO 4217
  exponent, no floating point, unknown currency is an error.
- `isPaid()` and `isTerminal()` status helpers.
