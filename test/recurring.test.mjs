import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { test } from 'node:test'

import {
  AGREEMENT_STATUSES,
  ApiError,
  DominaiteClient,
  INTERVAL_UNITS,
  PAST_DUE_REASONS,
  PLAN_STATUSES,
  TransportError,
} from '../dist/esm/index.js'
import { VECTOR } from './vector.mjs'

const KEY_ID = 'dmk_0123456789abcdef0123456789abcdef'
const BASE_URL = 'https://dev.example.test/payments'
const PLAN_ID = 'plan_0A1b2C3d4E5f60718293a4b5c6d7e8f9'
const AGREEMENT_ID = 'agr_0123456789abcdef0123456789abcdef'

// A plan in wire form: the gateway leaves null fields out (periodCount, cancelUrl, archivedAt).
const PLAN = {
  id: PLAN_ID,
  name: 'Pro monthly',
  amount: 1999,
  currency: 'EUR',
  intervalUnit: 'month',
  intervalCount: 1,
  trialDays: 0,
  status: 'active',
  createdAt: '2026-10-11T09:00:00Z',
}
const PLAN_RESULT = { ...PLAN, periodCount: null, cancelUrl: null, archivedAt: null }

// A pending agreement in wire form: no card, no consent, no dates yet.
const AGREEMENT = {
  id: AGREEMENT_ID,
  planId: PLAN_ID,
  customerReference: 'customer-42',
  status: 'pending',
  amount: 1999,
  currency: 'EUR',
  intervalUnit: 'month',
  intervalCount: 1,
  trialDays: 0,
  version: 1,
  sequence: 0,
  createdAt: '2026-10-11T09:00:00Z',
}
const AGREEMENT_RESULT = {
  ...AGREEMENT,
  storedPaymentMethodId: null,
  maxAmountPerPeriod: null,
  periodCount: null,
  nextChargeAt: null,
  pastDueReason: null,
  pastDueAt: null,
  consent: null,
  activatedAt: null,
  cancelledAt: null,
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

function failure(code, httpStatus) {
  return { success: false, error: { code, message: `${code} happened`, statusCode: httpStatus } }
}

async function rejects(run) {
  try {
    await run()
  } catch (error) {
    return error
  }
  assert.fail('expected the call to reject')
}

test('the recurring enumerations are the gateway values, in its order', () => {
  assert.deepEqual([...INTERVAL_UNITS], ['day', 'week', 'month', 'year'])
  assert.deepEqual([...PLAN_STATUSES], ['active', 'archived'])
  assert.deepEqual([...AGREEMENT_STATUSES], ['pending', 'active', 'past_due', 'cancelled', 'completed', 'failed'])
  assert.deepEqual(
    [...PAST_DUE_REASONS],
    ['card_expired', 'card_revoked', 'hard_decline', 'dunning_exhausted', 'sca_required', 'unprocessable'],
  )
})

test('createPlan posts every field as given, signs the key it sends, and answers the plan', async () => {
  const { fetchImpl, calls } = recordingFetch({ success: true, data: PLAN }, 201)
  const params = {
    name: 'Pro monthly',
    amount: 1999,
    currency: 'EUR',
    intervalUnit: 'month',
    intervalCount: 1,
    periodCount: 12,
    trialDays: 14,
    cancelUrl: 'https://shop.example/account/cancel',
    futureField: { kept: true },
  }

  const plan = await makeClient(fetchImpl).createPlan({ ...params, idempotencyKey: 'plan-pro-monthly' })

  const { url, init } = calls[0]
  const path = '/merchant-api/plans'
  assert.equal(url, BASE_URL + path)
  assert.equal(init.body, JSON.stringify(params))
  assert.equal(init.headers['Idempotency-Key'], 'plan-pro-monthly')
  assertSigned(init, { method: 'POST', path, idempotencyKey: 'plan-pro-monthly', body: JSON.stringify(params) })
  assert.deepEqual(plan, PLAN_RESULT)
})

test('createPlan and createAgreement refuse a call without an idempotency key before sending', async () => {
  const { fetchImpl, calls } = recordingFetch({ success: true, data: PLAN }, 201)
  const client = makeClient(fetchImpl)

  await assert.rejects(
    () => client.createPlan({ name: 'x', amount: 1, currency: 'EUR', intervalUnit: 'day' }),
    TypeError,
  )
  await assert.rejects(() => client.createAgreement({ planId: PLAN_ID, customerReference: 'c' }), TypeError)
  assert.equal(calls.length, 0)
})

test('listPlans reads the plans path, signing an empty key and an empty body, and keeps the order', async () => {
  const archived = { ...PLAN, id: 'plan_ffffffffffffffffffffffffffffffff', status: 'archived', archivedAt: '2026-10-10T09:00:00Z' }
  const { fetchImpl, calls } = recordingFetch({ success: true, data: [PLAN, archived] })

  const plans = await makeClient(fetchImpl).listPlans()

  const { url, init } = calls[0]
  assert.equal(url, BASE_URL + '/merchant-api/plans')
  assert.equal(init.body, undefined)
  assert.equal(init.headers['Idempotency-Key'], undefined)
  assertSigned(init, { method: 'GET', path: '/merchant-api/plans', idempotencyKey: '', body: '' })
  assert.deepEqual(plans, [PLAN_RESULT, { ...archived, periodCount: null, cancelUrl: null }])
})

test('listPlans resolves an account without plans with an empty list', async () => {
  const { fetchImpl } = recordingFetch({ success: true, data: [] })

  assert.deepEqual(await makeClient(fetchImpl).listPlans(), [])
})

test('listPlans rejects a 200 whose data is not a list as an ApiError', async () => {
  const { fetchImpl } = recordingFetch({ success: true, data: PLAN })

  const error = await rejects(() => makeClient(fetchImpl).listPlans())
  assert.ok(error instanceof ApiError)
})

test('getPlan sends the plan id exactly as given, case included', async () => {
  const { fetchImpl, calls } = recordingFetch({ success: true, data: PLAN })

  const plan = await makeClient(fetchImpl).getPlan(PLAN_ID)

  const path = `/merchant-api/plans/${PLAN_ID}`
  assert.equal(calls[0].url, BASE_URL + path)
  assertSigned(calls[0].init, { method: 'GET', path, idempotencyKey: '', body: '' })
  assert.deepEqual(plan, PLAN_RESULT)
})

test('getPlan rejects a plan that is not yours with ApiError PLAN_NOT_FOUND', async () => {
  const body = failure('PLAN_NOT_FOUND', 404)
  const { fetchImpl } = recordingFetch(body, 404)

  const error = await rejects(() => makeClient(fetchImpl).getPlan(PLAN_ID))

  assert.ok(error instanceof ApiError)
  assert.equal(error.httpStatus, 404)
  assert.equal(error.errorCode, 'PLAN_NOT_FOUND')
  assert.deepEqual(error.result, body)
})

test('the plan and agreement methods refuse an id that is not one path segment before sending', async () => {
  const { fetchImpl, calls } = recordingFetch({ success: true, data: PLAN })
  const client = makeClient(fetchImpl)

  for (const bad of ['', 'plan_1/archive', 'plan_1?x=1', 'plan 1', '../agreements', null, undefined]) {
    await assert.rejects(() => client.getPlan(bad), TypeError)
    await assert.rejects(() => client.updatePlan(bad, { name: 'x' }), TypeError)
    await assert.rejects(() => client.deletePlan(bad), TypeError)
    await assert.rejects(() => client.getAgreement(bad), TypeError)
    await assert.rejects(() => client.cancelAgreement(bad), TypeError)
  }
  assert.equal(calls.length, 0)
})

test('updatePlan without a key PATCHes the fields as given and signs an empty key with no header', async () => {
  const renamed = { ...PLAN, name: 'Pro', cancelUrl: 'https://shop.example/cancel' }
  const { fetchImpl, calls } = recordingFetch({ success: true, data: renamed })
  const params = { name: 'Pro', cancelUrl: 'https://shop.example/cancel', futureField: 1 }

  const plan = await makeClient(fetchImpl).updatePlan(PLAN_ID, params)

  const { url, init } = calls[0]
  const path = `/merchant-api/plans/${PLAN_ID}`
  assert.equal(url, BASE_URL + path)
  assert.equal(init.body, JSON.stringify(params))
  assert.equal(init.headers['Idempotency-Key'], undefined)
  assertSigned(init, { method: 'PATCH', path, idempotencyKey: '', body: JSON.stringify(params) })
  assert.deepEqual(plan, { ...renamed, periodCount: null, archivedAt: null })
})

test('updatePlan with a key sends it and signs it', async () => {
  const { fetchImpl, calls } = recordingFetch({ success: true, data: PLAN })

  await makeClient(fetchImpl).updatePlan(PLAN_ID, { trialDays: 0, idempotencyKey: 'plan-trial-off' })

  const { init } = calls[0]
  assert.equal(init.body, '{"trialDays":0}')
  assert.equal(init.headers['Idempotency-Key'], 'plan-trial-off')
  assertSigned(init, {
    method: 'PATCH',
    path: `/merchant-api/plans/${PLAN_ID}`,
    idempotencyKey: 'plan-trial-off',
    body: '{"trialDays":0}',
  })
})

test('deletePlan sends a signed DELETE and resolves on 204', async () => {
  const { fetchImpl, calls } = recordingFetch(null, 204)

  const result = await makeClient(fetchImpl).deletePlan(PLAN_ID)

  const path = `/merchant-api/plans/${PLAN_ID}`
  assert.equal(result, undefined)
  assert.equal(calls[0].url, BASE_URL + path)
  assert.equal(calls[0].init.body, undefined)
  assertSigned(calls[0].init, { method: 'DELETE', path, idempotencyKey: '', body: '' })
})

test('deletePlan rejects a plan that is not yours with ApiError PLAN_NOT_FOUND', async () => {
  const { fetchImpl } = recordingFetch(failure('PLAN_NOT_FOUND', 404), 404)

  const error = await rejects(() => makeClient(fetchImpl).deletePlan(PLAN_ID))
  assert.ok(error instanceof ApiError)
  assert.equal(error.errorCode, 'PLAN_NOT_FOUND')
})

test('a 503 on a plan route is a TransportError: retry with the same key', async () => {
  const { fetchImpl } = recordingFetch(failure('MERCHANT_API_UNAVAILABLE', 503), 503)

  const error = await rejects(() =>
    makeClient(fetchImpl).createPlan({
      name: 'x',
      amount: 1,
      currency: 'EUR',
      intervalUnit: 'day',
      idempotencyKey: 'plan-x',
    }),
  )
  assert.ok(error instanceof TransportError)
})

test('createAgreement posts every field as given, signs the key it sends, and answers the agreement', async () => {
  const consent = { textVersion: 'terms-2026-09', acceptedAt: '2026-10-11T08:59:00Z', ip: '203.0.113.7' }
  const created = {
    ...AGREEMENT,
    storedPaymentMethodId: 'pm_0123456789abcdef0123456789abcdef',
    maxAmountPerPeriod: 4999,
    consent: { ...consent, receivedAt: '2026-10-11T09:00:00Z' },
  }
  const { fetchImpl, calls } = recordingFetch({ success: true, data: created }, 201)
  const params = {
    planId: PLAN_ID,
    customerReference: 'customer-42',
    storedPaymentMethodId: 'pm_0123456789abcdef0123456789abcdef',
    consent,
    maxAmountPerPeriod: 4999,
    futureField: 'kept',
  }

  const agreement = await makeClient(fetchImpl).createAgreement({ ...params, idempotencyKey: 'sub-customer-42' })

  const { url, init } = calls[0]
  const path = '/merchant-api/agreements'
  assert.equal(url, BASE_URL + path)
  assert.equal(init.body, JSON.stringify(params))
  assert.equal(init.headers['Idempotency-Key'], 'sub-customer-42')
  assertSigned(init, { method: 'POST', path, idempotencyKey: 'sub-customer-42', body: JSON.stringify(params) })
  assert.deepEqual(agreement, {
    ...AGREEMENT_RESULT,
    storedPaymentMethodId: 'pm_0123456789abcdef0123456789abcdef',
    maxAmountPerPeriod: 4999,
    consent: { ...consent, receivedAt: '2026-10-11T09:00:00Z', receivedFromIp: null },
  })
})

test('createAgreement rejects a refusal with ApiError keeping the code', async () => {
  const body = failure('AGREEMENT_CONSENT_REQUIRED', 422)
  const { fetchImpl } = recordingFetch(body, 422)

  const error = await rejects(() =>
    makeClient(fetchImpl).createAgreement({
      planId: PLAN_ID,
      customerReference: 'customer-42',
      storedPaymentMethodId: 'pm_0123456789abcdef0123456789abcdef',
      idempotencyKey: 'sub-customer-42',
    }),
  )
  assert.ok(error instanceof ApiError)
  assert.equal(error.httpStatus, 422)
  assert.equal(error.errorCode, 'AGREEMENT_CONSENT_REQUIRED')
  assert.deepEqual(error.result, body)
})

test('getAgreement reads a past_due agreement with why and since when', async () => {
  const pastDue = {
    ...AGREEMENT,
    status: 'past_due',
    storedPaymentMethodId: 'pm_0123456789abcdef0123456789abcdef',
    pastDueReason: 'card_expired',
    pastDueAt: '2026-11-11T09:00:00Z',
    activatedAt: '2026-10-11T09:01:00Z',
    sequence: 3,
  }
  const { fetchImpl, calls } = recordingFetch({ success: true, data: pastDue })

  const agreement = await makeClient(fetchImpl).getAgreement(AGREEMENT_ID)

  const path = `/merchant-api/agreements/${AGREEMENT_ID}`
  assert.equal(calls[0].url, BASE_URL + path)
  assertSigned(calls[0].init, { method: 'GET', path, idempotencyKey: '', body: '' })
  assert.equal(agreement.status, 'past_due')
  assert.equal(agreement.pastDueReason, 'card_expired')
  assert.equal(agreement.pastDueAt, '2026-11-11T09:00:00Z')
  assert.equal(agreement.nextChargeAt, null)
  assert.equal(agreement.sequence, 3)
})

test('cancelAgreement sends a signed DELETE and resolves on 204', async () => {
  const { fetchImpl, calls } = recordingFetch(null, 204)

  assert.equal(await makeClient(fetchImpl).cancelAgreement(AGREEMENT_ID), undefined)

  const path = `/merchant-api/agreements/${AGREEMENT_ID}`
  assert.equal(calls[0].url, BASE_URL + path)
  assertSigned(calls[0].init, { method: 'DELETE', path, idempotencyKey: '', body: '' })
})

test('cancelAgreement rejects an ended agreement with ApiError AGREEMENT_ENDED', async () => {
  const { fetchImpl } = recordingFetch(failure('AGREEMENT_ENDED', 409), 409)

  const error = await rejects(() => makeClient(fetchImpl).cancelAgreement(AGREEMENT_ID))
  assert.ok(error instanceof ApiError)
  assert.equal(error.httpStatus, 409)
  assert.equal(error.errorCode, 'AGREEMENT_ENDED')
})
