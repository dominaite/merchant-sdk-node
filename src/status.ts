import type { TransactionStatus } from './types.js'

/**
 * The statuses a payment does not leave on its own. A reconciliation sweep can stop
 * polling on these. disputed is not one: a dispute is still being decided.
 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set<TransactionStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'abandoned',
  'refunded',
  'partially_refunded',
])

/**
 * True only for succeeded: the one status that means the money is in hand. Fulfil the
 * order on this and nothing else. requires_capture is NOT paid yet (the funds are held,
 * not captured), and neither is any status this SDK does not recognise.
 */
export function isPaid(status: TransactionStatus | string): boolean {
  return status === 'succeeded'
}

/**
 * True when the payment has reached an outcome and will not move on its own: succeeded,
 * failed, cancelled, abandoned, refunded, partially_refunded. Stop polling on these.
 *
 * pending, processing, requires_capture and disputed are not terminal, and neither is a
 * status this SDK does not recognise: a value the API adds later must keep you polling,
 * never silently close an order that is still live.
 */
export function isTerminal(status: TransactionStatus | string): boolean {
  return TERMINAL_STATUSES.has(status)
}
