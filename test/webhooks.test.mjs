import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'

import { verifyWebhook } from '../dist/esm/index.js'
import { WEBHOOK_VECTOR } from './vector.mjs'

// If these fail, this SDK disagrees with the gateway's signer and merchants are either
// rejecting real deliveries or accepting forged ones. The canonical vector cases below,
// plus the ten header-grammar vectors, are the set every Dominaite SDK is required to pin
// (WEBHOOKS-CONTRACT.md).

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

test('unknown header keys are ignored, values and repeats included', () => {
  const forged = 'a'.repeat(64)

  assert.equal(verifyWebhook(body, `${header},v0=${forged}`, secret, 300, timestamp), true)
  assert.equal(verifyWebhook(body, `v0=${forged},${header}`, secret, 300, timestamp), true)
  assert.equal(verifyWebhook(body, `${header},v2=x,v2=y`, secret, 300, timestamp), true)
  assert.equal(verifyWebhook(body, `t=${timestamp},v1=${forged}`, secret, 300, timestamp), false)
})

// The ten header-grammar vectors from WEBHOOKS-CONTRACT.md, pinned verbatim by every
// Dominaite SDK. Nine reject, one verifies. These close audit A7: this parser used to
// tolerate repeats and junk elements, so `t=,v1=garbage,v1=<valid mac>` - one appended
// element in front of a captured header - verified.
test('contract header-grammar vectors: the nine malformed shapes reject', () => {
  const mac = header.slice(header.indexOf('v1=') + 3)

  const vectors = [
    [1, `t=${timestamp}`, 'missing v1'],
    [2, `v1=${mac}`, 'missing t'],
    [3, `t=${timestamp},v1=${mac.toUpperCase()}`, 'uppercase hex'],
    [4, `t=${timestamp},v1=${mac},v1=${mac}`, 'repeated v1'],
    [5, `t=${timestamp},t=${timestamp},v1=${mac}`, 'repeated t'],
    [6, `t=,v1=garbage,v1=${mac}`, 'empty t plus repeated v1'],
    [7, `t=${timestamp}, v1=${mac}`, 'whitespace after the comma'],
    [8, `t=+${timestamp},v1=${mac}`, 'non-digit in t'],
    [9, 'garbage', 'element without ='],
  ]

  for (const [number, value, why] of vectors) {
    assert.equal(
      verifyWebhook(body, value, secret, 300, timestamp),
      false,
      `vector ${number} (${why}) was accepted: ${value}`,
    )
  }
})

test('A7 regression: a captured valid pair with junk appended no longer verifies', () => {
  const mac = header.slice(header.indexOf('v1=') + 3)

  // Both of these verified before the grammar landed. They are the shapes an attacker can
  // actually build on Node: the contract's own `t=,v1=garbage,v1=<mac>` vector already
  // failed here for an unrelated reason (the empty `t` never passed the digit check), so
  // it does not on its own prove the leniency is gone.
  assert.equal(verifyWebhook(body, `t=${timestamp},v1=garbage,v1=${mac}`, secret, 300, timestamp), false)
  assert.equal(verifyWebhook(body, `t=${timestamp},garbage,v1=${mac}`, secret, 300, timestamp), false)
})

test('contract header-grammar vector 10: an unknown key rides along and the header verifies', () => {
  const mac = header.slice(header.indexOf('v1=') + 3)

  assert.equal(
    verifyWebhook(body, `t=${timestamp},v1=${mac},v9=deadbeef`, secret, 300, timestamp),
    true,
  )
})

test('the raw t substring is what gets signed, never a reparsed number', () => {
  const mac = header.slice(header.indexOf('v1=') + 3)

  // Number('01755700000') and Number('1755700000') are the same value, so a verifier that
  // signs the parsed number accepts both. Only the byte-exact digits are ours.
  assert.equal(verifyWebhook(body, `t=0${timestamp},v1=${mac}`, secret, 300, timestamp), false)

  // And the padded form is signable in its own right - it is the substring that counts.
  const padded = `0${timestamp}`
  const paddedMac = createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(`${padded}.${body}`, 'utf8')
    .digest('hex')

  assert.equal(verifyWebhook(body, `t=${padded},v1=${paddedMac}`, secret, 300, timestamp), true)
})

function signedHeader(atSeconds) {
  const mac = createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(`${atSeconds}.${body}`, 'utf8')
    .digest('hex')

  return `t=${atSeconds},v1=${mac}`
}
