import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DominaiteClient, PRODUCTION_BASE_URL, SANDBOX_BASE_URL } from '../dist/esm/index.js'
import { VECTOR } from './vector.mjs'

// From 0.6.0 there is no default base URL. A missing value (an unset environment
// variable) must fail at construction instead of sending the request to production.

const KEY_ID = 'dmk_0123456789abcdef0123456789abcdef'
const REQUIRED =
  'baseUrl is required. Use https://api.staging.dominaite.com/payments for the sandbox ' +
  'or https://api.dominaite.com/payments for production.'

function recordingFetch() {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    return new Response(JSON.stringify({ success: true, data: { ok: true } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return { fetchImpl, calls }
}

test('a missing, empty or whitespace baseUrl fails at construction with the required message', () => {
  const { fetchImpl, calls } = recordingFetch()
  const missing = [{}, { baseUrl: undefined }, { baseUrl: null }, { baseUrl: '' }, { baseUrl: '   ' }, { baseUrl: '\t\n' }, { baseUrl: '/' }, { baseUrl: ' // ' }]

  for (const extra of missing) {
    assert.throws(
      () => new DominaiteClient({ keyId: KEY_ID, secret: VECTOR.secret, fetch: fetchImpl, ...extra }),
      (error) => error instanceof TypeError && error.message === REQUIRED,
      `should require a baseUrl: ${JSON.stringify(extra)}`,
    )
  }
  assert.equal(calls.length, 0)
})

test('the exported constants are the sandbox and production APIs', () => {
  assert.equal(SANDBOX_BASE_URL, 'https://api.staging.dominaite.com/payments')
  assert.equal(PRODUCTION_BASE_URL, 'https://api.dominaite.com/payments')
})

test('each explicit base URL is the one the client calls', async () => {
  for (const baseUrl of [SANDBOX_BASE_URL, PRODUCTION_BASE_URL, `  ${SANDBOX_BASE_URL}/  `]) {
    const { fetchImpl, calls } = recordingFetch()
    const client = new DominaiteClient({ keyId: KEY_ID, secret: VECTOR.secret, baseUrl, fetch: fetchImpl })

    await client.ping()

    assert.ok(calls[0].startsWith(`${baseUrl.trim().replace(/\/+$/, '')}/merchant-api/`), calls[0])
  }
})

test('the https-only check still applies to an explicit base URL', () => {
  assert.throws(
    () => new DominaiteClient({ keyId: KEY_ID, secret: VECTOR.secret, baseUrl: 'http://api.dominaite.com/payments' }),
    /must use https:\/\//,
  )
})
