# Changelog

## 0.6.0

### Breaking

- The base URL is required. The client no longer falls back to production when you leave it
  out, so an unset environment variable cannot send sandbox credentials to production.
  Construction fails with `TypeError` when the base URL is missing, empty or whitespace. Pass
  `SANDBOX_BASE_URL` (`https://api.staging.dominaite.com/payments`) or `PRODUCTION_BASE_URL`
  (`https://api.dominaite.com/payments`), or your own value. `baseUrl` is no longer optional
  in `DominaiteClientOptions`.

## 0.5.2

### Added

- Billing address on the payer: `CheckoutCustomer.address`, `city`, `postalCode` and `state`,
  all optional. Address is one line, at most 200 characters; city at most 100; postal code at
  most 20. State is the state or province code, at most 50 characters, and only used for the
  United States, Canada and Australia. The widget does not ask the payer for a field that you
  send. A value that is too long fails with 400 `VALIDATION_ERROR`, code `MAX_LENGTH`.

## 0.5.1

### Added

- `Transaction` has `fee`, `netAmount`, `settledAt` and `payoutId`. They are `null` until the
  acquirer settles the payment, and `payoutId` until the money is paid out. `fee` and `netAmount`
  are in minor units.
- `ListTransactionsParams` has `settledFrom` and `settledTo`: a settlement-date window, sent as
  dates (`2026-10-13`). A `Date` is sent as its UTC date. The SDK still signs the path only.

## 0.5.0

### Added

- Verify-only sessions: `verifyOnly: true` on `createCheckoutSession()` saves the payer's card with
  no payment. Send `amount: 0` or leave the amount out; any other amount throws `TypeError` before
  anything is sent. The API refuses the session with 403 `VERIFY_ONLY_NOT_ENABLED` until we switch
  it on for your account. The session sends `verification.succeeded` or `verification.failed`
  (`VerificationWebhookEvent`), never a `payment.*` event.
- Subscription sessions: `CreateCheckoutSessionParams` models `agreementId` and `consent`
  (`AgreementConsent`), and also `locationId`.
- Subscriptions: `createPlan()`, `listPlans()`, `getPlan()`, `updatePlan()` (PATCH) and
  `deletePlan()`, and `createAgreement()`, `getAgreement()` and `cancelAgreement()`.
  `createPlan()` and `createAgreement()` need an idempotency key. `updatePlan()` sends one only
  when you give one, because the API does not replay a plan update. `Plan`, `Agreement`,
  `AgreementConsentRecord`, `CreatePlanParams`, `UpdatePlanParams`, `CreateAgreementParams`,
  `PLAN_STATUSES`, `INTERVAL_UNITS`, `AGREEMENT_STATUSES` and `PAST_DUE_REASONS` are exported.
- `listRefunds(transactionId)`: the refunds of one payment that you created through the API, and
  the `refundedAmount` and `refundableAmount` totals (`RefundList`).
- Webhook endpoints from your code, with a `webhooks:manage` key: `createWebhookEndpoint()`,
  `listWebhookEndpoints()` and `deleteWebhookEndpoint()`. The create answers the `whsec_` secret
  one time only; a repeat with the same key answers `secret: null`. `WebhookEndpoint`,
  `CreatedWebhookEndpoint`, `CreateWebhookEndpointParams` and `WEBHOOK_ENDPOINT_STATUSES` are
  exported.
- `listTransactions({ from, to, status, limit, cursor })`, with a `transactions:read` key: one page
  of your payments, oldest first, and the `nextCursor` of the next page. The SDK signs the path
  without the query. `Transaction`, `TransactionPage`, `ListTransactionsParams` and
  `TRANSACTION_TYPES` are exported.
- `getIntegrationContract()`: the contract that the API publishes about itself. Only `version` is
  modelled (`IntegrationContract`); the other fields come through as sent.
- Response fields: `verifyOnly`, `declineClass`, `isRecurring`, `agreement`
  (`CheckoutStatusAgreement`) and `sequence` on `CheckoutStatus`; `verifyOnly` and `agreementId`
  on `CheckoutSession`; `agreementId` and `sequence` on `PaymentMethodCharge`; `verifyOnly` and
  `declineClass` on `PaymentWebhookData`. Every status, class and reason stays a lenient string,
  so a value the SDK does not know never throws.
- `agreementId` on `ChargePaymentMethodParams`.
- Errors: `AuthenticationError.httpStatus` (401 or 403). `RateLimitError.errorCode` and
  `RateLimitError.result`. `ApiError.result`, and so `StorefrontError.result`: the whole JSON
  answer, for example `error.params.webhookId` on 409 `WEBHOOK_ALREADY_REGISTERED`.
- `ErrorCodes` gains `INSUFFICIENT_SCOPE`, `VERIFY_ONLY_NOT_ENABLED`, `RATE_LIMIT_EXCEEDED`,
  `CHARGE_VELOCITY_EXCEEDED` and `CHARGE_DECLINE_RATE_EXCEEDED`. `AUTHORIZATION_ERROR_CODES` and
  `AuthorizationErrorCode` list the 403 authorization group, pinned against the wire contract.
- Contract fixture: the new status read, checkout session and charge fields, with examples. Wire
  contract fixture: the authorization error group.
- Wallet reporting: `paymentMethod` and `walletType` (both optional, nullable strings) on
  `CheckoutStatus`. `paymentMethod` is how the payer paid (`card`, `wallet`, `bank_transfer`,
  `sepa`), null while the payment is still open and on older transactions. `walletType` names the
  wallet when `paymentMethod` is `wallet` and is null otherwise; an unknown value is a valid wallet,
  not an error. Reporting data only: a wallet payment refunds, captures and disputes like a card.
  `PAYMENT_METHOD_CATEGORIES`, `WALLET_TYPES`, `PaymentMethodCategory` and `WalletType` are
  exported.
- Contract fixture: `paymentMethod` and `walletType` in the status read fields and examples. Wire
  contract fixture and the drift check: the `wallets` section.

### Changed

- A 403 no longer tells you to check your key id, secret and server clock. That hint is for 401
  only. 403 `INSUFFICIENT_SCOPE` repeats the API message that names the missing scope, and 403
  `VERIFY_ONLY_NOT_ENABLED` says that verify-only is not on for your account.
- `chargePaymentMethod()` and `createRefund()` send every field you give, not only the fields that
  the SDK models, so a new API field needs no SDK release. The idempotency key stays a header,
  and the amount and reason checks stay.
- `declineClass` can be null, for example when nobody declined the payment. The docs no longer
  promise a class on every decline, and `getStatus()` carries the latest class.
- The README installs from npm and documents key scopes, verify-only sessions, subscriptions,
  the refund list, webhook endpoints, transactions and the integration contract.

## 0.4.0

### Added

- Card fields: `integration` on `createCheckoutSession` (`'widget'` or `'fields'`, left out of the
  body when not set), and `integration` and `clientSecret` on the returned `CheckoutSession`.
  `clientSecret` is set only for fields sessions. `CHECKOUT_INTEGRATIONS` and
  `CheckoutIntegration` are exported. Card fields are enabled per merchant on request; see the
  README.
- Processor reference: `pspReference` (`string | null`, optional) on `CheckoutStatus` and on
  `payment.*` webhook data. The payment processor's reference for the transaction, null until
  known and on a sale settled by reconciliation without a processor webhook. Refund and cancel
  events carry the original sale's reference. Not on `charge.*` events.
- Contract fixture: `pspReference` in the status read fields and examples.
- Contract fixture: `integrationVocabulary`, the two new checkout fields and a fields session
  example.

## 0.3.1

0.3.0 never reached npm (its publish run failed), so this is the first npm release since 0.2.0 and
includes everything listed under 0.3.0 below.

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
