import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  SESSION_REFUSAL_ERROR_CODES,
  TRANSACTION_STATUSES,
  VALIDATION_ERROR_CODES,
  WALLET_TYPES,
} from '../dist/esm/index.js'

// merchant-api-wire-contract.json is the machine-relevant projection of the gateway's
// GET /merchant-api/integration/contract, refreshed by .github/workflows/contract-drift.yml.
// These tests pin the enumerations this SDK hardcodes against it. When one fails the
// gateway moved: fix the SDK and release, never the fixture.

const WIRE = JSON.parse(
  readFileSync(fileURLToPath(new URL('./merchant-api-wire-contract.json', import.meta.url)), 'utf8'),
)

const sorted = (list) => [...list].sort()
const codesWithStatus = (groups, httpStatus) =>
  groups.flat().filter((entry) => entry.httpStatus === httpStatus).map((entry) => entry.code)

test('the status vocabulary is exactly the gateway contract, in order', () => {
  assert.deepEqual([...TRANSACTION_STATUSES], WIRE.statuses)
})

test('the refusal codes are exactly the HTTP 200 error codes the gateway publishes', () => {
  const expected = codesWithStatus([WIRE.errorCodes.transient, WIRE.errorCodes.idempotency], 200)
  assert.deepEqual(sorted(SESSION_REFUSAL_ERROR_CODES), sorted(expected))
})

test('the validation codes are exactly the HTTP 400 idempotency codes', () => {
  const expected = codesWithStatus([WIRE.errorCodes.idempotency], 400)
  assert.deepEqual(sorted(VALIDATION_ERROR_CODES), sorted(expected))
  assert.equal(WIRE.validationHttpStatus, 400)
})

test('the contract still lists this SDK', () => {
  assert.ok(WIRE.sdks.includes('node'))
})

test('the wallet types are exactly the gateway contract, in order', () => {
  assert.deepEqual([...WALLET_TYPES], WIRE.wallets.walletTypes)
})

test('the wallet reporting fields are paymentMethod and walletType, both optional', () => {
  assert.deepEqual(
    WIRE.wallets.reportingFields.map((field) => field.path),
    ['paymentMethod', 'walletType'],
  )
  assert.ok(WIRE.wallets.reportingFields.every((field) => field.required === false))
})
