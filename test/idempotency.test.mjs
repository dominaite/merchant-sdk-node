import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DominaiteClient, orderIdempotencyKey } from '../dist/esm/index.js'
import { VECTOR } from './vector.mjs'

const ORDER = { scope: 'checkout', orderId: 'order-1042', amountMinor: 2500, currency: 'eur' }

test('orderIdempotencyKey is {scope}-{orderId}-{amountMinor}-{CURRENCY}', () => {
  assert.equal(orderIdempotencyKey(ORDER), 'checkout-order-1042-2500-EUR')
})

test('the same order at the same amount always gets the same key, so a reload replays the session', () => {
  assert.equal(orderIdempotencyKey(ORDER), orderIdempotencyKey({ ...ORDER, currency: 'EUR' }))
})

test('a changed amount or currency gets a new key', () => {
  const key = orderIdempotencyKey(ORDER)
  assert.notEqual(orderIdempotencyKey({ ...ORDER, amountMinor: 2600 }), key)
  assert.notEqual(orderIdempotencyKey({ ...ORDER, currency: 'BGN' }), key)
})

test('orderIdempotencyKey refuses malformed inputs with a TypeError', () => {
  const bad = [
    { ...ORDER, scope: '' },
    { ...ORDER, scope: undefined },
    { ...ORDER, orderId: '  ' },
    { ...ORDER, orderId: 1042 },
    { ...ORDER, amountMinor: 25.5 },
    { ...ORDER, amountMinor: '2500' },
    { ...ORDER, amountMinor: 0 },
    { ...ORDER, currency: 'EURO' },
    { ...ORDER, currency: '' },
    undefined,
  ]
  for (const input of bad) {
    assert.throws(() => orderIdempotencyKey(input), TypeError, JSON.stringify(input))
  }
})

test('a key past the 100 character limit is refused here, not by the gateway', () => {
  // checkout- (9) + orderId + -2500-EUR (9): 82 characters of order id is exactly 100.
  assert.equal(orderIdempotencyKey({ ...ORDER, orderId: 'x'.repeat(82) }).length, 100)
  assert.throws(() => orderIdempotencyKey({ ...ORDER, orderId: 'x'.repeat(83) }), TypeError)
})

test('orderIdempotencyKey refuses an order id that would put a space or non-ASCII in the key', () => {
  assert.throws(() => orderIdempotencyKey({ ...ORDER, orderId: 'order 1042' }), TypeError)
  assert.throws(() => orderIdempotencyKey({ ...ORDER, orderId: 'поръчка-1042' }), TypeError)
  assert.throws(() => orderIdempotencyKey({ ...ORDER, scope: 'check out' }), TypeError)
  assert.match(orderIdempotencyKey({ ...ORDER, orderId: 'ORD_1042/b' }), /^[\x21-\x7E]+$/)
})

test('the derived key is what goes on the wire as Idempotency-Key', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push(init)
    return new Response(JSON.stringify({ success: true, checkout: {} }), { status: 200 })
  }
  const client = new DominaiteClient({ keyId: 'dmk_test', secret: VECTOR.secret, fetch: fetchImpl })

  await client.createCheckoutSession({
    amount: 2500,
    currency: 'EUR',
    orderReference: 'order-1042',
    idempotencyKey: orderIdempotencyKey(ORDER),
  })

  assert.equal(calls[0].headers['Idempotency-Key'], 'checkout-order-1042-2500-EUR')
})
