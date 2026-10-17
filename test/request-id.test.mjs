import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  ApiError,
  AuthenticationError,
  CheckoutRefusedError,
  DominaiteClient,
  DominaiteError,
  RateLimitError,
  TransportError,
} from '../dist/esm/index.js'
import { PAYMENT_METHOD_ID, VECTOR } from './vector.mjs'

// requestId: the Dominaite-Request-Id header when the API sends it, metadata.requestId from
// the body otherwise (an API that predates the header sends only the body field). On every
// result and on every error.

const KEY_ID = 'dmk_0123456789abcdef0123456789abcdef'
const BASE_URL = 'https://dev.example.test/payments'
const TRANSACTION_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const HEADER_ID = 'hdr-0f9e8d7c'
const BODY_ID = 'c2a1e6d4-3b5f-4c7e-9a8d-1f2e3d4c5b6a'

const CONTRACT = JSON.parse(
  readFileSync(fileURLToPath(new URL('./merchant-api-contract.json', import.meta.url)), 'utf8'),
)

const STATUS = {
  transactionId: TRANSACTION_ID,
  orderId: 'ord_1',
  status: 'pending',
  amount: 2500,
  currency: 'EUR',
  createdAt: '2026-10-17T10:00:00.000000Z',
  isRecurring: false,
  sequence: 1,
}

/** Answers every call with one status, body and set of headers. */
function fetchAnswering(status, body, headers = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    })
  }
  return { fetchImpl, calls }
}

/** Retries run at once in tests; the retry tests check the waits themselves. */
const noWait = async () => {}

function makeClient(fetchImpl) {
  return new DominaiteClient({ keyId: KEY_ID, secret: VECTOR.secret, baseUrl: BASE_URL, fetch: fetchImpl, sleep: noWait })
}

function withMetadata(data, requestId = BODY_ID) {
  return { success: true, data, metadata: { requestId, timestamp: '2026-10-17T10:00:00Z', apiVersion: '1.0' } }
}

async function rejection(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  assert.fail('expected a rejection')
}

test('the Dominaite-Request-Id header wins over the body metadata.requestId', async () => {
  const { fetchImpl } = fetchAnswering(200, withMetadata(STATUS), { 'Dominaite-Request-Id': HEADER_ID })
  const status = await makeClient(fetchImpl).getStatus(TRANSACTION_ID)
  assert.equal(status.requestId, HEADER_ID)
})

test('without the header, the result carries metadata.requestId from the body', async () => {
  const { fetchImpl } = fetchAnswering(200, withMetadata(STATUS))
  const status = await makeClient(fetchImpl).getStatus(TRANSACTION_ID)
  assert.equal(status.requestId, BODY_ID)
})

test('without the header and the body field, requestId is null', async () => {
  const { fetchImpl } = fetchAnswering(200, { success: true, data: STATUS })
  const status = await makeClient(fetchImpl).getStatus(TRANSACTION_ID)
  assert.equal(status.requestId, null)
})

test('requestId is readable but stays out of JSON, spreads and deep equality', async () => {
  const { fetchImpl } = fetchAnswering(200, withMetadata(STATUS))
  const status = await makeClient(fetchImpl).getStatus(TRANSACTION_ID)
  assert.equal(status.requestId, BODY_ID)
  assert.equal(Object.keys(status).includes('requestId'), false)
  assert.equal(JSON.stringify(status).includes(BODY_ID), false)
  assert.deepEqual(status, STATUS)
})

test('every item of a list carries the list request id', async () => {
  const plan = {
    id: 'plan_0123456789abcdef0123456789abcdef', name: 'Monthly', amount: 1999, currency: 'EUR',
    intervalUnit: 'month', intervalCount: 1, trialDays: 0, status: 'active', createdAt: '2026-10-17T10:00:00Z',
  }
  const { fetchImpl } = fetchAnswering(200, withMetadata([plan, { ...plan, id: 'plan_1' }]))
  const plans = await makeClient(fetchImpl).listPlans()
  assert.deepEqual(plans.map((item) => item.requestId), [BODY_ID, BODY_ID])
})

test('an error carries the header request id, or the body one without the header', async () => {
  const notFound = {
    success: false,
    error: { code: 'PLAN_NOT_FOUND', message: 'No plan.', statusCode: 404 },
    metadata: { requestId: BODY_ID },
  }
  const plan = 'plan_0123456789abcdef0123456789abcdef'

  const withHeader = await rejection(
    makeClient(fetchAnswering(404, notFound, { 'Dominaite-Request-Id': HEADER_ID }).fetchImpl).getPlan(plan),
  )
  assert.ok(withHeader instanceof ApiError)
  assert.equal(withHeader.requestId, HEADER_ID)

  const fromBody = await rejection(makeClient(fetchAnswering(404, notFound).fetchImpl).getPlan(plan))
  assert.equal(fromBody.requestId, BODY_ID)
})

test('every error class the client throws after an answer carries the request id', async () => {
  const meta = { metadata: { requestId: BODY_ID } }
  const cases = [
    [AuthenticationError, 401, { success: false, error: { code: 'INVALID_SIGNATURE' }, ...meta }, (c) => c.getStatus(TRANSACTION_ID)],
    [AuthenticationError, 403, { success: false, error: { code: 'INSUFFICIENT_SCOPE' }, ...meta }, (c) => c.listWebhookEndpoints()],
    [RateLimitError, 429, { success: false, error: { code: 'RATE_LIMIT_EXCEEDED' }, ...meta }, (c) => c.getStatus(TRANSACTION_ID)],
    [TransportError, 500, { success: false, error: { code: 'INTERNAL_ERROR' }, ...meta }, (c) => c.deletePlan('plan_1')],
    [
      CheckoutRefusedError,
      200,
      { success: true, data: { success: false, errorCode: 'ALREADY_PROCESSED', errorMessage: 'Done.' }, ...meta },
      (c) => c.createCheckoutSession({ amount: 2500, currency: 'EUR', orderReference: 'o-1', idempotencyKey: 'k-1' }),
    ],
  ]
  for (const [ErrorClass, status, body, call] of cases) {
    const error = await rejection(call(makeClient(fetchAnswering(status, body).fetchImpl)))
    assert.ok(error instanceof ErrorClass, `${status}: got ${error?.constructor?.name}`)
    assert.equal(error.requestId, BODY_ID, `${status} ${ErrorClass.name}`)
  }
})

test('a request that never got an answer has a null request id', async () => {
  const client = new DominaiteClient({
    keyId: KEY_ID,
    secret: VECTOR.secret,
    baseUrl: BASE_URL,
    fetch: async () => {
      throw new Error('socket hang up')
    },
    maxRetries: 0,
  })
  const error = await rejection(client.getStatus(TRANSACTION_ID))
  assert.ok(error instanceof TransportError)
  assert.equal(error.requestId, null)
  assert.equal(new DominaiteError('x').requestId, null)
})

// Contract level: every example response in the hand fixture that carries metadata.requestId
// hands it to the caller, on the result or on the error.
function contractExamples() {
  const { chargePaymentMethod: charge, revokePaymentMethod: revoke, createRefund, getRefund } = CONTRACT.endpoints
  const chargeIt = (c) =>
    c.chargePaymentMethod(PAYMENT_METHOD_ID, { amount: 8440, currency: 'EUR', orderReference: 'order-1042', idempotencyKey: 'k-1' })
  const refundIt = (c) => c.createRefund(TRANSACTION_ID, { idempotencyKey: 'k-1' })
  const readIt = (c) => c.getRefund(TRANSACTION_ID, 're_7c1e9a2b4d6f48a0b3c5d7e9f1a2b3c4')
  return [
    ['charge success', charge.httpStatus, charge.successExample, chargeIt],
    ['charge declined', charge.declinedHttpStatus, charge.declinedExample, chargeIt],
    ['charge not found', charge.notFoundExample.httpStatus, charge.notFoundExample.body, chargeIt],
    ...charge.errorExamples.map((e) => [`charge ${e.code}`, e.httpStatus, e.body, chargeIt]),
    ['revoke not found', revoke.notFoundExample.httpStatus, revoke.notFoundExample.body, (c) => c.revokePaymentMethod(PAYMENT_METHOD_ID)],
    ...revoke.errorExamples.map((e) => [`revoke ${e.code}`, e.httpStatus, e.body, (c) => c.revokePaymentMethod(PAYMENT_METHOD_ID)]),
    ['refund partial', createRefund.httpStatus, createRefund.partialExample, refundIt],
    ['refund full', createRefund.httpStatus, createRefund.fullExample, refundIt],
    ...createRefund.errorExamples.map((e) => [`refund ${e.code}`, e.httpStatus, e.body, refundIt]),
    ['refund read succeeded', getRefund.httpStatus, getRefund.succeededExample, readIt],
    ['refund read failed', getRefund.httpStatus, getRefund.failedExample, readIt],
    ...getRefund.errorExamples.map((e) => [`refund read ${e.code}`, e.httpStatus, e.body, readIt]),
  ]
}

test('every contract example with metadata.requestId hands it to the caller', async () => {
  const examples = contractExamples()
  assert.ok(examples.length >= 20)
  for (const [name, status, body, call] of examples) {
    const expected = body.metadata?.requestId
    assert.equal(typeof expected, 'string', `${name} carries metadata.requestId`)
    const client = new DominaiteClient({
      keyId: KEY_ID,
      secret: VECTOR.secret,
      baseUrl: BASE_URL,
      fetch: fetchAnswering(status, body).fetchImpl,
      maxRetries: 0,
    })
    let outcome
    try {
      outcome = await call(client)
    } catch (error) {
      outcome = error
    }
    assert.equal(outcome?.requestId, expected, name)
  }
})
