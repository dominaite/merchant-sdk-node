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
 * The gateway understood the request but refused to open a checkout session.
 * Branch on `errorCode`:
 * - PAYMENT_PROCESSING_UNAVAILABLE: card payments are off right now; retry later.
 * - DUPLICATE_REQUEST: a session for this idempotency key is already open.
 * - ALREADY_PROCESSED: this idempotency key's payment already completed.
 * - IDEMPOTENCY_KEY_REUSED: same key sent with a DIFFERENT body; use a fresh key.
 */
export class CheckoutRefusedError extends DominaiteError {
  readonly errorCode: string

  constructor(errorCode: string, message: string) {
    super(message)
    this.errorCode = errorCode
  }
}

/** The API answered, but with an unexpected or rejecting response. */
export class ApiError extends DominaiteError {
  readonly httpStatus: number

  constructor(httpStatus: number, message: string) {
    super(message)
    this.httpStatus = httpStatus
  }
}

/**
 * Network-level failure or a 5xx - the request may or may not have reached the API.
 * Safe to retry WITH THE SAME idempotency key; a retried key never creates a second payment.
 */
export class TransportError extends DominaiteError {}
