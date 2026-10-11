import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DominaiteClient, signRequest } from '../dist/esm/index.js'
import { VECTOR } from './vector.mjs'

// The session request: verify-only sessions, subscription sessions, and the fields the
// gateway accepts. Every field is sent as given, in the order given, and the signature
// covers exactly the bytes sent.

const KEY_ID = 'dmk_0123456789abcdef0123456789abcdef'
const BASE_URL = 'https://dev.example.test/payments'
const KEY = 'card-check-customer-7'

const CHECKOUT = {
  transactionId: '11111111-1111-4111-8111-111111111111',
  orderId: 'ord_1',
  cashierKey: 'ck_1',
  cashierToken: 'ct_1',
  amount: 0,
  currency: 'EUR',
  expiresAt: '2026-10-11T12:00:00Z',
  integration: 'widget',
  verifyOnly: true,
}

const { verifyOnly: _unused, ...PAYMENT_CHECKOUT } = CHECKOUT

function recordingFetch(body = { success: true, checkout: CHECKOUT }) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  return { fetchImpl, calls }
}

function makeClient(fetchImpl) {
  return new DominaiteClient({ keyId: KEY_ID, secret: VECTOR.secret, baseUrl: BASE_URL, fetch: fetchImpl })
}

function assertSigned(init) {
  const expected = signRequest({
    secret: VECTOR.secret,
    timestamp: init.headers['X-Timestamp'],
    method: 'POST',
    path: DominaiteClient.SESSIONS_PATH,
    idempotencyKey: init.headers['Idempotency-Key'],
    body: init.body,
  })
  assert.equal(init.headers['X-Signature'], expected)
}

test('a verifyOnly session may leave the amount out', async () => {
  const { fetchImpl, calls } = recordingFetch()

  const session = await makeClient(fetchImpl).createCheckoutSession({
    verifyOnly: true,
    currency: 'EUR',
    orderReference: 'card-check-7',
    idempotencyKey: KEY,
  })

  assert.equal(session.transactionId, CHECKOUT.transactionId)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.body, '{"verifyOnly":true,"currency":"EUR","orderReference":"card-check-7"}')
  assert.equal(calls[0].init.headers['Idempotency-Key'], KEY)
  assertSigned(calls[0].init)
})

test('a verifyOnly session may send amount 0', async () => {
  const { fetchImpl, calls } = recordingFetch()

  await makeClient(fetchImpl).createCheckoutSession({
    amount: 0,
    currency: 'EUR',
    orderReference: 'card-check-7',
    verifyOnly: true,
    idempotencyKey: KEY,
  })

  assert.equal(calls[0].init.body, '{"amount":0,"currency":"EUR","orderReference":"card-check-7","verifyOnly":true}')
  assertSigned(calls[0].init)
})

test('a verifyOnly session refuses a real amount before sending', async () => {
  const { fetchImpl, calls } = recordingFetch()
  const client = makeClient(fetchImpl)

  for (const amount of [2500, 1, -1, 0.5, null, '0']) {
    await assert.rejects(
      () => client.createCheckoutSession({ amount, currency: 'EUR', orderReference: 'o', verifyOnly: true, idempotencyKey: KEY }),
      TypeError,
      `amount ${String(amount)} should be rejected with verifyOnly`,
    )
  }
  assert.equal(calls.length, 0)
})

test('a verifyOnly session still needs a currency, an order reference and a key', async () => {
  const { fetchImpl, calls } = recordingFetch()
  const client = makeClient(fetchImpl)
  const complete = { verifyOnly: true, currency: 'EUR', orderReference: 'card-check-7', idempotencyKey: KEY }

  for (const missing of ['currency', 'orderReference', 'idempotencyKey']) {
    const params = { ...complete }
    delete params[missing]
    await assert.rejects(() => client.createCheckoutSession(params), TypeError, `${missing} must be required`)
  }
  assert.equal(calls.length, 0)
})

test('without verifyOnly an amount of 0, or none, is still refused before sending', async () => {
  const { fetchImpl, calls } = recordingFetch()
  const client = makeClient(fetchImpl)
  const base = { currency: 'EUR', orderReference: 'order-1042', idempotencyKey: KEY }

  for (const params of [
    { ...base, amount: 0 },
    { ...base },
    { ...base, amount: 0, verifyOnly: false },
    { ...base, verifyOnly: 'true' },
  ]) {
    await assert.rejects(() => client.createCheckoutSession(params), TypeError, JSON.stringify(params))
  }
  assert.equal(calls.length, 0)
})

test('a subscription session sends agreementId, consent and every other field as given', async () => {
  const { fetchImpl, calls } = recordingFetch({
    success: true,
    checkout: { ...PAYMENT_CHECKOUT, amount: 1999, agreementId: 'agr_0123456789abcdef0123456789abcdef' },
  })

  const params = {
    amount: 1999,
    currency: 'EUR',
    orderReference: 'sub-42-first',
    customer: { firstName: 'Ana', lastName: 'Example', email: 'ana@example.test', phone: '+359888123456' },
    country: 'BG',
    language: 'bg',
    theme: 'dark',
    description: 'Monthly plan',
    locationId: '22222222-2222-4222-8222-222222222222',
    saveCard: true,
    agreementId: 'agr_0123456789abcdef0123456789abcdef',
    consent: { textVersion: 'recurring-2026-09', acceptedAt: '2026-10-11T09:30:00Z', ip: '203.0.113.7' },
    integration: 'widget',
    futureField: { kept: true },
  }
  await makeClient(fetchImpl).createCheckoutSession({ ...params, idempotencyKey: KEY })

  // The key is a header, never a body field; everything else goes out untouched.
  assert.equal(calls[0].init.body, JSON.stringify(params))
  assertSigned(calls[0].init)
})
