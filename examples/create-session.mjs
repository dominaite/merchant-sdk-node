// Smallest end-to-end check: mint a session, then read its status back.
//
//   export DOMINAITE_KEY_ID=dmk_...
//   export DOMINAITE_SECRET=dms_...
//   export DOMINAITE_BASE_URL=https://<dev-payments-host>/api   # omit for production
//   node examples/create-session.mjs
//
// Run `npm run build` first - this imports the built output.
import { CheckoutRefusedError, DominaiteClient, TransportError } from '../dist/esm/index.js'

const keyId = process.env.DOMINAITE_KEY_ID
const secret = process.env.DOMINAITE_SECRET

if (!keyId || !secret) {
  console.error('Set DOMINAITE_KEY_ID and DOMINAITE_SECRET first.')
  process.exit(1)
}

const client = new DominaiteClient({
  keyId,
  secret,
  ...(process.env.DOMINAITE_BASE_URL ? { baseUrl: process.env.DOMINAITE_BASE_URL } : {}),
})

try {
  const session = await client.createCheckoutSession({
    amount: 2500,
    currency: 'EUR',
    orderReference: `smoke-${Date.now()}`,
    customer: { firstName: 'Ana', lastName: 'Kirova', email: 'ana@example.com' },
  })

  // Never log cashierToken (or the whole session object, which contains it): it is
  // what lets a browser drive this payment.
  console.log('session minted:', {
    transactionId: session.transactionId,
    orderId: session.orderId,
    amount: session.amount,
    currency: session.currency,
    expiresAt: session.expiresAt,
  })

  const status = await client.getStatus(session.transactionId)
  console.log('status:', status.status)
} catch (error) {
  if (error instanceof CheckoutRefusedError) {
    console.error('refused:', error.errorCode, error.message)
  } else if (error instanceof TransportError) {
    console.error('transport failure (safe to retry with the same idempotency key):', error.message)
  } else {
    console.error(`${error.name}:`, error.message, error.errorCode ?? error.httpStatus ?? '')
  }
  process.exit(1)
}
