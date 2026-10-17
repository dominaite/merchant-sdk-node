import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  AUTH_ERROR_CODES,
  AUTHORIZATION_ERROR_CODES,
  CHARGE_ERROR_CODES,
  ErrorCodes,
  FIELD_ERROR_CODES,
  RECURRING_ERROR_CODES,
  REFUND_ERROR_CODES,
  REFUND_FAILURE_CODES,
  REVOKE_ERROR_CODES,
  SESSION_REFUSAL_ERROR_CODES,
  STOREFRONT_ERROR_CODES,
  SUBSCRIPTION_REFUSAL_ERROR_CODES,
  VALIDATION_ERROR_CODES,
  WEBHOOK_ERROR_CODES,
} from '../dist/esm/index.js'

// The code vocabulary, pinned to the errorCodes the gateway publishes in its contract (the
// vendored wire fixture). The fixture carries the auth, authorization, idempotency,
// storefront, transient and validation groups; the route groups below it are not in the
// contract projection yet, so they are pinned to ErrorCodes only.

const WIRE = JSON.parse(
  readFileSync(fileURLToPath(new URL('./merchant-api-wire-contract.json', import.meta.url)), 'utf8'),
)

const LISTS = {
  AUTH_ERROR_CODES,
  AUTHORIZATION_ERROR_CODES,
  CHARGE_ERROR_CODES,
  FIELD_ERROR_CODES,
  RECURRING_ERROR_CODES,
  REFUND_ERROR_CODES,
  REFUND_FAILURE_CODES,
  REVOKE_ERROR_CODES,
  SESSION_REFUSAL_ERROR_CODES,
  STOREFRONT_ERROR_CODES,
  SUBSCRIPTION_REFUSAL_ERROR_CODES,
  VALIDATION_ERROR_CODES,
  WEBHOOK_ERROR_CODES,
}

test('every code the gateway publishes has an ErrorCodes constant', () => {
  for (const [group, entries] of Object.entries(WIRE.errorCodes)) {
    for (const { code } of entries) {
      assert.equal(ErrorCodes[code], code, `${group}: ${code}`)
    }
  }
})

test('the auth codes are exactly the gateway auth group, in order, all 401', () => {
  assert.deepEqual([...AUTH_ERROR_CODES], WIRE.errorCodes.auth.map((entry) => entry.code))
  assert.ok(WIRE.errorCodes.auth.every((entry) => entry.httpStatus === 401 && entry.retry === false))
})

test('the field codes are exactly the gateway validation group, in order', () => {
  assert.deepEqual([...FIELD_ERROR_CODES], WIRE.errorCodes.validation.map((entry) => entry.code))
})

test('every code in every SDK list has an ErrorCodes constant, and no list repeats a code', () => {
  for (const [name, list] of Object.entries(LISTS)) {
    assert.equal(new Set(list).size, list.length, `${name} repeats a code`)
    for (const code of list) {
      assert.equal(ErrorCodes[code], code, `${name}: ${code}`)
    }
  }
})

test('ErrorCodes maps every name to itself', () => {
  for (const [name, value] of Object.entries(ErrorCodes)) {
    assert.equal(value, name)
  }
})

test('the subscription refusals are refusals of their own, not storefront or replay codes', () => {
  for (const code of SUBSCRIPTION_REFUSAL_ERROR_CODES) {
    assert.equal(SESSION_REFUSAL_ERROR_CODES.includes(code), false, code)
    assert.equal(STOREFRONT_ERROR_CODES.includes(code), false, code)
  }
})

test('the charge codes hold no decline and no 429 limit: those are a result and a RateLimitError', () => {
  for (const code of ['CHARGE_DECLINED', 'CHARGE_VELOCITY_EXCEEDED', 'CHARGE_DECLINE_RATE_EXCEEDED', 'RATE_LIMIT_EXCEEDED']) {
    assert.equal(CHARGE_ERROR_CODES.includes(code), false, code)
  }
  for (const code of ['PAYMENT_METHOD_NOT_FOUND', 'AGREEMENT_NOT_FOUND', 'CHARGE_IN_PROGRESS', 'CHARGE_AMOUNT_ABOVE_CAP']) {
    assert.ok(CHARGE_ERROR_CODES.includes(code), code)
  }
})
