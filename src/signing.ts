import { createHash, createHmac } from 'node:crypto'

/** Everything that goes into one signature. */
export interface SignRequestInput {
  /** Your API secret (dms_...). */
  secret: string
  /** Unix seconds, as sent in X-Timestamp. */
  timestamp: string
  /** HTTP method; uppercased before signing. */
  method: string
  /** Canonical path only - no host, no query string. */
  path: string
  /** The Idempotency-Key header value. Empty string for GET. */
  idempotencyKey: string
  /** The exact request body string that will be sent. Empty string for GET. */
  body: string
}

/**
 * Request signature: lowercase hex HMAC-SHA256 over
 * "{timestamp}\n{METHOD}\n{path}\n{idempotencyKey}\n{sha256hex(body)}".
 *
 * The idempotency key is INSIDE the signature, so a captured request cannot be replayed
 * with a different key to mint extra sessions. The server rejects timestamps more than
 * 5 minutes off - keep your server clock on NTP.
 *
 * Exported so you can pin it with the offline test vector before calling the live API.
 */
export function signRequest(input: SignRequestInput): string {
  const bodyHash = createHash('sha256').update(input.body, 'utf8').digest('hex')
  const payload = [
    input.timestamp,
    input.method.toUpperCase(),
    input.path,
    input.idempotencyKey,
    bodyHash,
  ].join('\n')

  return createHmac('sha256', Buffer.from(input.secret, 'utf8')).update(payload, 'utf8').digest('hex')
}
