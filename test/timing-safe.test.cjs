const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { test } = require('node:test')

// Closes audit A8. The rest of the webhook suite passes just as happily against a
// verifier that compares MACs with `===`, so none of it actually pins the constant-time
// property the docs promise. These tests do, by watching the call itself.
//
// They run against the CommonJS build on purpose: it resolves `timingSafeEqual` as a
// property of the shared `node:crypto` module object at call time, so a spy installed
// here is seen. The ESM build compiles from the same source, so a swap to `===` in
// src/webhooks.ts breaks both.
const { verifyWebhook } = require('../dist/cjs/index.js')

/** Runs `body` with crypto.timingSafeEqual swapped out, and always puts it back. */
function withSpy(impl, body) {
  const original = crypto.timingSafeEqual
  const calls = []

  crypto.timingSafeEqual = function spy(a, b) {
    calls.push({ a: Buffer.from(a), b: Buffer.from(b) })
    return impl === null ? original.call(this, a, b) : impl
  }

  try {
    return body(calls)
  } finally {
    crypto.timingSafeEqual = original
  }
}

test('verifyWebhook compares the MAC through crypto.timingSafeEqual', async () => {
  const { WEBHOOK_VECTOR } = await import('./vector.mjs')
  const { secret, timestamp, body, header } = WEBHOOK_VECTOR

  withSpy(null, (calls) => {
    assert.equal(verifyWebhook(body, header, secret, 300, timestamp), true)

    assert.equal(calls.length, 1, 'the MAC comparison must go through timingSafeEqual')
    // Raw digest bytes, not the hex text: 32 bytes each, and equal for the good vector.
    assert.equal(calls[0].a.length, 32)
    assert.equal(calls[0].b.length, 32)
    assert.ok(calls[0].a.equals(calls[0].b))
  })
})

test('the timingSafeEqual verdict is what decides the outcome', async () => {
  const { WEBHOOK_VECTOR } = await import('./vector.mjs')
  const { secret, timestamp, body } = WEBHOOK_VECTOR

  // A MAC that is wrong in every byte. A verifier doing its own `===` would reject it no
  // matter what the spy says; only one that delegates the decision returns true here.
  const forged = `t=${timestamp},v1=${'a'.repeat(64)}`

  withSpy(true, (calls) => {
    assert.equal(
      verifyWebhook(body, forged, secret, 300, timestamp),
      true,
      'the comparison result must come from timingSafeEqual, not a separate equality check',
    )
    assert.equal(calls.length, 1)
  })

  // And the mirror: the real MAC is rejected when the spy says the bytes differ.
  withSpy(false, (calls) => {
    assert.equal(verifyWebhook(body, WEBHOOK_VECTOR.header, secret, 300, timestamp), false)
    assert.equal(calls.length, 1)
  })
})

test('a tampered body still reaches the constant-time comparison', async () => {
  const { WEBHOOK_VECTOR } = await import('./vector.mjs')
  const { secret, timestamp, body, header } = WEBHOOK_VECTOR
  const tampered = body.replace('"amount":8440', '"amount":8441')
  assert.notEqual(tampered, body)

  withSpy(null, (calls) => {
    // Not short-circuited on a length or prefix check before the real compare - that is
    // where the timing leak would live.
    assert.equal(verifyWebhook(tampered, header, secret, 300, timestamp), false)
    assert.equal(calls.length, 1)
    assert.ok(!calls[0].a.equals(calls[0].b))
  })
})
