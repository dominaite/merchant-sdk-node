import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isPaid, isTerminal, TRANSACTION_STATUSES } from '../dist/esm/index.js'

const TERMINAL = ['succeeded', 'failed', 'cancelled', 'abandoned', 'refunded', 'partially_refunded']
const OPEN = ['pending', 'processing', 'requires_capture', 'disputed']

test('isPaid is true for succeeded and nothing else', () => {
  for (const status of TRANSACTION_STATUSES) {
    assert.equal(isPaid(status), status === 'succeeded', status)
  }
  // Held funds are not captured money.
  assert.equal(isPaid('requires_capture'), false)
  assert.equal(isPaid('SUCCEEDED'), false)
  assert.equal(isPaid('paid'), false)
})

test('isTerminal splits every known status into terminal or still open', () => {
  for (const status of TERMINAL) {
    assert.equal(isTerminal(status), true, status)
  }
  for (const status of OPEN) {
    assert.equal(isTerminal(status), false, status)
  }
  // Nothing in the vocabulary is left unclassified.
  assert.deepEqual([...TERMINAL, ...OPEN].sort(), [...TRANSACTION_STATUSES].sort())
})

test('an unknown status is not terminal, so a new API value keeps you polling', () => {
  for (const status of ['chargeback_pending', '', 'SUCCEEDED', 'constructor', 'toString']) {
    assert.equal(isTerminal(status), false, status)
  }
})
