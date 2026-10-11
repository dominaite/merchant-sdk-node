import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DominaiteClient, parseWebhookEvent } from '../dist/esm/index.js'
import { VECTOR } from './vector.mjs'

const KEY_ID = 'dmk_0123456789abcdef0123456789abcdef'
const BASE_URL = 'https://dev.example.test/payments'
const TRANSACTION_ID = '11111111-1111-4111-8111-111111111111'
const PM_ID = 'pm_0123456789abcdef0123456789abcdef'

function clientAnswering(data, status = 200) {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ success: true, data }), { status, headers: { 'Content-Type': 'application/json' } })
  return new DominaiteClient({ keyId: KEY_ID, secret: VECTOR.secret, baseUrl: BASE_URL, fetch: fetchImpl })
}

test('values this SDK version does not know never throw and come back exactly as the API sent them', async () => {
  // Every status, reason, class, type and unit below is one no gateway sends today, plus a field
  // no gateway sends today. The SDK must hand all of them over untouched.
  const status = {
    transactionId: TRANSACTION_ID,
    status: 'on_hold',
    amount: 2500,
    currency: 'EUR',
    paymentMethod: 'crypto',
    walletType: 'future_pay',
    declineClass: 'soft_future',
    isRecurring: true,
    agreement: { id: 'agr_0123456789abcdef0123456789abcdef', status: 'paused', futureField: 1 },
    storedPaymentMethod: { id: PM_ID, status: 'frozen', retiredReason: 'future_reason' },
    sequence: 1,
    futureField: { nested: true },
  }
  const read = await clientAnswering(status).getStatus(TRANSACTION_ID)
  assert.equal(read.status, 'on_hold')
  assert.equal(read.paymentMethod, 'crypto')
  assert.equal(read.walletType, 'future_pay')
  assert.equal(read.declineClass, 'soft_future')
  assert.deepEqual(read.agreement, status.agreement)
  assert.equal(read.storedPaymentMethod.status, 'frozen')
  assert.equal(read.storedPaymentMethod.retiredReason, 'future_reason')
  assert.deepEqual(read.futureField, { nested: true })

  const charge = await clientAnswering({
    chargeId: 'ch_1',
    transactionId: TRANSACTION_ID,
    status: 'held',
    declineClass: 'soft_future',
    sequence: 2,
    futureField: 'x',
  }).chargePaymentMethod(PM_ID, { amount: 100, currency: 'EUR', orderReference: 'o-1', idempotencyKey: 'k-1' })
  assert.equal(charge.status, 'held')
  assert.equal(charge.declineClass, 'soft_future')
  assert.equal(charge.futureField, 'x')

  const refund = await clientAnswering({
    refundId: 're_1',
    transactionId: TRANSACTION_ID,
    status: 'reversed',
    currency: 'EUR',
    failureCode: 'FUTURE_FAILURE',
  }).getRefund(TRANSACTION_ID, 're_1')
  assert.equal(refund.status, 'reversed')
  assert.equal(refund.failureCode, 'FUTURE_FAILURE')

  const [plan] = await clientAnswering([
    { id: 'plan_1', status: 'paused', intervalUnit: 'fortnight', futureField: true },
  ]).listPlans()
  assert.equal(plan.status, 'paused')
  assert.equal(plan.intervalUnit, 'fortnight')
  assert.equal(plan.futureField, true)

  const agreement = await clientAnswering({
    id: 'agr_1',
    status: 'paused',
    pastDueReason: 'future_reason',
    intervalUnit: 'fortnight',
  }).getAgreement('agr_1')
  assert.equal(agreement.status, 'paused')
  assert.equal(agreement.pastDueReason, 'future_reason')

  const page = await clientAnswering({
    items: [{ transactionId: TRANSACTION_ID, type: 'payout', status: 'on_hold', futureField: 1 }],
    nextCursor: null,
  }).listTransactions({ from: '2026-10-01', to: '2026-10-02' })
  assert.equal(page.items[0].type, 'payout')
  assert.equal(page.items[0].status, 'on_hold')
  assert.equal(page.items[0].futureField, 1)

  const [endpoint] = await clientAnswering([
    { id: '7d3c2b1a-0f9e-4d8c-b7a6-543210fedcba', status: 'suspended', events: ['future.event'] },
  ]).listWebhookEndpoints()
  assert.equal(endpoint.status, 'suspended')
  assert.deepEqual(endpoint.events, ['future.event'])

  const event = parseWebhookEvent(
    JSON.stringify({ id: 'evt_1', type: 'payout.future', createdAt: '2026-10-11T10:00:00Z', data: { anything: 1 } }),
  )
  assert.equal(event.type, 'payout.future')
  assert.deepEqual(event.data, { anything: 1 })
})
