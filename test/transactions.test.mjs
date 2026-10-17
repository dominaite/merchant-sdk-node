import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { test } from 'node:test'

import { ApiError, AuthenticationError, DominaiteClient, TRANSACTION_TYPES } from '../dist/esm/index.js'
import { VECTOR } from './vector.mjs'

const KEY_ID = 'dmk_0123456789abcdef0123456789abcdef'
const BASE_URL = 'https://dev.example.test/payments'
const PATH = '/merchant-api/transactions'
const FROM = '2026-10-01T00:00:00Z'
const TO = '2026-10-11T00:00:00Z'

// Rows in wire form: the gateway leaves out null fields, except nextCursor, which is always there.
const CHECKOUT_ROW = {
  transactionId: '11111111-1111-4111-8111-111111111111',
  orderReference: 'order-1042',
  type: 'payment',
  status: 'partially_refunded',
  amount: 2500,
  currency: 'EUR',
  createdAt: '2026-10-02T09:00:00Z',
  completedAt: '2026-10-02T09:01:00Z',
  refundedAmount: 500,
}
const CHARGE_ROW = {
  transactionId: '22222222-2222-4222-8222-222222222222',
  type: 'charge',
  status: 'failed',
  amount: 1999,
  currency: 'EUR',
  createdAt: '2026-10-03T09:00:00Z',
  storedPaymentMethodId: 'pm_0123456789abcdef0123456789abcdef',
}

function recordingFetch(...bodies) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const { body, status = 200 } = bodies[Math.min(calls.length, bodies.length) - 1]
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return { fetchImpl, calls }
}

function page(items, nextCursor = null) {
  return { body: { success: true, data: { items, nextCursor } } }
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

test('the transaction types are the gateway values, in its order', () => {
  assert.deepEqual([...TRANSACTION_TYPES], ['payment', 'charge', 'verification'])
})

test('listTransactions puts the parameters in the query and signs the path without it', async () => {
  const { fetchImpl, calls } = recordingFetch(page([]))

  await makeClient(fetchImpl).listTransactions({ from: FROM, to: TO, status: 'succeeded', limit: 100, cursor: 'c+/=1' })

  const { url, init } = calls[0]
  const sent = new URL(url)
  assert.equal(sent.origin + sent.pathname, BASE_URL + PATH)
  assert.deepEqual(Object.fromEntries(sent.searchParams), {
    from: FROM,
    to: TO,
    status: 'succeeded',
    limit: '100',
    cursor: 'c+/=1',
  })
  assert.equal(init.method, 'GET')
  assert.equal(init.body, undefined)
  assert.equal(init.headers['Idempotency-Key'], undefined)
  assert.equal(
    init.headers['X-Signature'],
    expectedSignature({ timestamp: init.headers['X-Timestamp'], method: 'GET', path: PATH, idempotencyKey: '', body: '' }),
  )
})

test('listTransactions sends a Date as ISO 8601 UTC and encodes a + offset so it is not read as a space', async () => {
  const { fetchImpl, calls } = recordingFetch(page([]))

  await makeClient(fetchImpl).listTransactions({ from: new Date(Date.UTC(2026, 9, 1)), to: '2026-10-11T02:00:00+02:00' })

  const url = calls[0].url
  assert.ok(url.includes('to=2026-10-11T02%3A00%3A00%2B02%3A00'), url)
  const sent = new URL(url).searchParams
  assert.equal(sent.get('from'), '2026-10-01T00:00:00.000Z')
  assert.equal(sent.get('to'), '2026-10-11T02:00:00+02:00')
})

test('listTransactions sends a query parameter it does not model as given and leaves out empty ones', async () => {
  const { fetchImpl, calls } = recordingFetch(page([]))

  await makeClient(fetchImpl).listTransactions({ from: FROM, to: TO, futureFilter: 'x', status: undefined, cursor: null })

  assert.deepEqual(Object.fromEntries(new URL(calls[0].url).searchParams), { from: FROM, to: TO, futureFilter: 'x' })
})

test('listTransactions refuses a call without from or to, or with an invalid Date, before sending', async () => {
  const { fetchImpl, calls } = recordingFetch(page([]))
  const client = makeClient(fetchImpl)

  await assert.rejects(() => client.listTransactions({ to: TO }), TypeError)
  await assert.rejects(() => client.listTransactions({ from: FROM }), TypeError)
  await assert.rejects(() => client.listTransactions({ from: '', to: TO }), TypeError)
  await assert.rejects(() => client.listTransactions({ from: new Date('not a date'), to: TO }), TypeError)
  await assert.rejects(() => client.listTransactions(undefined), TypeError)
  assert.equal(calls.length, 0)
})

test('listTransactions answers every row with absent fields as null, and the next cursor', async () => {
  const { fetchImpl } = recordingFetch(page([CHECKOUT_ROW, CHARGE_ROW], 'next-page-cursor'))

  const result = await makeClient(fetchImpl).listTransactions({ from: FROM, to: TO })

  assert.equal(result.nextCursor, 'next-page-cursor')
  assert.deepEqual(result.items, [
    { ...CHECKOUT_ROW, storedPaymentMethodId: null },
    { ...CHARGE_ROW, orderReference: null, completedAt: null, refundedAmount: null },
  ].map((row) => ({ fee: null, netAmount: null, settledAt: null, payoutId: null, ...row })))
})

test('listTransactions reads the settlement fields of a settled row, and null on a row not settled yet', async () => {
  const settled = {
    ...CHECKOUT_ROW,
    fee: 75,
    netAmount: 2425,
    settledAt: '2026-10-03T00:00:00Z',
    payoutId: '33333333-3333-4333-8333-333333333333',
  }
  const notSettled = { ...CHARGE_ROW, fee: null, netAmount: null, settledAt: null, payoutId: null }
  const { fetchImpl } = recordingFetch(page([settled, notSettled]))

  const [first, second] = (await makeClient(fetchImpl).listTransactions({ from: FROM, to: TO })).items

  assert.equal(first.fee, 75)
  assert.equal(first.netAmount, 2425)
  assert.equal(first.settledAt, '2026-10-03T00:00:00Z')
  assert.equal(first.payoutId, '33333333-3333-4333-8333-333333333333')
  for (const name of ['fee', 'netAmount', 'settledAt', 'payoutId']) {
    assert.equal(second[name], null, name)
  }
})

test('listTransactions sends the settlement window as dates and still signs the path only', async () => {
  const { fetchImpl, calls } = recordingFetch(page([]), page([]))
  const client = makeClient(fetchImpl)

  await client.listTransactions({ from: FROM, to: TO, settledFrom: '2026-10-13', settledTo: '2026-10-14' })
  await client.listTransactions({
    from: FROM,
    to: TO,
    settledFrom: new Date(Date.UTC(2026, 9, 13, 15, 30)),
    settledTo: new Date(Date.UTC(2026, 9, 14)),
  })

  for (const { url, init } of calls) {
    const sent = new URL(url)
    assert.equal(sent.origin + sent.pathname, BASE_URL + PATH)
    assert.deepEqual(Object.fromEntries(sent.searchParams), {
      from: FROM,
      to: TO,
      settledFrom: '2026-10-13',
      settledTo: '2026-10-14',
    })
    assert.equal(
      init.headers['X-Signature'],
      expectedSignature({ timestamp: init.headers['X-Timestamp'], method: 'GET', path: PATH, idempotencyKey: '', body: '' }),
    )
  }
})

test('listTransactions leaves out a settlement window that is not set', async () => {
  const { fetchImpl, calls } = recordingFetch(page([]))

  await makeClient(fetchImpl).listTransactions({ from: FROM, to: TO, settledFrom: undefined, settledTo: null })

  assert.deepEqual(Object.fromEntries(new URL(calls[0].url).searchParams), { from: FROM, to: TO })
})

test('listTransactions pages through a window by sending nextCursor back until it is null', async () => {
  const { fetchImpl, calls } = recordingFetch(page([CHECKOUT_ROW], 'cursor-2'), page([CHARGE_ROW]))
  const client = makeClient(fetchImpl)

  const seen = []
  let cursor
  do {
    const result = await client.listTransactions({ from: FROM, to: TO, cursor })
    seen.push(...result.items.map((item) => item.transactionId))
    cursor = result.nextCursor ?? undefined
  } while (cursor)

  assert.deepEqual(seen, [CHECKOUT_ROW.transactionId, CHARGE_ROW.transactionId])
  assert.equal(new URL(calls[0].url).searchParams.has('cursor'), false)
  assert.equal(new URL(calls[1].url).searchParams.get('cursor'), 'cursor-2')
})

test('a key without transactions:read is refused with AuthenticationError INSUFFICIENT_SCOPE', async () => {
  const { fetchImpl } = recordingFetch({
    body: { success: false, error: { code: 'INSUFFICIENT_SCOPE', statusCode: 403 } },
    status: 403,
  })

  const error = await rejects(() => makeClient(fetchImpl).listTransactions({ from: FROM, to: TO }))

  assert.ok(error instanceof AuthenticationError)
  assert.equal(error.errorCode, 'INSUFFICIENT_SCOPE')
})

test('a window the API refuses is an ApiError with the validation code', async () => {
  const body = { success: false, error: { code: 'VALIDATION_ERROR', message: 'The window cannot exceed 31 days', statusCode: 400 } }
  const { fetchImpl } = recordingFetch({ body, status: 400 })

  const error = await rejects(() => makeClient(fetchImpl).listTransactions({ from: FROM, to: '2026-12-01T00:00:00Z' }))

  assert.ok(error instanceof ApiError)
  assert.equal(error.httpStatus, 400)
  assert.equal(error.errorCode, 'VALIDATION_ERROR')
  assert.deepEqual(error.result, body)
})
