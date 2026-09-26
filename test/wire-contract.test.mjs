import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  SESSION_REFUSAL_ERROR_CODES,
  STOREFRONT_ERROR_CODES,
  TRANSACTION_STATUSES,
  VALIDATION_ERROR_CODES,
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

test('the storefront codes are exactly the gateway storefront group, in order, none retryable', () => {
  assert.deepEqual(
    [...STOREFRONT_ERROR_CODES],
    WIRE.errorCodes.storefront.map((entry) => entry.code),
  )
  assert.deepEqual(
    WIRE.errorCodes.storefront.map(({ code, httpStatus, retry }) => [code, httpStatus, retry]),
    [
      ['STOREFRONT_MISMATCH', 400, false],
      ['STOREFRONT_INACTIVE', 409, false],
      ['STOREFRONT_NOT_WHITELISTED', 409, false],
    ],
  )
})

test('the contract still lists this SDK', () => {
  assert.ok(WIRE.sdks.includes('node'))
})
