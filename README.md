# dominaite-node

Server-side Node.js client for the Dominaite merchant API. One call from your backend opens a
hosted checkout session; a two-line script tag renders the payment widget on your page. Card
details go straight from your customer's browser into the payment widget - they never touch
your server, which keeps your PCI scope minimal (SAQ A).

Node 20 or newer. Zero runtime dependencies: `node:crypto` and the built-in `fetch`. Ships ESM,
CommonJS, and TypeScript types.

## Install

The package name is `@dominaite/merchant-sdk` (scope and name verified free on npm, 2026-08-17;
publishing needs the `dominaite` npm org created first). It is **not published yet** - until it
is, install from a local checkout:

```bash
npm install /path/to/dominaite-node-sdk
```

or in `package.json`:

```json
{ "dependencies": { "@dominaite/merchant-sdk": "file:../dominaite-node-sdk" } }
```

If you cloned this repo directly, build it once before using it - `npm install` in your app runs
`prepack` for you, but a plain in-place checkout does not:

```bash
cd dominaite-node-sdk
npm install
npm run build     # emits dist/esm, dist/cjs, dist/types
npm test          # builds, then runs the suite (includes the offline signing vector)
```

## Credentials

You get two values from the Dominaite dashboard, **Website integration** tab, when you generate an
API key (shown once - store them like passwords):

- `dmk_...` - your API key id. Identifies you; not secret by itself.
- `dms_...` - your API secret. Server-side only: environment variable or a config file outside the
  web root. Never in a browser, never in git, never in logs.

Every request is signed with the secret (HMAC-SHA256) and timestamped. Keep your server clock on
NTP - signatures older than 5 minutes are rejected with `TIMESTAMP_OUT_OF_RANGE`.

If the key has an IP allowlist, calls from anywhere else fail with `IP_NOT_ALLOWED`. The allowlist
is managed on the same dashboard tab.

## Quickstart (zero to a signed session against dev)

Everything below is copy-paste. It assumes an empty directory and nothing installed.

```bash
mkdir my-checkout && cd my-checkout
npm init -y
npm pkg set type=module
npm install /path/to/dominaite-node-sdk
```

Set your credentials and the environment you are pointing at:

```bash
export DOMINAITE_KEY_ID=dmk_...      # Website integration tab
export DOMINAITE_SECRET=dms_...      # shown once when you generated the key
# Dev: the payments function app, whose Azure Functions route prefix is /api.
# Confirm the host for your environment before the first call.
export DOMINAITE_BASE_URL=https://func-dom-gw-payments-dev-gwc-01.azurewebsites.net/api
# Production needs no DOMINAITE_BASE_URL - the SDK defaults to
# https://api.dominaite.com/payments
```

`create-session.mjs`:

```js
import { CheckoutRefusedError, DominaiteClient, TransportError } from '@dominaite/merchant-sdk'

const client = new DominaiteClient({
  keyId: process.env.DOMINAITE_KEY_ID,
  secret: process.env.DOMINAITE_SECRET,
  baseUrl: process.env.DOMINAITE_BASE_URL, // omit in production
})

try {
  const session = await client.createCheckoutSession({
    amount: 2500,                    // minor units: 2500 = 25.00 EUR
    currency: 'EUR',
    orderReference: 'order-1042',    // your own order id, shows up in your dashboard
    customer: {
      // Pass everything you already know - prefilled fields are hidden from the
      // payer, so the checkout form stays short.
      firstName: 'Ana',
      lastName: 'Kirova',
      email: 'ana@example.com',
    },
    language: 'bg',                  // widget UI language
    theme: 'dark',
  })

  console.log(session)
  // Store session.transactionId against your order, then hand cashierKey +
  // cashierToken to the page that renders the widget.
} catch (error) {
  if (error instanceof CheckoutRefusedError) {
    // Machine-readable: error.errorCode - codes listed below.
    console.error('Payment unavailable:', error.errorCode)
  } else if (error instanceof TransportError) {
    // Network blip - safe to retry with the same idempotencyKey.
    console.error('Payment temporarily unavailable')
  } else {
    throw error
  }
}
```

```bash
node create-session.mjs
```

A successful run prints `transactionId`, `orderId`, `cashierKey`, `cashierToken`, `amount`,
`currency`, `expiresAt`. Render the widget with the last two:

```html
<div id="checkout"></div>
<script src="https://bp-checkout.dominaite.com/v2/launcher"
        data-cashier-key="CASHIER_KEY_FROM_SESSION"
        data-cashier-token="CASHIER_TOKEN_FROM_SESSION"></script>
```

`cashierKey` and `cashierToken` are per-payment session values, not credentials - but HTML-escape
them when you template them into the page.

That's the whole integration: the session call, the script tag, and your domain bound to your
checkout by Dominaite during onboarding.

There is a runnable version of the above in `examples/create-session.mjs` in this repo - it mints a
session and reads the status back, using the same three environment variables.

### CommonJS

```js
const { DominaiteClient } = require('@dominaite/merchant-sdk')
```

Same API. Node's `require()` of this package resolves to the CJS build.

## Amounts are minor units

`amount` is always an integer in the currency's minor unit: `2500` is 25.00 EUR. The SDK rejects
floats and non-positive values before anything reaches the network. The amount is locked
server-side - what you pass here is what gets charged; nothing in the browser can change it.

## Retries and double-charges

Every `createCheckoutSession` call carries an idempotency key (auto-generated, or pass your own as
`idempotencyKey`). Retrying with the same key never opens a second payment - on a timeout, retry
with the same key rather than generating a new one.

`createCheckoutSessionWithRetry` does that for you: it pins one key up front and reuses it across
attempts, retrying only `TransportError` (network failures and 5xx, including
`MERCHANT_API_UNAVAILABLE`). Refusals and authentication failures are not retried - they will not
change.

```js
const session = await client.createCheckoutSessionWithRetry(
  { amount: 2500, currency: 'EUR', orderReference: 'order-1042' },
  { attempts: 3, baseDelayMs: 500 },   // both optional; delay doubles per attempt
)
```

## Sessions expire

A session is valid for 2 hours. If the payer comes back later, create a new session.

## Status polling

```js
const status = await client.getStatus(session.transactionId)
// { transactionId, orderReference: 'order-1042', status: 'succeeded',
//   amount: 2500, currency: 'EUR', ... }
```

`status` is one of: `pending`, `processing`, `succeeded`, `failed`, `refunded`,
`partially_refunded`, `cancelled`, `disputed`, `abandoned`. While the session is still payable the
response also carries `expiresAt`; after that instant a `pending` session can only become
`abandoned`. An unknown transaction id throws an `ApiError` with `httpStatus` 404.

Poll after the payer returns to you, or on your order timeout - not in a tight loop; the endpoint
is rate limited per key.

## Errors

Everything thrown by the SDK extends `DominaiteError`.

| Error | When | What to do |
|---|---|---|
| `CheckoutRefusedError` | The API answered, `success: false`. `errorCode` carries the reason. | Branch on `errorCode`. Do not blind-retry. |
| `AuthenticationError` | 401/403. `errorCode` is `INVALID_API_KEY`, `INVALID_SIGNATURE`, `TIMESTAMP_OUT_OF_RANGE`, or `IP_NOT_ALLOWED`. | Fix the key id, secret, server clock, or allowlist. Never retry-loop. |
| `TransportError` | Network failure, timeout, or 5xx (`MERCHANT_API_UNAVAILABLE`). | Retry with the **same** idempotency key. |
| `ApiError` | Any other rejecting or unexpected response; `httpStatus` carries the code. | Inspect. A 422 means an idempotency key was replayed with a different body - use a fresh key. |
| `TypeError` | Bad arguments (float amount, missing field, malformed key id). | Fix the call; nothing was sent. |

Refusal codes on `CheckoutRefusedError.errorCode`:

- `PAYMENT_PROCESSING_UNAVAILABLE` - card payments are off right now; retry later.
- `DUPLICATE_REQUEST` - a session for this idempotency key is already open.
- `ALREADY_PROCESSED` - this idempotency key's payment already completed.
- `IDEMPOTENCY_KEY_REUSED` - same key sent with a different body; use a fresh key.

## Verifying your signing

The SDK signs for you, but the recipe is pinned by an offline known-answer vector shared with the
gateway and the dashboard - `npm test` reproduces it byte-for-byte. If you ever hand-roll the
signing (or debug an `INVALID_SIGNATURE`), `signRequest` is exported:

```js
import { signRequest } from '@dominaite/merchant-sdk'

signRequest({
  secret: 'dms_...',
  timestamp: '1755302400',                                  // unix SECONDS
  method: 'POST',
  path: '/merchant-api/checkout/sessions',        // path only, no host
  idempotencyKey: '00000000-0000-4000-8000-000000000001',    // '' for GET
  body: '{"amount":2500,"currency":"EUR","orderReference":"order-1042"}',  // '' for GET
})
// '95759958a0a0a9bd3e6e37101c01e8e7fee1166406e4ac2ff488764f5f742cbf'
```

The signed payload is five lines:
`"{timestamp}\n{METHOD}\n{path}\n{idempotencyKey}\n{sha256hex(body)}"`, signed as lowercase hex
HMAC-SHA256 with your secret, UTF-8 throughout. GET signs an empty idempotency key and an empty
body, and sends no `Idempotency-Key` header.
