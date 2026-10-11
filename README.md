# dominaite-node

Server-side Node.js client for the Dominaite merchant API. One call from your backend opens a
hosted checkout session; a two-line script tag renders the payment widget on your page. Card
details go straight from your customer's browser into the payment widget - they never touch
your server, which keeps your PCI scope minimal (SAQ A).

Node 20 or newer. Zero runtime dependencies: `node:crypto` and the built-in `fetch`. Ships ESM,
CommonJS, and TypeScript types.

## Install

```bash
npm install @dominaite/merchant-sdk
```

If you cloned this repo directly, build it once before using it. A plain checkout has no `dist/`:

```bash
cd merchant-sdk-node
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

### Key scopes

Each key holds one or more scopes. A route answers only a key that holds its scope:

| Scope | What the key can call |
|---|---|
| `payments` | Checkout sessions and status reads, stored-card charges and revokes, refunds, plans and agreements. |
| `transactions:read` | `listTransactions()`. |
| `webhooks:manage` | `createWebhookEndpoint()`, `listWebhookEndpoints()` and `deleteWebhookEndpoint()`. |

A key holds `payments` alone, or one or both of the other two scopes. A key with
`transactions:read` or `webhooks:manage` is a reporting key, and it is not bound to one storefront.
A key issued without scopes holds `payments`. The scopes of a key are fixed when it is issued: to change them, issue a new key.
Every key can call `ping()` and `getIntegrationContract()`.

A call with a key that does not hold the scope throws `AuthenticationError` with `errorCode`
`INSUFFICIENT_SCOPE` and `httpStatus` 403. Nothing was created. Use a key that holds the scope.

## Quickstart (zero to a signed session against dev)

Everything below is copy-paste. It assumes an empty directory and nothing installed.

```bash
mkdir my-checkout && cd my-checkout
npm init -y
npm pkg set type=module
npm install @dominaite/merchant-sdk
```

Set your credentials and the environment you are pointing at:

```bash
export DOMINAITE_KEY_ID=dmk_...      # Website integration tab
export DOMINAITE_SECRET=dms_...      # shown once when you generated the key
# Production needs no DOMINAITE_BASE_URL - the SDK defaults to
# https://api.dominaite.com/payments
# For a test environment, set it to that environment's base URL:
# export DOMINAITE_BASE_URL=https://...
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

`baseUrl` has to be `https://`. The only exception is a local gateway on `localhost`,
`127.0.0.1` or `::1`; anything else over plain http would put your key id, timestamp and
signature on the wire in the clear, so the constructor throws a `TypeError` instead.

`create-session.mjs`:

```js
import {
  CheckoutRefusedError,
  DominaiteClient,
  orderIdempotencyKey,
  TransportError,
} from '@dominaite/merchant-sdk'

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
    // Required. Same order + same amount = same key, so a reload replays this session.
    idempotencyKey: orderIdempotencyKey({
      scope: 'checkout',
      orderId: 'order-1042',
      amountMinor: 2500,
      currency: 'EUR',
    }),
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
`currency`, `expiresAt` and `integration` (plus `clientSecret` for card fields, see "Card fields"
below). Render the widget with the two cashier fields:

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

How many digits the minor unit has depends on the currency, as the gateway counts it. Most have
two, but not all:

| Exponent | Currencies | `25` of it in minor units |
|---|---|---|
| 2 | EUR, USD, GBP, CAD, AUD, CHF, BGN, RON, PLN, CZK, SEK, DKK, NOK | `2500` |
| 0 | JPY, HUF | `25` |
| 3 | BHD, KWD | `25000` |

**HUF is whole forints.** ISO 4217 gives the forint two decimals, but the gateway charges whole
forints: 2500 HUF is `amount: 2500`, not `250000`. Converting with the ISO exponent charges 100
times too much. ISK, KRW, OMR, JOD and TND are not supported by the helper, because ISO and the
gateway disagree on them.

`toMinorUnits` does the conversion from the decimal string your price list or database already
holds, without floating point:

```js
import { toMinorUnits } from '@dominaite/merchant-sdk'

toMinorUnits('25.00', 'EUR')   // 2500
toMinorUnits('0.30', 'EUR')    // 30
toMinorUnits('2500', 'JPY')    // 2500
toMinorUnits('2500', 'HUF')    // 2500 (whole forints)
toMinorUnits('1.5', 'BHD')     // 1500

toMinorUnits(0.1 + 0.2, 'EUR') // TypeError: pass a string, floats cannot hold prices exactly
toMinorUnits('25.001', 'EUR')  // TypeError: EUR has 2 decimal places
toMinorUnits('25.000', 'EUR')  // TypeError too: extra zeros are not ignored
toMinorUnits('25.00', 'XYZ')   // TypeError: unknown currency, never a guessed default
```

It throws `TypeError` rather than rounding or guessing: a number instead of a string, more
fractional digits than the currency has (zeros included), an unsupported currency, or a currency
missing from `CURRENCY_EXPONENTS`.

## Idempotency keys

Every `createCheckoutSession` and `chargePaymentMethod` call needs an `idempotencyKey`. There is no
default: a missing or empty key throws `TypeError` before anything is sent. A key the SDK made up
would be different on every attempt, which is the double payment the key exists to stop.

Derive the key from the order instead of generating one:

```js
import { orderIdempotencyKey } from '@dominaite/merchant-sdk'

orderIdempotencyKey({ scope: 'checkout', orderId: 'order-1042', amountMinor: 2500, currency: 'eur' })
// 'checkout-order-1042-2500-EUR'
```

- **Same order, same amount, same key.** A page reload, the back button or a retry after a timeout
  sends the key again and replays the same session instead of opening a second payment.
- **Changed amount, new key.** If the basket changes, the amount (or currency) in the key changes
  with it and you get a fresh session. Reusing the old key with a new amount would be refused
  with `IDEMPOTENCY_KEY_REUSED`.
- `scope` keeps different kinds of request for one order apart (`checkout`, `charge`, ...).
- A key is 1 to 100 visible ASCII characters (`0x21` to `0x7E`): no spaces, no accented or
  Cyrillic letters. The helper throws `TypeError` if `scope` and `orderId` break that (slug the
  order id first), or if an input is malformed. `amountMinor` is the integer you send as `amount`.

## Retries and double-charges

Retrying with the same key never opens a second payment - on a timeout, retry with the same key
rather than generating a new one.

`createCheckoutSessionWithRetry` does that for you: it sends your key unchanged on every attempt,
retrying `TransportError` (network failures and 5xx, including `MERCHANT_API_UNAVAILABLE`) and
`PAYMENT_PROCESSING_UNAVAILABLE`, whether it arrives as a 503 or as an HTTP 200 refusal. Other
refusals and authentication failures are not retried - they will not change.

```js
const session = await client.createCheckoutSessionWithRetry(
  {
    amount: 2500,
    currency: 'EUR',
    orderReference: 'order-1042',
    idempotencyKey: orderIdempotencyKey({
      scope: 'checkout', orderId: 'order-1042', amountMinor: 2500, currency: 'EUR',
    }),
  },
  { attempts: 3, baseDelayMs: 500 },   // both optional; delay doubles per attempt
)
```

What a retry (or a page reload) of the same key gets back depends on where the first attempt got:

- **It never reached the gateway.** The retry is an ordinary create and you get a new session.
- **It reached the gateway and the session is still open and unexpired.** A clean replay (same
  amount, currency and `saveCard`) returns the **original** session, `success: true`, with the
  same `transactionId`, `cashierKey` and `cashierToken`. This is how a reload or a lost response
  gets the payer back into the checkout they already had.
- **The payment has moved on, or the body changed.** The retry comes back HTTP 200 with
  `success: false` and a replay code - `DUPLICATE_REQUEST`, `ALREADY_PROCESSED`,
  `PRIOR_ATTEMPT_FAILED` or `IDEMPOTENCY_KEY_REUSED` - which this SDK throws as
  `CheckoutRefusedError`.

So the timeout path can get either a session or a refusal. When the refusal names a
`transactionId`, read it back with `getStatus` to find out what the first attempt did (see
"Recovering from a replay refusal" below).

## Sessions expire

A session is valid for 2 hours. If the payer comes back later, create a new session - and from a
few minutes past `expiresAt` you can re-POST the **same** idempotency key to get one, so keep the
order-derived key for the life of the order (see "Recovering from a replay refusal").

## Card fields

Instead of the hosted widget, you can render card fields inside your own checkout page. Card
fields are enabled per merchant on request: ask Dominaite support to switch them on. Until then a
session with `integration: 'fields'` is rejected with a 400 (`INVALID_SELECTION` on
`integration`).

Pass `integration: 'fields'` when you create the session. Leave it out (or pass `'widget'`) for
the hosted widget. It is part of the idempotency identity, so a replay of the same key with a
different `integration` is refused with `IDEMPOTENCY_KEY_REUSED`.

```js
const session = await client.createCheckoutSession({
  amount: 8440,
  currency: 'EUR',
  orderReference: 'order-1042',
  integration: 'fields',
  idempotencyKey: orderIdempotencyKey({
    scope: 'checkout',
    orderId: 'order-1042',
    amountMinor: 8440,
    currency: 'EUR',
  }),
})
// session.integration === 'fields', session.clientSecret is set
```

Hand `transactionId`, `integration`, `cashierKey`, `cashierToken` and `clientSecret` to the
payer's page, load the drop-in and mount it:

```html
<div id="checkout"></div>
<script src="https://pay.dominaite.com/v1/checkout.js"></script>
<script>
  const checkout = Dominaite.checkout({
    transactionId: 'TRANSACTION_ID_FROM_SESSION',
    integration: 'fields',
    cashierKey: 'CASHIER_KEY_FROM_SESSION',
    cashierToken: 'CASHIER_TOKEN_FROM_SESSION',
    clientSecret: 'CLIENT_SECRET_FROM_SESSION',
  })
  checkout.on('success', () => { /* show a "thank you, confirming" state */ })
  checkout.mount('#checkout')
</script>
```

`clientSecret` is what lets the browser charge this one session: treat it like `cashierToken`,
keep it out of logs and HTML-escape it. A widget session has no `clientSecret`.

The page saying "success" is not proof of payment. Mark the order paid only from the
`payment.succeeded` webhook or a `getStatus()` read, exactly as with the widget.

## Stored payment methods (recurring)

Pass `saveCard: true` when you create a session and, once that payment is approved, the gateway
keeps the card on file. You never see the card number or the provider token: `getStatus()` returns
a `storedPaymentMethod` with an opaque `id` (`pm_` + 32 hex characters), the `brand`, the `last4`
and the expiry, and that `id` is what you charge and revoke with. Store it against your customer.
(`paymentMethod` on the same status is something else: the gateway's string category of how the
payer paid, `card`, `wallet` and so on.)

```js
import { ChargeError, RevokeError } from '@dominaite/merchant-sdk'

const session = await client.createCheckoutSession({
  amount: 2500,
  currency: 'EUR',
  orderReference: 'sub-8817-first',
  idempotencyKey: 'sub-8817-first',
  saveCard: true,
})
// ... the payer completes the hosted checkout ...
const status = await client.getStatus(session.transactionId)
if (status.status === 'succeeded' && status.storedPaymentMethod?.status === 'active') {
  await db.saveCard(customerId, status.storedPaymentMethod.id) // pm_...
}

// Later, off-session, no payer present:
try {
  const charge = await client.chargePaymentMethod(paymentMethodId, {
    amount: 2500,
    currency: 'EUR',
    orderReference: 'sub-8817-2026-10',
    description: 'Monthly plan, October',
    idempotencyKey: 'sub-8817-2026-10', // derive it from the billing period, never random per attempt
  })

  switch (charge.status) {
    case 'succeeded':
      break
    case 'pending':
      // Not terminal. Poll getStatus(charge.transactionId), or wait for the webhook.
      break
    case 'failed':
      // HTTP 402 from the gateway, but not an exception: branch on the class, log the code.
      // hard              - give up on this card, ask the customer for another one
      // soft_funds        - insufficient funds, retry later (not in a loop)
      // soft_sca_required - the issuer wants the customer present: send them through a
      //                     hosted session with saveCard and charge the new method
      // soft_other        - transient, one retry later is reasonable
      // null              - not classified yet: getStatus(charge.transactionId) carries
      //                     the class later. Never read null as hard
      handleDecline(charge.declineClass, charge.declineCode)
      break
    case 'cancelled':
      // An authorization voided before capture; no money moved.
      break
  }
} catch (error) {
  if (error instanceof ChargeError) {
    switch (error.errorCode) {
      case 'CHARGE_OUTCOME_UNKNOWN':
        // 502: the provider gave no verdict, the charge MAY have happened. Never retry
        // under a new key: poll the transaction the gateway attached instead.
        await pollUntilSettled(error.charge.transactionId)
        break
      case 'DUPLICATE_REQUEST':
      case 'PAYMENT_METHOD_CHARGES_DISABLED':
      case 'PAYMENT_PROCESSING_UNAVAILABLE':
        // Nothing was charged; retry later with the SAME idempotency key.
        break
      case 'PAYMENT_METHOD_NOT_ACTIVE':
        // Revoked or expired: bring the customer back for a hosted session with saveCard.
        break
      case 'CHARGE_FAILED':
        // 502, nothing was charged. error.charge is present when a row exists.
        break
      case 'IDEMPOTENCY_KEY_REUSED':
        // Same key, different body or method: a bug on your side.
        break
    }
  } else {
    throw error
  }
}

// When the customer removes the card:
try {
  await client.revokePaymentMethod(paymentMethodId) // 204, resolves with nothing; 204 again if already revoked
} catch (error) {
  if (error instanceof RevokeError && error.errorCode === 'MERCHANT_API_UNAVAILABLE') {
    // 503: nothing changed, retry later.
  } else if (error instanceof RevokeError) {
    // 502 UPSTREAM_CONTRACT_ERROR: the provider refused for good, nothing changed. Contact support with the id.
  }
}
```

A charge is signed exactly like a session and carries an `Idempotency-Key`, so a retry after a
timeout with the **same** key never charges the card twice: the gateway replays its first answer,
HTTP status included. The HTTP status is the contract on this route: 201 (or 200 on a replay)
resolves with the charge, 402 resolves with the charge too (`status: 'failed'`, and a
`declineClass` when the decline arrived with one), and 409, 422, 502 and 503 throw `ChargeError` with `errorCode`, `httpStatus`,
the gateway's message and, when the gateway attached the charge row, `charge` and
`transactionId`. Only authentication (401/403), an id that is not yours (404, `ApiError`),
validation (400, `ApiError`), rate limiting (429) and network failures keep their generic
errors. `declineClass` and `declineCode` are `null` unless the charge was declined. On a
decline, `declineClass` can still be `null`: the charge answer classifies only SCA declines at
once, and `getStatus()` carries the class once the provider settles it. Never read a null class
as hard. The gateway omits null fields on the wire and the SDK reads absent as null.

Revoking signs an empty key and an empty body, like `getStatus()`. A revoke that fails with
`RevokeError` changed nothing: `MERCHANT_API_UNAVAILABLE` (503) is retryable,
`UPSTREAM_CONTRACT_ERROR` (502) is not. After a revoke the status read keeps the
`storedPaymentMethod` with `status: 'revoked'`, and a charge against it is refused with
`PAYMENT_METHOD_NOT_ACTIVE`.

The platform can also retire a card on its own: `status: 'retired'`, with `retiredReason` set to
`hard_decline`, `chargeback` or `source_sale_reversed` (`STORED_PAYMENT_METHOD_RETIRED_REASONS`).
A retired card is refused with `PAYMENT_METHOD_NOT_ACTIVE` too and never becomes active again,
so ask the customer to save a card again. `retiredReason` is `null` on every other card.

### Save a card without a payment

Send `verifyOnly: true` to save a card with no payment. Send `amount: 0` or leave the amount out:
the platform sets the amount of the check. Any other amount throws `TypeError` before anything is
sent. The session always saves the card, so you do not need `saveCard`. It works only with the
widget (`integration` left out or `'widget'`), and the API refuses it with an `agreementId`.

```js
const session = await client.createCheckoutSession({
  verifyOnly: true,
  currency: 'EUR',
  orderReference: 'card-check-8817',
  idempotencyKey: 'card-check-8817',
})
```

The checkout places a small authorization to check the card. The platform releases it within
about 15 minutes, and nobody is charged. The status read carries `verifyOnly: true`. Its `status`
is `requires_capture`, then `cancelled` when the authorization is released. A non-null
`storedPaymentMethod` tells you that the card is verified.

A verify-only session sends `verification.succeeded` or `verification.failed`, never a `payment.*`
event. On `verification.failed`, `data.declineClass` tells you why. It is `null` when the payer
abandoned the checkout. In `listTransactions()` the session is a row with `type: 'verification'`,
and it is not revenue.

Verify-only sessions work only on an account where they are switched on. We switch it on for your
account. Until then, the call throws `AuthenticationError` with `errorCode`
`VERIFY_ONLY_NOT_ENABLED` and `httpStatus` 403. Nothing was created, and you can use the same
idempotency key again.

## Subscriptions

A plan is a recurring price that you sell. An agreement subscribes one of your customers to a
plan. The platform then charges the saved card each period.

1. Create a plan once for each price with `createPlan()`.
2. Create an agreement for the customer with `createAgreement()`. It starts `pending` and charges
   nothing.
3. Create a subscription session: `createCheckoutSession()` with the `agreementId` and the
   customer's `consent`. The checkout takes the session payment and saves the card.
4. When that payment is approved, the agreement goes `active`. The platform then charges each
   period and sends the `agreement.*` and `charge.*` webhooks.

```js
const plan = await client.createPlan({
  name: 'Pro monthly',
  amount: 1999,                              // minor units, each period
  currency: 'EUR',
  intervalUnit: 'month',                     // day, week, month or year
  intervalCount: 1,
  idempotencyKey: 'plan-pro-monthly-1999-EUR',
})

const agreement = await client.createAgreement({
  planId: plan.id,
  customerReference: customerId,             // your own id for the customer
  idempotencyKey: `subscription-${subscriptionId}`,
})

const session = await client.createCheckoutSession({
  agreementId: agreement.id,
  amount: agreement.amount,                  // the agreement's amount, exactly
  currency: agreement.currency,
  orderReference: `subscription-${subscriptionId}`,
  idempotencyKey: `subscription-${subscriptionId}-first`,
  consent: {
    textVersion: 'recurring-2026-09',        // the platform consent text that your page showed
    acceptedAt: new Date().toISOString(),
    ip: customerIp,
  },
})
```

On the subscription session, `consent.textVersion` is the version of the platform consent text
that your page showed: one of `recurring.consentTextVersions` in `getIntegrationContract()`. On
`createAgreement()`, `consent.textVersion` is your own label for your own wording. Without a
trial, the session amount is the agreement's amount. With a trial, you choose the session amount,
and the first scheduled charge comes when the trial ends. When the session cannot start the
subscription, it throws `CheckoutRefusedError`, for example with `SUBSCRIPTIONS_NOT_ENABLED` or
`AGREEMENT_NOT_PENDING`.

The amount, the currency and the interval of a plan never change. For a new price, create a new
plan and archive the old one with `deletePlan()`. The existing agreements keep their own price.
`updatePlan()` changes only `name`, `trialDays` and `cancelUrl`. It sends an `Idempotency-Key`
only when you give one, because the API does not replay a plan update.

`createPlan()` and `createAgreement()` need an idempotency key. The same key with the same body
answers the same object again, so you can repeat a create that timed out. The same key with
another body throws `ApiError` with `errorCode` `IDEMPOTENCY_KEY_REUSED` (422).

`getAgreement()` answers the `status` (`AGREEMENT_STATUSES`) and `nextChargeAt`. On `past_due` it
also answers `pastDueReason` (`PAST_DUE_REASONS`) and `pastDueAt`. For `card_expired` and
`card_revoked`, ask the customer for a new card. The status read of a subscription session carries
`isRecurring`, `agreement` (`id`, `status`, `nextChargeAt`) and `sequence`.

`cancelAgreement()` stops all further charges. It does not reverse a charge that was already
placed. Cancelling a cancelled agreement resolves again. A completed or failed agreement throws
`ApiError` with `errorCode` `AGREEMENT_ENDED` and `httpStatus` 409.

The plan and agreement methods throw `ApiError` with the API's `errorCode`, for example
`PLAN_NOT_FOUND` (404), `PLAN_NOT_ACTIVE` (409) or `AGREEMENT_CONSENT_REQUIRED` (422). The full
answer is on `error.result`.

## Refunds

Refund a payment in full or in part with `createRefund()`. `transactionId` is the id the checkout
session or the charge returned. The amount is minor units of the payment's currency, so convert
with `toMinorUnits()`; omit it to refund everything still refundable (the SDK then sends no
`amount` at all). A refund is always in the payment's currency, and partial refunds add up: the
amount may not exceed what is left after earlier refunds and refunds still in progress.

```js
import { ErrorCodes, RefundError, toMinorUnits } from '@dominaite/merchant-sdk'

// 1,500 HUF back on a payment: HUF has no minor unit here, so this is 1500.
const refund = await client.createRefund(transactionId, {
  amount: toMinorUnits('1500', 'HUF'),
  reason: 'Returned item',                   // optional, at most 500 characters
  idempotencyKey: `refund-${creditNoteId}`,  // required: derive it from YOUR refund
})
// refund.status is 'pending': queued, not done yet.

// Everything still refundable:
await client.createRefund(transactionId, { idempotencyKey: `refund-${creditNoteId}` })

// Later, or while waiting for the webhook:
const current = await client.getRefund(transactionId, refund.refundId)
if (current.status === 'succeeded') {
  // current.amount is what went back to the customer.
} else if (current.status === 'failed') {
  // current.amount is null; current.failureCode says why. A new attempt needs a NEW key.
}
```

`createRefund()` answers HTTP 202 as soon as the refund is queued. The outcome arrives later:
read it with `getRefund()` (signed with an empty key and an empty body, like `getStatus()`) or
wait for `payment.refunded`, which fires once the money has moved. **A refund that fails sends
no webhook**, so poll `getRefund()` if you need to know about failures.

The `Idempotency-Key` is signed, exactly like a charge. Replaying the same key never refunds
twice: the gateway answers 202 with the same refund as it stands now, so a replay doubles as a
status read. The same key with a different amount, reason or payment is refused with
`IDEMPOTENCY_KEY_REUSED`.

A refund (`Refund`) carries `refundId` (`re_` + 32 hex characters), `transactionId`, `status`,
`amount`, `currency`, `failureCode`, `failureMessage` and `completedAt`. The gateway omits null
fields on the wire and the SDK reads absent as null. `amount` is the amount requested on
`pending` (null for a full refund), the amount being refunded on `processing` (null until a full
refund has been sized), the amount actually refunded on `succeeded`, and always null on `failed`.

`status` is one of `REFUND_STATUSES`: `pending` (queued), `processing` (with the payment
provider), `succeeded` or `failed`. The last two are final, and `failed` is final for that key.
A failed refund is a result, not an exception: `failureCode` is one of `REFUND_FAILURE_CODES`
(`REFUND_AMOUNT_EXCEEDED`, `PAYMENT_NOT_REFUNDABLE`, `REFUND_FAILED`). Treat a code you do not
recognise as `REFUND_FAILED`.

When the gateway refuses the request itself, the SDK throws `RefundError` (an `ApiError`) with
`errorCode`, `httpStatus` and `retryable`:

| `errorCode` | HTTP | What to do |
|---|---|---|
| `PAYMENT_NOT_FOUND` | 404 | No card-not-present payment with this id under your account. |
| `REFUND_NOT_FOUND` | 404 | `getRefund()` only. Right after the 202 the refund may not be picked up yet: poll again for up to 60 seconds. `retryable` is true. |
| `PAYMENT_NOT_REFUNDABLE` | 422 | Not paid, already fully refunded, or everything left is already being refunded. Nothing was queued; the key is not burnt. |
| `REFUND_AMOUNT_EXCEEDED` | 422 | More than what is left to refund; the message names the amount left. Nothing was queued; the key is not burnt. |
| `IDEMPOTENCY_KEY_REUSED` | 422 | The key was first used for a different refund. Use a fresh key. |
| `DUPLICATE_REQUEST` | 409 | A request with this key is still being processed. Retry with the **same** key after a second, for up to 120 seconds. `retryable` is true. |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | The key was missing or too long. |

A 500 means nothing was queued and arrives as `TransportError`: retry with the **same** key.

```js
try {
  await client.createRefund(transactionId, { amount, idempotencyKey })
} catch (error) {
  if (error instanceof RefundError && error.errorCode === ErrorCodes.REFUND_AMOUNT_EXCEEDED) {
    // Ask for a smaller amount; the same key can be used again.
  } else if (error instanceof RefundError && error.retryable) {
    // DUPLICATE_REQUEST: try again shortly with the same key.
  }
}
```

On `payment.refunded`, `data.transactionId` is the refund's own transaction id, `data.amount` is
that refund's amount, and `data.originalTransactionId` is the payment it refunds. There is one
event per completed refund, partial or full.

### List the refunds of a payment

`listRefunds(transactionId)` answers the refunds that you created through the API. Each refund has
the shape that `getRefund()` answers. The pending refunds come first, then the processing ones,
then the finished ones, newest first in each group. A new refund is in the list as soon as
`getRefund()` stops answering `REFUND_NOT_FOUND`. A payment with no refunds answers an empty list.

The answer also carries two totals. `refundedAmount` counts every refund of the payment, the
refunds made in the dashboard included. `refundableAmount` is what a new refund can take now.

```js
const { refundableAmount, refunds } = await client.listRefunds(transactionId)
```

## Webhooks

Register an endpoint in the Dominaite dashboard, **Webhooks** tab: an HTTPS URL, the events you
want, and a retry count. The signing secret (`whsec_...`) is shown **once** at creation - store it
like your API secret. Regenerating it replaces the old one immediately. You can have up to 25
active endpoints. You can also manage endpoints from your code: see
[Manage endpoints with the API](#manage-endpoints-with-the-api).

Events you can subscribe to: `payment.succeeded`, `payment.failed`, `payment.requires_capture`,
`payment.cancelled`, `payment.abandoned`, `payment.refunded`, `payment.disputed`. `succeeded` is
the only one that means money in hand. In-flight states (`pending`, `processing`) are never
webhooked - see the polling subsection below for those.

Recurring billing adds `agreement.activated`, `agreement.past_due`, `agreement.cancelled`,
`charge.succeeded`, `charge.failed` and `charge.retrying`, on the same envelope and the same retry
ladder. See [Ordering agreement and charge events](#ordering-agreement-and-charge-events).

Verify-only sessions send `verification.succeeded` and `verification.failed` in place of the
`payment.*` events. See [Save a card without a payment](#save-a-card-without-a-payment).

The body is flat JSON, with no `success` wrapper to branch on:

```json
{
  "id": "7f9c24e5-1d1f-4c0a-9b6c-2f3a4d5e6f70",
  "type": "payment.succeeded",
  "apiVersion": "2026-09-25",
  "createdAt": "2026-08-20T14:00:00Z",
  "data": {
    "transactionId": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
    "orderReference": "order-123",
    "orderId": "dom_9a8b7c6d5e4f",
    "pspReference": "psp_8f3a21c4",
    "description": "Pro plan",
    "status": "succeeded",
    "previousStatus": "pending",
    "kind": "sale",
    "amount": 8440,
    "grossAmount": 8701,
    "surchargeAmount": 261,
    "currency": "EUR",
    "paymentMethod": "card",
    "walletType": null,
    "paymentMethodBrand": "visa",
    "paymentMethodLast4": "4242",
    "originalTransactionId": null,
    "idempotencyKey": "order-123",
    "storedPaymentMethod": null
  }
}
```

Amounts are minor units. On `payment.*` the `amount` is what you are paid and `grossAmount` is the
card movement; on `payment.refunded` the `amount` is what went back to the customer.

Every `payment.*` event carries the same identification fields, typed on `PaymentWebhookData`:

- `transactionId`: our transaction id, the same one create session and `getStatus()` return.
- `orderReference`: your own order reference, the field to match events to your orders on. Null
  when the payment did not start through the API or the session had none; refund and cancel
  events carry the original payment's.
- `orderId`: the hosted checkout order id, as on `getStatus()`. Null for refunds, cancellations
  and payments taken outside hosted checkout.
- `pspReference`: the payment processor's reference, as on `getStatus()`. Null until the
  processor reports it, so read `getStatus()` later if a `payment.succeeded` arrives without it.
  Refund and cancel events carry the original payment's.
- `description`: what you sent on create session. Null when none was given and on refund and
  cancellation events.
- `paymentMethodBrand` and `paymentMethodLast4`: the lower-cased card brand and last four digits
  once a card payment was attempted. Null while the payment is open, for non-card methods, and
  when the provider did not report them.
- `idempotencyKey`: the `Idempotency-Key` you sent on create session. Null on refund and dispute
  events.
- `originalTransactionId`: the earlier transaction this one hangs off. On `payment.refunded` it is
  the refunded payment, and on the `payment.succeeded` of a captured authorization it is the
  authorization. Null otherwise.

Ignore keys you do not know: more may be added without a new `apiVersion`.

`payment.*` data also carries `storedPaymentMethod`: the card a `saveCard` payment stored, the
same object as `storedPaymentMethod` on `getStatus()` (`id`, `brand`, `last4`, `expiryMonth`,
`expiryYear`, `status`, `retiredReason`). It is set on `payment.succeeded` (and
`payment.requires_capture` for an authorization) when the card was stored together with the
approval, and null or absent on every other event and whenever no card was saved. It can also be
null when a card **was** saved, because a card can be stored after the approval was already
announced. The status read is the source of truth: on a `saveCard` payment whose event has no
`storedPaymentMethod`, call `getStatus()` to pick the card up.

The same data carries `verifyOnly` and `declineClass`. `verifyOnly` is `true` on the
`verification.*` events of a verify-only session and `false` on `payment.*` events.
On `verification.failed`, `declineClass` tells you why the issuer declined. It is `null` for an
abandoned checkout and on `payment.*` events.

`apiVersion` is the dated version of the payload shapes. A new date means a breaking change to the
envelope or a `data` shape; added fields keep the current date. A gateway that predates it does not
send it, so the SDK types it as optional.

### Verify first, parse second

Every delivery carries `X-Webhook-Signature: t={unix_seconds},v1={hex}` - HMAC-SHA256 over
`"{t}.{raw_body}"`, keyed with your endpoint secret. `verifyWebhook` checks it in constant time and
rejects a timestamp more than 5 minutes off, which is what stops someone replaying a delivery they
captured earlier.

```js
import express from 'express'
import { parseWebhookEvent, verifyWebhook } from '@dominaite/merchant-sdk'

const app = express()

// express.raw, not express.json: the signature covers the exact bytes that arrived, and
// JSON.parse + re-serialize does not reproduce them.
app.post('/webhooks/dominaite', express.raw({ type: 'application/json' }), (req, res) => {
  const raw = req.body.toString('utf8')

  if (!verifyWebhook(raw, req.get('X-Webhook-Signature') ?? '', process.env.DOMINAITE_WEBHOOK_SECRET)) {
    return res.sendStatus(400)
  }

  const event = parseWebhookEvent(raw)
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

`parseWebhookEvent(raw)` parses the verified body and checks the envelope (`id`, `type`,
`createdAt`, `data`). It returns the JSON as it arrived, typed as `DominaiteWebhookEvent`, so
narrowing on `event.type` gives you `PaymentWebhookData`, `AgreementWebhookData` or
`ChargeWebhookData`. Nothing is renamed or defaulted: a field the gateway adds later comes through,
and one an older gateway does not send yet (`apiVersion`, `sequence`) is simply absent. It throws
`SyntaxError` for a body that is not JSON and `TypeError` for one that is not an envelope.

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
- Order is not guaranteed. For `payment.*`, use `createdAt` and `previousStatus` rather than
  assuming arrival order. For `agreement.*` and `charge.*`, use `data.sequence` (next section).

### Ordering agreement and charge events

Every `agreement.*` and `charge.*` event carries an integer `data.sequence`, counted per object:

> Deliveries can arrive out of order. Keep the highest sequence you have processed per object and
> discard any event whose sequence is not higher; when you need current state, read the object by
> id. createdAt can repeat across events, so order by sequence, not createdAt. A sequence of 0 only
> comes from events recorded before the counter existed; treat it as older than any positive number.

The object is:

- `agreement.*`: the agreement, `data.id`.
- `charge.*` for a platform charge (one with an `agreementId`): the agreement period,
  `data.agreementId` plus `data.periodNumber`.
- `charge.*` for a one-off charge: `data.chargeId`.

```js
function orderingKey(event) {
  if (event.type.startsWith('agreement.')) return `agreement:${event.data.id}`
  if (event.data.agreementId) return `period:${event.data.agreementId}:${event.data.periodNumber}`
  return `charge:${event.data.chargeId}`
}

// Inside your worker, in the same database transaction as the work itself.
const key = orderingKey(event)
const seen = await highestSequence(key)          // undefined when you have none yet
if (seen !== undefined && event.data.sequence <= seen) {
  return                                          // stale or duplicate, drop it
}
await applyEvent(event)
await saveHighestSequence(key, event.data.sequence)
```

`sequence` is typed optional because a gateway older than this contract does not send it. If you
receive events without it, you cannot order them by sequence; read the object by id instead.

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

`paymentMethod` (`card`, `wallet`, `bank_transfer`, `sepa`) and `walletType` (`apple_pay`,
`google_pay`, `samsung_pay`) say how the payer paid; both are null while the payment is open, and
`walletType` is null for non-wallet payments. They are reporting data, not a money-flow switch: a
wallet payment refunds, captures and disputes like a card. A `walletType` outside `WALLET_TYPES`
is a wallet added after this SDK version, so treat it as valid.

`succeeded` is the only value that means the payment is complete. Keep polling on `pending`,
`processing` and `requires_capture` - none of them is terminal.

`requires_capture` is **not** "unpaid": the payer has already paid and the funds are held
awaiting capture. Never treat it as an abandoned order.

Treat any status you do not recognise as still-open as well: a value the API adds later should
make you keep polling, never silently close an order that is still live.

`isPaid` and `isTerminal` encode those rules so your sweep does not have to:

```js
import { isPaid, isTerminal } from '@dominaite/merchant-sdk'

const { status } = await client.getStatus(order.transactionId)
if (isPaid(status)) {
  await fulfil(order)            // succeeded, and only succeeded
} else if (isTerminal(status)) {
  await close(order, status)     // failed, cancelled, abandoned, refunded, partially_refunded
}
// Anything else (pending, processing, requires_capture, disputed, or a value this SDK
// does not know yet) is still open: poll again later.
```

Poll after the payer returns to you, or on your order timeout - not in a tight loop; the endpoint
is rate limited per key. The platform allows 60 requests a minute per API key and 120 a minute per
IP; going over throws `RateLimitError`, which carries `retryAfterSeconds`.

### Manage endpoints with the API

A key with the `webhooks:manage` scope can manage your webhook endpoints from your code.

```js
const endpoint = await client.createWebhookEndpoint({
  url: 'https://shop.example/webhooks/dominaite',
  events: ['payment.succeeded', 'payment.refunded'],
  idempotencyKey: 'webhook-endpoint-main',
})
await saveSecret(endpoint.secret) // whsec_..., shown once
```

The answer carries the signing secret one time only. Store it at once. A repeat with the same
idempotency key answers the same endpoint with `secret: null`, and no other route shows the
secret. If you lose the secret, delete the endpoint and create a new one.

A create that got no answer can still have registered the endpoint. Repeat it with the same key.
If the first create did not finish, the API replaces its endpoint and answers a new `id` and
`secret`. If it did finish, you get the repeat answer with `secret: null`. When you use a key
again more than a day later and its endpoint still exists, the call throws `ApiError` with
`errorCode` `WEBHOOK_ALREADY_REGISTERED`. `error.result.error.params.webhookId` names that
endpoint.

`listWebhookEndpoints()` answers your endpoints newest first, without secrets.
`deleteWebhookEndpoint(id)` stops the deliveries at once. A second delete of the same id throws
`ApiError` with `errorCode` `WEBHOOK_NOT_FOUND` (404): treat that as done. Other refusals are
`WEBHOOK_URL_REJECTED` (400, the URL is not HTTPS on a public host) and `WEBHOOK_LIMIT_REACHED`
(409, you have 25 active endpoints).

## Transactions

`listTransactions()` lists your card-not-present payments, one page at a time, oldest first. It
needs a key with the `transactions:read` scope. Refunds are not rows of their own: a refunded
payment shows `refundedAmount` and its status.

```js
let cursor
do {
  const page = await client.listTransactions({
    from: '2026-10-01T00:00:00Z',            // inclusive
    to: '2026-10-08T00:00:00Z',              // exclusive, at most 31 days after from
    cursor,
  })
  for (const row of page.items) {
    // row.transactionId, row.type, row.status, row.amount, row.refundedAmount, ...
  }
  cursor = page.nextCursor ?? undefined
} while (cursor)
```

The `type` of a row is `payment` (the payer paid on the checkout), `charge` (a saved card was
charged) or `verification` (a verify-only session, not revenue). The `status` has the same values
as `getStatus()`. You can also filter on `status` and set `limit` (1 to 100, 50 by default).
`from` and `to` take an ISO 8601 UTC string or a `Date`. The SDK sends the parameters in the query
string and signs the path only.

A row shows the status at the time of the read. For a statement, end the window a few minutes in
the past. Read the window again later to get status changes such as refunds.

## Integration contract

`getIntegrationContract()` answers the contract that the API publishes about itself: routes,
fields, statuses, error codes, webhook events and signing rules. Every key can read it. The SDK
models only `version`. Read the other fields by name.

```js
const contract = await client.getIntegrationContract()
console.log(contract.version, contract.recurring.consentTextVersions)
```

## Errors

Everything thrown by the SDK extends `DominaiteError`.

| Error | When | What to do |
|---|---|---|
| `CheckoutRefusedError` | The API answered, `success: false`. `errorCode` carries the reason. | Branch on `errorCode`. Do not blind-retry. |
| `StorefrontError` | 409 or 400 about the website the payment belongs to. `errorCode` is a storefront code, see below. Extends `ApiError`. | Fix the storefront setup. Retrying does not help. |
| `RefundError` | A refund route refused with one of the refund codes. Extends `ApiError`; `retryable` says whether the same request can succeed later. | See [Refunds](#refunds). |
| `AuthenticationError` | 401 with `INVALID_API_KEY`, `INVALID_SIGNATURE`, `TIMESTAMP_OUT_OF_RANGE` or `IP_NOT_ALLOWED`. 403 with `INSUFFICIENT_SCOPE` (the key does not hold the route's scope) or `VERIFY_ONLY_NOT_ENABLED`. `httpStatus` tells 401 from 403. | On 401, fix the key id, secret, server clock or allowlist. On `INSUFFICIENT_SCOPE`, use a key that holds the scope. On `VERIFY_ONLY_NOT_ENABLED`, ask us to switch verify-only on. Never retry-loop. |
| `RateLimitError` | 429. `errorCode` says which limit: `RATE_LIMIT_EXCEEDED` (over 60 requests/min for the key or 120/min for the IP), `CHARGE_VELOCITY_EXCEEDED` or `CHARGE_DECLINE_RATE_EXCEEDED` (stored-card charges). `retryAfterSeconds` carries `Retry-After` when it was a whole number of seconds, else `null`. `result` is the whole answer. | Wait `retryAfterSeconds` (or your own backoff), then send it again with the **same** idempotency key. The SDK does not retry this for you. |
| `TransportError` | Network failure, timeout, 5xx (`MERCHANT_API_UNAVAILABLE`), or a response body over 10MB. | Retry with the **same** idempotency key, and expect a replay refusal if the first attempt did land. |
| `ApiError` | Any other rejecting or unexpected response. `httpStatus` carries the HTTP status, `errorCode` the API's code when it sent one, and `result` the whole answer. | Inspect. A 422 means an idempotency key was replayed with a different body - use a fresh key. |
| `ApiError` with a 3xx `httpStatus` | The host you called answered with a redirect. | The Dominaite API never redirects, so the SDK refuses to follow one: your signed headers would be handed to whatever `Location` names, and its answer would look authentic. Check `baseUrl` and any proxy in front of it. |
| `TypeError` | Bad arguments (float amount, missing field or idempotency key, malformed key id). | Fix the call; nothing was sent. |

Refusal codes on `CheckoutRefusedError.errorCode`:

- `PAYMENT_PROCESSING_UNAVAILABLE` - card payments are off right now; retry later with the same
  key. `createCheckoutSessionWithRetry` does this for you.
- `DUPLICATE_REQUEST` - the session for this key is still open but cannot be handed back right
  now (still being created, or expired and not settled yet); re-POST the same key shortly, never a
  fresh one.
- `ALREADY_PROCESSED` - this idempotency key's payment already completed.
- `PRIOR_ATTEMPT_FAILED` - a prior attempt with this key failed terminally; use a fresh key.
- `IDEMPOTENCY_KEY_REUSED` - same key sent with a different body; use a fresh key.

Every code above has a named constant on `ErrorCodes`, so a typo fails to compile instead of
silently never matching:

```js
import { CheckoutRefusedError, ErrorCodes } from '@dominaite/merchant-sdk'

if (error instanceof CheckoutRefusedError && error.errorCode === ErrorCodes.ALREADY_PROCESSED) {
  // ...
}
```

### Storefront errors

If you run more than one website under one merchant account, every session and charge is
attributed to a storefront (one website). When the gateway cannot use that storefront it refuses
the request before anything is created, and the SDK throws `StorefrontError`:

| `errorCode` | HTTP | Meaning | What to do |
|---|---|---|---|
| `STOREFRONT_NOT_WHITELISTED` | 409 | The site's domain is not whitelisted at the payment provider yet. Usually a new website. | Ask Dominaite support to finish the whitelisting. |
| `STOREFRONT_INACTIVE` | 409 | The storefront was deactivated or deleted. | Use the key for an active site, or ask Dominaite support to reactivate it. |
| `STOREFRONT_MISMATCH` | 400 | The storefront in the request is not the one your API key is bound to. | Use the API key issued for that website. |

```js
import { ErrorCodes, StorefrontError } from '@dominaite/merchant-sdk'

try {
  session = await client.createCheckoutSession(params)
} catch (error) {
  if (error instanceof StorefrontError && error.errorCode === ErrorCodes.STOREFRONT_NOT_WHITELISTED) {
    // Configuration, not a blip: alert yourself and show the payer a "try later" page.
  }
}
```

`StorefrontError` extends `ApiError` (with `httpStatus` and `errorCode`), so an existing `ApiError`
branch still catches it. These are never retried, by `createCheckoutSessionWithRetry` or by you.

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

A refusal carries the status of the earlier payment, not its session: no refusal has `cashierKey`
or `cashierToken`. That is fine, because the one case where the session is still payable (open and
unexpired) is not a refusal: the replay returns the original session itself. Reconcile refusals
against the status.

One replay is not a refusal at all. A session that expired unpaid is superseded: from a few
minutes past `expiresAt`, re-POSTing the same key returns an ordinary success with a fresh session
(new `transactionId`, same key), so a customer who comes back late just pays. Keep the
order-derived key for the life of the order to keep that path open. The band is not endless - once
the platform has independently closed the attempt (about an hour past expiry), the replay answers
`PRIOR_ATTEMPT_FAILED` and the key is spent; reconcile and use a fresh key.

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
