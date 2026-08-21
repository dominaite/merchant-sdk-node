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

Ping before your first mint. It is one signed GET that creates nothing, so anything that
fails here is your credentials, your signing or your clock:

```js
import { DominaiteClient } from '@dominaite/merchant-sdk'

const client = new DominaiteClient({
  keyId: process.env.DOMINAITE_KEY_ID,
  secret: process.env.DOMINAITE_SECRET,
  baseUrl: process.env.DOMINAITE_BASE_URL, // omit in production
})

console.log(await client.ping())
// { pong: true, merchantId: '...', serverTime: '...', clockSkewSeconds: 0 }
```

Keep an eye on `clockSkewSeconds`: the gateway rejects requests once it passes 300, so a
number that keeps growing is your cue to fix NTP before payments start failing.

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

  // Never log cashierToken, and never log the whole session object either - it
  // carries the token. Log the fields you actually need to trace an order.
  console.log({
    transactionId: session.transactionId,
    orderId: session.orderId,
    amount: session.amount,
    currency: session.currency,
    expiresAt: session.expiresAt,
  })
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

The session carries `transactionId`, `orderId`, `cashierKey`, `cashierToken`, `amount`,
`currency` and `expiresAt`. Render the widget with the two cashier fields:

```html
<div id="checkout"></div>
<script src="https://bp-checkout.dominaite.com/v2/launcher"
        data-cashier-key="CASHIER_KEY_FROM_SESSION"
        data-cashier-token="CASHIER_TOKEN_FROM_SESSION"></script>
```

`cashierKey` and `cashierToken` are per-payment session values rather than account credentials,
but `cashierToken` is what lets a browser drive the payment: keep it out of your logs, your error
reports and any analytics payload, and HTML-escape both when you template them into the page.

That covers the paying half: the session call, the script tag, and your domain bound to your
checkout by Dominaite during onboarding. The other half is finding out that the money arrived,
which is what the next section is about. The shape of a full integration is:

1. Create a session from your backend.
2. Render the widget and let the payer pay.
3. Receive a `payment.succeeded` webhook.
4. Fulfill the order, keyed off your `orderReference`.

Do not fulfill on the browser redirect back to your site. The payer closing the tab, a flaky
network or a curious customer editing the return URL all produce the same "success" page; only
the webhook (or `getStatus`) tells you what actually happened.

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

**A retry is protection against a double charge, not a way to recover the first session.** The
two outcomes of retrying a key differ:

- The first attempt never reached the gateway. The retry is an ordinary create and you get a
  session back.
- The first attempt did reach the gateway and took the key. The retry comes back HTTP 200 with
  `success: false` and a replay code - `DUPLICATE_REQUEST`, `ALREADY_PROCESSED`,
  `PRIOR_ATTEMPT_FAILED` or `IDEMPOTENCY_KEY_REUSED` - which this SDK throws as
  `CheckoutRefusedError`. The original session's `cashierKey` and `cashierToken` are **not**
  returned, by that call or any other, so a payer who never got the widget cannot be handed the
  first session.

So write the timeout path to expect a refusal, not a session. When the refusal names a
`transactionId`, read it back with `getStatus` to find out what the first attempt did (see
"Recovering from a replay refusal" below). If it turns out the first attempt never became a
payment you can pay, mint a new session under a **fresh** idempotency key.

## Sessions expire

A session is valid for 2 hours. If the payer comes back later, create a new session.

## Webhooks

Register an endpoint in the Dominaite dashboard, **Webhooks** tab: an HTTPS URL, the events you
want, and a retry count. The signing secret (`whsec_...`) is shown **once** at creation - store it
like your API secret. Regenerating it replaces the old one immediately. You can have up to 25
active endpoints.

Events you can subscribe to: `payment.succeeded`, `payment.failed`, `payment.requires_capture`,
`payment.cancelled`, `payment.abandoned`, `payment.refunded`, `payment.disputed`. `succeeded` is
the only one that means money in hand. In-flight states (`pending`, `processing`) are never
webhooked - see the polling subsection below for those.

The body is flat JSON, with no `success` wrapper to branch on:

```json
{
  "id": "7f9c24e5-1d1f-4c0a-9b6c-2f3a4d5e6f70",
  "type": "payment.succeeded",
  "createdAt": "2026-08-20T14:00:00Z",
  "data": {
    "transactionId": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
    "status": "succeeded",
    "previousStatus": "pending",
    "kind": "sale",
    "amount": 8440,
    "grossAmount": 8701,
    "surchargeAmount": 261,
    "currency": "EUR",
    "originalTransactionId": null,
    "idempotencyKey": "order-123"
  }
}
```

Amounts are minor units. On `payment.*` the `amount` is what you are paid and `grossAmount` is the
card movement; on `payment.refunded` the `amount` is what went back to the customer.

### Verify first, parse second

Every delivery carries `X-Webhook-Signature: t={unix_seconds},v1={hex}` - HMAC-SHA256 over
`"{t}.{raw_body}"`, keyed with your endpoint secret. `verifyWebhook` checks it in constant time and
rejects a timestamp more than 5 minutes off, which is what stops someone replaying a delivery they
captured earlier.

```js
import express from 'express'
import { verifyWebhook } from '@dominaite/merchant-sdk'

const app = express()

// express.raw, not express.json: the signature covers the exact bytes that arrived, and
// JSON.parse + re-serialize does not reproduce them.
app.post('/webhooks/dominaite', express.raw({ type: 'application/json' }), (req, res) => {
  const raw = req.body.toString('utf8')

  if (!verifyWebhook(raw, req.get('X-Webhook-Signature') ?? '', process.env.DOMINAITE_WEBHOOK_SECRET)) {
    return res.sendStatus(400)
  }

  const event = JSON.parse(raw)
  if (alreadyHandled(event.id)) {
    return res.sendStatus(200)     // duplicate delivery, nothing to do
  }

  enqueue(event)                   // your queue, your worker, your database transaction
  res.sendStatus(200)
})
```

`verifyWebhook(payload, signatureHeader, secret, toleranceSeconds = 300, nowSeconds?)` returns a
boolean. Anything an attacker controls - a tampered body, a wrong secret, a stale or future
timestamp, a malformed or missing header - comes back `false` rather than throwing. It throws
`TypeError` only when your own call is wrong (a Buffer instead of a string, an empty secret). The
`nowSeconds` argument exists so tests can pin a fixed clock; leave it unset in production.

The recipe is pinned by the same offline vector every Dominaite SDK ships, so a Node verifier and a
Python one agree byte-for-byte. `npm test` reproduces it.

### Respond fast, dedupe, expect duplicates

- **Respond 2xx immediately.** Queue the work; never do the fulfillment inline. A slow handler
  looks like a failed one and earns you retries.
- **Delivery is at-least-once.** Dedupe on the top-level `id`, which is stable across retries of
  the same delivery. Handling an event twice must be harmless.
- **Retries**: up to your configured `RetryCount` (default 3, max 10, 0 disables), spaced 1m, 5m,
  30m, 2h, 12h, for as long as the endpoint is active.
- **Circuit breaker**: an endpoint that fails its initial attempt and every configured retry, over
  and over, is auto-disabled. Any later successful delivery re-enables it. An endpoint you disable
  by hand in the dashboard stays disabled.
- Order is not guaranteed. Use `createdAt` and `previousStatus` rather than assuming arrival order.

### Webhooks do not replace your reconciliation sweep

**Keep the sweep.** A periodic job that lists your own open orders and calls `getStatus` on each is
still mandatory, and webhooks complement it rather than retiring it. There are real windows where a
delivery never lands: an endpoint sitting disabled parks its chain, and a delivery can be lost
before it is ever queued. Nothing in the webhook pipeline is a durable outbox, so the sweep is your
backstop for the money you would otherwise never hear about.

Run it on a schedule, over every order that is not in a terminal state, and treat what `getStatus`
says as the truth.

### Fallback: polling and in-flight UX

Webhooks tell you about terminal outcomes. For the "we are still working on it" screen the payer
sees right after paying, and as the fallback when you have no endpoint registered yet, poll:

```js
const status = await client.getStatus(session.transactionId)
// { transactionId, orderReference: 'order-1042', status: 'succeeded',
//   amount: 2500, currency: 'EUR', ... }
```

`status` is one of: `pending`, `processing`, `succeeded`, `failed`, `refunded`,
`partially_refunded`, `cancelled`, `disputed`, `requires_capture`, `abandoned`. While the session
is still payable the response also carries `expiresAt`; after that instant a `pending` session can
only become `abandoned`. An unknown transaction id throws an `ApiError` with `httpStatus` 404.

`succeeded` is the only value that means the payment is complete. Keep polling on `pending`,
`processing` and `requires_capture` - none of them is terminal.

`requires_capture` is **not** "unpaid": the payer has already paid and the funds are held
awaiting capture. Never treat it as an abandoned order.

Treat any status you do not recognise as still-open as well: a value the API adds later should
make you keep polling, never silently close an order that is still live.

Poll after the payer returns to you, or on your order timeout - not in a tight loop; the endpoint
is rate limited per key.

## Errors

Everything thrown by the SDK extends `DominaiteError`.

| Error | When | What to do |
|---|---|---|
| `CheckoutRefusedError` | The API answered, `success: false`. `errorCode` carries the reason. | Branch on `errorCode`. Do not blind-retry. |
| `AuthenticationError` | 401/403. `errorCode` is `INVALID_API_KEY`, `INVALID_SIGNATURE`, `TIMESTAMP_OUT_OF_RANGE`, or `IP_NOT_ALLOWED`. | Fix the key id, secret, server clock, or allowlist. Never retry-loop. |
| `TransportError` | Network failure, timeout, or 5xx (`MERCHANT_API_UNAVAILABLE`). | Retry with the **same** idempotency key, and expect a replay refusal if the first attempt did land. |
| `ApiError` | Any other rejecting or unexpected response; `httpStatus` carries the code. | Inspect. A 422 means an idempotency key was replayed with a different body - use a fresh key. |
| `ApiError` with a 3xx `httpStatus` | The host you called answered with a redirect. | The Dominaite API never redirects, so the SDK refuses to follow one: your signed headers would be handed to whatever `Location` names, and its answer would look authentic. Check `baseUrl` and any proxy in front of it. |
| `TypeError` | Bad arguments (float amount, missing field, malformed key id). | Fix the call; nothing was sent. |

Refusal codes on `CheckoutRefusedError.errorCode`:

- `PAYMENT_PROCESSING_UNAVAILABLE` - card payments are off right now; retry later.
- `DUPLICATE_REQUEST` - a session for this idempotency key is already open.
- `ALREADY_PROCESSED` - this idempotency key's payment already completed.
- `PRIOR_ATTEMPT_FAILED` - a prior attempt with this key failed terminally; use a fresh key.
- `IDEMPOTENCY_KEY_REUSED` - same key sent with a different body; use a fresh key.

### Recovering from a replay refusal

When your idempotency key collides with an earlier attempt, the refusal names the transaction it
collided with, so you can reconcile instead of minting a second payment:

```js
try {
  session = await client.createCheckoutSession(params)
} catch (error) {
  if (error instanceof CheckoutRefusedError && error.transactionId) {
    const status = await client.getStatus(error.transactionId)
    // Now you know what the earlier attempt actually did.
  }
}
```

`error.transactionId` is `undefined` when the API did not name one (a concurrent-race
`DUPLICATE_REQUEST` knows the key is taken but not yet by which row), so check it before use. The
full refusal payload is on `error.result`.

What you get back is the status of the earlier payment, not the earlier session: no refusal
carries `cashierKey` or `cashierToken`, so there is no way to re-render the widget for a session
you lost. Reconcile against the status, and start a fresh key when you need a payable session.

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
  path: '/merchant-api/checkout/sessions',                   // path only, no host
  idempotencyKey: '00000000-0000-4000-8000-000000000001',    // '' for GET
  body: '{"amount":2500,"currency":"EUR","orderReference":"order-1042"}',  // '' for GET
})
// '8f5fba0b29a8eea81b76a0e6d7119e79ec68f586910f77713b045652e5ce9b74'
```

The signed payload is five lines:
`"{timestamp}\n{METHOD}\n{path}\n{idempotencyKey}\n{sha256hex(body)}"`, signed as lowercase hex
HMAC-SHA256 with your secret, UTF-8 throughout. GET signs an empty idempotency key and an empty
body, and sends no `Idempotency-Key` header.
