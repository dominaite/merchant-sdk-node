import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  AUTHORIZATION_ERROR_CODES,
  ApiError,
  AuthenticationError,
  DominaiteClient,
  ErrorCodes,
  RateLimitError,
  TransportError,
} from '../dist/esm/index.js'
import { PAYMENT_METHOD_ID, VECTOR } from './vector.mjs'

// 401 is a credential problem, 403 a key that may not call the route, 429 a limit. Each
// carries its own code and message; the clock hint belongs to 401 alone.

const KEY_ID = 'dmk_0123456789abcdef0123456789abcdef'
const BASE_URL = 'https://dev.example.test/payments'

const SESSION_PARAMS = {
  amount: 2500,
  currency: 'EUR',
  orderReference: 'order-1042',
  idempotencyKey: VECTOR.idempotencyKey,
}

function respondWith(status, body, headers = {}) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    })
}

/** Retries run at once in tests; the retry tests check the waits themselves. */
const noWait = async () => {}

function makeClient(fetchImpl) {
  return new DominaiteClient({ keyId: KEY_ID, secret: VECTOR.secret, baseUrl: BASE_URL, fetch: fetchImpl, sleep: noWait })
}

function failure(code, message, statusCode, params) {
  return { success: false, error: { code, message, statusCode, ...(params ? { params } : {}) } }
}

test('a 401 keeps the credential hint and says httpStatus 401', async () => {
  const fetchImpl = respondWith(401, failure('TIMESTAMP_OUT_OF_RANGE', 'Request timestamp is outside the allowed window', 401))

  await assert.rejects(
    () => makeClient(fetchImpl).ping(),
    (error) => {
      assert.ok(error instanceof AuthenticationError)
      assert.equal(error.httpStatus, 401)
      assert.equal(error.errorCode, 'TIMESTAMP_OUT_OF_RANGE')
      assert.match(error.message, /server clock/)
      return true
    },
  )
})

test('a 403 INSUFFICIENT_SCOPE names the missing scope and drops the clock hint', async () => {
  const fetchImpl = respondWith(
    403,
    failure('INSUFFICIENT_SCOPE', "This API key does not have the 'payments' scope this route requires", 403),
  )

  await assert.rejects(
    () => makeClient(fetchImpl).createCheckoutSession(SESSION_PARAMS),
    (error) => {
      assert.ok(error instanceof AuthenticationError)
      assert.equal(error.httpStatus, 403)
      assert.equal(error.errorCode, ErrorCodes.INSUFFICIENT_SCOPE)
      assert.ok(AUTHORIZATION_ERROR_CODES.includes(error.errorCode))
      assert.match(error.message, /'payments' scope/)
      assert.match(error.message, /use a key that holds this scope/)
      assert.doesNotMatch(error.message, /clock|secret/)
      return true
    },
  )
})

test('a 403 INSUFFICIENT_SCOPE without an API message still explains itself', async () => {
  const fetchImpl = respondWith(403, { success: false, error: { code: 'INSUFFICIENT_SCOPE', statusCode: 403 } })

  await assert.rejects(
    () => makeClient(fetchImpl).getStatus('11111111-1111-4111-8111-111111111111'),
    (error) => {
      assert.ok(error instanceof AuthenticationError)
      assert.match(error.message, /does not have the scope this route requires/)
      assert.doesNotMatch(error.message, /clock/)
      return true
    },
  )
})

test('a 403 VERIFY_ONLY_NOT_ENABLED says we switch it on for your account', async () => {
  const fetchImpl = respondWith(
    403,
    failure('VERIFY_ONLY_NOT_ENABLED', 'Verify-only sessions are not enabled for this account.', 403),
  )

  await assert.rejects(
    () =>
      makeClient(fetchImpl).createCheckoutSession({
        verifyOnly: true,
        currency: 'EUR',
        orderReference: 'card-check-7',
        idempotencyKey: VECTOR.idempotencyKey,
      }),
    (error) => {
      assert.ok(error instanceof AuthenticationError)
      assert.equal(error.httpStatus, 403)
      assert.equal(error.errorCode, ErrorCodes.VERIFY_ONLY_NOT_ENABLED)
      assert.match(error.message, /We switch it on for your account/)
      assert.doesNotMatch(error.message, /clock|secret/)
      return true
    },
  )
})

test('a 403 with a code the SDK does not know is still an AuthenticationError without the clock hint', async () => {
  const fetchImpl = respondWith(403, failure('SOME_FUTURE_REFUSAL', 'Not today', 403))

  await assert.rejects(
    () => makeClient(fetchImpl).createCheckoutSession(SESSION_PARAMS),
    (error) => {
      assert.ok(error instanceof AuthenticationError)
      assert.equal(error.httpStatus, 403)
      assert.equal(error.errorCode, 'SOME_FUTURE_REFUSAL')
      assert.doesNotMatch(error.message, /clock/)
      return true
    },
  )
})

test('a 429 RATE_LIMIT_EXCEEDED carries its code, Retry-After and the envelope', async () => {
  const body = failure('RATE_LIMIT_EXCEEDED', 'Rate limit exceeded. Try again later.', 429)
  const fetchImpl = respondWith(429, body, { 'Retry-After': '42' })

  await assert.rejects(
    () => makeClient(fetchImpl).createCheckoutSession(SESSION_PARAMS),
    (error) => {
      assert.ok(error instanceof RateLimitError)
      assert.ok(!(error instanceof TransportError), '429 must not look retryable')
      assert.ok(!(error instanceof ApiError))
      assert.equal(error.errorCode, ErrorCodes.RATE_LIMIT_EXCEEDED)
      assert.equal(error.retryAfterSeconds, 42)
      assert.deepEqual(error.result, body)
      assert.match(error.message, /RATE_LIMIT_EXCEEDED/)
      return true
    },
  )
})

test('the charge route 429s are RateLimitErrors that keep the window and limit', async () => {
  const velocity = failure('CHARGE_VELOCITY_EXCEEDED', 'Charge volume limit reached', 429, { window: 86400, limit: 10 })
  const declines = failure('CHARGE_DECLINE_RATE_EXCEEDED', 'Charge route locked', 429)
  const cases = [
    [velocity, '86400', ErrorCodes.CHARGE_VELOCITY_EXCEEDED, 86400],
    [declines, '3600', ErrorCodes.CHARGE_DECLINE_RATE_EXCEEDED, 3600],
  ]

  for (const [body, retryAfter, code, seconds] of cases) {
    const fetchImpl = respondWith(429, body, { 'Retry-After': retryAfter })
    await assert.rejects(
      () =>
        makeClient(fetchImpl).chargePaymentMethod(PAYMENT_METHOD_ID, {
          amount: 2500,
          currency: 'EUR',
          orderReference: 'sub-42-2026-10',
          idempotencyKey: 'sub-42-2026-10',
        }),
      (error) => {
        assert.ok(error instanceof RateLimitError)
        assert.equal(error.errorCode, code)
        assert.equal(error.retryAfterSeconds, seconds)
        // The velocity window and limit stay readable on the envelope.
        assert.deepEqual(error.result, body)
        return true
      },
    )
  }
})

test('a 429 without a code leaves errorCode undefined', async () => {
  const fetchImpl = respondWith(429, { success: false })

  await assert.rejects(
    () => makeClient(fetchImpl).ping(),
    (error) => {
      assert.ok(error instanceof RateLimitError)
      assert.equal(error.errorCode, undefined)
      assert.equal(error.retryAfterSeconds, null)
      return true
    },
  )
})

test('an ApiError keeps the whole envelope on result, params included', async () => {
  const body = failure('SOME_FUTURE_CONFLICT', 'Already there', 409, { existingId: 'x_1' })
  const fetchImpl = respondWith(409, body)

  await assert.rejects(
    () => makeClient(fetchImpl).createCheckoutSession(SESSION_PARAMS),
    (error) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.httpStatus, 409)
      assert.equal(error.errorCode, 'SOME_FUTURE_CONFLICT')
      assert.deepEqual(error.result, body)
      assert.equal(error.result.error.params.existingId, 'x_1')
      return true
    },
  )
})

test('an ApiError without a parsable body has an empty result', async () => {
  const fetchImpl = async () => new Response('<html>bad gateway</html>', { status: 404 })

  await assert.rejects(
    () => makeClient(fetchImpl).ping(),
    (error) => {
      assert.ok(error instanceof ApiError)
      assert.deepEqual(error.result, {})
      return true
    },
  )
})
