import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { ApiError, DominaiteClient } from '../dist/esm/index.js'
import { VECTOR } from './vector.mjs'

// The warning hook, the Dominaite-Sdk-Notice header and the debug log: what a caller sees,
// and what it must never see.

const KEY_ID = 'dmk_0123456789abcdef0123456789abcdef'
const BASE_URL = 'https://dev.example.test/payments'
const { version: VERSION } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const CASHIER_TOKEN = 'ct_secret_cashier_token_value'
const CHECKOUT = {
  transactionId: '11111111-1111-4111-8111-111111111111',
  orderId: 'ord_1',
  cashierKey: 'ck_1',
  cashierToken: CASHIER_TOKEN,
  amount: 2500,
  currency: 'EUR',
  expiresAt: '2026-08-16T12:00:00Z',
  integration: 'widget',
}
const SESSION_PARAMS = {
  amount: 2500,
  currency: 'EUR',
  orderReference: 'order-1042',
  idempotencyKey: VECTOR.idempotencyKey,
}
const PONG = { success: true, data: { pong: true, merchantId: 'm_1', clockSkewSeconds: 0 } }
const NOTICE = 'deprecated; current="0.7.0"; sunset="2027-01-31"; info="https://docs.example/upgrade"'

/** Replies with each response in turn (the last one repeats), with optional headers. */
function scriptedFetch(responses) {
  const calls = []
  const queue = [...responses]
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const next = queue.length > 1 ? queue.shift() : queue[0]
    if (next.throws) throw new TypeError('fetch failed')
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...(next.headers ?? {}) },
    })
  }
  return { fetchImpl, calls }
}

function makeClient(fetchImpl, extra = {}) {
  return new DominaiteClient({ keyId: KEY_ID, secret: VECTOR.secret, baseUrl: BASE_URL, fetch: fetchImpl, ...extra })
}

test('the same notice warns once per client, with the upgrade message', async () => {
  const warnings = []
  const { fetchImpl } = scriptedFetch([{ body: PONG, headers: { 'Dominaite-Sdk-Notice': NOTICE } }])
  const client = makeClient(fetchImpl, { onWarning: (message) => warnings.push(message) })

  await client.ping()
  await client.ping()
  await client.ping()

  assert.deepEqual(warnings, [
    `dominaite-node ${VERSION} is deprecated; upgrade to 0.7.0 (sunset 2027-01-31). https://docs.example/upgrade`,
  ])
})

test('a second distinct notice warns again; optional parts may be absent', async () => {
  const warnings = []
  const { fetchImpl } = scriptedFetch([
    { body: PONG, headers: { 'Dominaite-Sdk-Notice': NOTICE } },
    { body: PONG, headers: { 'Dominaite-Sdk-Notice': 'deprecated; current=0.7.0' } },
    { body: PONG, headers: { 'Dominaite-Sdk-Notice': 'maintenance; window="2026-11-01"' } },
  ])
  const client = makeClient(fetchImpl, { onWarning: (message) => warnings.push(message) })

  await client.ping()
  await client.ping()
  await client.ping()

  assert.equal(warnings.length, 3)
  assert.equal(warnings[1], `dominaite-node ${VERSION} is deprecated; upgrade to 0.7.0.`)
  assert.equal(warnings[2], `dominaite-node ${VERSION}: maintenance; window="2026-11-01"`)
})

test('each client warns on its own', async () => {
  const warnings = []
  const { fetchImpl } = scriptedFetch([{ body: PONG, headers: { 'Dominaite-Sdk-Notice': NOTICE } }])
  const onWarning = (message) => warnings.push(message)

  await makeClient(fetchImpl, { onWarning }).ping()
  await makeClient(fetchImpl, { onWarning }).ping()

  assert.equal(warnings.length, 2)
})

test('a notice on an error response also warns', async () => {
  const warnings = []
  const { fetchImpl } = scriptedFetch([
    {
      status: 400,
      body: { success: false, error: { code: 'VALIDATION_ERROR', message: 'bad' } },
      headers: { 'Dominaite-Sdk-Notice': NOTICE },
    },
  ])
  const client = makeClient(fetchImpl, { onWarning: (message) => warnings.push(message) })

  await assert.rejects(() => client.createCheckoutSession(SESSION_PARAMS), ApiError)

  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /is deprecated; upgrade to 0\.7\.0/)
})

test('no notice header means no warning', async () => {
  const warnings = []
  const { fetchImpl } = scriptedFetch([{ body: PONG }, { body: PONG, headers: { 'Dominaite-Sdk-Notice': '' } }])
  const client = makeClient(fetchImpl, { onWarning: (message) => warnings.push(message) })

  await client.ping()
  await client.ping()

  assert.deepEqual(warnings, [])
})

test('without onWarning the notice goes to process.emitWarning as a DeprecationWarning', async () => {
  const seen = []
  const listener = (warning) => seen.push(warning)
  process.on('warning', listener)
  try {
    const { fetchImpl } = scriptedFetch([{ body: PONG, headers: { 'Dominaite-Sdk-Notice': NOTICE } }])
    await makeClient(fetchImpl).ping()
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    process.off('warning', listener)
  }

  const ours = seen.filter((warning) => warning.code === 'DOMINAITE_SDK')
  assert.equal(ours.length, 1)
  assert.equal(ours[0].name, 'DeprecationWarning')
  assert.match(ours[0].message, /is deprecated; upgrade to 0\.7\.0/)
})

test('a hook that throws does not fail the request', async () => {
  const { fetchImpl } = scriptedFetch([
    { body: PONG, headers: { 'Dominaite-Sdk-Notice': NOTICE, 'Dominaite-Request-Id': 'req_1' } },
  ])
  const client = makeClient(fetchImpl, {
    onWarning: () => {
      throw new Error('broken sink')
    },
    onDebug: () => {
      throw new Error('broken sink')
    },
  })

  const ping = await client.ping()
  assert.equal(ping.merchantId, 'm_1')
})

test('a hook that is not a function is refused at construction', () => {
  for (const extra of [{ onWarning: 'yes' }, { onDebug: true }]) {
    assert.throws(() => makeClient(async () => {}, extra), TypeError)
  }
})

test('the debug log is off by default and never reaches the warning hook', async () => {
  const warnings = []
  const { fetchImpl } = scriptedFetch([{ body: PONG, headers: { 'Dominaite-Request-Id': 'req_1' } }])
  const client = makeClient(fetchImpl, { onWarning: (message) => warnings.push(message) })

  await client.ping()
  await client.createCheckoutSession(SESSION_PARAMS).catch(() => {})

  assert.deepEqual(warnings, [])
})

test('onDebug gets one line per request with method, path, status, time, request id and key', async () => {
  const lines = []
  const { fetchImpl } = scriptedFetch([
    { body: PONG, headers: { 'Dominaite-Request-Id': 'req_ping' } },
    { status: 201, body: { success: true, checkout: CHECKOUT }, headers: { 'Dominaite-Request-Id': 'req_session' } },
    { status: 400, body: { success: false, error: { code: 'VALIDATION_ERROR', message: 'bad' } } },
  ])
  const client = makeClient(fetchImpl, { onDebug: (line) => lines.push(line) })

  await client.ping()
  await client.createCheckoutSession(SESSION_PARAMS)
  await assert.rejects(() => client.createCheckoutSession(SESSION_PARAMS), ApiError)

  assert.equal(lines.length, 3)
  assert.match(lines[0], /^dominaite-node: GET \/merchant-api\/ping 200 \d+ms request_id=req_ping$/)
  assert.match(
    lines[1],
    new RegExp(
      `^dominaite-node: POST /merchant-api/checkout/sessions 201 \\d+ms request_id=req_session idempotency_key=${VECTOR.idempotencyKey}$`,
    ),
  )
  assert.match(lines[2], new RegExp(`^dominaite-node: POST /merchant-api/checkout/sessions 400 \\d+ms idempotency_key=`))
})

test('a transport failure is logged with status error', async () => {
  const lines = []
  const { fetchImpl } = scriptedFetch([{ throws: true }])
  const client = makeClient(fetchImpl, { onDebug: (line) => lines.push(line) })

  await assert.rejects(() => client.ping())

  assert.equal(lines.length, 1)
  assert.match(lines[0], /^dominaite-node: GET \/merchant-api\/ping error \d+ms$/)
})

test('the debug line leaves out the query string', async () => {
  const lines = []
  const { fetchImpl } = scriptedFetch([
    { body: { success: true, data: { items: [], hasMore: false, nextCursor: null } } },
  ])
  const client = makeClient(fetchImpl, { onDebug: (line) => lines.push(line) })

  await client.listTransactions({ from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z' }).catch(() => {})

  assert.equal(lines.length, 1)
  assert.match(lines[0], /^dominaite-node: GET \/merchant-api\/transactions \d+ \d+ms$/)
})

test('a retry in createCheckoutSessionWithRetry warns before each new attempt', async () => {
  const warnings = []
  const { fetchImpl } = scriptedFetch([
    { throws: true },
    { throws: true },
    { status: 201, body: { success: true, checkout: CHECKOUT } },
  ])
  const client = makeClient(fetchImpl, { onWarning: (message) => warnings.push(message) })

  await client.createCheckoutSessionWithRetry(SESSION_PARAMS, { attempts: 3, baseDelayMs: 1 })

  assert.deepEqual(warnings, [
    'dominaite-node: retrying createCheckoutSessionWithRetry after TransportError (attempt 2 of 3)',
    'dominaite-node: retrying createCheckoutSessionWithRetry after TransportError (attempt 3 of 3)',
  ])
})

test('ping warns when the clock skew is above 60 seconds', async () => {
  for (const [skew, expected] of [
    [61, 1],
    [-61, 1],
    [60, 0],
    [0, 0],
  ]) {
    const warnings = []
    const { fetchImpl } = scriptedFetch([{ body: { success: true, data: { pong: true, clockSkewSeconds: skew } } }])
    await makeClient(fetchImpl, { onWarning: (message) => warnings.push(message) }).ping()
    assert.equal(warnings.length, expected, `skew ${skew}`)
    if (expected === 1) {
      assert.equal(
        warnings[0],
        `dominaite-node: clock skew is ${skew} s; requests fail at 300 s. Sync this server's clock.`,
      )
    }
  }
})

test('no warning or debug line carries the secret, the signature, the cashierToken or a body', async () => {
  const captured = []
  const { fetchImpl, calls } = scriptedFetch([
    {
      status: 201,
      body: { success: true, checkout: CHECKOUT },
      headers: { 'Dominaite-Sdk-Notice': NOTICE, 'Dominaite-Request-Id': 'req_1' },
    },
    {
      status: 422,
      body: { success: false, error: { code: 'VALIDATION_ERROR', message: 'body-fragment-from-the-api' } },
      headers: { 'Dominaite-Sdk-Notice': 'deprecated; current="0.8.0"' },
    },
    { body: { success: true, data: { pong: true, clockSkewSeconds: 120 } } },
  ])
  const client = makeClient(fetchImpl, {
    onWarning: (message) => captured.push(message),
    onDebug: (line) => captured.push(line),
  })

  await client.createCheckoutSession(SESSION_PARAMS)
  await assert.rejects(() => client.createCheckoutSession(SESSION_PARAMS))
  await client.ping()

  const signatures = calls.map((call) => call.init.headers['X-Signature'])
  assert.ok(captured.length >= 6)
  for (const line of captured) {
    assert.ok(!line.includes(VECTOR.secret), line)
    for (const signature of signatures) {
      assert.ok(!line.includes(signature), line)
    }
    assert.ok(!line.includes(CASHIER_TOKEN), line)
    assert.ok(!line.includes('body-fragment-from-the-api'), line)
    assert.ok(!line.includes('orderReference'), line)
    assert.ok(!line.includes('order-1042'), line)
  }
})
