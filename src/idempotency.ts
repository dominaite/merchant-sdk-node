/** Maximum length of the fields the API caps at 100, counted in Unicode code points. */
export const MAX_FIELD_CODE_POINTS = 100

/** ISO 4217 alphabetic code, before uppercasing. */
const CURRENCY_PATTERN = /^[A-Za-z]{3}$/

/** Parameters for {@link orderIdempotencyKey}. */
export interface OrderIdempotencyKeyInput {
  /** What the key is for, so two kinds of request for one order never collide, e.g. 'checkout'. */
  scope: string
  /** Your own order id. */
  orderId: string
  /** The amount you are about to send, in MINOR units. */
  amountMinor: number
  /** ISO 4217, any case. The key carries it uppercased. */
  currency: string
}

/**
 * Builds an idempotency key from the order itself: `{scope}-{orderId}-{amountMinor}-{CURRENCY}`.
 *
 * Derive the key, never generate it per attempt. The same order at the same amount always
 * produces the same key, so a page reload, a back button or a retry after a timeout replays
 * the same session instead of opening a second payment. A changed amount or currency
 * produces a new key, so an edited basket gets a new session instead of an
 * IDEMPOTENCY_KEY_REUSED refusal.
 *
 * Throws TypeError when an input is missing or malformed, or when the key would pass the
 * API's 100 character limit (shorten scope or orderId).
 */
export function orderIdempotencyKey(input: OrderIdempotencyKeyInput): string {
  const { scope, orderId, amountMinor, currency } = input ?? ({} as OrderIdempotencyKeyInput)
  if (typeof scope !== 'string' || scope.trim() === '') {
    throw new TypeError('scope must be a non-empty string')
  }
  if (typeof orderId !== 'string' || orderId.trim() === '') {
    throw new TypeError('orderId must be a non-empty string')
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new TypeError('amountMinor must be a positive integer in MINOR units (e.g. 2500 for 25.00 EUR)')
  }
  if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
    throw new TypeError('currency must be a three-letter ISO 4217 code, e.g. EUR')
  }

  return normalizeIdempotencyKey(`${scope}-${orderId}-${amountMinor}-${currency.toUpperCase()}`)
}

/**
 * The key rules every idempotent request shares: required, a non-empty string, at most
 * 100 code points. There is no fallback: a key made up here would differ on every attempt,
 * which is exactly the double payment the key exists to prevent.
 */
export function normalizeIdempotencyKey(providedKey: unknown): string {
  if (providedKey === undefined || providedKey === null) {
    throw new TypeError(
      'idempotencyKey is required. Derive it from your order with orderIdempotencyKey(), never per attempt',
    )
  }
  if (
    typeof providedKey !== 'string' ||
    providedKey === '' ||
    countCodePoints(providedKey) > MAX_FIELD_CODE_POINTS
  ) {
    throw new TypeError(
      `idempotencyKey must be a non-empty string of at most ${MAX_FIELD_CODE_POINTS} characters`,
    )
  }
  return providedKey
}

/**
 * Length in Unicode CODE POINTS, which is what the API's own limits count - not UTF-16
 * units and not bytes. A 100-character Cyrillic order reference is 100 here and 200
 * bytes, and must not be rejected for it.
 *
 * Known caveat: an astral character (emoji, rarer CJK) counts as 1 here while the server
 * counts it as 2, so a string packed with them can pass this check and still be rejected
 * upstream. The server is the final arbiter; this check only catches the obvious cases
 * before they cost a round trip.
 */
export function countCodePoints(value: string): number {
  let count = 0
  for (const _ of value) {
    count++
  }
  return count
}
