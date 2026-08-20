const assert = require('node:assert/strict')
const { test } = require('node:test')

// The CommonJS build has to be usable from a plain require() app, which is the
// half of the dual output nothing else exercises.
const sdk = require('../dist/cjs/index.js')

test('the CommonJS build exports the same surface', () => {
  assert.equal(typeof sdk.DominaiteClient, 'function')
  assert.equal(typeof sdk.signRequest, 'function')
  assert.equal(typeof sdk.verifyWebhook, 'function')
  for (const name of ['DominaiteError', 'ApiError', 'AuthenticationError', 'CheckoutRefusedError', 'TransportError']) {
    assert.equal(typeof sdk[name], 'function', `${name} missing from the CJS build`)
  }
})

test('the CommonJS build reproduces the known-answer vector', () => {
  const signature = sdk.signRequest({
    secret: 'dms_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    timestamp: '1755302400',
    method: 'POST',
    path: '/merchant-api/checkout/sessions',
    idempotencyKey: '00000000-0000-4000-8000-000000000001',
    body: '{"amount":2500,"currency":"EUR","orderReference":"order-1042"}',
  })

  assert.equal(signature, '95759958a0a0a9bd3e6e37101c01e8e7fee1166406e4ac2ff488764f5f742cbf')
})
