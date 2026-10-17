import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { test } from 'node:test'

import {
  ApiError,
  DominaiteClient,
  ErrorCodes,
  REFUND_ERROR_CODES,
  REFUND_FAILURE_CODES,
  RefundError,
  StorefrontError,
  TransportError,
  toMinorUnits,
} from '../dist/esm/index.js'
import { VECTOR } from './vector.mjs'

const KEY_ID = 'dmk_0123456789abcdef0123456789abcdef'
const BASE_URL = 'https://dev.example.test/payments'
const TRANSACTION_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const REFUND_ID = 're_7c1e9a2b4d6f48a0b3c5d7e9f1a2b3c4'
const REFUND_KEY = 'refund-credit-note-77'

const QUEUED = {
  refundId: REFUND_ID,
  transactionId: TRANSACTION_ID,
  status: 'pending',
  amount: 1500,
  currency: 'HUF',
}

// Every code the refund routes answer with, its HTTP status, and whether the same request
// can succeed later (the gateway contract's retry flag for each outcome).
const REFUND_OUTCOMES = [
  { code: 'PAYMENT_NOT_FOUND', httpStatus: 404, retryable: false },
  { code: 'REFUND_NOT_FOUND', httpStatus: 404, retryable: true },
  { code: 'PAYMENT_NOT_REFUNDABLE', httpStatus: 422, retryable: false },
  { code: 'REFUND_AMOUNT_EXCEEDED', httpStatus: 422, retryable: false },
  { code: 'IDEMPOTENCY_KEY_REUSED', httpStatus: 422, retryable: false },
  { code: 'DUPLICATE_REQUEST', httpStatus: 409, retryable: true },
  { code: 'IDEMPOTENCY_KEY_REQUIRED', httpStatus: 400, retryable: false },
]

function recordingFetch(body, status = 200) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return { fetchImpl, calls }
}

/** Retries run at once in tests; the retry tests check the waits themselves. */
const noWait = async () => {}

function makeClient(fetchImpl) {
  return new DominaiteClient({ keyId: KEY_ID, secret: VECTOR.secret, baseUrl: BASE_URL, fetch: fetchImpl, sleep: noWait })
}

/** The signature computed from the documented scheme, independently of signRequest(). */
function expectedSignature({ timestamp, method, path, idempotencyKey, body }) {
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex')
  return createHmac('sha256', Buffer.from(VECTOR.secret, 'utf8'))
    .update([timestamp, method, path, idempotencyKey, bodyHash].join('\n'), 'utf8')
    .digest('hex')
}

async function rejects(run) {
  try {
    await run()
  } catch (error) {
    return error
  }
  assert.fail('expected the call to reject')
}

test('a partial refund sends its amount and signs the idempotency key it sends in the header', async () => {
  const { fetchImpl, calls } = recordingFetch({ success: true, data: QUEUED }, 202)

  await makeClient(fetchImpl).createRefund(TRANSACTION_ID.toUpperCase(), {
    amount: toMinorUnits('1500', 'HUF'),
    reason: 'damaged in transit',
    idempotencyKey: REFUND_KEY,
  })

  const { url, init } = calls[0]
  const path = `/merchant-api/payments/${TRANSACTION_ID}/refunds`
  assert.equal(url, BASE_URL + path)
  assert.equal(init.method, 'POST')
  assert.equal(init.body, '{"amount":1500,"reason":"damaged in transit"}')
  assert.equal(init.headers['Idempotency-Key'], REFUND_KEY)
  assert.equal(
    init.headers['X-Signature'],
    expectedSignature({
      timestamp: init.headers['X-Timestamp'],
      method: 'POST',
      path,
      idempotencyKey: REFUND_KEY,
      body: init.body,
    }),
  )
  // The key is inside the signature: the same request under another key signs differently.
  assert.notEqual(
    init.headers['X-Signature'],
    expectedSignature({
      timestamp: init.headers['X-Timestamp'],
      method: 'POST',
      path,
      idempotencyKey: 'another-key',
      body: init.body,
    }),
  )
})

test('a full refund sends no amount key at all, not a null one', async () => {
  const { fetchImpl, calls } = recordingFetch({ success: true, data: { ...QUEUED, amount: undefined } }, 202)

  await makeClient(fetchImpl).createRefund(TRANSACTION_ID, { idempotencyKey: REFUND_KEY })

  assert.equal(calls[0].init.body, '{}')
  assert.equal(calls[0].init.headers['Idempotency-Key'], REFUND_KEY)
})

test('createRefund sends a field it does not model, as given, and signs it', async () => {
  const { fetchImpl, calls } = recordingFetch({ success: true, data: QUEUED }, 202)

  await makeClient(fetchImpl).createRefund(TRANSACTION_ID, {
    amount: 1500,
    futureField: 'kept',
    amountForgotten: undefined,
    idempotencyKey: REFUND_KEY,
  })

  const { init } = calls[0]
  assert.equal(init.body, '{"amount":1500,"futureField":"kept"}')
  assert.equal(
    init.headers['X-Signature'],
    expectedSignature({
      timestamp: init.headers['X-Timestamp'],
      method: 'POST',
      path: `/merchant-api/payments/${TRANSACTION_ID}/refunds`,
      idempotencyKey: REFUND_KEY,
      body: init.body,
    }),
  )
})

test('createRefund resolves with the queued refund, absent fields read as null', async () => {
  const { fetchImpl } = recordingFetch({ success: true, data: QUEUED }, 202)

  const refund = await makeClient(fetchImpl).createRefund(TRANSACTION_ID, { amount: 1500, idempotencyKey: REFUND_KEY })

  assert.deepEqual(refund, {
    ...QUEUED,
    failureCode: null,
    failureMessage: null,
    completedAt: null,
  })
})

test('a refund without an idempotency key, or with a bad amount, is refused before anything is sent', async () => {
  const { fetchImpl, calls } = recordingFetch({ success: true, data: QUEUED }, 202)
  const client = makeClient(fetchImpl)

  for (const params of [{}, { idempotencyKey: '' }, { idempotencyKey: null }, undefined]) {
    await assert.rejects(() => client.createRefund(TRANSACTION_ID, params), TypeError)
  }
  for (const amount of [0, -1, 12.5, null, '1500']) {
    await assert.rejects(() => client.createRefund(TRANSACTION_ID, { amount, idempotencyKey: REFUND_KEY }), TypeError)
  }
  await assert.rejects(() => client.createRefund(TRANSACTION_ID, { reason: 42, idempotencyKey: REFUND_KEY }), TypeError)
  await assert.rejects(() => client.createRefund('not-a-uuid', { idempotencyKey: REFUND_KEY }), TypeError)
  assert.equal(calls.length, 0)
})

test('getRefund reads the refund path, signing an empty key and an empty body', async () => {
  const { fetchImpl, calls } = recordingFetch({ success: true, data: QUEUED })

  await makeClient(fetchImpl).getRefund(TRANSACTION_ID, REFUND_ID)

  const { url, init } = calls[0]
  const path = `/merchant-api/payments/${TRANSACTION_ID}/refunds/${REFUND_ID}`
  assert.equal(url, BASE_URL + path)
  assert.equal(init.method, 'GET')
  assert.equal(init.body, undefined)
  assert.equal(init.headers['Idempotency-Key'], undefined)
  assert.equal(
    init.headers['X-Signature'],
    expectedSignature({ timestamp: init.headers['X-Timestamp'], method: 'GET', path, idempotencyKey: '', body: '' }),
  )
})

test('getRefund resolves a succeeded refund with its amount and completedAt', async () => {
  const succeeded = { ...QUEUED, status: 'succeeded', completedAt: '2026-09-26T10:05:40.1200000Z' }
  const refund = await makeClient(recordingFetch({ success: true, data: succeeded }).fetchImpl).getRefund(
    TRANSACTION_ID,
    REFUND_ID,
  )

  assert.equal(refund.status, 'succeeded')
  assert.equal(refund.amount, 1500)
  assert.equal(refund.completedAt, succeeded.completedAt)
  assert.equal(refund.failureCode, null)
})

test('getRefund resolves a failed refund as a result: amount null, failureCode REFUND_FAILED', async () => {
  const failed = {
    refundId: REFUND_ID,
    transactionId: TRANSACTION_ID,
    status: 'failed',
    currency: 'HUF',
    failureCode: 'REFUND_FAILED',
    failureMessage: 'The refund could not be completed.',
    completedAt: '2026-09-26T10:05:41.0000000Z',
  }
  const refund = await makeClient(recordingFetch({ success: true, data: failed }).fetchImpl).getRefund(
    TRANSACTION_ID,
    REFUND_ID,
  )

  assert.equal(refund.status, 'failed')
  assert.equal(refund.amount, null)
  assert.equal(refund.failureCode, ErrorCodes.REFUND_FAILED)
  assert.equal(refund.failureMessage, failed.failureMessage)
})

test('every refund error code is a RefundError with its status and retry classification', async () => {
  assert.deepEqual(REFUND_OUTCOMES.map((outcome) => outcome.code), [...REFUND_ERROR_CODES])

  for (const { code, httpStatus, retryable } of REFUND_OUTCOMES) {
    const body = { success: false, error: { code, message: `refused: ${code}`, statusCode: httpStatus } }
    for (const call of [
      (client) => client.createRefund(TRANSACTION_ID, { idempotencyKey: REFUND_KEY }),
      (client) => client.getRefund(TRANSACTION_ID, REFUND_ID),
    ]) {
      const error = await rejects(() => call(makeClient(recordingFetch(body, httpStatus).fetchImpl)))

      assert.ok(error instanceof RefundError, `${code} must be a RefundError, got ${error?.constructor?.name}`)
      assert.ok(error instanceof ApiError, `${code} must still be caught as an ApiError`)
      assert.equal(error.httpStatus, httpStatus, code)
      assert.equal(error.errorCode, code)
      assert.equal(error.retryable, retryable, code)
      assert.equal(error.message, `refused: ${code}`)
      assert.deepEqual(error.result, body)
    }
  }
})

test('the refund codes in ErrorCodes are the ones a refund raises or fails with', () => {
  for (const code of ['PAYMENT_NOT_FOUND', 'REFUND_NOT_FOUND', 'PAYMENT_NOT_REFUNDABLE', 'REFUND_AMOUNT_EXCEEDED']) {
    assert.ok(REFUND_ERROR_CODES.includes(ErrorCodes[code]), code)
  }
  for (const code of ['PAYMENT_NOT_REFUNDABLE', 'REFUND_AMOUNT_EXCEEDED', 'REFUND_FAILED']) {
    assert.ok(REFUND_FAILURE_CODES.includes(ErrorCodes[code]), code)
  }
  assert.equal(REFUND_ERROR_CODES.includes('REFUND_FAILED'), false)
})

test('a 500 on a refund route is a TransportError: nothing was queued, retry with the same key', async () => {
  const body = { success: false, error: { code: 'INTERNAL_ERROR', message: 'boom' } }
  const error = await rejects(() =>
    makeClient(recordingFetch(body, 500).fetchImpl).createRefund(TRANSACTION_ID, { idempotencyKey: REFUND_KEY }),
  )
  assert.ok(error instanceof TransportError)
})

test('a storefront refusal on a refund is a StorefrontError, and an uncoded 4xx a plain ApiError', async () => {
  const storefront = await rejects(() =>
    makeClient(
      recordingFetch({ success: false, error: { code: 'STOREFRONT_INACTIVE', message: 'inactive' } }, 409).fetchImpl,
    ).createRefund(TRANSACTION_ID, { idempotencyKey: REFUND_KEY }),
  )
  assert.ok(storefront instanceof StorefrontError)
  assert.ok(!(storefront instanceof RefundError))

  const plain = await rejects(() =>
    makeClient(recordingFetch({ success: false, error: { message: 'bad amount' } }, 400).fetchImpl).createRefund(
      TRANSACTION_ID,
      { amount: 1, idempotencyKey: REFUND_KEY },
    ),
  )
  assert.ok(plain instanceof ApiError)
  assert.ok(!(plain instanceof RefundError))
  assert.equal(plain.httpStatus, 400)
})

test('a refund id that would not stay one path segment is refused before signing', async () => {
  const { fetchImpl, calls } = recordingFetch({ success: true, data: QUEUED })
  for (const refundId of ['', 're_1/../x', 're_1?x=1', 're 1', null]) {
    await assert.rejects(() => makeClient(fetchImpl).getRefund(TRANSACTION_ID, refundId), TypeError)
  }
  assert.equal(calls.length, 0)
})

const REFUND_LIST = {
  transactionId: TRANSACTION_ID,
  currency: 'HUF',
  refundedAmount: 2500,
  refundableAmount: 7500,
  refunds: [
    { ...QUEUED, refundId: 're_00000000000000000000000000000002', status: 'pending' },
    {
      ...QUEUED,
      refundId: 're_00000000000000000000000000000001',
      status: 'succeeded',
      amount: 2500,
      completedAt: '2026-10-11T09:00:00Z',
    },
  ],
}

test('listRefunds reads the refunds path, signing an empty key and an empty body', async () => {
  const { fetchImpl, calls } = recordingFetch({ success: true, data: REFUND_LIST })

  await makeClient(fetchImpl).listRefunds(TRANSACTION_ID.toUpperCase())

  const { url, init } = calls[0]
  const path = `/merchant-api/payments/${TRANSACTION_ID}/refunds`
  assert.equal(url, BASE_URL + path)
  assert.equal(init.method, 'GET')
  assert.equal(init.body, undefined)
  assert.equal(init.headers['Idempotency-Key'], undefined)
  assert.equal(
    init.headers['X-Signature'],
    expectedSignature({ timestamp: init.headers['X-Timestamp'], method: 'GET', path, idempotencyKey: '', body: '' }),
  )
})

test('listRefunds resolves the totals and every refund in the shape getRefund returns, newest first', async () => {
  const { fetchImpl } = recordingFetch({ success: true, data: REFUND_LIST })

  const list = await makeClient(fetchImpl).listRefunds(TRANSACTION_ID)

  assert.equal(list.transactionId, TRANSACTION_ID)
  assert.equal(list.currency, 'HUF')
  assert.equal(list.refundedAmount, 2500)
  assert.equal(list.refundableAmount, 7500)
  assert.deepEqual(
    list.refunds.map((refund) => refund.refundId),
    ['re_00000000000000000000000000000002', 're_00000000000000000000000000000001'],
  )
  const getRefundShape = await makeClient(recordingFetch({ success: true, data: REFUND_LIST.refunds[1] }).fetchImpl)
    .getRefund(TRANSACTION_ID, REFUND_LIST.refunds[1].refundId)
  assert.deepEqual(list.refunds[1], getRefundShape)
  assert.equal(list.refunds[0].completedAt, null)
  assert.equal(list.refunds[0].failureCode, null)
})

test('listRefunds resolves a payment without refunds with an empty list', async () => {
  const empty = { transactionId: TRANSACTION_ID, currency: 'EUR', refundedAmount: 0, refundableAmount: 1999, refunds: [] }
  const { fetchImpl } = recordingFetch({ success: true, data: empty })

  const list = await makeClient(fetchImpl).listRefunds(TRANSACTION_ID)

  assert.deepEqual(list, empty)
})

test('listRefunds rejects a payment that is not yours with RefundError PAYMENT_NOT_FOUND', async () => {
  const body = { success: false, error: { code: 'PAYMENT_NOT_FOUND', message: 'No payment', statusCode: 404 } }
  const { fetchImpl } = recordingFetch(body, 404)

  const error = await rejects(() => makeClient(fetchImpl).listRefunds(TRANSACTION_ID))

  assert.ok(error instanceof RefundError)
  assert.equal(error.errorCode, 'PAYMENT_NOT_FOUND')
  assert.equal(error.httpStatus, 404)
  assert.equal(error.retryable, false)
  assert.deepEqual(error.result, body)
})

test('listRefunds refuses a transactionId that is not a UUID before sending', async () => {
  const { fetchImpl, calls } = recordingFetch({ success: true, data: REFUND_LIST })

  await assert.rejects(() => makeClient(fetchImpl).listRefunds('../plans'), TypeError)
  assert.equal(calls.length, 0)
})

test('listRefunds rejects a 200 without a list body as an ApiError', async () => {
  const { fetchImpl } = recordingFetch({ success: true, data: QUEUED })

  const error = await rejects(() => makeClient(fetchImpl).listRefunds(TRANSACTION_ID))

  assert.ok(error instanceof ApiError)
  assert.ok(!(error instanceof RefundError))
})
