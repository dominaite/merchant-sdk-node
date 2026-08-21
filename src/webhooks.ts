import { createHmac, timingSafeEqual } from 'node:crypto'

/** Default clock tolerance, matching the gateway's own 300 seconds. */
const DEFAULT_TOLERANCE_SECONDS = 300

const HEX_64 = /^[0-9a-f]{64}$/
const DIGITS = /^[0-9]+$/

/**
 * Verifies the `X-Webhook-Signature` header on an incoming webhook delivery.
 *
 * Signature: lowercase hex HMAC-SHA256 over the ASCII concatenation `"{t}.{payload}"`,
 * keyed with the UTF-8 bytes of the endpoint's `whsec_` secret. The header is exactly
 * `t={unix_seconds},v1={64 lowercase hex}` - one `t`, one `v1`, no whitespace, and
 * unknown keys ignored so a future scheme version can ride along. Any other shape is
 * rejected the same way a bad MAC is. The MAC is compared in constant time, and a delivery
 * whose timestamp is more than `toleranceSeconds` away from now (in EITHER direction)
 * is rejected even when the MAC is good - that is what stops a captured delivery from
 * being replayed at you later.
 *
 * `payload` must be the RAW request body, exactly as it arrived. Parsing it to JSON and
 * re-serialising changes bytes (key order, spacing, unicode escapes) and the signature
 * will not match. Verify FIRST, parse second.
 *
 * Returns false for every failure a hostile caller controls - bad MAC, wrong secret,
 * stale or future timestamp, malformed or missing header. It throws only TypeError, and
 * only for arguments your own code got wrong.
 *
 * Express, with the raw body preserved:
 *
 *   app.post('/webhooks/dominaite', express.raw({ type: 'application/json' }), (req, res) => {
 *     const raw = req.body.toString('utf8')
 *     if (!verifyWebhook(raw, req.get('X-Webhook-Signature') ?? '', process.env.DOMINAITE_WEBHOOK_SECRET)) {
 *       return res.sendStatus(400)
 *     }
 *     const event = JSON.parse(raw)
 *     enqueue(event)        // dedupe on event.id; do the work off the request path
 *     res.sendStatus(200)
 *   })
 *
 * @param payload The raw request body as a string.
 * @param signatureHeader The `X-Webhook-Signature` header value.
 * @param secret The endpoint's signing secret (`whsec_...`) from the dashboard.
 * @param toleranceSeconds Maximum clock difference to accept, in seconds. Default 300.
 * @param nowSeconds Current unix seconds. Injection point for tests; leave it unset in
 *   production so the system clock is used.
 */
export function verifyWebhook(
  payload: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
  nowSeconds?: number,
): boolean {
  if (typeof payload !== 'string') {
    throw new TypeError('payload must be the raw request body as a string')
  }
  if (typeof secret !== 'string' || secret === '') {
    throw new TypeError('secret must be the endpoint signing secret (whsec_...)')
  }
  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) {
    throw new TypeError('toleranceSeconds must be a non-negative number of seconds')
  }
  if (nowSeconds !== undefined && !Number.isFinite(nowSeconds)) {
    throw new TypeError('nowSeconds must be a number of unix seconds')
  }
  if (typeof signatureHeader !== 'string') {
    return false
  }

  const parsed = parseSignatureHeader(signatureHeader)
  if (parsed === null) {
    return false
  }

  const expected = createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(`${parsed.timestamp}.${payload}`, 'utf8')
    .digest('hex')

  // Compare before looking at the clock, so the work done here does not depend on
  // whether the timestamp happened to be fresh.
  if (!constantTimeEquals(parsed.signature, expected)) {
    return false
  }

  const now = nowSeconds ?? Math.floor(Date.now() / 1000)
  return Math.abs(now - Number(parsed.timestamp)) <= toleranceSeconds
}

interface ParsedSignatureHeader {
  /** The raw digits exactly as they appeared, since the timestamp is signed as text. */
  timestamp: string
  signature: string
}

/**
 * Parses the header against the grammar in WEBHOOKS-CONTRACT.md: a comma-separated list
 * of `key=value` elements, no whitespace anywhere, exactly one `t` and exactly one `v1`.
 *
 * Unknown keys are ignored, values and repeats included, so a later scheme version (a
 * `v2` rollover) can ride along on the same header. Everything else rejects, including a
 * repeat of `t` or `v1` even when one of the candidates carries a good MAC. The platform
 * never rotates secrets with overlapping signatures, so a second candidate is not a
 * merchant feature we would be breaking - it is an attacker appending one junk element in
 * front of a captured valid one and watching a lenient verifier pick the winner.
 */
function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  // The platform emits no whitespace. Trimming it away here would let a caller smuggle
  // one shape past this parser and a different shape past someone else's.
  if (/\s/.test(header)) {
    return null
  }

  let timestamp: string | undefined
  let signature: string | undefined

  for (const part of header.split(',')) {
    const separator = part.indexOf('=')
    if (separator === -1) {
      return null
    }
    const key = part.slice(0, separator)
    const value = part.slice(separator + 1)

    if (key === 't') {
      if (timestamp !== undefined) {
        return null
      }
      timestamp = value
    } else if (key === 'v1') {
      if (signature !== undefined) {
        return null
      }
      signature = value
    }
  }

  // Digits only, and the raw substring is what gets signed - reformatting it through
  // Number() would make '+1755700000' and '01755700000' verify as the plain value.
  if (timestamp === undefined || !DIGITS.test(timestamp)) {
    return null
  }
  if (signature === undefined || !HEX_64.test(signature)) {
    return null
  }

  return { timestamp, signature }
}

function constantTimeEquals(candidate: string, expected: string): boolean {
  // timingSafeEqual throws on a length mismatch. The candidate is already known to be 64
  // lowercase hex by the time it gets here, and the expected length is a public constant.
  if (!HEX_64.test(candidate)) {
    return false
  }
  return timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(expected, 'hex'))
}
