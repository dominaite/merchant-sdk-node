import {
  ApiError,
  AuthenticationError,
  ChargeError,
  CheckoutRefusedError,
  DominaiteError,
  RateLimitError,
  REFUND_ERROR_CODES,
  RefundError,
  type RefundErrorCode,
  RevokeError,
  STOREFRONT_ERROR_CODES,
  StorefrontError,
  type StorefrontErrorCode,
  TransportError,
} from './errors.js'
import { countCodePoints, MAX_FIELD_CODE_POINTS, normalizeIdempotencyKey } from './idempotency.js'
import { signRequest } from './signing.js'
import type {
  ChargePaymentMethodParams,
  CheckoutSession,
  CheckoutStatus,
  CreateCheckoutSessionParams,
  CreateRefundParams,
  DominaiteClientOptions,
  PaymentMethodCharge,
  Ping,
  Refund,
  RetryOptions,
  StoredPaymentMethod,
} from './types.js'

const DEFAULT_BASE_URL = 'https://api.dominaite.com/payments'
const SESSIONS_PATH = '/merchant-api/checkout/sessions'
const PAYMENT_METHODS_PATH = '/merchant-api/payment-methods'
const PAYMENTS_PATH = '/merchant-api/payments'
const PING_PATH = '/merchant-api/ping'
const DEFAULT_TIMEOUT_MS = 45_000 // serverless cold starts hit 10+s on dev; 15s was a coin flip
const SDK_VERSION = '0.3.0'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/**
 * A payment method id is opaque (pm_...), so this only pins what keeps it a single path
 * segment: no slash, no query, no whitespace, nothing that needs percent-encoding. The
 * id goes into the signed canonical path verbatim, so anything else would sign one
 * path and request another.
 */
const PAYMENT_METHOD_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/
/** A refund id (re_...) is opaque too, and goes into the signed path the same way. */
const REFUND_ID_PATTERN = PAYMENT_METHOD_ID_PATTERN
/** Hard ceiling on a response body. Past this the read is abandoned, not buffered. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024
/** Hosts allowed to be reached over plain http, for local development only. */
const PLAINTEXT_ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
/**
 * Statuses that stay generic on the payment-method routes even when the envelope
 * carries a code: validation (400), authentication (401, 403), unknown id (404) and
 * rate limiting (429) mean the same thing on every route and keep their usual errors.
 * Everything else with a code is the gateway telling this route something specific
 * (a decline, an unknown outcome, a refusal) and arrives as ChargeError / RevokeError.
 */
const GENERIC_FAILURE_STATUSES = new Set([400, 401, 403, 404, 429])

/** A parsed reply, whatever its status. Auth and rate-limit failures never get this far. */
interface Reply {
  status: number
  /** The whole JSON body ({} for a 204). */
  envelope: Record<string, unknown>
  /** envelope.data when the gateway wrapped the answer, the envelope itself otherwise. */
  payload: Record<string, unknown>
  /** envelope.error when present, {} otherwise. */
  error: Record<string, unknown>
}

/**
 * Server-side client for the Dominaite merchant API.
 *
 * Keep your API secret on the server. Never ship it to a browser, never commit it,
 * never log it. Card details never touch your backend or this SDK - the payer enters
 * them inside the hosted checkout widget.
 *
 * Usage:
 *
 *   const client = new DominaiteClient({
 *     keyId: process.env.DOMINAITE_KEY_ID,
 *     secret: process.env.DOMINAITE_SECRET,
 *   })
 *   const session = await client.createCheckoutSession({
 *     amount: 2500,                  // minor units: 25.00 EUR
 *     currency: 'EUR',
 *     orderReference: 'order-1042',  // your own order id
 *     idempotencyKey: orderIdempotencyKey({
 *       scope: 'checkout', orderId: 'order-1042', amountMinor: 2500, currency: 'EUR',
 *     }),
 *     customer: { firstName: 'Ana', lastName: 'Kirova', email: 'ana@example.com' },
 *   })
 *   // Hand session.cashierKey + session.cashierToken to the embed snippet.
 */
export class DominaiteClient {
  static readonly SESSIONS_PATH = SESSIONS_PATH
  static readonly PAYMENT_METHODS_PATH = PAYMENT_METHODS_PATH
  static readonly PAYMENTS_PATH = PAYMENTS_PATH
  static readonly PING_PATH = PING_PATH

  readonly #keyId: string
  readonly #secret: string
  readonly #baseUrl: string
  readonly #timeoutMs: number
  readonly #fetch: typeof globalThis.fetch

  constructor(options: DominaiteClientOptions) {
    if (!options?.keyId?.startsWith('dmk_')) {
      throw new TypeError('keyId must start with dmk_')
    }
    if (!options?.secret?.startsWith('dms_')) {
      throw new TypeError('secret must start with dms_')
    }

    this.#keyId = options.keyId
    this.#secret = options.secret
    this.#baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL)
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

    const fetchImpl = options.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('No global fetch available. Use Node 20+ or pass options.fetch')
    }
    this.#fetch = fetchImpl
  }

  /**
   * Checks your credentials, your signing and your clock without creating anything.
   *
   * Make this your first live call: it separates the setup problems from the payment
   * ones. Throws AuthenticationError (key id, secret, signature, clock or IP
   * allowlist), ApiError (unexpected response), or TransportError (network or 5xx).
   *
   * Watch clockSkewSeconds - the gateway rejects requests once it passes 300.
   */
  async ping(): Promise<Ping> {
    // GET signs an EMPTY idempotency key and an EMPTY body.
    const response = await this.#request('GET', PING_PATH, null, '')
    return response as Ping
  }

  /**
   * Creates a hosted checkout session for one payment.
   *
   * idempotencyKey is required: derive it from the order with orderIdempotencyKey(), so a
   * reload or a retry replays the same session instead of opening a second payment. A
   * missing or empty key throws TypeError before anything is sent.
   *
   * Throws AuthenticationError (wrong credentials, bad signature, clock off, IP not
   * allowlisted - fix config, do not retry), CheckoutRefusedError (the gateway refused;
   * inspect errorCode), StorefrontError (the website this session belongs to is not
   * whitelisted, inactive or not the key's own - fix the storefront, do not retry),
   * RateLimitError (429 - wait out retryAfterSeconds, then retry with the same key),
   * ApiError (unexpected response), or TransportError (network or 5xx - safe to retry
   * WITH the same idempotencyKey).
   */
  async createCheckoutSession(params: CreateCheckoutSessionParams): Promise<CheckoutSession> {
    const { idempotencyKey, body } = this.#prepareSessionRequest(params)
    const response = await this.#request('POST', SESSIONS_PATH, body, idempotencyKey)

    if (response['success'] !== true || typeof response['checkout'] !== 'object' || response['checkout'] === null) {
      // A replay refusal names the transaction your key collided with. Carry it (and
      // the whole payload) so the caller can reconcile with getStatus() instead of
      // minting a second payment for the same order.
      throw new CheckoutRefusedError(
        typeof response['errorCode'] === 'string' ? response['errorCode'] : 'UNKNOWN',
        typeof response['errorMessage'] === 'string'
          ? response['errorMessage']
          : 'The checkout session was refused.',
        typeof response['transactionId'] === 'string' ? response['transactionId'] : undefined,
        response,
      )
    }

    return response['checkout'] as CheckoutSession
  }

  /**
   * createCheckoutSession with retries on TransportError and on PAYMENT_PROCESSING_UNAVAILABLE,
   * sending your idempotency key unchanged on every attempt - which is what makes the retry
   * safe: the API never opens a second payment for a key it has already seen.
   *
   * PAYMENT_PROCESSING_UNAVAILABLE is retried in both forms the gateway sends it: a 503,
   * and an HTTP 200 refusal (CheckoutRefusedError). Either way card payments are briefly
   * off and nothing was created. When the attempts run out the last error comes back as
   * it arrived.
   *
   * Other refusals and authentication failures are not retried; they will not change. Neither
   * is a 429: retrying into a limiter that just said stop makes it worse, so the
   * RateLimitError comes straight back with retryAfterSeconds for you to honour.
   *
   * If an earlier attempt did reach the gateway and its session is still open and unexpired,
   * the retry is a clean replay: the gateway answers with that ORIGINAL session (same
   * transactionId and cashier fields), so a response lost to a timeout is recovered. Any
   * other state comes back as a replay refusal (CheckoutRefusedError: DUPLICATE_REQUEST,
   * ALREADY_PROCESSED, PRIOR_ATTEMPT_FAILED, IDEMPOTENCY_KEY_REUSED); reconcile those with
   * getStatus(error.transactionId).
   */
  async createCheckoutSessionWithRetry(
    params: CreateCheckoutSessionParams,
    options: RetryOptions = {},
  ): Promise<CheckoutSession> {
    const attempts = options.attempts ?? 3
    const baseDelayMs = options.baseDelayMs ?? 500
    if (!Number.isInteger(attempts) || attempts < 1) {
      throw new TypeError('attempts must be a positive integer')
    }

    let lastError: TransportError | CheckoutRefusedError | undefined
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.createCheckoutSession(params)
      } catch (error) {
        const retryable =
          error instanceof TransportError ||
          (error instanceof CheckoutRefusedError && error.errorCode === 'PAYMENT_PROCESSING_UNAVAILABLE')
        if (!retryable) {
          throw error
        }
        lastError = error
        if (attempt < attempts - 1) {
          await delay(baseDelayMs * 2 ** attempt)
        }
      }
    }

    throw lastError as TransportError | CheckoutRefusedError
  }

  /**
   * Reads the payment status of one of your checkout sessions.
   *
   * Status values: pending, processing, succeeded, failed, refunded, partially_refunded,
   * cancelled, disputed, requires_capture, abandoned. While a session is still payable the
   * response carries expiresAt; amounts are integers in MINOR units. An unknown transaction
   * id throws an ApiError with httpStatus 404.
   *
   * succeeded is the only value that means the payment is complete. Keep polling on
   * pending, processing and requires_capture - none of them is terminal.
   *
   * requires_capture is NOT "unpaid": the payer has already paid and the funds are held
   * awaiting capture. Never treat it as an abandoned order.
   *
   * Treat any status you do not recognise as still-open too: a value the API adds later
   * should make you keep polling, never silently close an order that is still live.
   *
   * Poll after the payer returns to you, or on your order timeout - not in a tight loop;
   * the endpoint is rate limited per key (60/min/key, 120/min/IP) and going over throws
   * RateLimitError.
   */
  async getStatus(transactionId: string): Promise<CheckoutStatus> {
    const normalized = String(transactionId ?? '').trim().toLowerCase()
    if (!UUID_PATTERN.test(normalized)) {
      throw new TypeError('transactionId must be the UUID returned by createCheckoutSession()')
    }

    // GET signs an EMPTY idempotency key and an EMPTY body.
    const response = await this.#request('GET', `${SESSIONS_PATH}/${normalized}`, null, '')
    // Passed through as sent, except the card on file: the gateway omits its null fields
    // on the wire, and the caller gets one shape for it, not two. When the gateway sent no
    // storedPaymentMethod at all there is no key here either (there is no card).
    const stored = response['storedPaymentMethod']
    if (isPlainObject(stored)) {
      return { ...response, storedPaymentMethod: toStoredPaymentMethod(stored) } as CheckoutStatus
    }
    return response as CheckoutStatus
  }

  /**
   * Charges a card kept on file, off-session: no widget, no payer present.
   *
   * paymentMethodId is the id from getStatus().storedPaymentMethod of a session you
   * created with saveCard. The charge is signed like a session and carries the
   * Idempotency-Key you pass (required; derive it from the billing period or the order),
   * so retrying after a timeout WITH THE SAME KEY never charges the card twice; the
   * gateway replays its first answer.
   *
   * A decline is not an exception: the gateway answers HTTP 402 and this resolves with a
   * charge whose status is 'failed' plus a declineClass telling you whether to give up on
   * the card (hard), wait (soft_funds, soft_other) or bring the customer back for a
   * hosted session (soft_sca_required). 'pending' is not terminal - poll
   * getStatus(charge.transactionId).
   *
   * Throws ChargeError when the gateway answered with a code instead of a charge:
   * CHARGE_OUTCOME_UNKNOWN (502, the charge MAY have happened - poll
   * error.charge.transactionId, never retry under a new key), CHARGE_FAILED (502, nothing
   * charged), PAYMENT_METHOD_NOT_ACTIVE or DUPLICATE_REQUEST (409), IDEMPOTENCY_KEY_REUSED
   * (422), PAYMENT_METHOD_CHARGES_DISABLED or PAYMENT_PROCESSING_UNAVAILABLE (503, retry
   * later with the same key). A storefront refusal is a StorefrontError, as on sessions.
   * Otherwise AuthenticationError, RateLimitError, ApiError
   * (404 for an id that is not yours, 400 validation) or TransportError (network - safe
   * to retry with the same key).
   */
  async chargePaymentMethod(
    paymentMethodId: string,
    params: ChargePaymentMethodParams,
  ): Promise<PaymentMethodCharge> {
    const id = normalizePaymentMethodId(paymentMethodId)
    const { idempotencyKey, body } = this.#prepareChargeRequest(params)
    const reply = await this.#send('POST', `${PAYMENT_METHODS_PATH}/${id}/charges`, body, idempotencyKey)

    const data = isPlainObject(reply.envelope['data']) ? reply.envelope['data'] : undefined
    const charge = data !== undefined && typeof data['chargeId'] === 'string' ? toCharge(data) : undefined
    const errorCode = stringOr(reply.error['code'], '')

    // 201 (200 on a durable replay): the charge was placed, whatever its status. 402: the
    // provider declined; the envelope says success=false but the charge is right there,
    // status 'failed' with its decline class, so it is a result, not an exception.
    if (charge !== undefined && (reply.envelope['success'] === true || reply.status === 402)) {
      return charge
    }

    if (
      errorCode !== '' &&
      reply.status >= 400 &&
      !GENERIC_FAILURE_STATUSES.has(reply.status) &&
      !isStorefrontErrorCode(errorCode)
    ) {
      throw new ChargeError(
        reply.status,
        errorCode,
        stringOr(reply.error['message'], 'The charge was refused.'),
        charge,
        reply.envelope,
      )
    }
    if (reply.status >= 400) {
      throw rejection(reply)
    }
    throw new ApiError(reply.status, 'The API answered the charge without a charge body')
  }

  /**
   * Revokes a card kept on file. The saved credential is deleted at the payment provider
   * and the method's status becomes 'revoked'; a later chargePaymentMethod() on it is
   * refused with PAYMENT_METHOD_NOT_ACTIVE. Resolves with nothing on success (HTTP 204),
   * and again on an already revoked method, so retrying a timed-out revoke is safe.
   *
   * Throws RevokeError when the gateway refused and nothing changed:
   * MERCHANT_API_UNAVAILABLE (503, retry later) or UPSTREAM_CONTRACT_ERROR (502, the
   * provider refused for good - contact support with the id). An id that is not yours
   * throws an ApiError with httpStatus 404. Not a payment operation: no idempotency key
   * is signed.
   */
  async revokePaymentMethod(paymentMethodId: string): Promise<void> {
    const id = normalizePaymentMethodId(paymentMethodId)
    // DELETE signs an EMPTY idempotency key and an EMPTY body, like GET.
    const reply = await this.#send('DELETE', `${PAYMENT_METHODS_PATH}/${id}`, null, '')
    if (reply.status < 400) {
      return
    }

    const errorCode = stringOr(reply.error['code'], '')
    if (errorCode !== '' && !GENERIC_FAILURE_STATUSES.has(reply.status)) {
      throw new RevokeError(
        reply.status,
        errorCode,
        stringOr(reply.error['message'], 'The revoke was refused.'),
        reply.envelope,
      )
    }
    throw rejection(reply)
  }

  /**
   * Refunds a payment, in full or in part. Answers once the refund is queued (HTTP 202),
   * not once the money has moved: read the outcome with getRefund(), or wait for the
   * payment.refunded webhook. A refund that fails sends no webhook, so poll getRefund() if
   * you need to know about failures.
   *
   * transactionId is the id the checkout session or the charge returned. Omit
   * params.amount to refund everything still refundable; otherwise it is MINOR units of
   * the payment's currency (use toMinorUnits()). The refund is signed and carries the
   * Idempotency-Key you pass (required; derive it from your return or credit note), so
   * retrying WITH THE SAME KEY never refunds twice: the gateway answers with the same
   * refund as it stands now.
   *
   * Throws RefundError when the gateway answered with a code: PAYMENT_NOT_FOUND (404),
   * PAYMENT_NOT_REFUNDABLE or REFUND_AMOUNT_EXCEEDED (422, nothing queued, the key is not
   * burnt), IDEMPOTENCY_KEY_REUSED (422), DUPLICATE_REQUEST (409, retryable with the same
   * key), IDEMPOTENCY_KEY_REQUIRED (400). Otherwise AuthenticationError, RateLimitError,
   * ApiError, or TransportError (network or 5xx, nothing queued on a 500 - retry with the
   * same key).
   */
  async createRefund(transactionId: string, params: CreateRefundParams): Promise<Refund> {
    const id = normalizeTransactionId(transactionId)
    const { idempotencyKey, body } = this.#prepareRefundRequest(params)
    const reply = await this.#send('POST', `${PAYMENTS_PATH}/${id}/refunds`, body, idempotencyKey)
    return readRefund(reply)
  }

  /**
   * Reads one refund of one of your payments: pending, processing, succeeded or failed.
   * A failed refund resolves too, with failureCode saying why and amount null; it is not
   * an exception.
   *
   * Throws RefundError: REFUND_NOT_FOUND (404, retryable) right after createRefund() means
   * the refund is not picked up yet, so poll again for up to 60 seconds; PAYMENT_NOT_FOUND
   * (404) for a payment that is not yours. Otherwise AuthenticationError, RateLimitError,
   * ApiError or TransportError.
   */
  async getRefund(transactionId: string, refundId: string): Promise<Refund> {
    const id = normalizeTransactionId(transactionId)
    const refund = normalizeRefundId(refundId)
    // GET signs an EMPTY idempotency key and an EMPTY body.
    const reply = await this.#send('GET', `${PAYMENTS_PATH}/${id}/refunds/${refund}`, null, '')
    return readRefund(reply)
  }

  #prepareSessionRequest(params: CreateCheckoutSessionParams): { idempotencyKey: string; body: string } {
    validateMoneyParams(params)
    const { idempotencyKey: providedKey, ...bodyParams } = params
    return { idempotencyKey: normalizeIdempotencyKey(providedKey), body: encodeBody(bodyParams) }
  }

  #prepareChargeRequest(params: ChargePaymentMethodParams): { idempotencyKey: string; body: string } {
    validateMoneyParams(params)
    if (params.description !== undefined && typeof params.description !== 'string') {
      throw new TypeError('description must be a string')
    }

    // Built field by field, not spread: the body is what gets signed, and the contract
    // for this route is exactly these fields in this order.
    const bodyParams: Record<string, unknown> = {
      amount: params.amount,
      currency: params.currency,
      orderReference: params.orderReference,
    }
    if (params.description !== undefined) {
      bodyParams['description'] = params.description
    }

    return { idempotencyKey: normalizeIdempotencyKey(params.idempotencyKey), body: encodeBody(bodyParams) }
  }

  #prepareRefundRequest(params: CreateRefundParams): { idempotencyKey: string; body: string } {
    if (typeof params !== 'object' || params === null) {
      throw new TypeError('params must be an object carrying idempotencyKey')
    }

    // Built field by field, not spread: the body is what gets signed, and a full refund
    // is an absent amount, never a null one.
    const bodyParams: Record<string, unknown> = {}
    if (params.amount !== undefined) {
      if (!Number.isSafeInteger(params.amount) || params.amount <= 0) {
        throw new TypeError(
          'amount must be a positive integer in MINOR units (e.g. 2500 for 25.00 EUR); ' +
            'omit it to refund everything still refundable',
        )
      }
      bodyParams['amount'] = params.amount
    }
    if (params.reason !== undefined) {
      if (typeof params.reason !== 'string') {
        throw new TypeError('reason must be a string')
      }
      bodyParams['reason'] = params.reason
    }

    return { idempotencyKey: normalizeIdempotencyKey(params.idempotencyKey), body: encodeBody(bodyParams) }
  }

  /** Sends and applies the generic failure rules: 5xx is transport, 4xx is ApiError. */
  async #request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: string | null,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    const reply = await this.#send(method, path, body, idempotencyKey)
    if (reply.status >= 400) {
      throw rejection(reply)
    }
    return reply.payload
  }

  /**
   * Signs, sends and parses one request. Transport failures, redirects, non-JSON bodies,
   * authentication failures (401, 403) and rate limiting (429) throw here because they
   * mean the same thing on every route. Any other status comes back parsed, so a route
   * can read the code and the data the gateway attached before deciding what it is.
   */
  async #send(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: string | null,
    idempotencyKey: string,
  ): Promise<Reply> {
    const json = body ?? ''
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const signature = signRequest({
      secret: this.#secret,
      timestamp,
      method,
      path,
      idempotencyKey,
      body: json,
    })

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Some edges block requests without a real User-Agent - always send one.
      'User-Agent': `dominaite-node/${SDK_VERSION} (node ${process.version})`,
      'X-Api-Key-Id': this.#keyId,
      'X-Timestamp': timestamp,
      'X-Signature': signature,
    }
    if (idempotencyKey !== '') {
      headers['Idempotency-Key'] = idempotencyKey
    }

    let response: Response
    try {
      response = await this.#fetch(this.#baseUrl + path, {
        method,
        headers,
        // Never follow a redirect: the hop would carry the signed headers to whatever
        // host the Location names, 301/302/303 would silently turn the POST into a GET,
        // and the answer coming back would be that host's, not the gateway's.
        redirect: 'manual',
        ...(body === null ? {} : { body }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch (error) {
      throw new TransportError(`Could not reach the Dominaite API: ${describe(error)}`)
    }

    // Node hands back the real 3xx here; a spec-compliant runtime hands back an opaque
    // redirect instead - status 0, no body. Both mean the same thing.
    if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
      // Not retryable, and not a response we will parse. The Dominaite API never emits
      // 3xx, so a redirect means something between you and it is answering instead.
      const status = response.type === 'opaqueredirect' ? 'opaque redirect' : `HTTP ${response.status}`
      throw new ApiError(
        response.status,
        `Unexpected redirect response (${status}); the Dominaite API never redirects. ` +
          'Check your baseUrl and any proxy in front of it.',
      )
    }

    // 204 carries nothing to parse; the status is the whole answer.
    if (response.status === 204) {
      return { status: 204, envelope: {}, payload: {}, error: {} }
    }

    let raw: string
    try {
      raw = await readBoundedText(response)
    } catch (error) {
      if (error instanceof TransportError) {
        throw error
      }
      throw new TransportError(`Could not read the Dominaite API response: ${describe(error)}`)
    }

    let decoded: unknown
    try {
      decoded = JSON.parse(raw)
    } catch {
      throw new ApiError(response.status, 'The API returned a non-JSON response')
    }
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      throw new ApiError(response.status, 'The API returned a non-JSON response')
    }

    // The gateway wraps responses as { success, data, ... }; unwrap when present.
    // Error responses carry the machine-readable code at error.code.
    const envelope = decoded as Record<string, unknown>
    const payload = isPlainObject(envelope['data']) ? envelope['data'] : envelope
    const envelopeError = isPlainObject(envelope['error']) ? envelope['error'] : {}

    if (response.status === 401 || response.status === 403) {
      throw new AuthenticationError(
        stringOr(payload['errorCode'], stringOr(envelopeError['code'], 'UNAUTHORIZED')),
        'Authentication failed - check your key id, secret, and server clock.',
      )
    }
    if (response.status === 429) {
      // Deliberately not a TransportError: the retry helper would hammer a limiter that
      // is already telling us to stop. The caller waits out retryAfterSeconds instead.
      const retryAfterSeconds = parseRetryAfterSeconds(response.headers?.get('Retry-After'))
      const wait =
        retryAfterSeconds === null
          ? 'Retry with the same idempotency key after backing off.'
          : `Wait ${retryAfterSeconds}s (retryAfterSeconds), then retry with the same idempotency key.`
      throw new RateLimitError(
        `Rate limit exceeded (HTTP 429). ${wait}`,
        retryAfterSeconds,
      )
    }

    return { status: response.status, envelope, payload, error: envelopeError }
  }
}

/** The generic reading of a failed reply: 5xx is the API being unavailable, 4xx a rejection. */
function rejection(reply: Reply): DominaiteError {
  if (reply.status >= 500) {
    return new TransportError(
      `The Dominaite API is unavailable (HTTP ${reply.status}); retry with the same idempotency key.`,
    )
  }
  // Carry the machine-readable code: a validation rejection like
  // IDEMPOTENCY_KEY_REQUIRED is only actionable if the caller can branch on it.
  const errorCode = stringOr(reply.payload['errorCode'], stringOr(reply.error['code'], ''))
  const message = stringOr(reply.payload['errorMessage'], stringOr(reply.error['message'], 'Request rejected'))
  if (isStorefrontErrorCode(errorCode)) {
    return new StorefrontError(reply.status, errorCode, message)
  }
  return new ApiError(reply.status, message, errorCode === '' ? undefined : errorCode)
}

/**
 * A refund reply: the refund on a 2xx, a RefundError for the refund codes on a 4xx, and the
 * generic reading otherwise (5xx is transport, so a 500 is retried with the same key).
 */
function readRefund(reply: Reply): Refund {
  const data = reply.envelope['data']
  if (reply.status < 300 && isPlainObject(data) && typeof data['refundId'] === 'string') {
    return toRefund(data)
  }

  const errorCode = stringOr(reply.error['code'], '')
  if (reply.status >= 400 && reply.status < 500 && isRefundErrorCode(errorCode)) {
    throw new RefundError(
      reply.status,
      errorCode,
      stringOr(reply.error['message'], 'The refund was refused.'),
      reply.envelope,
    )
  }
  if (reply.status >= 400) {
    throw rejection(reply)
  }
  throw new ApiError(reply.status, 'The API answered the refund without a refund body')
}

function isRefundErrorCode(code: string): code is RefundErrorCode {
  return (REFUND_ERROR_CODES as readonly string[]).includes(code)
}

/**
 * The refund as one shape: the gateway omits amount, failureCode, failureMessage and
 * completedAt when they are null, so read absent as null.
 */
function toRefund(data: Record<string, unknown>): Refund {
  return {
    ...data,
    refundId: String(data['refundId']),
    transactionId: stringOr(data['transactionId'], ''),
    status: stringOr(data['status'], ''),
    amount: typeof data['amount'] === 'number' ? data['amount'] : null,
    currency: stringOr(data['currency'], ''),
    failureCode: typeof data['failureCode'] === 'string' ? data['failureCode'] : null,
    failureMessage: typeof data['failureMessage'] === 'string' ? data['failureMessage'] : null,
    completedAt: typeof data['completedAt'] === 'string' ? data['completedAt'] : null,
  }
}

/** Storefront refusals keep their own error on sessions and charges alike. */
function isStorefrontErrorCode(code: string): code is StorefrontErrorCode {
  return (STOREFRONT_ERROR_CODES as readonly string[]).includes(code)
}

/**
 * The charge body as one shape: the gateway omits declineClass and declineCode when they
 * are null (every 201, and a 502 CHARGE_FAILED row), so read absent as null. Anything
 * else the gateway sends is carried through.
 */
function toCharge(data: Record<string, unknown>): PaymentMethodCharge {
  return {
    ...data,
    chargeId: String(data['chargeId']),
    status: stringOr(data['status'], ''),
    declineClass: typeof data['declineClass'] === 'string' ? data['declineClass'] : null,
    declineCode: typeof data['declineCode'] === 'string' ? data['declineCode'] : null,
    transactionId: stringOr(data['transactionId'], ''),
  }
}

/**
 * Same rule for the card on file: brand, last4 and the expiry are absent when unreported,
 * and retiredReason is absent unless the platform retired the card.
 */
function toStoredPaymentMethod(data: Record<string, unknown>): StoredPaymentMethod {
  return {
    ...data,
    id: stringOr(data['id'], ''),
    brand: typeof data['brand'] === 'string' ? data['brand'] : null,
    last4: typeof data['last4'] === 'string' ? data['last4'] : null,
    expiryMonth: typeof data['expiryMonth'] === 'number' ? data['expiryMonth'] : null,
    expiryYear: typeof data['expiryYear'] === 'number' ? data['expiryYear'] : null,
    status: stringOr(data['status'], ''),
    retiredReason: typeof data['retiredReason'] === 'string' ? data['retiredReason'] : null,
  }
}

/** The checks shared by every request that moves money: amount, currency, orderReference. */
function validateMoneyParams(params: { amount: number; currency: string; orderReference: string }): void {
  for (const required of ['amount', 'currency', 'orderReference'] as const) {
    if (params?.[required] === undefined || params[required] === null) {
      throw new TypeError(`Missing required parameter: ${required}`)
    }
  }
  if (!Number.isSafeInteger(params.amount) || params.amount <= 0) {
    throw new TypeError(
      'amount must be a positive integer in MINOR units (e.g. 2500 for 25.00 EUR)',
    )
  }

  if (typeof params.orderReference !== 'string' || params.orderReference === '') {
    throw new TypeError('orderReference must be a non-empty string')
  }
  if (countCodePoints(params.orderReference) > MAX_FIELD_CODE_POINTS) {
    throw new TypeError(
      `orderReference must be at most ${MAX_FIELD_CODE_POINTS} characters`,
    )
  }
}

function normalizePaymentMethodId(paymentMethodId: unknown): string {
  const normalized = String(paymentMethodId ?? '').trim()
  if (!PAYMENT_METHOD_ID_PATTERN.test(normalized)) {
    throw new TypeError('paymentMethodId must be the id from getStatus().storedPaymentMethod')
  }
  return normalized
}

/** The payment id goes into the signed path in the lowercase hyphenated form the gateway signs. */
function normalizeTransactionId(transactionId: unknown): string {
  const normalized = String(transactionId ?? '').trim().toLowerCase()
  if (!UUID_PATTERN.test(normalized)) {
    throw new TypeError('transactionId must be the payment UUID returned by createCheckoutSession() or a charge')
  }
  return normalized
}

function normalizeRefundId(refundId: unknown): string {
  const normalized = String(refundId ?? '').trim()
  if (!REFUND_ID_PATTERN.test(normalized)) {
    throw new TypeError('refundId must be the refundId returned by createRefund()')
  }
  return normalized
}

function encodeBody(bodyParams: Record<string, unknown>): string {
  let body: string
  try {
    body = JSON.stringify(bodyParams)
  } catch {
    throw new TypeError('Request parameters are not JSON-encodable')
  }
  if (typeof body !== 'string') {
    throw new TypeError('Request parameters are not JSON-encodable')
  }
  return body
}

/**
 * Strips trailing slashes and refuses anything that would put a signed request on the
 * wire in the clear. http:// is allowed only for the loopback names a developer runs a
 * local gateway on; everywhere else the API key id, timestamp and signature would be
 * readable by anything on the path, and the reply would be forgeable.
 */
function normalizeBaseUrl(baseUrl: string): string {
  if (typeof baseUrl !== 'string' || baseUrl === '') {
    throw new TypeError('baseUrl must be a URL string')
  }

  const trimmed = baseUrl.replace(/\/+$/, '')

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new TypeError(`baseUrl must be an absolute URL, got: ${baseUrl}`)
  }

  if (parsed.protocol === 'https:') {
    return trimmed
  }
  if (parsed.protocol === 'http:' && PLAINTEXT_ALLOWED_HOSTS.has(parsed.hostname)) {
    return trimmed
  }

  throw new TypeError(
    `baseUrl must use https:// (got ${parsed.protocol}//${parsed.host}). ` +
      'Plain http is accepted only for localhost, 127.0.0.1 and ::1.',
  )
}

/**
 * Reads the body with a hard byte ceiling so a wrong or hostile host on the other end
 * cannot make the SDK buffer until the process dies. Counts the bytes as they arrive
 * rather than trusting Content-Length, which the sender controls.
 */
async function readBoundedText(response: Response): Promise<string> {
  const body = response.body as ReadableStream<Uint8Array> | null | undefined
  if (!body || typeof body.getReader !== 'function') {
    // A fetch implementation with no readable stream. Nothing to meter incrementally, so
    // the best available check is the buffer it hands back.
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw oversizedBody()
    }
    return text
  }

  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let total = 0
  let text = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        throw oversizedBody()
      }
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    // Releases the socket whether we finished or bailed out at the ceiling.
    reader.cancel().catch(() => {})
  }

  return text + decoder.decode()
}

function oversizedBody(): TransportError {
  return new TransportError(
    `The Dominaite API response exceeded the ${MAX_RESPONSE_BYTES} byte limit and was not read. ` +
      'Check your baseUrl and any proxy in front of it, then retry with the same idempotency key.',
  )
}

/**
 * Retry-After as whole seconds, or null. The header may also carry an HTTP date; this SDK
 * does not translate one, and says so on RateLimitError rather than guessing a number.
 */
function parseRetryAfterSeconds(value: string | null | undefined): number | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (!/^[0-9]+$/.test(trimmed)) {
    return null
  }
  const seconds = Number(trimmed)
  return Number.isSafeInteger(seconds) ? seconds : null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError' ? 'request timed out' : error.message
  }
  return String(error)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
