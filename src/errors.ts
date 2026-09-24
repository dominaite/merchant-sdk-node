import type { PaymentMethodCharge } from './types.js'

/** Base class for every error this SDK throws. */
export class DominaiteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/**
 * The API rejected your credentials or signature. Not retryable - fix the key id,
 * secret, or server clock. Machine-readable code on `errorCode`:
 * INVALID_API_KEY, INVALID_SIGNATURE, TIMESTAMP_OUT_OF_RANGE, IP_NOT_ALLOWED.
 */
export class AuthenticationError extends DominaiteError {
  readonly errorCode: string

  constructor(errorCode: string, message: string) {
    super(message)
    this.errorCode = errorCode
  }
}

/**
 * Named constants for the error codes you are most likely to branch on, so a typo is a
 * compile error instead of a branch that never runs:
 *
 *   if (error instanceof StorefrontError && error.errorCode === ErrorCodes.STOREFRONT_NOT_WHITELISTED)
 *
 * The replay and availability codes arrive on {@link CheckoutRefusedError} (sessions) or
 * {@link ChargeError} (charges); the storefront codes on {@link StorefrontError}.
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
} as const)

/** The codes the SDK raises as a {@link StorefrontError}, on sessions and charges alike. */
export const STOREFRONT_ERROR_CODES = [
  'STOREFRONT_NOT_WHITELISTED',
  'STOREFRONT_INACTIVE',
  'STOREFRONT_MISMATCH',
] as const

/** One of the storefront codes this SDK knows about. */
export type StorefrontErrorCode = (typeof STOREFRONT_ERROR_CODES)[number]

/**
 * The gateway understood the request but refused to open a checkout session.
 * Branch on `errorCode`:
 * - PAYMENT_PROCESSING_UNAVAILABLE: card payments are off right now; retry later.
 * - DUPLICATE_REQUEST: a session for this idempotency key is already open.
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

/** One of the refusal codes this SDK knows about. Unknown codes arrive as plain strings. */
export type SessionRefusalErrorCode = (typeof SESSION_REFUSAL_ERROR_CODES)[number]

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
 */
export class ApiError extends DominaiteError {
  readonly httpStatus: number
  /** The API's machine-readable code, when it sent one. See {@link VALIDATION_ERROR_CODES}. */
  readonly errorCode?: string

  constructor(httpStatus: number, message: string, errorCode?: string) {
    super(message)
    this.httpStatus = httpStatus
    this.errorCode = errorCode
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

  constructor(httpStatus: number, errorCode: StorefrontErrorCode, message: string) {
    super(httpStatus, message, errorCode)
  }
}

/**
 * The codes {@link DominaiteClient.chargePaymentMethod} raises as a {@link ChargeError},
 * in the gateway's own order. CHARGE_DECLINED (HTTP 402) is deliberately not one of them:
 * a decline is a charge result with status 'failed', not an exception.
 */
export const CHARGE_ERROR_CODES = [
  'PAYMENT_METHOD_NOT_ACTIVE',
  'DUPLICATE_REQUEST',
  'IDEMPOTENCY_KEY_REUSED',
  'CHARGE_OUTCOME_UNKNOWN',
  'CHARGE_FAILED',
  'PAYMENT_METHOD_CHARGES_DISABLED',
  'PAYMENT_PROCESSING_UNAVAILABLE',
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
 * - PAYMENT_METHOD_NOT_ACTIVE (409): the method is revoked or expired; ask the customer
 *   for another card via a hosted session with saveCard.
 * - DUPLICATE_REQUEST (409): a request with this key is still in flight; retry with the
 *   SAME key in a moment.
 * - IDEMPOTENCY_KEY_REUSED (422): same key, different body or method; a bug on your side.
 * - PAYMENT_METHOD_CHARGES_DISABLED, PAYMENT_PROCESSING_UNAVAILABLE (503): nothing was
 *   charged; retry later with the SAME key.
 *
 * `result` is the whole envelope the gateway sent, for fields not modelled above.
 */
export class ChargeError extends DominaiteError {
  readonly httpStatus: number
  readonly errorCode: string
  /** The charge row the gateway attached to its answer, when it did. */
  readonly charge?: PaymentMethodCharge
  /** Shortcut for charge.transactionId, for polling getStatus(). */
  readonly transactionId?: string
  /** The full envelope, for fields not modelled above. */
  readonly result: Record<string, unknown>

  constructor(
    httpStatus: number,
    errorCode: string,
    message: string,
    charge?: PaymentMethodCharge,
    result: Record<string, unknown> = {},
  ) {
    super(message)
    this.httpStatus = httpStatus
    this.errorCode = errorCode
    this.charge = charge
    this.transactionId = charge?.transactionId
    this.result = result
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
 * HTTP 429: you sent more requests than your key or your IP is allowed.
 *
 * Platform limits are 60 requests per minute per API key and 120 per minute per IP.
 * Both are enforced on a rolling window, so a burst that fits inside one minute still
 * counts against the next.
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

  constructor(message: string, retryAfterSeconds: number | null = null) {
    super(message)
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/**
 * Network-level failure or a 5xx - the request may or may not have reached the API.
 * Safe to retry WITH THE SAME idempotency key; a retried key never creates a second payment.
 *
 * "Safe" means no double charge, not "you get the first session back". If the earlier
 * attempt did reach the API, the retry is refused as a replay ({@link CheckoutRefusedError})
 * and the first session's cashier fields are gone for good.
 */
export class TransportError extends DominaiteError {}
