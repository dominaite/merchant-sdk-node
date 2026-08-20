import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ApiError,
  AuthenticationError,
  CheckoutRefusedError,
  DominaiteClient,
  TransportError,
  signRequest,
} from '../dist/esm/index.js'
import { VECTOR } from './vector.mjs'

const KEY_ID = 'dmk_0123456789abcdef0123456789abcdef'
const BASE_URL = 'https://dev.example.test/payments'

/** Collects the calls a client makes and replies with canned responses. */
function recordingFetch(responses) {
  const calls = []
  const queue = Array.isArray(responses) ? [...responses] : [responses]

  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const next = queue.length > 1 ? queue.shift() : queue[0]
    if (typeof next === 'function') return next()
    return jsonResponse(next.status ?? 200, next.body)
  }

  return { fetchImpl, calls }
}

function jsonResponse(status, body) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeClient(fetchImpl) {
  return new DominaiteClient({ keyId: KEY_ID, secret: VECTOR.secret, baseUrl: BASE_URL, fetch: fetchImpl })
}

const CHECKOUT = {
  transactionId: '11111111-1111-4111-8111-111111111111',
  orderId: 'ord_1',
  cashierKey: 'ck_1',
  cashierToken: 'ct_1',
  amount: 2500,
  currency: 'EUR',
  expiresAt: '2026-08-16T12:00:00Z',
}

const SESSION_PARAMS = {
  amount: 2500,
  currency: 'EUR',
  orderReference: 'order-1042',
  idempotencyKey: VECTOR.idempotencyKey,
}

test('createCheckoutSession signs the request exactly as the gateway expects', async () => {
  const { fetchImpl, calls } = recordingFetch({ body: { success: true, checkout: CHECKOUT } })
  const session = await makeClient(fetchImpl).createCheckoutSession(SESSION_PARAMS)

  assert.deepEqual(session, CHECKOUT)
  assert.equal(calls.length, 1)

  const { url, init } = calls[0]
  assert.equal(url, `${BASE_URL}${DominaiteClient.SESSIONS_PATH}`)
  assert.equal(init.method, 'POST')
  assert.equal(init.body, VECTOR.body)
  assert.equal(init.headers['X-Api-Key-Id'], KEY_ID)
  assert.equal(init.headers['Idempotency-Key'], VECTOR.idempotencyKey)

  // The signature the client actually sent must be reproducible from the recipe,
  // using the timestamp it chose.
  const expected = signRequest({
    secret: VECTOR.secret,
    timestamp: init.headers['X-Timestamp'],
    method: 'POST',
    path: DominaiteClient.SESSIONS_PATH,
    idempotencyKey: VECTOR.idempotencyKey,
    body: VECTOR.body,
  })
  assert.equal(init.headers['X-Signature'], expected)

  // And the timestamp is unix SECONDS, not milliseconds.
  const sent = Number(init.headers['X-Timestamp'])
  assert.ok(Math.abs(sent - Math.floor(Date.now() / 1000)) <= 5, `timestamp out of range: ${sent}`)
})

test('the signed body is byte-identical to the body sent', async () => {
  const { fetchImpl, calls } = recordingFetch({ body: { success: true, checkout: CHECKOUT } })
  await makeClient(fetchImpl).createCheckoutSession({
    ...SESSION_PARAMS,
    customer: { firstName: 'Ana', email: 'ana@example.com' },
  })

  const { init } = calls[0]
  const expected = signRequest({
    secret: VECTOR.secret,
    timestamp: init.headers['X-Timestamp'],
    method: 'POST',
    path: DominaiteClient.SESSIONS_PATH,
    idempotencyKey: VECTOR.idempotencyKey,
    body: init.body,
  })
  assert.equal(init.headers['X-Signature'], expected)
  assert.ok(!init.body.includes('idempotencyKey'), 'idempotencyKey must not leak into the body')
})

test('getStatus signs an empty idempotency key and an empty body', async () => {
  const status = { transactionId: CHECKOUT.transactionId, status: 'succeeded', amount: 2500, currency: 'EUR' }
  const { fetchImpl, calls } = recordingFetch({ body: status })

  const result = await makeClient(fetchImpl).getStatus(CHECKOUT.transactionId)
  assert.deepEqual(result, status)

  const { url, init } = calls[0]
  assert.equal(url, `${BASE_URL}${DominaiteClient.SESSIONS_PATH}/${CHECKOUT.transactionId}`)
  assert.equal(init.method, 'GET')
  assert.equal(init.body, undefined)
  assert.equal(init.headers['Idempotency-Key'], undefined)

  const expected = signRequest({
    secret: VECTOR.secret,
    timestamp: init.headers['X-Timestamp'],
    method: 'GET',
    path: `${DominaiteClient.SESSIONS_PATH}/${CHECKOUT.transactionId}`,
    idempotencyKey: '',
    body: '',
  })
  assert.equal(init.headers['X-Signature'], expected)
})

test('ping signs an empty idempotency key and an empty body against the canonical path', async () => {
  const pong = {
    pong: true,
    merchantId: 'mer_1',
    serverTime: '2026-08-20T12:00:00Z',
    serverUnixTime: 1755691200,
    clockSkewSeconds: 2,
  }
  // The gateway envelope: the ping read is FLAT inside data, with no inner success.
  const { fetchImpl, calls } = recordingFetch({ body: { success: true, data: pong } })

  const result = await makeClient(fetchImpl).ping()
  assert.deepEqual(result, pong)

  const { url, init } = calls[0]
  assert.equal(url, `${BASE_URL}${DominaiteClient.PING_PATH}`)
  assert.equal(init.method, 'GET')
  assert.equal(init.body, undefined)
  assert.equal(init.headers['Idempotency-Key'], undefined)

  // The signed path is the canonical path, never the base URL's own prefix.
  const expected = signRequest({
    secret: VECTOR.secret,
    timestamp: init.headers['X-Timestamp'],
    method: 'GET',
    path: '/merchant-api/ping',
    idempotencyKey: '',
    body: '',
  })
  assert.equal(init.headers['X-Signature'], expected)
})

test('a ping against bad credentials is an AuthenticationError carrying the code', async () => {
  const { fetchImpl } = recordingFetch({ status: 401, body: { errorCode: 'INVALID_SIGNATURE' } })

  await assert.rejects(
    () => makeClient(fetchImpl).ping(),
    (error) => {
      assert.ok(error instanceof AuthenticationError)
      assert.equal(error.errorCode, 'INVALID_SIGNATURE')
      return true
    },
  )
})

test('getStatus rejects anything that is not the returned transaction UUID', async () => {
  const { fetchImpl, calls } = recordingFetch({ body: {} })
  await assert.rejects(() => makeClient(fetchImpl).getStatus('order-1042'), TypeError)
  assert.equal(calls.length, 0)
})

test('a refusal is a CheckoutRefusedError carrying the error code, not a transport failure', async () => {
  const { fetchImpl } = recordingFetch({
    status: 200,
    body: { success: false, errorCode: 'PAYMENT_PROCESSING_UNAVAILABLE', errorMessage: 'Card payments are off' },
  })

  await assert.rejects(
    () => makeClient(fetchImpl).createCheckoutSession(SESSION_PARAMS),
    (error) => {
      assert.ok(error instanceof CheckoutRefusedError)
      assert.ok(!(error instanceof TransportError))
      assert.equal(error.errorCode, 'PAYMENT_PROCESSING_UNAVAILABLE')
      return true
    },
  )
})

test('a replay refusal carries the transaction id so the caller can reconcile', async () => {
  // Without this the documented recovery - read it back with getStatus() - is
  // unreachable from the error, leaving a second payment as the only option.
  const { fetchImpl } = recordingFetch({
    status: 200,
    body: {
      success: false,
      transactionId: CHECKOUT.transactionId,
      errorCode: 'DUPLICATE_REQUEST',
      errorMessage: 'A checkout session for this idempotency key is already open.',
    },
  })

  await assert.rejects(
    () => makeClient(fetchImpl).createCheckoutSession(SESSION_PARAMS),
    (error) => {
      assert.ok(error instanceof CheckoutRefusedError)
      assert.equal(error.errorCode, 'DUPLICATE_REQUEST')
      assert.equal(error.transactionId, CHECKOUT.transactionId)
      assert.equal(error.result.errorCode, 'DUPLICATE_REQUEST')
      return true
    },
  )
})

test('a refusal with no transaction id leaves it undefined', async () => {
  // The concurrent-race DUPLICATE_REQUEST knows the key is taken, not by which row.
  const { fetchImpl } = recordingFetch({
    status: 200,
    body: { success: false, errorCode: 'DUPLICATE_REQUEST' },
  })

  await assert.rejects(
    () => makeClient(fetchImpl).createCheckoutSession(SESSION_PARAMS),
    (error) => {
      assert.equal(error.transactionId, undefined)
      return true
    },
  )
})

test('a 503 is a TransportError, not a refusal', async () => {
  const { fetchImpl } = recordingFetch({
    status: 503,
    body: { success: false, errorCode: 'MERCHANT_API_UNAVAILABLE', errorMessage: 'temporarily unavailable' },
  })

  await assert.rejects(
    () => makeClient(fetchImpl).createCheckoutSession(SESSION_PARAMS),
    (error) => {
      assert.ok(error instanceof TransportError)
      assert.ok(!(error instanceof CheckoutRefusedError))
      return true
    },
  )
})

test('a network failure is a TransportError', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed')
  }

  await assert.rejects(() => makeClient(fetchImpl).createCheckoutSession(SESSION_PARAMS), TransportError)
})

test('401 codes surface as AuthenticationError, including IP_NOT_ALLOWED', async () => {
  for (const code of ['INVALID_API_KEY', 'INVALID_SIGNATURE', 'TIMESTAMP_OUT_OF_RANGE', 'IP_NOT_ALLOWED']) {
    const { fetchImpl } = recordingFetch({ status: 401, body: { success: false, errorCode: code } })
    await assert.rejects(
      () => makeClient(fetchImpl).createCheckoutSession(SESSION_PARAMS),
      (error) => {
        assert.ok(error instanceof AuthenticationError)
        assert.equal(error.errorCode, code)
        return true
      },
    )
  }
})

test('a 422 idempotency-key reuse surfaces as ApiError with the status', async () => {
  const { fetchImpl } = recordingFetch({
    status: 422,
    body: { success: false, errorCode: 'IDEMPOTENCY_KEY_REUSED', errorMessage: 'Key reused with a different body' },
  })

  await assert.rejects(
    () => makeClient(fetchImpl).createCheckoutSession(SESSION_PARAMS),
    (error) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.httpStatus, 422)
      return true
    },
  )
})

test('the gateway { success, data } envelope is unwrapped', async () => {
  const status = { transactionId: CHECKOUT.transactionId, status: 'pending', amount: 2500, currency: 'EUR' }
  const { fetchImpl } = recordingFetch({ body: { success: true, data: status } })

  assert.deepEqual(await makeClient(fetchImpl).getStatus(CHECKOUT.transactionId), status)
})

test('the retry helper reuses the SAME idempotency key across attempts', async () => {
  let attempt = 0
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push(init)
    attempt++
    if (attempt < 3) throw new TypeError('fetch failed')
    return jsonResponse(200, { success: true, checkout: CHECKOUT })
  }

  const session = await makeClient(fetchImpl).createCheckoutSessionWithRetry(
    { amount: 2500, currency: 'EUR', orderReference: 'order-1042' },
    { attempts: 3, baseDelayMs: 1 },
  )

  assert.deepEqual(session, CHECKOUT)
  assert.equal(calls.length, 3)
  const keys = new Set(calls.map((init) => init.headers['Idempotency-Key']))
  assert.equal(keys.size, 1, `expected one idempotency key across retries, got ${[...keys].join(', ')}`)
  assert.ok([...keys][0])
})

test('the retry helper does not retry refusals', async () => {
  let attempts = 0
  const fetchImpl = async () => {
    attempts++
    return jsonResponse(200, { success: false, errorCode: 'DUPLICATE_REQUEST' })
  }

  await assert.rejects(
    () => makeClient(fetchImpl).createCheckoutSessionWithRetry(SESSION_PARAMS, { attempts: 3, baseDelayMs: 1 }),
    CheckoutRefusedError,
  )
  assert.equal(attempts, 1)
})

test('the retry helper gives up with the last TransportError', async () => {
  let attempts = 0
  const fetchImpl = async () => {
    attempts++
    throw new TypeError('fetch failed')
  }

  await assert.rejects(
    () => makeClient(fetchImpl).createCheckoutSessionWithRetry(SESSION_PARAMS, { attempts: 2, baseDelayMs: 1 }),
    TransportError,
  )
  assert.equal(attempts, 2)
})

test('amounts must be positive integers in minor units', async () => {
  const { fetchImpl, calls } = recordingFetch({ body: { success: true, checkout: CHECKOUT } })
  const client = makeClient(fetchImpl)

  for (const amount of [25.0001, 25.5, 0, -100, '2500', Number.NaN]) {
    await assert.rejects(
      () => client.createCheckoutSession({ ...SESSION_PARAMS, amount }),
      TypeError,
      `amount ${String(amount)} should be rejected`,
    )
  }
  assert.equal(calls.length, 0, 'invalid amounts must never reach the network')
})

test('credentials are prefix-checked at construction', () => {
  assert.throws(() => new DominaiteClient({ keyId: 'nope', secret: VECTOR.secret }), TypeError)
  assert.throws(() => new DominaiteClient({ keyId: KEY_ID, secret: 'nope' }), TypeError)
})

test('a non-JSON response is an ApiError, not a crash', async () => {
  const fetchImpl = async () => new Response('<html>502 Bad Gateway</html>', { status: 200 })
  await assert.rejects(() => makeClient(fetchImpl).createCheckoutSession(SESSION_PARAMS), ApiError)
})
