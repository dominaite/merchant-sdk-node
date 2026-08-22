const assert = require('node:assert/strict')
const { test } = require('node:test')

// The CommonJS build has to be usable from a plain require() app, which is the
// half of the dual output nothing else exercises.
const sdk = require('../dist/cjs/index.js')

test('the CommonJS build exports the same surface', () => {
  assert.equal(typeof sdk.DominaiteClient, 'function')
  assert.equal(typeof sdk.signRequest, 'function')
  assert.equal(typeof sdk.verifyWebhook, 'function')
  const errors = [
    'DominaiteError',
    'ApiError',
    'AuthenticationError',
    'CheckoutRefusedError',
    'RateLimitError',
    'TransportError',
  ]
  for (const name of errors) {
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

  assert.equal(signature, '8f5fba0b29a8eea81b76a0e6d7119e79ec68f586910f77713b045652e5ce9b74')
})
