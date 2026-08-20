import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'

import { verifyWebhook } from '../dist/esm/index.js'
import { WEBHOOK_VECTOR } from './vector.mjs'

// If these fail, this SDK disagrees with the gateway's signer and merchants are either
// rejecting real deliveries or accepting forged ones. The five cases below are the set
// every Dominaite SDK is required to pin (WEBHOOKS-CONTRACT.md).

const { secret, timestamp, body, header } = WEBHOOK_VECTOR

test('canonical vector: the published header verifies', () => {
  assert.equal(verifyWebhook(body, header, secret, 300, timestamp), true)
})

test('canonical vector: the header is the documented HMAC, recomputed independently', () => {
  const mac = createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(`${timestamp}.${body}`, 'utf8')
    .digest('hex')

  assert.equal(header, `t=${timestamp},v1=${mac}`)
})

test('a single-byte body tamper fails', () => {
  // 8440 -> 8441: one digit, and the delivery is no longer ours.
  const tampered = body.replace('"amount":8440', '"amount":8441')
  assert.notEqual(tampered, body)

  assert.equal(verifyWebhook(tampered, header, secret, 300, timestamp), false)
})

test('a wrong secret fails', () => {
  const other = 'whsec_cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd'
  assert.equal(verifyWebhook(body, header, other, 300, timestamp), false)
})

test('a timestamp outside tolerance fails even with a valid MAC', () => {
  // Same header, same body, same secret - only the clock moved.
  assert.equal(verifyWebhook(body, header, secret, 300, timestamp + 301), false)
  assert.equal(verifyWebhook(body, header, secret, 300, timestamp + 300), true)

  // Future timestamps are rejected too, or a replayer just has to skew your clock one way.
  assert.equal(verifyWebhook(body, header, secret, 300, timestamp - 301), false)
  assert.equal(verifyWebhook(body, header, secret, 300, timestamp - 300), true)
})

test('malformed headers fail without throwing', () => {
  const mac = header.slice(header.indexOf('v1=') + 3)
  const malformed = [
    '',
    'garbage',
    `v1=${mac}`, // missing t=
    `t=${timestamp}`, // missing v1=
    `t=,v1=${mac}`,
    `t=${timestamp},v1=`,
    `t=not-a-number,v1=${mac}`,
    `t=0x${timestamp.toString(16)},v1=${mac}`, // Number() would have taken this one
    `t=${timestamp},v1=${mac.slice(0, 63)}`, // short hex: timingSafeEqual would throw
    `t=${timestamp},v1=${mac}ff`, // long hex
    `t=${timestamp},v1=zz${mac.slice(2)}`, // non-hex
    `t=${timestamp};v1=${mac}`, // wrong separator
    `${timestamp}.${mac}`,
  ]

  for (const value of malformed) {
    assert.equal(verifyWebhook(body, value, secret, 300, timestamp), false, `accepted: ${value}`)
  }
})

test('bad arguments throw TypeError, not a silent false', () => {
  assert.throws(() => verifyWebhook(Buffer.from(body), header, secret, 300, timestamp), TypeError)
  assert.throws(() => verifyWebhook(body, header, '', 300, timestamp), TypeError)
  assert.throws(() => verifyWebhook(body, header, secret, -1, timestamp), TypeError)
  assert.throws(() => verifyWebhook(body, header, secret, 300, Number.NaN), TypeError)
})

test('tolerance defaults to 300 seconds and the clock defaults to now', () => {
  const now = Math.floor(Date.now() / 1000)
  const fresh = signedHeader(now)

  assert.equal(verifyWebhook(body, fresh, secret), true)
  assert.equal(verifyWebhook(body, signedHeader(now - 299), secret), true)
  assert.equal(verifyWebhook(body, signedHeader(now - 400), secret), false)
  // An explicit tolerance widens it back out.
  assert.equal(verifyWebhook(body, signedHeader(now - 400), secret, 600), true)
})

test('unknown header keys are ignored and a rotated second v1 still verifies', () => {
  const mac = header.slice(header.indexOf('v1=') + 3)
  const forged = 'a'.repeat(64)

  assert.equal(verifyWebhook(body, `${header},v0=${forged}`, secret, 300, timestamp), true)
  assert.equal(verifyWebhook(body, `t=${timestamp},v1=${forged},v1=${mac}`, secret, 300, timestamp), true)
  assert.equal(verifyWebhook(body, `t=${timestamp},v1=${forged}`, secret, 300, timestamp), false)
})

function signedHeader(atSeconds) {
  const mac = createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(`${atSeconds}.${body}`, 'utf8')
    .digest('hex')

  return `t=${atSeconds},v1=${mac}`
}
