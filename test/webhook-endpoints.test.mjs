import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { test } from 'node:test'

import { ApiError, AuthenticationError, DominaiteClient, WEBHOOK_ENDPOINT_STATUSES } from '../dist/esm/index.js'
import { VECTOR } from './vector.mjs'

const KEY_ID = 'dmk_0123456789abcdef0123456789abcdef'
const BASE_URL = 'https://dev.example.test/payments'
const WEBHOOK_ID = '7d3c2b1a-0f9e-4d8c-b7a6-543210fedcba'
const SECRET = `whsec_${'ab'.repeat(32)}`

const ENDPOINT = {
  id: WEBHOOK_ID,
  url: 'https://shop.example/webhooks/dominaite',
  events: ['payment.succeeded', 'agreement.past_due'],
  status: 'active',
  createdAt: '2026-10-11T09:00:00Z',
}

function recordingFetch(body, status = 200) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    if (status === 204) {
      return new Response(null, { status })
    }
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return { fetchImpl, calls }
}

function makeClient(fetchImpl) {
  return new DominaiteClient({ keyId: KEY_ID, secret: VECTOR.secret, baseUrl: BASE_URL, fetch: fetchImpl })
}

/** The signature computed from the documented scheme, independently of signRequest(). */
function expectedSignature({ timestamp, method, path, idempotencyKey, body }) {
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex')
  return createHmac('sha256', Buffer.from(VECTOR.secret, 'utf8'))
    .update([timestamp, method, path, idempotencyKey, bodyHash].join('\n'), 'utf8')
    .digest('hex')
}

function assertSigned(init, { method, path, idempotencyKey, body }) {
  assert.equal(init.method, method)
  assert.equal(
    init.headers['X-Signature'],
    expectedSignature({ timestamp: init.headers['X-Timestamp'], method, path, idempotencyKey, body }),
  )
}

async function rejects(run) {
  try {
    await run()
  } catch (error) {
    return error
  }
  assert.fail('expected the call to reject')
}

test('the webhook endpoint statuses are the gateway values, in its order', () => {
  assert.deepEqual([...WEBHOOK_ENDPOINT_STATUSES], ['active', 'inactive'])
})

test('createWebhookEndpoint posts the fields as given, signs the key it sends, and answers the secret', async () => {
  const { fetchImpl, calls } = recordingFetch({ success: true, data: { ...ENDPOINT, secret: SECRET } }, 201)
  const params = { url: ENDPOINT.url, events: ENDPOINT.events, futureField: true }

  const endpoint = await makeClient(fetchImpl).createWebhookEndpoint({ ...params, idempotencyKey: 'endpoint-main' })

  const { url, init } = calls[0]
  const path = '/merchant-api/webhooks'
  assert.equal(url, BASE_URL + path)
  assert.equal(init.body, JSON.stringify(params))
  assert.equal(init.headers['Idempotency-Key'], 'endpoint-main')
  assertSigned(init, { method: 'POST', path, idempotencyKey: 'endpoint-main', body: JSON.stringify(params) })
  assert.deepEqual(endpoint, { ...ENDPOINT, secret: SECRET })
})

test('a replayed createWebhookEndpoint answers the same endpoint with secret null', async () => {
  const { fetchImpl } = recordingFetch({ success: true, data: ENDPOINT }, 201)

  const endpoint = await makeClient(fetchImpl).createWebhookEndpoint({
    url: ENDPOINT.url,
    events: ENDPOINT.events,
    idempotencyKey: 'endpoint-main',
  })

  assert.deepEqual(endpoint, { ...ENDPOINT, secret: null })
})

test('createWebhookEndpoint refuses a call without an idempotency key before sending', async () => {
  const { fetchImpl, calls } = recordingFetch({ success: true, data: ENDPOINT }, 201)

  await assert.rejects(
    () => makeClient(fetchImpl).createWebhookEndpoint({ url: ENDPOINT.url, events: ENDPOINT.events }),
    TypeError,
  )
  assert.equal(calls.length, 0)
})

test('WEBHOOK_ALREADY_REGISTERED is an ApiError whose result names the existing endpoint', async () => {
  const body = {
    success: false,
    error: {
      code: 'WEBHOOK_ALREADY_REGISTERED',
      message: 'This Idempotency-Key already registered an endpoint.',
      statusCode: 409,
      params: { webhookId: WEBHOOK_ID },
    },
  }
  const { fetchImpl } = recordingFetch(body, 409)

  const error = await rejects(() =>
    makeClient(fetchImpl).createWebhookEndpoint({ url: ENDPOINT.url, events: ENDPOINT.events, idempotencyKey: 'old-key' }),
  )

  assert.ok(error instanceof ApiError)
  assert.equal(error.httpStatus, 409)
  assert.equal(error.errorCode, 'WEBHOOK_ALREADY_REGISTERED')
  assert.equal(error.result.error.params.webhookId, WEBHOOK_ID)
})

test('a key without webhooks:manage is refused with AuthenticationError INSUFFICIENT_SCOPE', async () => {
  const body = { success: false, error: { code: 'INSUFFICIENT_SCOPE', message: 'This route needs the webhooks:manage scope.', statusCode: 403 } }
  const { fetchImpl } = recordingFetch(body, 403)

  const error = await rejects(() => makeClient(fetchImpl).listWebhookEndpoints())

  assert.ok(error instanceof AuthenticationError)
  assert.equal(error.httpStatus, 403)
  assert.equal(error.errorCode, 'INSUFFICIENT_SCOPE')
  assert.match(error.message, /webhooks:manage/)
})

test('listWebhookEndpoints reads the webhooks path, signing an empty key and an empty body', async () => {
  const older = { ...ENDPOINT, id: '00000000-0000-4000-8000-000000000001', status: 'inactive', events: ['payment.failed'] }
  const { fetchImpl, calls } = recordingFetch({ success: true, data: [ENDPOINT, older] })

  const endpoints = await makeClient(fetchImpl).listWebhookEndpoints()

  const { url, init } = calls[0]
  assert.equal(url, BASE_URL + '/merchant-api/webhooks')
  assert.equal(init.body, undefined)
  assert.equal(init.headers['Idempotency-Key'], undefined)
  assertSigned(init, { method: 'GET', path: '/merchant-api/webhooks', idempotencyKey: '', body: '' })
  assert.deepEqual(endpoints, [ENDPOINT, older])
  assert.equal('secret' in endpoints[0], false)
})

test('deleteWebhookEndpoint signs the id in lowercase and resolves on 204', async () => {
  const { fetchImpl, calls } = recordingFetch(null, 204)

  assert.equal(await makeClient(fetchImpl).deleteWebhookEndpoint(WEBHOOK_ID.toUpperCase()), undefined)

  const path = `/merchant-api/webhooks/${WEBHOOK_ID}`
  assert.equal(calls[0].url, BASE_URL + path)
  assert.equal(calls[0].init.body, undefined)
  assertSigned(calls[0].init, { method: 'DELETE', path, idempotencyKey: '', body: '' })
})

test('deleteWebhookEndpoint rejects a deleted or unknown id with ApiError WEBHOOK_NOT_FOUND', async () => {
  const body = { success: false, error: { code: 'WEBHOOK_NOT_FOUND', message: 'No webhook endpoint with this id.', statusCode: 404 } }
  const { fetchImpl } = recordingFetch(body, 404)

  const error = await rejects(() => makeClient(fetchImpl).deleteWebhookEndpoint(WEBHOOK_ID))

  assert.ok(error instanceof ApiError)
  assert.equal(error.httpStatus, 404)
  assert.equal(error.errorCode, 'WEBHOOK_NOT_FOUND')
})

test('deleteWebhookEndpoint refuses an id that is not a UUID before sending', async () => {
  const { fetchImpl, calls } = recordingFetch(null, 204)

  for (const bad of ['', 'whk_1', `${WEBHOOK_ID}/x`, null, undefined]) {
    await assert.rejects(() => makeClient(fetchImpl).deleteWebhookEndpoint(bad), TypeError)
  }
  assert.equal(calls.length, 0)
})
