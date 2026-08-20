import { createHmac, timingSafeEqual } from 'node:crypto'

/** Default clock tolerance, matching the gateway's own 300 seconds. */
const DEFAULT_TOLERANCE_SECONDS = 300

const HEX_64 = /^[0-9a-f]{64}$/

/**
 * Verifies the `X-Webhook-Signature` header on an incoming webhook delivery.
 *
 * Signature: lowercase hex HMAC-SHA256 over the ASCII concatenation `"{t}.{payload}"`,
 * keyed with the UTF-8 bytes of the endpoint's `whsec_` secret. The header is
 * `t={unix_seconds},v1={hex}`. The MAC is compared in constant time, and a delivery
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

  // Compare every candidate before looking at the clock, so the work done here does not
  // depend on whether the timestamp happened to be fresh.
  let macOk = false
  for (const candidate of parsed.signatures) {
    if (constantTimeEquals(candidate, expected)) {
      macOk = true
    }
  }
  if (!macOk) {
    return false
  }

  const now = nowSeconds ?? Math.floor(Date.now() / 1000)
  return Math.abs(now - Number(parsed.timestamp)) <= toleranceSeconds
}

interface ParsedSignatureHeader {
  /** The timestamp exactly as it appeared, since it is signed as text. */
  timestamp: string
  signatures: string[]
}

/**
 * Splits `t=...,v1=...` into its parts. Unknown keys are ignored so a future scheme
 * version can be added to the header without breaking this verifier, and repeated `v1`
 * entries are all kept so a secret rotation that signs twice still verifies.
 */
function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  let timestamp: string | undefined
  const signatures: string[] = []

  for (const part of header.split(',')) {
    const separator = part.indexOf('=')
    if (separator === -1) {
      continue
    }
    const key = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()

    if (key === 't' && timestamp === undefined) {
      timestamp = value
    } else if (key === 'v1') {
      signatures.push(value)
    }
  }

  // A digit-only timestamp keeps Number() away from '0x10', ' 12 ', '1e3' and friends.
  if (timestamp === undefined || !/^[0-9]{1,15}$/.test(timestamp) || signatures.length === 0) {
    return null
  }

  return { timestamp, signatures }
}

function constantTimeEquals(candidate: string, expected: string): boolean {
  // timingSafeEqual throws on a length mismatch, and the candidate is attacker-shaped.
  // The expected length is a public constant, so screening on it leaks nothing.
  if (!HEX_64.test(candidate.toLowerCase())) {
    return false
  }
  return timingSafeEqual(Buffer.from(candidate.toLowerCase(), 'hex'), Buffer.from(expected, 'hex'))
}
