import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  AUTHORIZATION_ERROR_CODES,
  SESSION_REFUSAL_ERROR_CODES,
  STOREFRONT_ERROR_CODES,
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

const DECLARATIONS = readFileSync(
  fileURLToPath(new URL('../dist/types/types.d.ts', import.meta.url)),
  'utf8',
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

test('the authorization codes are exactly the gateway authorization group, in order, 403 and none retryable', () => {
  assert.deepEqual(
    [...AUTHORIZATION_ERROR_CODES],
    WIRE.errorCodes.authorization.map((entry) => entry.code),
  )
  assert.deepEqual(
    WIRE.errorCodes.authorization.map(({ code, httpStatus, retry }) => [code, httpStatus, retry]),
    [['INSUFFICIENT_SCOPE', 403, false]],
  )
})

test('the wallet types are exactly the gateway contract, in order', () => {
  assert.deepEqual([...WALLET_TYPES], WIRE.wallets.walletTypes)
})

test('the status response carries every wallet reporting field, optional and nullable', () => {
  const start = DECLARATIONS.indexOf('export interface CheckoutStatus {')
  const body = DECLARATIONS.slice(start, DECLARATIONS.indexOf('\n}', start))
  assert.deepEqual(
    WIRE.wallets.reportingFields.map(({ path, type, required }) => [path, type, required]),
    [
      ['paymentMethod', 'string', false],
      ['walletType', 'string', false],
    ],
  )
  for (const { path } of WIRE.wallets.reportingFields) {
    assert.match(body, new RegExp(`^ {4}${path}\\?: .*\\| null;$`, 'm'), `CheckoutStatus.${path}`)
  }
})

test('the agreement and charge webhook event types are exactly the recurring events the gateway publishes', () => {
  const eventTypes = (name) => {
    const line = DECLARATIONS.match(new RegExp(`^export type ${name} = WebhookEvent<([^>]*), \\w+>;$`, 'm'))
    assert.ok(line, name)
    return [...line[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
  }
  assert.deepEqual(
    sorted([...eventTypes('AgreementWebhookEvent'), ...eventTypes('ChargeWebhookEvent')]),
    sorted(WIRE.recurringWebhookEvents),
  )
})

test('the contract still lists this SDK', () => {
  assert.ok(WIRE.sdks.includes('node'))
})
