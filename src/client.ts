import { randomUUID } from 'node:crypto'

import { ApiError, AuthenticationError, CheckoutRefusedError, TransportError } from './errors.js'
import { signRequest } from './signing.js'
import type {
  CheckoutSession,
  CheckoutStatus,
  CreateCheckoutSessionParams,
  DominaiteClientOptions,
  Ping,
  RetryOptions,
} from './types.js'

const DEFAULT_BASE_URL = 'https://api.dominaite.com/payments'
const SESSIONS_PATH = '/merchant-api/checkout/sessions'
const PING_PATH = '/merchant-api/ping'
const DEFAULT_TIMEOUT_MS = 45_000 // serverless cold starts hit 10+s on dev; 15s was a coin flip
const SDK_VERSION = '0.1.2'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

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
 *     customer: { firstName: 'Ana', lastName: 'Kirova', email: 'ana@example.com' },
 *   })
 *   // Hand session.cashierKey + session.cashierToken to the embed snippet.
 */
export class DominaiteClient {
  static readonly SESSIONS_PATH = SESSIONS_PATH
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
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
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
   * Throws AuthenticationError (wrong credentials, bad signature, clock off, IP not
   * allowlisted - fix config, do not retry), CheckoutRefusedError (the gateway refused;
   * inspect errorCode), ApiError (unexpected response), or TransportError (network or
   * 5xx - safe to retry WITH the same idempotencyKey).
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
   * createCheckoutSession with retries on TransportError only, reusing THE SAME
   * idempotency key across attempts - which is what makes the retry safe: the API
   * never opens a second payment for a key it has already seen.
   *
   * Refusals and authentication failures are not retried; they will not change.
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

    // Pin the key ONCE, before the first attempt. Generating a fresh key per attempt
    // would make every retry a new payment.
    const pinned: CreateCheckoutSessionParams = {
      ...params,
      idempotencyKey: params.idempotencyKey ?? randomUUID(),
    }

    let lastError: TransportError | undefined
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.createCheckoutSession(pinned)
      } catch (error) {
        if (!(error instanceof TransportError)) {
          throw error
        }
        lastError = error
        if (attempt < attempts - 1) {
          await delay(baseDelayMs * 2 ** attempt)
        }
      }
    }

    throw lastError as TransportError
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
   * the endpoint is rate limited per key.
   */
  async getStatus(transactionId: string): Promise<CheckoutStatus> {
    const normalized = String(transactionId ?? '').trim().toLowerCase()
    if (!UUID_PATTERN.test(normalized)) {
      throw new TypeError('transactionId must be the UUID returned by createCheckoutSession()')
    }

    // GET signs an EMPTY idempotency key and an EMPTY body.
    const response = await this.#request('GET', `${SESSIONS_PATH}/${normalized}`, null, '')
    return response as CheckoutStatus
  }

  #prepareSessionRequest(params: CreateCheckoutSessionParams): { idempotencyKey: string; body: string } {
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

    const { idempotencyKey: providedKey, ...bodyParams } = params
    const idempotencyKey = providedKey ?? randomUUID()
    if (typeof idempotencyKey !== 'string' || idempotencyKey === '' || idempotencyKey.length > 100) {
      throw new TypeError('idempotencyKey must be a non-empty string of at most 100 characters')
    }

    let body: string
    try {
      body = JSON.stringify(bodyParams)
    } catch {
      throw new TypeError('Request parameters are not JSON-encodable')
    }
    if (typeof body !== 'string') {
      throw new TypeError('Request parameters are not JSON-encodable')
    }

    return { idempotencyKey, body }
  }

  async #request(
    method: 'GET' | 'POST',
    path: string,
    body: string | null,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
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
        ...(body === null ? {} : { body }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch (error) {
      throw new TransportError(`Could not reach the Dominaite API: ${describe(error)}`)
    }

    let raw: string
    try {
      raw = await response.text()
    } catch (error) {
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
    if (response.status >= 500) {
      throw new TransportError(
        `The Dominaite API is unavailable (HTTP ${response.status}); retry with the same idempotency key.`,
      )
    }
    if (response.status >= 400) {
      throw new ApiError(
        response.status,
        stringOr(payload['errorMessage'], stringOr(envelopeError['message'], 'Request rejected')),
      )
    }

    return payload
  }
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
