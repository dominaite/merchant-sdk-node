import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  parseWebhookEvent,
  STORED_PAYMENT_METHOD_RETIRED_REASONS,
  STORED_PAYMENT_METHOD_STATUSES,
  verifyWebhook,
} from '../dist/esm/index.js'
import { WEBHOOK_VECTOR } from './vector.mjs'

// Payloads in the shape the gateway serializes them (RecurringWebhookEventMapper), one line,
// field order as sent. apiVersion rides on every envelope; sequence on agreement and charge data.

const AGREEMENT_EVENT =
  '{"id":"4b0f6c1e-8a2d-4f3b-9c5e-1d2e3f4a5b6c","type":"agreement.past_due","apiVersion":"2026-09-25","createdAt":"2026-09-25T10:00:00Z","data":{"id":"agr_0123456789abcdef0123456789abcdef","planId":"plan_monthly","customerReference":"cust-42","storedPaymentMethodId":"pm_0123456789abcdef0123456789abcdef","status":"past_due","previousStatus":"active","amount":1999,"currency":"EUR","intervalUnit":"month","intervalCount":1,"periodCount":null,"trialDays":0,"nextChargeAt":"2026-10-25T10:00:00Z","activatedAt":"2026-08-25T10:00:00Z","cancelledAt":null,"version":3,"sequence":7}}'

const CHARGE_EVENT =
  '{"id":"9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d","type":"charge.retrying","apiVersion":"2026-09-25","createdAt":"2026-09-25T10:00:00Z","data":{"chargeId":"ch_0123456789abcdef0123456789abcdef","transactionId":"0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0","storedPaymentMethodId":"pm_0123456789abcdef0123456789abcdef","agreementId":"agr_0123456789abcdef0123456789abcdef","customerReference":"cust-42","outcome":"retrying","periodNumber":2,"attemptNumber":1,"amount":1999,"currency":"EUR","paymentMethod":{"brand":"visa","last4":"4242"},"orderReference":null,"description":null,"declineClass":"soft_funds","declineCode":"51","nextAttemptAt":"2026-09-28T10:00:00Z","nextChargeAt":null,"sequence":3}}'

// A payment.succeeded that stored a card, as the gateway serializes it: nulls written out,
// storedPaymentMethod with the same keys as on the status read.
const SAVED_CARD_EVENT =
  '{"id":"5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f","type":"payment.succeeded","apiVersion":"2026-09-25","createdAt":"2026-09-25T10:00:00Z","data":{"transactionId":"0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0","status":"succeeded","previousStatus":"pending","kind":"sale","amount":8440,"grossAmount":8440,"surchargeAmount":null,"currency":"EUR","paymentMethod":"card","walletType":null,"originalTransactionId":null,"idempotencyKey":"order-123","orderReference":"order-123","orderId":"ord_1","description":null,"paymentMethodBrand":"visa","paymentMethodLast4":"4242","storedPaymentMethod":{"id":"pm_0123456789abcdef0123456789abcdef","brand":"visa","last4":"4242","expiryMonth":12,"expiryYear":2030,"status":"active","retiredReason":null}}}'

test('a payment event carries the stored card, the same shape as on the status read', () => {
  const event = parseWebhookEvent(SAVED_CARD_EVENT)
  assert.equal(event.type, 'payment.succeeded')
  assert.deepEqual(event.data.storedPaymentMethod, {
    id: 'pm_0123456789abcdef0123456789abcdef',
    brand: 'visa',
    last4: '4242',
    expiryMonth: 12,
    expiryYear: 2030,
    status: 'active',
    retiredReason: null,
  })
  assert.ok(STORED_PAYMENT_METHOD_STATUSES.includes(event.data.storedPaymentMethod.status))
  // The payment's own method category stays the string it is.
  assert.equal(event.data.paymentMethod, 'card')
})

test('a payment event without a stored card reads null or absent, never a half-built card', () => {
  const nulled = parseWebhookEvent(SAVED_CARD_EVENT.replace(/"storedPaymentMethod":\{[^}]*\}/, '"storedPaymentMethod":null'))
  assert.equal(nulled.data.storedPaymentMethod, null)

  const absent = parseWebhookEvent(SAVED_CARD_EVENT.replace(/,"storedPaymentMethod":\{[^}]*\}/, ''))
  assert.equal('storedPaymentMethod' in absent.data, false)
  assert.equal(absent.data.storedPaymentMethod ?? null, null)
  assert.equal(absent.data.amount, 8440)
})

test('a retired stored card on a payment event carries its retiredReason', () => {
  const event = parseWebhookEvent(
    SAVED_CARD_EVENT.replace('"status":"active","retiredReason":null', '"status":"retired","retiredReason":"hard_decline"'),
  )
  assert.equal(event.data.storedPaymentMethod.status, 'retired')
  assert.equal(event.data.storedPaymentMethod.retiredReason, 'hard_decline')
  assert.ok(STORED_PAYMENT_METHOD_RETIRED_REASONS.includes(event.data.storedPaymentMethod.retiredReason))
})

test('an envelope carries apiVersion through', () => {
  const event = parseWebhookEvent(CHARGE_EVENT)
  assert.equal(event.apiVersion, '2026-09-25')
  assert.equal(event.id, '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d')
})

test('an agreement event parses with sequence and createdAt', () => {
  const event = parseWebhookEvent(AGREEMENT_EVENT)
  assert.equal(event.type, 'agreement.past_due')
  assert.equal(event.createdAt, '2026-09-25T10:00:00Z')
  assert.equal(event.data.id, 'agr_0123456789abcdef0123456789abcdef')
  assert.equal(event.data.sequence, 7)
  assert.equal(event.data.previousStatus, 'active')
})

test('a charge event parses with sequence, createdAt and its ordering object', () => {
  const event = parseWebhookEvent(CHARGE_EVENT)
  assert.equal(event.type, 'charge.retrying')
  assert.equal(event.createdAt, '2026-09-25T10:00:00Z')
  assert.equal(event.data.sequence, 3)
  assert.equal(event.data.agreementId, 'agr_0123456789abcdef0123456789abcdef')
  assert.equal(event.data.periodNumber, 2)
})

test('a sequence of 0 is kept as 0, not dropped or defaulted', () => {
  const event = parseWebhookEvent(CHARGE_EVENT.replace('"sequence":3', '"sequence":0'))
  assert.equal(event.data.sequence, 0)
})

test('an old payment payload without apiVersion still parses: the canonical vector body', () => {
  // Verify first, parse second, on the exact cross-SDK bytes.
  const { secret, timestamp, body, header } = WEBHOOK_VECTOR
  assert.equal(verifyWebhook(body, header, secret, 300, timestamp), true)

  const event = parseWebhookEvent(body)
  assert.equal(event.type, 'payment.succeeded')
  assert.equal(event.apiVersion, undefined)
  assert.equal(event.data.amount, 8440)
})

test('old agreement and charge payloads without apiVersion or sequence still parse', () => {
  const agreement = parseWebhookEvent(
    AGREEMENT_EVENT.replace('"apiVersion":"2026-09-25",', '').replace(',"sequence":7', ''),
  )
  assert.equal(agreement.apiVersion, undefined)
  assert.equal(agreement.data.sequence, undefined)
  assert.equal(agreement.data.status, 'past_due')

  const charge = parseWebhookEvent(
    CHARGE_EVENT.replace('"apiVersion":"2026-09-25",', '').replace(',"sequence":3', ''),
  )
  assert.equal(charge.apiVersion, undefined)
  assert.equal(charge.data.sequence, undefined)
  assert.equal(charge.data.chargeId, 'ch_0123456789abcdef0123456789abcdef')
})

test('fields a newer gateway adds come through untouched', () => {
  const event = parseWebhookEvent(AGREEMENT_EVENT.replace('"sequence":7', '"sequence":7,"futureField":"x"'))
  assert.equal(event.data.futureField, 'x')
})

test('a body that is not an envelope throws', () => {
  assert.throws(() => parseWebhookEvent('not json'), SyntaxError)
  assert.throws(() => parseWebhookEvent('[]'), TypeError)
  assert.throws(() => parseWebhookEvent('{"id":"x","type":"payment.succeeded","createdAt":"t"}'), TypeError)
  assert.throws(
    () => parseWebhookEvent('{"id":"x","type":"payment.succeeded","createdAt":"t","data":{},"apiVersion":20260925}'),
    TypeError,
  )
  assert.throws(() => parseWebhookEvent(Buffer.from(CHARGE_EVENT)), TypeError)
})
