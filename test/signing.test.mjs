import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { test } from 'node:test'

import { signRequest } from '../dist/esm/index.js'
import { CHARGE_VECTOR, REVOKE_VECTOR, VECTOR } from './vector.mjs'

// If these fail, the signing recipe drifted from the gateway and every merchant
// integration built on this SDK is broken.

test('known-answer vector: body hash matches the published sha256', () => {
  const hash = createHash('sha256').update(VECTOR.body, 'utf8').digest('hex')
  assert.equal(hash, VECTOR.bodySha256)
})

test('known-answer vector: signature matches byte-for-byte', () => {
  const signature = signRequest({
    secret: VECTOR.secret,
    timestamp: VECTOR.timestamp,
    method: VECTOR.method,
    path: VECTOR.path,
    idempotencyKey: VECTOR.idempotencyKey,
    body: VECTOR.body,
  })

  assert.equal(signature, VECTOR.signature)
})

test('method is uppercased before signing', () => {
  const lower = signRequest({ ...VECTOR, method: 'post' })
  assert.equal(lower, VECTOR.signature)
})

test('a different idempotency key produces a different signature', () => {
  const other = signRequest({ ...VECTOR, idempotencyKey: '00000000-0000-4000-8000-000000000002' })
  assert.notEqual(other, VECTOR.signature)
})

test('GET shape: empty idempotency key and empty body hash the empty string', () => {
  const expectedEmptyHash = createHash('sha256').update('', 'utf8').digest('hex')
  assert.equal(expectedEmptyHash, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')

  const signature = signRequest({
    secret: VECTOR.secret,
    timestamp: VECTOR.timestamp,
    method: 'GET',
    path: `${VECTOR.path}/11111111-1111-4111-8111-111111111111`,
    idempotencyKey: '',
    body: '',
  })

  // Recompute the documented payload independently rather than trusting the helper.
  const payload = [
    VECTOR.timestamp,
    'GET',
    `${VECTOR.path}/11111111-1111-4111-8111-111111111111`,
    '',
    expectedEmptyHash,
  ].join('\n')
  assert.equal(signature, createHmac('sha256', VECTOR.secret).update(payload, 'utf8').digest('hex'))
})

test('charge vector: POST with a body and an Idempotency-Key on the payment-methods path', () => {
  const hash = createHash('sha256').update(CHARGE_VECTOR.body, 'utf8').digest('hex')
  assert.equal(hash, CHARGE_VECTOR.bodySha256)
  assert.equal(signRequest(CHARGE_VECTOR), CHARGE_VECTOR.signature)
})

test('revoke vector: DELETE signs an empty idempotency key and an empty body', () => {
  const hash = createHash('sha256').update(REVOKE_VECTOR.body, 'utf8').digest('hex')
  assert.equal(hash, REVOKE_VECTOR.bodySha256)
  assert.equal(signRequest(REVOKE_VECTOR), REVOKE_VECTOR.signature)
  // Same recipe as the session vector: only the method and path moved.
  assert.notEqual(REVOKE_VECTOR.signature, signRequest({ ...REVOKE_VECTOR, method: 'GET' }))
})
