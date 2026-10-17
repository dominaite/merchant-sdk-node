import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ChargeError,
  CheckoutRefusedError,
  DominaiteClient,
  RateLimitError,
  RevokeError,
  TransportError,
  signRequest,
} from '../dist/esm/index.js'
import { PAYMENT_METHOD_ID, VECTOR } from './vector.mjs'

// One client-level retry policy: GET calls and POST calls with an idempotency key are sent
// again after a transport failure, a 5xx the route does not own, or
// PAYMENT_PROCESSING_UNAVAILABLE. Same key, same body, every attempt. Never a 429.

const KEY_ID = 'dmk_0123456789abcdef0123456789abcdef'
const BASE_URL = 'https://dev.example.test/payments'
const TRANSACTION_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

const CHARGE = {
  chargeId: 'ch_0123456789abcdef0123456789abcdef',
  status: 'succeeded',
  transactionId: TRANSACTION_ID,
  sequence: 1,
}
const CHARGE_PARAMS = { amount: 2500, currency: 'EUR', orderReference: 'order-7', idempotencyKey: 'charge-order-7' }
const REFUND = { refundId: 're_0123456789abcdef0123456789abcdef', transactionId: TRANSACTION_ID, status: 'pending', currency: 'EUR' }
const CHECKOUT = {
  transactionId: TRANSACTION_ID,
  orderId: 'ord_1',
  cashierKey: 'ck_1',
  cashierToken: 'ct_1',
  amount: 2500,
  currency: 'EUR',
  expiresAt: '2026-10-17T12:00:00Z',
  integration: 'widget',
}
const SESSION_PARAMS = { amount: 2500, currency: 'EUR', orderReference: 'order-7', idempotencyKey: 'checkout-order-7' }

/** Answers each call with the next scripted step: a { status, body } or 'network' to throw. */
function scripted(steps) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]
    if (step === 'network') {
      throw new TypeError('fetch failed')
    }
    const headers = { 'Content-Type': 'application/json', ...(step.headers ?? {}) }
    const body = typeof step.body === 'string' ? step.body : JSON.stringify(step.body)
    return new Response(body, { status: step.status, headers })
  }
  return { fetchImpl, calls }
}

function makeClient(fetchImpl, extra = {}) {
  const sleeps = []
  const client = new DominaiteClient({
    keyId: KEY_ID,
    secret: VECTOR.secret,
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    ...extra,
  })
  return { client, sleeps }
}

/** Every attempt carries the same key and body, and a signature valid for its own timestamp. */
function assertSameSignedInput(calls, method, path, idempotencyKey) {
  for (const { url, init } of calls) {
    assert.equal(url, BASE_URL + path)
    assert.equal(init.headers['Idempotency-Key'], idempotencyKey)
    assert.equal(init.body, calls[0].init.body)
    assert.equal(
      init.headers['X-Signature'],
      signRequest({ secret: VECTOR.secret, timestamp: init.headers['X-Timestamp'], method, path, idempotencyKey, body: init.body }),
    )
  }
}

test('a transport failure then success on a charge resends the same key and signed input', async () => {
  const { fetchImpl, calls } = scripted(['network', { status: 201, body: { success: true, data: CHARGE } }])
  const { client, sleeps } = makeClient(fetchImpl)

  const charge = await client.chargePaymentMethod(PAYMENT_METHOD_ID, CHARGE_PARAMS)

  assert.equal(charge.chargeId, CHARGE.chargeId)
  assert.equal(calls.length, 2)
  assert.equal(sleeps.length, 1)
  assertSameSignedInput(calls, 'POST', `/merchant-api/payment-methods/${PAYMENT_METHOD_ID}/charges`, CHARGE_PARAMS.idempotencyKey)
})

test('a transport failure then success on a refund resends the same key and signed input', async () => {
  const { fetchImpl, calls } = scripted(['network', { status: 202, body: { success: true, data: REFUND } }])
  const { client } = makeClient(fetchImpl)

  const refund = await client.createRefund(TRANSACTION_ID, { amount: 500, idempotencyKey: 'refund-note-9' })

  assert.equal(refund.refundId, REFUND.refundId)
  assert.equal(calls.length, 2)
  assertSameSignedInput(calls, 'POST', `/merchant-api/payments/${TRANSACTION_ID}/refunds`, 'refund-note-9')
})

test('maxRetries 0 sends once', async () => {
  const { fetchImpl, calls } = scripted(['network'])
  const { client, sleeps } = makeClient(fetchImpl, { maxRetries: 0 })

  await assert.rejects(client.chargePaymentMethod(PAYMENT_METHOD_ID, CHARGE_PARAMS), TransportError)
  assert.equal(calls.length, 1)
  assert.equal(sleeps.length, 0)
})

test('the default is two retries, and the last error comes back as it arrived', async () => {
  const { fetchImpl, calls } = scripted([{ status: 503, body: { success: false, error: { code: 'MERCHANT_API_UNAVAILABLE' } } }])
  const { client, sleeps } = makeClient(fetchImpl)

  await assert.rejects(client.getStatus(TRANSACTION_ID), (error) => {
    assert.ok(error instanceof TransportError)
    assert.equal(error.httpStatus, 503)
    assert.equal(error.errorCode, 'MERCHANT_API_UNAVAILABLE')
    return true
  })
  assert.equal(calls.length, 3)
  assert.equal(sleeps.length, 2)
})

test('a 429 is never retried and keeps retryAfterSeconds', async () => {
  const limited = {
    status: 429,
    headers: { 'Retry-After': '17' },
    body: { success: false, error: { code: 'RATE_LIMIT_EXCEEDED' } },
  }
  for (const call of [
    (client) => client.getStatus(TRANSACTION_ID),
    (client) => client.chargePaymentMethod(PAYMENT_METHOD_ID, CHARGE_PARAMS),
  ]) {
    const { fetchImpl, calls } = scripted([limited])
    const { client, sleeps } = makeClient(fetchImpl)
    await assert.rejects(call(client), (error) => error instanceof RateLimitError && error.retryAfterSeconds === 17)
    assert.equal(calls.length, 1)
    assert.equal(sleeps.length, 0)
  }
})

test('each wait is full jitter: random in [0, 500 * 2^attempt), capped at 8 s', async () => {
  const failing = { status: 500, body: { success: false, error: { code: 'INTERNAL_ERROR' } } }
  const ceilings = [500, 1000, 2000, 4000, 8000, 8000]

  for (const [random, expected] of [
    [() => 0, ceilings.map(() => 0)],
    [() => 0.5, ceilings.map((ceiling) => ceiling / 2)],
    [() => 0.999999, ceilings.map((ceiling) => ceiling - 1)],
  ]) {
    const { fetchImpl, calls } = scripted([failing])
    const { client, sleeps } = makeClient(fetchImpl, { maxRetries: ceilings.length, random })
    await assert.rejects(client.listPlans(), TransportError)
    assert.equal(calls.length, ceilings.length + 1)
    assert.deepEqual(sleeps, expected)
    sleeps.forEach((ms, attempt) => assert.ok(ms >= 0 && ms < ceilings[attempt], `wait ${attempt}: ${ms}`))
  }
})

test('a GET is retried after a 5xx and resolves with the answer that came', async () => {
  const status = { transactionId: TRANSACTION_ID, orderId: 'o', status: 'pending', amount: 1, currency: 'EUR', createdAt: 'x', isRecurring: false, sequence: 1 }
  const { fetchImpl, calls } = scripted([
    { status: 502, body: '<html>502 Bad Gateway</html>' },
    { status: 200, body: { success: true, data: status } },
  ])
  const { client } = makeClient(fetchImpl)
  assert.equal((await client.getStatus(TRANSACTION_ID)).status, 'pending')
  assert.equal(calls.length, 2)
})

test('a non-JSON 5xx is a TransportError with its status once the retries run out', async () => {
  const { fetchImpl, calls } = scripted([{ status: 502, body: '<html>502 Bad Gateway</html>' }])
  const { client } = makeClient(fetchImpl, { maxRetries: 1 })
  await assert.rejects(client.listPlans(), (error) => error instanceof TransportError && error.httpStatus === 502)
  assert.equal(calls.length, 2)
})

test('a PAYMENT_PROCESSING_UNAVAILABLE session refusal is retried by createCheckoutSession itself', async () => {
  const { fetchImpl, calls } = scripted([
    { status: 200, body: { success: true, data: { success: false, errorCode: 'PAYMENT_PROCESSING_UNAVAILABLE' } } },
    { status: 200, body: { success: true, data: { success: true, checkout: CHECKOUT } } },
  ])
  const { client } = makeClient(fetchImpl)
  const session = await client.createCheckoutSession(SESSION_PARAMS)
  assert.equal(session.transactionId, TRANSACTION_ID)
  assert.equal(calls.length, 2)
  assertSameSignedInput(calls, 'POST', '/merchant-api/checkout/sessions', SESSION_PARAMS.idempotencyKey)
})

test('other session refusals are not retried', async () => {
  const { fetchImpl, calls } = scripted([
    { status: 200, body: { success: true, data: { success: false, errorCode: 'DUPLICATE_REQUEST' } } },
  ])
  const { client } = makeClient(fetchImpl)
  await assert.rejects(client.createCheckoutSession(SESSION_PARAMS), CheckoutRefusedError)
  assert.equal(calls.length, 1)
})

test('a charge code on a 5xx is the charge answer and is not retried, except PAYMENT_PROCESSING_UNAVAILABLE', async () => {
  for (const [status, code] of [[502, 'CHARGE_OUTCOME_UNKNOWN'], [502, 'CHARGE_FAILED'], [503, 'PAYMENT_METHOD_CHARGES_DISABLED']]) {
    const { fetchImpl, calls } = scripted([{ status, body: { success: false, error: { code, statusCode: status } } }])
    const { client } = makeClient(fetchImpl)
    await assert.rejects(client.chargePaymentMethod(PAYMENT_METHOD_ID, CHARGE_PARAMS), ChargeError)
    assert.equal(calls.length, 1, code)
  }

  const { fetchImpl, calls } = scripted([
    { status: 503, body: { success: false, error: { code: 'PAYMENT_PROCESSING_UNAVAILABLE', statusCode: 503 } } },
    { status: 201, body: { success: true, data: CHARGE } },
  ])
  const { client } = makeClient(fetchImpl)
  assert.equal((await client.chargePaymentMethod(PAYMENT_METHOD_ID, CHARGE_PARAMS)).chargeId, CHARGE.chargeId)
  assert.equal(calls.length, 2)
})

test('DELETE and PATCH are never retried, and neither is a 4xx', async () => {
  const unavailable = { status: 503, body: { success: false, error: { code: 'MERCHANT_API_UNAVAILABLE' } } }
  const internal = { status: 500, body: { success: false, error: { code: 'INTERNAL_ERROR' } } }
  const invalid = { status: 400, body: { success: false, error: { code: 'VALIDATION_ERROR' } } }
  const cases = [
    [unavailable, (c) => c.revokePaymentMethod(PAYMENT_METHOD_ID), RevokeError],
    [internal, (c) => c.deletePlan('plan_0123456789abcdef0123456789abcdef'), TransportError],
    [internal, (c) => c.updatePlan('plan_0123456789abcdef0123456789abcdef', { name: 'x', idempotencyKey: 'k' }), TransportError],
    [invalid, (c) => c.chargePaymentMethod(PAYMENT_METHOD_ID, CHARGE_PARAMS), Error],
  ]
  for (const [answer, call, ErrorClass] of cases) {
    const { fetchImpl, calls } = scripted([answer])
    const { client } = makeClient(fetchImpl)
    await assert.rejects(call(client), ErrorClass)
    assert.equal(calls.length, 1)
  }
})

test('maxRetries must be a whole number of 0 or more', () => {
  for (const maxRetries of [-1, 1.5, '2', Number.NaN]) {
    assert.throws(() => makeClient(async () => new Response('{}'), { maxRetries }), TypeError, String(maxRetries))
  }
})

test('the deprecated createCheckoutSessionWithRetry uses its own attempts, not on top of the client policy', async () => {
  const { fetchImpl, calls } = scripted(['network'])
  const warnings = []
  const { client } = makeClient(fetchImpl, { onWarning: (message) => warnings.push(message) })

  await assert.rejects(client.createCheckoutSessionWithRetry(SESSION_PARAMS, { attempts: 2, baseDelayMs: 1 }), TransportError)
  assert.equal(calls.length, 2)
  assert.deepEqual(warnings, ['dominaite-node: retrying createCheckoutSessionWithRetry after TransportError (attempt 2 of 2)'])
})
