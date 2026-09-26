import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  ApiError,
  CHARGE_ERROR_CODES,
  CHARGE_STATUSES,
  ChargeError,
  CheckoutRefusedError,
  DECLINE_CLASSES,
  DominaiteClient,
  REFUND_ERROR_CODES,
  REFUND_FAILURE_CODES,
  REFUND_STATUSES,
  RefundError,
  REVOKE_ERROR_CODES,
  RevokeError,
  SESSION_REFUSAL_ERROR_CODES,
  STORED_PAYMENT_METHOD_RETIRED_REASONS,
  STORED_PAYMENT_METHOD_STATUSES,
  STOREFRONT_ERROR_CODES,
  StorefrontError,
  TRANSACTION_STATUSES,
  TransportError,
  VALIDATION_ERROR_CODES,
} from '../dist/esm/index.js'
import { VECTOR } from './vector.mjs'

// merchant-api-contract.json is the canonical response contract, vendored byte-identical
// into every Dominaite SDK. If these fail, this SDK disagrees with the gateway about what
// the API returns - which is how a status value or a field ships in one language and goes
// missing in another. Fix the SDK, not the fixture: the fixture only moves after the
// matching gateway DTO change lands.

const CONTRACT = JSON.parse(
  readFileSync(fileURLToPath(new URL('./merchant-api-contract.json', import.meta.url)), 'utf8'),
)
const WIRE = JSON.parse(
  readFileSync(fileURLToPath(new URL('./merchant-api-wire-contract.json', import.meta.url)), 'utf8'),
)
const DECLARATIONS = readFileSync(
  fileURLToPath(new URL('../dist/types/types.d.ts', import.meta.url)),
  'utf8',
)

const KEY_ID = 'dmk_0123456789abcdef0123456789abcdef'
const BASE_URL = 'https://dev.example.test/payments'

test('the status vocabulary is exactly the contract, in order', () => {
  assert.deepEqual([...TRANSACTION_STATUSES], CONTRACT.statusVocabulary)
})

test('ping exposes exactly the contract fields', () => {
  assert.deepEqual(declaredFields('Ping'), CONTRACT.endpoints.ping.fields)
})

test('the checkout session exposes exactly the contract fields', () => {
  assert.deepEqual(
    declaredFields('CheckoutSession'),
    CONTRACT.endpoints.createCheckoutSession.checkoutFields,
  )
})

test('the status response exposes exactly the contract fields', () => {
  assert.deepEqual(declaredFields('CheckoutStatus'), CONTRACT.endpoints.getStatus.fields)
})

test('ping() returns the contract example unchanged', async () => {
  const example = CONTRACT.endpoints.ping.example
  const { fetchImpl, calls } = recordingFetch(example)

  const ping = await makeClient(fetchImpl).ping()

  assert.deepEqual(ping, example)
  assert.equal(calls[0].url, BASE_URL + CONTRACT.endpoints.ping.path)
  assert.equal(calls[0].init.method, CONTRACT.endpoints.ping.method)
})

test('createCheckoutSession() returns the checkout out of the contract success example', async () => {
  const example = CONTRACT.endpoints.createCheckoutSession.successExample
  const { fetchImpl, calls } = recordingFetch(example)

  const session = await makeClient(fetchImpl).createCheckoutSession({
    amount: 8440,
    currency: 'EUR',
    orderReference: 'order-1042',
    idempotencyKey: 'checkout-order-1042-8440-EUR',
  })

  assert.deepEqual(session, example.checkout)
  assert.deepEqual(
    Object.keys(session).sort(),
    [...CONTRACT.endpoints.createCheckoutSession.checkoutFields].sort(),
  )
  assert.equal(calls[0].url, BASE_URL + CONTRACT.endpoints.createCheckoutSession.path)
  assert.equal(calls[0].init.method, CONTRACT.endpoints.createCheckoutSession.method)
})

test('the contract refusal example raises CheckoutRefusedError, not a session', async () => {
  const example = CONTRACT.endpoints.createCheckoutSession.refusalExample
  const { fetchImpl } = recordingFetch(example)

  // HTTP 200 with success=false. Branching on the status code would return a broken
  // session object here instead of throwing.
  const error = await rejects(() =>
    makeClient(fetchImpl).createCheckoutSession({
      amount: 8440,
      currency: 'EUR',
      orderReference: 'order-1042',
      idempotencyKey: 'checkout-order-1042-8440-EUR',
    }),
  )

  assert.ok(error instanceof CheckoutRefusedError)
  assert.equal(error.errorCode, example.errorCode)
  assert.equal(error.message, example.errorMessage)
  assert.equal(error.transactionId, example.transactionId)
  // The whole envelope survives, so a caller can reconcile fields we do not model.
  assert.deepEqual(
    Object.keys(error.result).sort(),
    [...CONTRACT.endpoints.createCheckoutSession.fields].sort(),
  )
})

test('the refusal codes are exactly the contract, in order', () => {
  assert.deepEqual([...SESSION_REFUSAL_ERROR_CODES], CONTRACT.sessionRefusalErrorCodes)
})

test('the validation codes are exactly the contract, in order', () => {
  assert.deepEqual([...VALIDATION_ERROR_CODES], CONTRACT.validationErrorCodes)
})

test('every refusal code in the contract is recognised and carried through', async () => {
  for (const code of CONTRACT.sessionRefusalErrorCodes) {
    const { fetchImpl } = recordingFetch({
      ...CONTRACT.endpoints.createCheckoutSession.refusalExample,
      errorCode: code,
    })
    const error = await rejects(() =>
      makeClient(fetchImpl).createCheckoutSession({
        amount: 8440,
        currency: 'EUR',
        orderReference: 'order-1042',
        idempotencyKey: 'checkout-order-1042-8440-EUR',
      }),
    )

    assert.ok(error instanceof CheckoutRefusedError)
    assert.equal(error.errorCode, code)
  }
})

test('a validation code arrives as an ApiError 400 with the code intact', async () => {
  // A different shape from the refusals: HTTP 400, no success=false envelope. Both
  // wire forms the gateway uses must reach the caller as a branchable code, or
  // "which input did I get wrong" is only recoverable by reading English prose.
  for (const code of CONTRACT.validationErrorCodes) {
    const bodies = [
      { errorCode: code, errorMessage: 'Idempotency-Key header is required.' },
      { success: false, error: { code, message: 'Idempotency-Key header is required.' } },
    ]

    for (const body of bodies) {
      const { fetchImpl } = recordingFetch(body, 400)
      const error = await rejects(() =>
        makeClient(fetchImpl).createCheckoutSession({
          amount: 8440,
          currency: 'EUR',
          orderReference: 'order-1042',
          idempotencyKey: 'checkout-order-1042-8440-EUR',
        }),
      )

      assert.ok(error instanceof ApiError, `expected ApiError for ${code}`)
      assert.ok(!(error instanceof CheckoutRefusedError))
      assert.equal(error.httpStatus, 400)
      assert.equal(error.errorCode, code)
    }
  }
})

test('getStatus() returns the contract example unchanged', async () => {
  const example = CONTRACT.endpoints.getStatus.example
  const { fetchImpl, calls } = recordingFetch(example)

  const status = await makeClient(fetchImpl).getStatus(example.transactionId)

  assert.deepEqual(status, example)
  assert.ok(TRANSACTION_STATUSES.includes(status.status))
  assert.equal(
    calls[0].url,
    BASE_URL + CONTRACT.endpoints.getStatus.path.replace('{transactionId}', example.transactionId),
  )
  assert.equal(calls[0].init.method, CONTRACT.endpoints.getStatus.method)
})

test('getStatus() carries every status in the vocabulary through untouched', async () => {
  for (const status of CONTRACT.statusVocabulary) {
    const example = { ...CONTRACT.endpoints.getStatus.example, status }
    const { fetchImpl } = recordingFetch(example)

    const result = await makeClient(fetchImpl).getStatus(example.transactionId)
    assert.equal(result.status, status)
  }
})

test('the stored payment method exposes exactly the contract fields', () => {
  assert.deepEqual(declaredFields('StoredPaymentMethod'), CONTRACT.endpoints.getStatus.storedPaymentMethodFields)
  assert.deepEqual([...STORED_PAYMENT_METHOD_STATUSES], CONTRACT.storedPaymentMethodStatusVocabulary)
  assert.deepEqual(
    [...STORED_PAYMENT_METHOD_RETIRED_REASONS],
    CONTRACT.storedPaymentMethodRetiredReasonVocabulary,
  )
})

test('getStatus() reads the retired-card example as retired with its reason, in both wire forms', async () => {
  const example = CONTRACT.endpoints.getStatus.retiredCardExample
  for (const wire of [example, withoutNulls(example)]) {
    const status = await makeClient(recordingFetch(wire).fetchImpl).getStatus(example.transactionId)

    assert.equal(status.status, 'refunded')
    assert.deepEqual(status.storedPaymentMethod, example.storedPaymentMethod)
    assert.equal(status.storedPaymentMethod.status, 'retired')
    assert.equal(status.storedPaymentMethod.retiredReason, 'source_sale_reversed')
    assert.ok(STORED_PAYMENT_METHOD_RETIRED_REASONS.includes(status.storedPaymentMethod.retiredReason))
  }
})

test('the storefront codes are exactly the contract, in order, and none is a session refusal', () => {
  assert.deepEqual([...STOREFRONT_ERROR_CODES], CONTRACT.storefrontErrorCodes)
  for (const code of CONTRACT.storefrontErrorCodes) {
    assert.equal(SESSION_REFUSAL_ERROR_CODES.includes(code), false, code)
  }
})

test('every storefront code comes back as a StorefrontError with its contract status and is never retried', async () => {
  for (const { code, httpStatus, retry } of WIRE.errorCodes.storefront) {
    assert.equal(retry, false, code)
    const { fetchImpl, calls } = recordingFetch(
      { success: false, error: { code, message: 'refused' } },
      httpStatus,
    )
    const error = await rejects(() =>
      makeClient(fetchImpl).createCheckoutSessionWithRetry(
        {
          amount: 8440,
          currency: 'EUR',
          orderReference: 'order-1042',
          idempotencyKey: 'checkout-order-1042-8440-EUR',
        },
        { attempts: 3, baseDelayMs: 1 },
      ),
    )

    assert.ok(error instanceof StorefrontError, `${code} must be a StorefrontError`)
    assert.ok(!(error instanceof CheckoutRefusedError), `${code} is not a refusal`)
    assert.equal(error.httpStatus, httpStatus, code)
    assert.equal(error.errorCode, code)
    assert.equal(calls.length, 1, `${code} must not be retried`)
  }
})

test('the charge exposes exactly the contract fields and vocabularies', () => {
  assert.deepEqual(declaredFields('PaymentMethodCharge'), CONTRACT.endpoints.chargePaymentMethod.fields)
  assert.deepEqual([...CHARGE_STATUSES], CONTRACT.chargeStatusVocabulary)
  assert.deepEqual([...DECLINE_CLASSES], CONTRACT.declineClassVocabulary)
  assert.deepEqual([...CHARGE_ERROR_CODES], CONTRACT.chargeErrorCodes)
  assert.deepEqual([...REVOKE_ERROR_CODES], CONTRACT.revokeErrorCodes)
})

test('getStatus() returns the saved-card example unchanged, stored payment method included', async () => {
  const example = CONTRACT.endpoints.getStatus.savedCardExample
  const { fetchImpl } = recordingFetch(example)

  const status = await makeClient(fetchImpl).getStatus(example.transactionId)

  assert.deepEqual(status, example)
  assert.deepEqual(status.storedPaymentMethod, example.storedPaymentMethod)
  assert.ok(STORED_PAYMENT_METHOD_STATUSES.includes(status.storedPaymentMethod.status))
})

test('getStatus() reads an absent storedPaymentMethod as no card and absent card fields as null, like the wire', async () => {
  // The gateway serializes WhenWritingNull: a session without a saved card has no
  // storedPaymentMethod key at all, and an unreported brand is a missing key, not null.
  const { getStatus } = CONTRACT.endpoints
  const wire = withoutNulls(getStatus.example)
  assert.equal('storedPaymentMethod' in wire, false)
  const bare = await makeClient(recordingFetch(wire).fetchImpl).getStatus(getStatus.example.transactionId)
  // The status passes through as sent; absent and null both read as "no card on file".
  assert.deepEqual(bare, wire)
  assert.equal(bare.storedPaymentMethod ?? null, null)

  const unreported = {
    ...getStatus.savedCardExample,
    storedPaymentMethod: { id: getStatus.savedCardExample.storedPaymentMethod.id, status: 'active' },
  }
  const status = await makeClient(recordingFetch(unreported).fetchImpl).getStatus(unreported.transactionId)
  assert.deepEqual(status.storedPaymentMethod, {
    id: unreported.storedPaymentMethod.id,
    brand: null,
    last4: null,
    expiryMonth: null,
    expiryYear: null,
    status: 'active',
    retiredReason: null,
  })
})

test('chargePaymentMethod() returns the 201 charge out of the contract envelope', async () => {
  const { chargePaymentMethod, getStatus } = CONTRACT.endpoints
  const paymentMethodId = getStatus.savedCardExample.storedPaymentMethod.id
  const example = chargePaymentMethod.successExample
  const { fetchImpl, calls } = recordingFetch(example, chargePaymentMethod.httpStatus)

  const charge = await makeClient(fetchImpl).chargePaymentMethod(paymentMethodId, {
    amount: 8440,
    currency: 'EUR',
    orderReference: 'order-1042',
    idempotencyKey: 'checkout-order-1042-8440-EUR',
  })

  assert.deepEqual(charge, example.data)
  assert.ok(CHARGE_STATUSES.includes(charge.status))
  assert.equal(charge.declineClass, null)
  assert.equal(
    calls[0].url,
    BASE_URL + chargePaymentMethod.path.replace('{paymentMethodId}', paymentMethodId),
  )
  assert.equal(calls[0].init.method, chargePaymentMethod.method)
  assert.ok(typeof calls[0].init.headers['Idempotency-Key'] === 'string')
})

test('chargePaymentMethod() returns the 402 decline as a charge with its decline class, never throws', async () => {
  const { chargePaymentMethod, getStatus } = CONTRACT.endpoints
  const paymentMethodId = getStatus.savedCardExample.storedPaymentMethod.id
  const example = chargePaymentMethod.declinedExample
  const { fetchImpl } = recordingFetch(example, chargePaymentMethod.declinedHttpStatus)

  const charge = await makeClient(fetchImpl).chargePaymentMethod(paymentMethodId, {
    amount: 8440,
    currency: 'EUR',
    orderReference: 'order-1042',
    idempotencyKey: 'checkout-order-1042-8440-EUR',
  })

  assert.deepEqual(charge, example.data)
  assert.equal(charge.status, 'failed')
  assert.ok(DECLINE_CLASSES.includes(charge.declineClass))
  assert.equal(example.error.code, 'CHARGE_DECLINED')
  assert.equal(CHARGE_ERROR_CODES.includes('CHARGE_DECLINED'), false)
})

test('chargePaymentMethod() reads an absent declineClass and declineCode as null, like the wire', async () => {
  const { chargePaymentMethod, getStatus } = CONTRACT.endpoints
  const paymentMethodId = getStatus.savedCardExample.storedPaymentMethod.id
  const { fetchImpl } = recordingFetch(withoutNulls(chargePaymentMethod.successExample), chargePaymentMethod.httpStatus)

  const charge = await makeClient(fetchImpl).chargePaymentMethod(paymentMethodId, {
    amount: 8440,
    currency: 'EUR',
    orderReference: 'order-1042',
    idempotencyKey: 'checkout-order-1042-8440-EUR',
  })

  assert.deepEqual(charge, chargePaymentMethod.successExample.data)
})

test('every charge error example in the contract is a ChargeError with code, status and data intact', async () => {
  const { chargePaymentMethod, getStatus } = CONTRACT.endpoints
  const paymentMethodId = getStatus.savedCardExample.storedPaymentMethod.id
  const seen = new Set()

  for (const example of chargePaymentMethod.errorExamples) {
    // Both wire forms: nulls spelled out (the fixture) and nulls omitted (the gateway).
    for (const body of [example.body, withoutNulls(example.body)]) {
      const { fetchImpl } = recordingFetch(body, example.httpStatus)
      const error = await rejects(() =>
        makeClient(fetchImpl).chargePaymentMethod(paymentMethodId, {
          amount: 8440,
          currency: 'EUR',
          orderReference: 'order-1042',
          idempotencyKey: 'checkout-order-1042-8440-EUR',
        }),
      )

      assert.ok(error instanceof ChargeError, `${example.code} must be a ChargeError, got ${error?.constructor?.name}`)
      assert.ok(!(error instanceof TransportError))
      assert.equal(error.httpStatus, example.httpStatus)
      assert.equal(error.errorCode, example.code)
      assert.equal(error.message, example.body.error.message)
      assert.ok(CHARGE_ERROR_CODES.includes(error.errorCode))
      assert.deepEqual(error.result, body)
      if (example.body.data) {
        assert.deepEqual(error.charge, example.body.data)
        assert.equal(error.transactionId, example.body.data.transactionId)
      } else {
        assert.equal(error.charge, undefined)
        assert.equal(error.transactionId, undefined)
      }
    }
    seen.add(example.code)
  }

  // The fixture exercises every code the SDK claims to know, and no other.
  assert.deepEqual([...seen].sort(), [...CHARGE_ERROR_CODES].sort())
})

test('CHARGE_OUTCOME_UNKNOWN carries the transaction to poll', async () => {
  const { chargePaymentMethod, getStatus } = CONTRACT.endpoints
  const paymentMethodId = getStatus.savedCardExample.storedPaymentMethod.id
  const example = chargePaymentMethod.errorExamples.find((entry) => entry.code === 'CHARGE_OUTCOME_UNKNOWN')
  const { fetchImpl } = recordingFetch(example.body, example.httpStatus)

  const error = await rejects(() =>
    makeClient(fetchImpl).chargePaymentMethod(paymentMethodId, {
      amount: 8440,
      currency: 'EUR',
      orderReference: 'order-1042',
      idempotencyKey: 'checkout-order-1042-8440-EUR',
    }),
  )

  assert.ok(error instanceof ChargeError)
  assert.equal(error.transactionId, example.body.data.transactionId)
  assert.equal(error.charge.chargeId, example.body.data.chargeId)
})

test('a charge against an unknown id is the generic ApiError 404 with the contract code', async () => {
  const { chargePaymentMethod, getStatus } = CONTRACT.endpoints
  const paymentMethodId = getStatus.savedCardExample.storedPaymentMethod.id
  const example = chargePaymentMethod.notFoundExample
  const { fetchImpl } = recordingFetch(example.body, example.httpStatus)

  const error = await rejects(() =>
    makeClient(fetchImpl).chargePaymentMethod(paymentMethodId, {
      amount: 8440,
      currency: 'EUR',
      orderReference: 'order-1042',
      idempotencyKey: 'checkout-order-1042-8440-EUR',
    }),
  )

  assert.ok(error instanceof ApiError)
  assert.ok(!(error instanceof ChargeError))
  assert.equal(error.httpStatus, 404)
  assert.equal(error.errorCode, example.code)
})

test('revokePaymentMethod() resolves on the contract 204 with nothing to parse', async () => {
  const { revokePaymentMethod, getStatus } = CONTRACT.endpoints
  const paymentMethodId = getStatus.savedCardExample.storedPaymentMethod.id
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return new Response(null, { status: revokePaymentMethod.httpStatus })
  }

  assert.equal(await makeClient(fetchImpl).revokePaymentMethod(paymentMethodId), undefined)
  assert.equal(
    calls[0].url,
    BASE_URL + revokePaymentMethod.path.replace('{paymentMethodId}', paymentMethodId),
  )
  assert.equal(calls[0].init.method, revokePaymentMethod.method)
  assert.equal('Idempotency-Key' in calls[0].init.headers, false)
})

test('every revoke error example in the contract is a RevokeError with code and status intact', async () => {
  const { revokePaymentMethod, getStatus } = CONTRACT.endpoints
  const paymentMethodId = getStatus.savedCardExample.storedPaymentMethod.id
  const seen = new Set()

  for (const example of revokePaymentMethod.errorExamples) {
    const { fetchImpl } = recordingFetch(example.body, example.httpStatus)
    const error = await rejects(() => makeClient(fetchImpl).revokePaymentMethod(paymentMethodId))

    assert.ok(error instanceof RevokeError, `${example.code} must be a RevokeError, got ${error?.constructor?.name}`)
    assert.ok(!(error instanceof TransportError))
    assert.equal(error.httpStatus, example.httpStatus)
    assert.equal(error.errorCode, example.code)
    assert.equal(error.message, example.body.error.message)
    assert.ok(REVOKE_ERROR_CODES.includes(error.errorCode))
    assert.deepEqual(error.result, example.body)
    seen.add(example.code)
  }

  assert.deepEqual([...seen].sort(), [...REVOKE_ERROR_CODES].sort())
})

test('a revoke of an unknown id is the generic ApiError 404', async () => {
  const { revokePaymentMethod, getStatus } = CONTRACT.endpoints
  const paymentMethodId = getStatus.savedCardExample.storedPaymentMethod.id
  const example = revokePaymentMethod.notFoundExample
  const { fetchImpl } = recordingFetch(example.body, example.httpStatus)

  const error = await rejects(() => makeClient(fetchImpl).revokePaymentMethod(paymentMethodId))

  assert.ok(error instanceof ApiError)
  assert.ok(!(error instanceof RevokeError))
  assert.equal(error.httpStatus, 404)
  assert.equal(error.errorCode, example.code)
})

const TRANSACTION_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const REFUND_KEY = 'refund-credit-note-77'
/** The refund fields the gateway leaves off the wire when null. */
const REFUND_NULLS = { amount: null, failureCode: null, failureMessage: null, completedAt: null }

test('the refund exposes exactly the contract fields and vocabularies', () => {
  assert.deepEqual(declaredFields('Refund'), CONTRACT.endpoints.createRefund.fields)
  assert.deepEqual(declaredFields('Refund'), CONTRACT.endpoints.getRefund.fields)
  assert.deepEqual([...REFUND_STATUSES], CONTRACT.refundStatusVocabulary)
  assert.deepEqual([...REFUND_ERROR_CODES], CONTRACT.refundErrorCodes)
  assert.deepEqual([...REFUND_FAILURE_CODES], CONTRACT.refundFailureCodes)
})

test('createRefund() returns the partial and full contract examples, absent fields as null', async () => {
  const { createRefund } = CONTRACT.endpoints
  const cases = [
    { example: createRefund.partialExample, params: { amount: 2500, idempotencyKey: REFUND_KEY } },
    { example: createRefund.fullExample, params: { idempotencyKey: REFUND_KEY } },
  ]

  for (const { example, params } of cases) {
    const { fetchImpl, calls } = recordingFetch(example, createRefund.httpStatus)

    const refund = await makeClient(fetchImpl).createRefund(example.data.transactionId, params)

    assert.deepEqual(refund, { ...REFUND_NULLS, ...example.data })
    assert.deepEqual(Object.keys(refund).sort(), [...createRefund.fields].sort())
    assert.ok(REFUND_STATUSES.includes(refund.status))
    assert.equal(
      calls[0].url,
      BASE_URL + createRefund.path.replace('{transactionId}', example.data.transactionId),
    )
    assert.equal(calls[0].init.method, createRefund.method)
    assert.equal(calls[0].init.headers['Idempotency-Key'], REFUND_KEY)
  }
  // The full example is a pending full refund: no amount yet.
  assert.equal('amount' in createRefund.fullExample.data, false)
})

test('getRefund() returns the succeeded and failed contract examples, a failed refund as a result', async () => {
  const { getRefund } = CONTRACT.endpoints

  for (const example of [getRefund.succeededExample, getRefund.failedExample]) {
    const { fetchImpl, calls } = recordingFetch(example, getRefund.httpStatus)
    const { transactionId, refundId } = example.data

    const refund = await makeClient(fetchImpl).getRefund(transactionId, refundId)

    assert.deepEqual(refund, { ...REFUND_NULLS, ...example.data })
    assert.deepEqual(Object.keys(refund).sort(), [...getRefund.fields].sort())
    assert.equal(
      calls[0].url,
      BASE_URL + getRefund.path.replace('{transactionId}', transactionId).replace('{refundId}', refundId),
    )
    assert.equal(calls[0].init.method, getRefund.method)
    assert.equal('Idempotency-Key' in calls[0].init.headers, false)
  }

  const failed = getRefund.failedExample.data
  assert.equal(failed.status, 'failed')
  assert.equal('amount' in failed, false)
  assert.ok(REFUND_FAILURE_CODES.includes(failed.failureCode))
})

test('every refund error example in the contract is a RefundError with code, status and envelope intact', async () => {
  const { createRefund, getRefund } = CONTRACT.endpoints
  const seen = new Set()
  const routes = [
    { examples: createRefund.errorExamples, call: (client) => client.createRefund(TRANSACTION_ID, { idempotencyKey: REFUND_KEY }) },
    { examples: getRefund.errorExamples, call: (client) => client.getRefund(TRANSACTION_ID, 're_7c1e9a2b4d6f48a0b3c5d7e9f1a2b3c4') },
  ]

  for (const { examples, call } of routes) {
    for (const example of examples) {
      const { fetchImpl } = recordingFetch(example.body, example.httpStatus)
      const error = await rejects(() => call(makeClient(fetchImpl)))

      assert.ok(error instanceof RefundError, `${example.code} must be a RefundError, got ${error?.constructor?.name}`)
      assert.ok(error instanceof ApiError)
      assert.equal(error.httpStatus, example.httpStatus)
      assert.equal(error.errorCode, example.code)
      assert.equal(error.message, example.body.error.message)
      assert.ok(REFUND_ERROR_CODES.includes(error.errorCode))
      assert.deepEqual(error.result, example.body)
      seen.add(example.code)
    }
  }

  assert.ok(seen.has('REFUND_NOT_FOUND'))
})

test('the contract examples themselves carry exactly their declared fields', () => {
  const { ping, createCheckoutSession, getStatus, chargePaymentMethod } = CONTRACT.endpoints

  assert.deepEqual(Object.keys(ping.example).sort(), [...ping.fields].sort())
  assert.deepEqual(
    Object.keys(createCheckoutSession.successExample).sort(),
    [...createCheckoutSession.fields].sort(),
  )
  assert.deepEqual(
    Object.keys(createCheckoutSession.refusalExample).sort(),
    [...createCheckoutSession.fields].sort(),
  )
  assert.deepEqual(
    Object.keys(createCheckoutSession.successExample.checkout).sort(),
    [...createCheckoutSession.checkoutFields].sort(),
  )
  assert.deepEqual(Object.keys(getStatus.example).sort(), [...getStatus.fields].sort())
  assert.deepEqual(Object.keys(getStatus.savedCardExample).sort(), [...getStatus.fields].sort())
  assert.deepEqual(
    Object.keys(getStatus.savedCardExample.storedPaymentMethod).sort(),
    [...getStatus.storedPaymentMethodFields].sort(),
  )
  // Refund examples are in wire form: every field they carry is declared, nulls are absent.
  const { createRefund, getRefund } = CONTRACT.endpoints
  for (const example of [
    createRefund.partialExample,
    createRefund.fullExample,
    getRefund.succeededExample,
    getRefund.failedExample,
  ]) {
    for (const field of Object.keys(example.data)) {
      assert.ok(createRefund.fields.includes(field), field)
    }
  }
  for (const example of [...createRefund.errorExamples, ...getRefund.errorExamples]) {
    assert.equal(example.body.success, false)
    assert.equal(example.body.error.code, example.code)
    assert.equal(example.body.error.statusCode, example.httpStatus)
  }
  const chargeFields = [...chargePaymentMethod.fields].sort()
  assert.deepEqual(Object.keys(chargePaymentMethod.successExample.data).sort(), chargeFields)
  assert.deepEqual(Object.keys(chargePaymentMethod.declinedExample.data).sort(), chargeFields)
  for (const example of chargePaymentMethod.errorExamples) {
    assert.equal(example.body.success, false)
    assert.equal(example.body.error.code, example.code)
    assert.equal(example.body.error.statusCode, example.httpStatus)
    if (example.body.data) {
      assert.deepEqual(Object.keys(example.body.data).sort(), chargeFields)
    }
  }
})

/** The wire form of an example: the gateway serializes WhenWritingNull, so null keys are absent. */
function withoutNulls(value) {
  if (Array.isArray(value)) return value.map(withoutNulls)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== null)
      .map(([key, entry]) => [key, withoutNulls(entry)]),
  )
}

/** Property names declared on one of the published interfaces, in declaration order. */
function declaredFields(interfaceName) {
  const start = DECLARATIONS.indexOf(`export interface ${interfaceName} {`)
  assert.notEqual(start, -1, `no published interface named ${interfaceName}`)
  const end = DECLARATIONS.indexOf('\n}', start)
  assert.notEqual(end, -1, `unterminated interface ${interfaceName}`)

  const names = []
  for (const line of DECLARATIONS.slice(start, end).split('\n')) {
    // Own properties only: skip the [key: string] index signature and doc comments.
    const match = /^ {4}(\w+)\??:/.exec(line)
    if (match) names.push(match[1])
  }

  assert.ok(names.length > 0, `no properties parsed off ${interfaceName}`)
  return names
}

function recordingFetch(body, status = 200) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return { fetchImpl, calls }
}

function makeClient(fetchImpl) {
  return new DominaiteClient({ keyId: KEY_ID, secret: VECTOR.secret, baseUrl: BASE_URL, fetch: fetchImpl })
}

async function rejects(run) {
  try {
    await run()
  } catch (error) {
    return error
  }
  assert.fail('expected the call to reject')
}
