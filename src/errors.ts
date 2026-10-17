import type { PaymentMethodCharge } from './types.js'

/** Base class for every error this SDK throws. */
export class DominaiteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/**
 * The API refused your credentials (HTTP 401) or your key's access (HTTP 403). Not
 * retryable with the same request. The HTTP status is on `httpStatus`, the machine-readable
 * code on `errorCode`:
 * - 401 INVALID_API_KEY, INVALID_SIGNATURE, TIMESTAMP_OUT_OF_RANGE, IP_NOT_ALLOWED: fix the
 *   key id, the secret, the server clock or the IP allowlist.
 * - 403 INSUFFICIENT_SCOPE: the key signed correctly but does not hold the scope the route
 *   needs (payments, webhooks:manage or transactions:read). A key's scopes are fixed when it
 *   is issued, so use a key that holds the scope.
 * - 403 VERIFY_ONLY_NOT_ENABLED: a verifyOnly session, and verify-only is not on for your
 *   account. Nothing was created and the idempotency key is not burnt. We switch it on for
 *   your account.
 */
export class AuthenticationError extends DominaiteError {
  readonly errorCode: string
  /** 401 for a credential problem, 403 for a key that may not call the route. */
  readonly httpStatus: number

  constructor(errorCode: string, message: string, httpStatus = 401) {
    super(message)
    this.errorCode = errorCode
    this.httpStatus = httpStatus
  }
}

/**
 * Named constants for the error codes you are most likely to branch on, so a typo is a
 * compile error instead of a branch that never runs:
 *
 *   if (error instanceof StorefrontError && error.errorCode === ErrorCodes.STOREFRONT_NOT_WHITELISTED)
 *
 * The replay and availability codes arrive on {@link CheckoutRefusedError} (sessions) or
 * {@link ChargeError} (charges); the storefront codes on {@link StorefrontError}; the refund
 * codes on {@link RefundError} or on a failed refund's failureCode.
 */
export const ErrorCodes = Object.freeze({
  /** 409: the storefront's domain is not whitelisted at the payment provider yet. */
  STOREFRONT_NOT_WHITELISTED: 'STOREFRONT_NOT_WHITELISTED',
  /** 409: the storefront was deactivated or deleted. */
  STOREFRONT_INACTIVE: 'STOREFRONT_INACTIVE',
  /** 400: the storefront in the request does not match the one your API key is bound to. */
  STOREFRONT_MISMATCH: 'STOREFRONT_MISMATCH',
  ALREADY_PROCESSED: 'ALREADY_PROCESSED',
  PRIOR_ATTEMPT_FAILED: 'PRIOR_ATTEMPT_FAILED',
  DUPLICATE_REQUEST: 'DUPLICATE_REQUEST',
  PAYMENT_PROCESSING_UNAVAILABLE: 'PAYMENT_PROCESSING_UNAVAILABLE',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  /** 404 on the refund routes: no such payment under your account. */
  PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND',
  /** 404 on getRefund: not picked up yet (poll for up to 60 seconds), or an unknown id. */
  REFUND_NOT_FOUND: 'REFUND_NOT_FOUND',
  /** 422 on createRefund, or a failed refund's failureCode. */
  PAYMENT_NOT_REFUNDABLE: 'PAYMENT_NOT_REFUNDABLE',
  /** 422 on createRefund, or a failed refund's failureCode. */
  REFUND_AMOUNT_EXCEEDED: 'REFUND_AMOUNT_EXCEEDED',
  /** A failed refund's failureCode; never an HTTP error. */
  REFUND_FAILED: 'REFUND_FAILED',
  /** 403 on any route: the key does not hold the scope the route needs. An AuthenticationError. */
  INSUFFICIENT_SCOPE: 'INSUFFICIENT_SCOPE',
  /** 403 on a verifyOnly createCheckoutSession: verify-only is not on for your account. An AuthenticationError. */
  VERIFY_ONLY_NOT_ENABLED: 'VERIFY_ONLY_NOT_ENABLED',
  /** 429: too many requests for your key or your IP. A RateLimitError. */
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  /** 429 on chargePaymentMethod: a charge volume limit. A RateLimitError; see error.result for the window. */
  CHARGE_VELOCITY_EXCEEDED: 'CHARGE_VELOCITY_EXCEEDED',
  /** 429 on chargePaymentMethod: too many declines, so the key's charge route is locked. A RateLimitError. */
  CHARGE_DECLINE_RATE_EXCEEDED: 'CHARGE_DECLINE_RATE_EXCEEDED',

  // 401: the request did not authenticate. An AuthenticationError. See AUTH_ERROR_CODES.
  INVALID_API_KEY: 'INVALID_API_KEY',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  TIMESTAMP_OUT_OF_RANGE: 'TIMESTAMP_OUT_OF_RANGE',
  IP_NOT_ALLOWED: 'IP_NOT_ALLOWED',

  /** 400: the idempotency key was missing or too long. */
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  /** 503: the API is briefly unavailable. A TransportError, or a RevokeError on revoke. */
  MERCHANT_API_UNAVAILABLE: 'MERCHANT_API_UNAVAILABLE',

  // Field codes, on error.validationErrors[].code of a 400. See FIELD_ERROR_CODES.
  REQUIRED: 'REQUIRED',
  MIN_VALUE: 'MIN_VALUE',
  MAX_LENGTH: 'MAX_LENGTH',
  INVALID_FORMAT: 'INVALID_FORMAT',
  INVALID_SELECTION: 'INVALID_SELECTION',
  DATE_IN_FUTURE: 'DATE_IN_FUTURE',
  INVALID_EMAIL: 'INVALID_EMAIL',
  INVALID_CURRENCY: 'INVALID_CURRENCY',

  // Checkout session refusals for a subscription session. See SUBSCRIPTION_REFUSAL_ERROR_CODES.
  AGREEMENT_NOT_PENDING: 'AGREEMENT_NOT_PENDING',
  AGREEMENT_SESSION_OPEN: 'AGREEMENT_SESSION_OPEN',
  AGREEMENT_ALREADY_PAID: 'AGREEMENT_ALREADY_PAID',
  AGREEMENT_VARIABLE_AMOUNT_UNSUPPORTED: 'AGREEMENT_VARIABLE_AMOUNT_UNSUPPORTED',
  SUBSCRIPTIONS_NOT_ENABLED: 'SUBSCRIPTIONS_NOT_ENABLED',

  // chargePaymentMethod. See CHARGE_ERROR_CODES.
  PAYMENT_METHOD_NOT_FOUND: 'PAYMENT_METHOD_NOT_FOUND',
  PAYMENT_METHOD_NOT_ACTIVE: 'PAYMENT_METHOD_NOT_ACTIVE',
  CHARGE_IN_PROGRESS: 'CHARGE_IN_PROGRESS',
  CHARGE_CURRENCY_MISMATCH: 'CHARGE_CURRENCY_MISMATCH',
  CHARGE_OUTCOME_UNKNOWN: 'CHARGE_OUTCOME_UNKNOWN',
  CHARGE_FAILED: 'CHARGE_FAILED',
  PAYMENT_METHOD_CHARGES_DISABLED: 'PAYMENT_METHOD_CHARGES_DISABLED',
  AGREEMENT_METHOD_MISMATCH: 'AGREEMENT_METHOD_MISMATCH',
  AGREEMENT_CONSENT_MISSING: 'AGREEMENT_CONSENT_MISSING',
  AGREEMENT_CURRENCY_MISMATCH: 'AGREEMENT_CURRENCY_MISMATCH',
  AGREEMENT_AMOUNT_MISMATCH: 'AGREEMENT_AMOUNT_MISMATCH',
  CHARGE_AMOUNT_ABOVE_AGREEMENT: 'CHARGE_AMOUNT_ABOVE_AGREEMENT',
  AGREEMENT_PERIOD_ALREADY_CHARGED: 'AGREEMENT_PERIOD_ALREADY_CHARGED',
  AGREEMENT_NOT_STARTED: 'AGREEMENT_NOT_STARTED',
  CHARGE_AMOUNT_ABOVE_CAP: 'CHARGE_AMOUNT_ABOVE_CAP',
  /** HTTP 402 on chargePaymentMethod. Never an exception: the charge resolves with status 'failed'. */
  CHARGE_DECLINED: 'CHARGE_DECLINED',

  // revokePaymentMethod. See REVOKE_ERROR_CODES.
  UPSTREAM_CONTRACT_ERROR: 'UPSTREAM_CONTRACT_ERROR',

  // Plans and agreements. See RECURRING_ERROR_CODES.
  PLAN_NOT_FOUND: 'PLAN_NOT_FOUND',
  PLAN_NOT_ACTIVE: 'PLAN_NOT_ACTIVE',
  AGREEMENT_NOT_FOUND: 'AGREEMENT_NOT_FOUND',
  AGREEMENT_ENDED: 'AGREEMENT_ENDED',
  PAYMENT_METHOD_CURRENCY_MISMATCH: 'PAYMENT_METHOD_CURRENCY_MISMATCH',
  PAYMENT_METHOD_CURRENCY_UNKNOWN: 'PAYMENT_METHOD_CURRENCY_UNKNOWN',
  MAX_AMOUNT_BELOW_PLAN_AMOUNT: 'MAX_AMOUNT_BELOW_PLAN_AMOUNT',
  AGREEMENT_CONSENT_REQUIRED: 'AGREEMENT_CONSENT_REQUIRED',

  // Webhook endpoints. See WEBHOOK_ERROR_CODES.
  WEBHOOK_NOT_FOUND: 'WEBHOOK_NOT_FOUND',
  WEBHOOK_LIMIT_REACHED: 'WEBHOOK_LIMIT_REACHED',
  WEBHOOK_ALREADY_REGISTERED: 'WEBHOOK_ALREADY_REGISTERED',
  WEBHOOK_URL_REJECTED: 'WEBHOOK_URL_REJECTED',
} as const)

/**
 * The codes of the contract's auth group, in the contract's order. Each arrives as an
 * {@link AuthenticationError} with httpStatus 401. Fix the key id, the secret, the server
 * clock or the IP allowlist; do not retry the same request.
 */
export const AUTH_ERROR_CODES = ['INVALID_API_KEY', 'INVALID_SIGNATURE', 'TIMESTAMP_OUT_OF_RANGE', 'IP_NOT_ALLOWED'] as const

/** One of the auth codes this SDK knows about. */
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number]

/**
 * The field codes of the contract's validation group, in the contract's order. They sit on
 * `result.error.validationErrors[].code` of a 400 ApiError, one per field; `errorCode` itself
 * is VALIDATION_ERROR.
 */
export const FIELD_ERROR_CODES = [
  'REQUIRED',
  'MIN_VALUE',
  'MAX_LENGTH',
  'INVALID_FORMAT',
  'INVALID_SELECTION',
  'DATE_IN_FUTURE',
  'INVALID_EMAIL',
  'INVALID_CURRENCY',
] as const

/** One of the field codes this SDK knows about. Unknown codes arrive as plain strings. */
export type FieldErrorCode = (typeof FIELD_ERROR_CODES)[number]

/**
 * The codes the plan and agreement routes answer with, as an {@link ApiError}: 404
 * PLAN_NOT_FOUND, AGREEMENT_NOT_FOUND, PAYMENT_METHOD_NOT_FOUND; 409 PLAN_NOT_ACTIVE,
 * AGREEMENT_ENDED, PAYMENT_METHOD_NOT_ACTIVE; 422 the rest. Nothing is created on any of them.
 */
export const RECURRING_ERROR_CODES = [
  'PLAN_NOT_FOUND',
  'PLAN_NOT_ACTIVE',
  'AGREEMENT_NOT_FOUND',
  'AGREEMENT_ENDED',
  'PAYMENT_METHOD_NOT_FOUND',
  'PAYMENT_METHOD_NOT_ACTIVE',
  'PAYMENT_METHOD_CURRENCY_MISMATCH',
  'PAYMENT_METHOD_CURRENCY_UNKNOWN',
  'MAX_AMOUNT_BELOW_PLAN_AMOUNT',
  'AGREEMENT_CONSENT_REQUIRED',
  'IDEMPOTENCY_KEY_REUSED',
] as const

/** One of the plan and agreement codes this SDK knows about. Unknown codes arrive as plain strings. */
export type RecurringErrorCode = (typeof RECURRING_ERROR_CODES)[number]

/**
 * The codes the webhook endpoint routes answer with, as an {@link ApiError}: 404
 * WEBHOOK_NOT_FOUND; 409 WEBHOOK_LIMIT_REACHED, WEBHOOK_ALREADY_REGISTERED, DUPLICATE_REQUEST;
 * 400 WEBHOOK_URL_REJECTED; 422 IDEMPOTENCY_KEY_REUSED.
 */
export const WEBHOOK_ERROR_CODES = [
  'WEBHOOK_NOT_FOUND',
  'WEBHOOK_LIMIT_REACHED',
  'WEBHOOK_ALREADY_REGISTERED',
  'WEBHOOK_URL_REJECTED',
  'IDEMPOTENCY_KEY_REUSED',
  'DUPLICATE_REQUEST',
] as const

/** One of the webhook endpoint codes this SDK knows about. Unknown codes arrive as plain strings. */
export type WebhookErrorCode = (typeof WEBHOOK_ERROR_CODES)[number]

/**
 * The codes the SDK raises as a {@link StorefrontError}, on sessions and charges alike, in
 * the contract's order: 400 STOREFRONT_MISMATCH, 409 STOREFRONT_INACTIVE, 409
 * STOREFRONT_NOT_WHITELISTED. None is retryable, and none is a session refusal.
 */
export const STOREFRONT_ERROR_CODES = [
  'STOREFRONT_MISMATCH',
  'STOREFRONT_INACTIVE',
  'STOREFRONT_NOT_WHITELISTED',
] as const

/** One of the storefront codes this SDK knows about. */
export type StorefrontErrorCode = (typeof STOREFRONT_ERROR_CODES)[number]

/**
 * The codes of the contract's authorization group, in the contract's order: 403
 * INSUFFICIENT_SCOPE, the key signed correctly but lacks the scope the route needs. It arrives
 * as an {@link AuthenticationError} with httpStatus 403. Not retryable with the same key.
 */
export const AUTHORIZATION_ERROR_CODES = ['INSUFFICIENT_SCOPE'] as const

/** One of the authorization codes this SDK knows about. */
export type AuthorizationErrorCode = (typeof AUTHORIZATION_ERROR_CODES)[number]

/**
 * The gateway understood the request but refused to open a checkout session.
 * Branch on `errorCode`:
 * - PAYMENT_PROCESSING_UNAVAILABLE: card payments are off right now; retry later.
 * - DUPLICATE_REQUEST: the session for this key is still open but cannot be handed back
 *   right now (still being created, or expired and not yet settled); retry the SAME key
 *   shortly. A clean replay of an open session is not a refusal: it returns the session.
 * - ALREADY_PROCESSED: this idempotency key's payment already completed.
 * - PRIOR_ATTEMPT_FAILED: a prior attempt with this key failed terminally; use a fresh key.
 * - IDEMPOTENCY_KEY_REUSED: same key sent with a DIFFERENT body; use a fresh key.
 *
 * On a replay refusal the API also names WHICH payment your key collided with, on
 * `transactionId`. That is the recovery path - read it back with getStatus() to find
 * out what the earlier attempt did, instead of minting a second payment for the same
 * order:
 *
 *   try {
 *     session = await client.createCheckoutSession(params)
 *   } catch (error) {
 *     if (error instanceof CheckoutRefusedError && error.transactionId) {
 *       const status = await client.getStatus(error.transactionId)
 *     }
 *   }
 *
 * `transactionId` is undefined when the API did not name one - notably the
 * concurrent-race DUPLICATE_REQUEST, which knows a key was taken but not yet by which
 * row. Always check before using it.
 */
/** Business refusals: HTTP 200 with success=false. They arrive as {@link CheckoutRefusedError}. */
export const SESSION_REFUSAL_ERROR_CODES = [
  'PAYMENT_PROCESSING_UNAVAILABLE',
  'DUPLICATE_REQUEST',
  'ALREADY_PROCESSED',
  'IDEMPOTENCY_KEY_REUSED',
  'PRIOR_ATTEMPT_FAILED',
] as const

/**
 * The refusals of a subscription session (createCheckoutSession with agreementId), also HTTP
 * 200 with success=false and also a {@link CheckoutRefusedError}. Nothing is created on any
 * of them. SUBSCRIPTIONS_NOT_ENABLED: subscriptions are not on for your account.
 */
export const SUBSCRIPTION_REFUSAL_ERROR_CODES = [
  'AGREEMENT_NOT_FOUND',
  'AGREEMENT_NOT_PENDING',
  'AGREEMENT_AMOUNT_MISMATCH',
  'AGREEMENT_CONSENT_REQUIRED',
  'AGREEMENT_SESSION_OPEN',
  'AGREEMENT_ALREADY_PAID',
  'AGREEMENT_VARIABLE_AMOUNT_UNSUPPORTED',
  'SUBSCRIPTIONS_NOT_ENABLED',
] as const

/** One of the refusal codes this SDK knows about. Unknown codes arrive as plain strings. */
export type SessionRefusalErrorCode =
  | (typeof SESSION_REFUSAL_ERROR_CODES)[number]
  | (typeof SUBSCRIPTION_REFUSAL_ERROR_CODES)[number]

/**
 * Input validation on the create endpoint. A different shape from the refusals above:
 * HTTP 400, not success=false, so these arrive as {@link ApiError} and not
 * {@link CheckoutRefusedError}.
 */
export const VALIDATION_ERROR_CODES = ['IDEMPOTENCY_KEY_REQUIRED'] as const

/** One of the validation codes this SDK knows about. Unknown codes arrive as plain strings. */
export type ValidationErrorCode = (typeof VALIDATION_ERROR_CODES)[number]

export class CheckoutRefusedError extends DominaiteError {
  readonly errorCode: string
  /** The payment this idempotency key collided with, when the API named one. */
  readonly transactionId?: string
  /** The full unwrapped refusal payload, for fields not modelled above. */
  readonly result: Record<string, unknown>

  constructor(
    errorCode: string,
    message: string,
    transactionId?: string,
    result: Record<string, unknown> = {},
  ) {
    super(message)
    this.errorCode = errorCode
    this.transactionId = transactionId
    this.result = result
  }
}

/**
 * The API answered, but with an unexpected or rejecting response.
 *
 * `errorCode` carries the machine-readable code when the API sent one - notably the
 * validation codes above on a 400 (IDEMPOTENCY_KEY_REQUIRED). It is undefined when the
 * response had no code to give, so check before branching on it.
 *
 * `result` is the whole JSON envelope the API sent ({} when there was none to parse), for
 * fields not modelled above, such as error.params.
 */
export class ApiError extends DominaiteError {
  readonly httpStatus: number
  /** The API's machine-readable code, when it sent one. See {@link VALIDATION_ERROR_CODES}. */
  readonly errorCode?: string
  /** The full envelope, for fields not modelled above. */
  readonly result: Record<string, unknown>

  constructor(httpStatus: number, message: string, errorCode?: string, result: Record<string, unknown> = {}) {
    super(message)
    this.httpStatus = httpStatus
    this.errorCode = errorCode
    this.result = result
  }
}

/**
 * The gateway refused the request because of the storefront (website) it would be
 * attributed to. A configuration problem, not a transient one: retrying does not help
 * until the storefront is fixed on the Dominaite side. A subclass of {@link ApiError},
 * so an existing `instanceof ApiError` branch still catches it. Branch on `errorCode`:
 * - STOREFRONT_NOT_WHITELISTED (409): the site's domain is not whitelisted at the payment
 *   provider yet. Ask Dominaite support to finish the whitelisting; nothing was created.
 * - STOREFRONT_INACTIVE (409): the storefront was deactivated or deleted.
 * - STOREFRONT_MISMATCH (400): the storefront in the request is not the one the API key is
 *   bound to. Use the key issued for that website.
 */
export class StorefrontError extends ApiError {
  declare readonly errorCode: StorefrontErrorCode

  constructor(
    httpStatus: number,
    errorCode: StorefrontErrorCode,
    message: string,
    result: Record<string, unknown> = {},
  ) {
    super(httpStatus, message, errorCode, result)
  }
}

/**
 * The codes {@link DominaiteClient.chargePaymentMethod} raises as a {@link ChargeError}.
 * CHARGE_DECLINED (HTTP 402) is deliberately not one of them: a decline is a charge result
 * with status 'failed', not an exception. Neither are the 429 limits: they arrive as a
 * {@link RateLimitError}.
 */
export const CHARGE_ERROR_CODES = [
  'PAYMENT_METHOD_NOT_ACTIVE',
  'DUPLICATE_REQUEST',
  'IDEMPOTENCY_KEY_REUSED',
  'CHARGE_OUTCOME_UNKNOWN',
  'CHARGE_FAILED',
  'PAYMENT_METHOD_CHARGES_DISABLED',
  'PAYMENT_PROCESSING_UNAVAILABLE',
  'PAYMENT_METHOD_NOT_FOUND',
  'CHARGE_IN_PROGRESS',
  'CHARGE_CURRENCY_MISMATCH',
  'AGREEMENT_NOT_FOUND',
  'AGREEMENT_METHOD_MISMATCH',
  'AGREEMENT_CONSENT_MISSING',
  'AGREEMENT_CURRENCY_MISMATCH',
  'AGREEMENT_AMOUNT_MISMATCH',
  'CHARGE_AMOUNT_ABOVE_AGREEMENT',
  'AGREEMENT_PERIOD_ALREADY_CHARGED',
  'AGREEMENT_ENDED',
  'AGREEMENT_NOT_STARTED',
  'CHARGE_AMOUNT_ABOVE_CAP',
] as const

/** One of the charge error codes this SDK knows about. Unknown codes arrive as plain strings. */
export type ChargeErrorCode = (typeof CHARGE_ERROR_CODES)[number]

/**
 * The gateway answered a charge with an error code instead of a charge result. The
 * HTTP status is on `httpStatus`, the machine-readable code on `errorCode`, and the
 * charge row the gateway attached (when it did) on `charge`. Branch on `errorCode`:
 * - CHARGE_OUTCOME_UNKNOWN (502): the provider gave no verdict and the charge MAY have
 *   happened. `charge` is present: poll getStatus(charge.transactionId) or wait for the
 *   webhook. Never retry under a new key.
 * - CHARGE_FAILED (502): nothing was charged. `charge` is present when a row exists
 *   (its declineClass and declineCode are null), absent when the provider refused before one.
 * - PAYMENT_METHOD_NOT_ACTIVE (409): the method is revoked, expired or retired; ask the customer
 *   for another card via a hosted session with saveCard.
 * - DUPLICATE_REQUEST (409): a request with this key is still in flight; retry with the
 *   SAME key in a moment.
 * - IDEMPOTENCY_KEY_REUSED (422): same key, different body or method; a bug on your side.
 * - PAYMENT_PROCESSING_UNAVAILABLE (503): nothing was charged; retry later with the SAME key.
 * - PAYMENT_METHOD_CHARGES_DISABLED (503): nothing was charged. We answer it until we switch
 *   stored-card charges on for your account. We also answer it when we pause charges for a
 *   short time. The code is the same in both cases. If we never switched stored-card charges
 *   on for your account, a retry does not help: ask us. If they are on, retry later with the
 *   SAME key.
 *
 * - PAYMENT_METHOD_NOT_FOUND or AGREEMENT_NOT_FOUND (404): the id is not one of yours.
 *
 * A subclass of {@link ApiError}, so an existing `instanceof ApiError` branch still catches
 * it. `result` is the whole envelope the gateway sent, for fields not modelled above.
 */
export class ChargeError extends ApiError {
  declare readonly errorCode: string
  /** The charge row the gateway attached to its answer, when it did. */
  readonly charge?: PaymentMethodCharge
  /** Shortcut for charge.transactionId, for polling getStatus(). */
  readonly transactionId?: string

  constructor(
    httpStatus: number,
    errorCode: string,
    message: string,
    charge?: PaymentMethodCharge,
    result: Record<string, unknown> = {},
  ) {
    super(httpStatus, message, errorCode, result)
    this.charge = charge
    this.transactionId = charge?.transactionId
  }
}

/**
 * The codes {@link DominaiteClient.revokePaymentMethod} raises as a {@link RevokeError},
 * in the gateway's own order.
 */
export const REVOKE_ERROR_CODES = ['UPSTREAM_CONTRACT_ERROR', 'MERCHANT_API_UNAVAILABLE'] as const

/** One of the revoke error codes this SDK knows about. Unknown codes arrive as plain strings. */
export type RevokeErrorCode = (typeof REVOKE_ERROR_CODES)[number]

/**
 * The gateway refused to revoke a stored payment method. Nothing changed either way;
 * branch on `errorCode`:
 * - MERCHANT_API_UNAVAILABLE (503): the provider is unavailable or throttling; retry later.
 * - UPSTREAM_CONTRACT_ERROR (502): the provider refused the deletion for a reason a retry
 *   will not fix; contact support with the payment method id.
 *
 * An id that is not yours is still the generic {@link ApiError} with httpStatus 404.
 */
export class RevokeError extends DominaiteError {
  readonly httpStatus: number
  readonly errorCode: string
  /** The full envelope, for fields not modelled above. */
  readonly result: Record<string, unknown>

  constructor(httpStatus: number, errorCode: string, message: string, result: Record<string, unknown> = {}) {
    super(message)
    this.httpStatus = httpStatus
    this.errorCode = errorCode
    this.result = result
  }
}

/**
 * The codes {@link DominaiteClient.createRefund} and {@link DominaiteClient.getRefund} raise
 * as a {@link RefundError}, in the contract's order. A 500 on a refund route is not one of
 * them: it means nothing was queued, and arrives as a {@link TransportError} (retry with the
 * SAME key).
 */
export const REFUND_ERROR_CODES = [
  'PAYMENT_NOT_FOUND',
  'REFUND_NOT_FOUND',
  'PAYMENT_NOT_REFUNDABLE',
  'REFUND_AMOUNT_EXCEEDED',
  'IDEMPOTENCY_KEY_REUSED',
  'DUPLICATE_REQUEST',
  'IDEMPOTENCY_KEY_REQUIRED',
] as const

/** One of the refund error codes this SDK knows about. Unknown codes arrive as plain strings. */
export type RefundErrorCode = (typeof REFUND_ERROR_CODES)[number]

/** The refund error codes worth retrying, each within its own window (see {@link RefundError}). */
const RETRYABLE_REFUND_ERROR_CODES: ReadonlySet<string> = new Set<RefundErrorCode>([
  'REFUND_NOT_FOUND',
  'DUPLICATE_REQUEST',
])

/**
 * Why a refund ended up failed, on {@link Refund.failureCode}, in the contract's order. Not
 * an exception: a failed refund is a result, read with getRefund(). Treat a value you do not
 * recognise as REFUND_FAILED.
 */
export const REFUND_FAILURE_CODES = ['REFUND_AMOUNT_EXCEEDED', 'PAYMENT_NOT_REFUNDABLE', 'REFUND_FAILED'] as const

/** One of the refund failure codes this SDK knows about. Unknown codes arrive as plain strings. */
export type RefundFailureCode = (typeof REFUND_FAILURE_CODES)[number]

/**
 * The gateway answered a refund route with an error code instead of a refund. A subclass of
 * {@link ApiError}, so an existing `instanceof ApiError` branch still catches it. The HTTP
 * status is on `httpStatus`, the code on `errorCode`, and `retryable` says whether sending the
 * same request again can help. Branch on `errorCode`:
 * - PAYMENT_NOT_FOUND (404): no card-not-present payment with this id under your account.
 * - REFUND_NOT_FOUND (404, getRefund only, retryable): right after the 202 the refund may not
 *   be picked up yet. Poll again for up to 60 seconds; after that the id is unknown.
 * - PAYMENT_NOT_REFUNDABLE (422): not paid, already fully refunded, or everything left is
 *   already being refunded. Nothing was queued and the key is not burnt.
 * - REFUND_AMOUNT_EXCEEDED (422): more than what is left to refund, counting refunds in
 *   progress; the message names the amount left. Nothing was queued and the key is not burnt.
 * - IDEMPOTENCY_KEY_REUSED (422): the key was first used for a different amount, reason or
 *   payment. Use a fresh key for a genuinely new refund.
 * - DUPLICATE_REQUEST (409, retryable): a request with this key is still being processed.
 *   Retry with the SAME key after a second, for up to 120 seconds.
 * - IDEMPOTENCY_KEY_REQUIRED (400): the key was missing or too long.
 *
 * `result` is the whole envelope the gateway sent, for fields not modelled above.
 */
export class RefundError extends ApiError {
  declare readonly errorCode: string
  /** True for REFUND_NOT_FOUND and DUPLICATE_REQUEST: the same request can succeed later. */
  readonly retryable: boolean

  constructor(httpStatus: number, errorCode: string, message: string, result: Record<string, unknown> = {}) {
    super(httpStatus, message, errorCode, result)
    this.retryable = RETRYABLE_REFUND_ERROR_CODES.has(errorCode)
  }
}

/**
 * HTTP 429: a limit refused the request before anything happened. Branch on `errorCode`:
 * - RATE_LIMIT_EXCEEDED: you sent more requests than your key or your IP is allowed.
 *   Platform limits are 60 requests per minute per API key and 120 per minute per IP.
 *   Both are enforced on a rolling window, so a burst that fits inside one minute still
 *   counts against the next.
 * - CHARGE_VELOCITY_EXCEEDED (chargePaymentMethod): a charge volume limit. The window and
 *   the limit are at `result.error.params`. A charge that keeps hitting this is a pattern
 *   to look into, not to retry around.
 * - CHARGE_DECLINE_RATE_EXCEEDED (chargePaymentMethod): the key collected too many declined
 *   charges, so its charge route is locked for a while. Your other routes keep working.
 *
 * `errorCode` is undefined when the API sent no code.
 *
 * This is NOT retried automatically. The SDK cannot know how long to wait without
 * making the burst worse, so it hands the decision back to you: sleep for
 * `retryAfterSeconds` and send the request again with the SAME idempotency key.
 *
 * `retryAfterSeconds` is the `Retry-After` header when the API sent it as a whole
 * number of seconds, and null otherwise - the header is also allowed to carry an HTTP
 * date, which this SDK does not translate. Fall back to your own backoff when it is null.
 */
export class RateLimitError extends DominaiteError {
  /** Seconds to wait before retrying, or null when the API did not give a usable value. */
  readonly retryAfterSeconds: number | null
  /** The API's machine-readable code, when it sent one. */
  readonly errorCode?: string
  /** The full envelope, for fields not modelled above. */
  readonly result: Record<string, unknown>

  constructor(
    message: string,
    retryAfterSeconds: number | null = null,
    errorCode?: string,
    result: Record<string, unknown> = {},
  ) {
    super(message)
    this.retryAfterSeconds = retryAfterSeconds
    this.errorCode = errorCode
    this.result = result
  }
}

/**
 * Network-level failure or a 5xx - the request may or may not have reached the API.
 * Safe to retry WITH THE SAME idempotency key; a retried key never creates a second payment.
 *
 * On a 5xx the HTTP status is on `httpStatus` and the API's code, when it sent one (for
 * example INTERNAL_ERROR or MERCHANT_API_UNAVAILABLE), on `errorCode`. Both are undefined
 * when the request never got an answer.
 *
 * If the earlier attempt did reach the API and its session is still open, the retry gets
 * that original session back. If the payment has moved on (paid, failed, expired), the
 * retry is refused as a replay ({@link CheckoutRefusedError}) naming the transaction.
 */
export class TransportError extends DominaiteError {
  /** The 5xx status, or undefined when no answer arrived. */
  readonly httpStatus?: number
  /** The API's machine-readable code on a 5xx, when it sent one. */
  readonly errorCode?: string
  /** The full envelope of a 5xx answer ({} when there was none to parse). */
  readonly result: Record<string, unknown>

  constructor(
    message: string,
    options: { httpStatus?: number; errorCode?: string; result?: Record<string, unknown> } = {},
  ) {
    super(message)
    this.httpStatus = options.httpStatus
    this.errorCode = options.errorCode
    this.result = options.result ?? {}
  }
}
