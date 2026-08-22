import { randomUUID } from 'node:crypto'

import {
  ApiError,
  AuthenticationError,
  CheckoutRefusedError,
  RateLimitError,
  TransportError,
} from './errors.js'
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
/** Maximum length of the fields the API caps at 100, counted in Unicode code points. */
const MAX_FIELD_CODE_POINTS = 100
/** Hosts allowed to be reached over plain http, for local development only. */
const PLAINTEXT_ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

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
   * Throws AuthenticationError (wrong credentials, bad signature, clock off, IP not
   * allowlisted - fix config, do not retry), CheckoutRefusedError (the gateway refused;
   * inspect errorCode), RateLimitError (429 - wait out retryAfterSeconds, then retry with
   * the same key), ApiError (unexpected response), or TransportError (network or
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
   * Refusals and authentication failures are not retried; they will not change. Neither
   * is a 429: retrying into a limiter that just said stop makes it worse, so the
   * RateLimitError comes straight back with retryAfterSeconds for you to honour.
   *
   * This buys you protection from a double charge, not recovery of the first session. If
   * an earlier attempt did reach the gateway and take the key, the retry comes back as a
   * replay refusal (CheckoutRefusedError: DUPLICATE_REQUEST, ALREADY_PROCESSED,
   * PRIOR_ATTEMPT_FAILED, IDEMPOTENCY_KEY_REUSED) - the first session's cashier fields are
   * not returned. Reconcile with getStatus(), then mint a new session under a fresh key.
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

    if (typeof params.orderReference !== 'string' || params.orderReference === '') {
      throw new TypeError('orderReference must be a non-empty string')
    }
    if (countCodePoints(params.orderReference) > MAX_FIELD_CODE_POINTS) {
      throw new TypeError(
        `orderReference must be at most ${MAX_FIELD_CODE_POINTS} characters`,
      )
    }

    const { idempotencyKey: providedKey, ...bodyParams } = params
    const idempotencyKey = providedKey ?? randomUUID()
    if (
      typeof idempotencyKey !== 'string' ||
      idempotencyKey === '' ||
      countCodePoints(idempotencyKey) > MAX_FIELD_CODE_POINTS
    ) {
      throw new TypeError(
        `idempotencyKey must be a non-empty string of at most ${MAX_FIELD_CODE_POINTS} characters`,
      )
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
    if (response.status >= 500) {
      throw new TransportError(
        `The Dominaite API is unavailable (HTTP ${response.status}); retry with the same idempotency key.`,
      )
    }
    if (response.status >= 400) {
      // Carry the machine-readable code: a validation rejection like
      // IDEMPOTENCY_KEY_REQUIRED is only actionable if the caller can branch on it.
      const errorCode = stringOr(payload['errorCode'], stringOr(envelopeError['code'], ''))
      throw new ApiError(
        response.status,
        stringOr(payload['errorMessage'], stringOr(envelopeError['message'], 'Request rejected')),
        errorCode === '' ? undefined : errorCode,
      )
    }

    return payload
  }
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
 * Length in Unicode CODE POINTS, which is what the API's own limits count - not UTF-16
 * units and not bytes. A 100-character Cyrillic order reference is 100 here and 200
 * bytes, and must not be rejected for it.
 *
 * Known caveat: an astral character (emoji, rarer CJK) counts as 1 here while the server
 * counts it as 2, so a string packed with them can pass this check and still be rejected
 * upstream. The server is the final arbiter; this check only catches the obvious cases
 * before they cost a round trip.
 */
function countCodePoints(value: string): number {
  let count = 0
  for (const _ of value) {
    count++
  }
  return count
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
