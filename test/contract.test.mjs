import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CheckoutRefusedError,
  DominaiteClient,
  SESSION_REFUSAL_ERROR_CODES,
  TRANSACTION_STATUSES,
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

test('every refusal code in the contract is recognised and carried through', async () => {
  for (const code of CONTRACT.sessionRefusalErrorCodes) {
    assert.ok(
      SESSION_REFUSAL_ERROR_CODES.includes(code),
      `refusal code not known to this SDK: ${code}`,
    )

    const { fetchImpl } = recordingFetch({
      ...CONTRACT.endpoints.createCheckoutSession.refusalExample,
      errorCode: code,
    })
    const error = await rejects(() =>
      makeClient(fetchImpl).createCheckoutSession({
        amount: 8440,
        currency: 'EUR',
        orderReference: 'order-1042',
      }),
    )

    assert.ok(error instanceof CheckoutRefusedError)
    assert.equal(error.errorCode, code)
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

test('the contract examples themselves carry exactly their declared fields', () => {
  const { ping, createCheckoutSession, getStatus } = CONTRACT.endpoints

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
})

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

function recordingFetch(body) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), {
      status: 200,
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
