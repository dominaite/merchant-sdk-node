/** Optional payer details. Prefilled fields are hidden from the payer in the widget. */
export interface CheckoutCustomer {
  firstName?: string
  lastName?: string
  email?: string
  phone?: string
}

/** Parameters for {@link DominaiteClient.createCheckoutSession}. */
export interface CreateCheckoutSessionParams {
  /** MINOR units - 2500 is 25.00 EUR. Integers only, never floats. */
  amount: number
  /** ISO 4217, e.g. 'EUR'. */
  currency: string
  /** Your own order id, <= 100 chars. Shows up in your dashboard. */
  orderReference: string
  customer?: CheckoutCustomer
  /** ISO 3166-1 alpha-2. */
  country?: string
  /** ISO 639-1 widget UI language. */
  language?: string
  theme?: 'light' | 'dark' | 'bright'
  description?: string
  /**
   * Ask the gateway to keep the card on file once this payment is approved, so you can
   * charge it again later with {@link DominaiteClient.chargePaymentMethod}. The stored
   * method shows up on {@link CheckoutStatus.paymentMethod} after the payment succeeds;
   * a declined first payment stores nothing. The card details themselves never reach
   * you: you get an id, a brand and the last four digits.
   */
  saveCard?: boolean
  /**
   * Auto-generated when omitted. Retrying with the same key never creates a
   * second payment - on a timeout, retry with the same key.
   */
  idempotencyKey?: string
  /** Anything else the API accepts. */
  [key: string]: unknown
}

/** What {@link DominaiteClient.createCheckoutSession} returns. */
export interface CheckoutSession {
  transactionId: string
  orderId: string
  /** Feeds the widget's data-cashier-key. Per-payment value, not a credential. */
  cashierKey: string
  /**
   * Feeds the widget's data-cashier-token. Per-payment value, not a credential, but it
   * drives the payment - do not log it, and do not log the whole session object either.
   */
  cashierToken: string
  /** MINOR units. */
  amount: number
  currency: string
  /** ISO 8601. Sessions are valid for 2 hours. */
  expiresAt: string
  [key: string]: unknown
}

/**
 * Every status the merchant API can report, in the gateway's own order.
 *
 * A value here, not a bare union, so the list survives compilation and a test can
 * compare it against the published contract fixture. Recognising a status is not the
 * same as closing an order - see {@link DominaiteClient.getStatus} for which ones are
 * terminal.
 */
export const TRANSACTION_STATUSES = [
  'pending',
  'processing',
  'succeeded',
  'failed',
  'refunded',
  'partially_refunded',
  'cancelled',
  'disputed',
  'requires_capture',
  'abandoned',
] as const

export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number]

/** What {@link DominaiteClient.getStatus} returns. */
export interface CheckoutStatus {
  transactionId: string
  orderId: string
  orderReference?: string
  status: TransactionStatus | string
  /** MINOR units. */
  amount: number
  currency: string
  refundedAmount?: number
  createdAt: string
  updatedAt?: string
  /** Present while the session is still payable. */
  expiresAt?: string
  /**
   * The card kept on file for this payment. Present once a session created with
   * saveCard has succeeded; absent otherwise. Store paymentMethod.id against your
   * customer - it is what {@link DominaiteClient.chargePaymentMethod} takes.
   */
  paymentMethod?: PaymentMethod
  [key: string]: unknown
}

/**
 * Every state a stored payment method can be in, in the gateway's own order.
 *
 * Only active methods can be charged. revoked is what {@link DominaiteClient.revokePaymentMethod}
 * leaves behind; expired means the card's expiry date has passed.
 */
export const PAYMENT_METHOD_STATUSES = ['active', 'revoked', 'expired'] as const

export type PaymentMethodStatus = (typeof PAYMENT_METHOD_STATUSES)[number]

/** A card kept on file. Never the card number, never the PSP token - only what you may show a customer. */
export interface PaymentMethod {
  /** Opaque id, pm_... - the handle you charge and revoke with. */
  id: string
  /** Card brand as the gateway reports it, e.g. 'visa', 'mastercard'. */
  brand: string
  /** Last four digits of the card number, for display only. */
  last4: string
  /** 1 to 12. */
  expiryMonth: number
  /** Four digits, e.g. 2029. */
  expiryYear: number
  /** Treat any value you do not recognise as not chargeable. */
  status: PaymentMethodStatus | string
  [key: string]: unknown
}

/** Parameters for {@link DominaiteClient.chargePaymentMethod}. */
export interface ChargePaymentMethodParams {
  /** MINOR units - 2500 is 25.00 EUR. Integers only, never floats. */
  amount: number
  /** ISO 4217, e.g. 'EUR'. */
  currency: string
  /** Your own order id, <= 100 chars. Shows up in your dashboard. */
  orderReference: string
  description?: string
  /**
   * Auto-generated when omitted. Retrying with the same key never charges the card
   * twice - on a timeout, retry with the same key.
   */
  idempotencyKey?: string
}

/** Every outcome a charge can report. pending is not terminal: keep polling getStatus(). */
export const CHARGE_STATUSES = ['succeeded', 'failed', 'pending'] as const

export type ChargeStatus = (typeof CHARGE_STATUSES)[number]

/**
 * Why a charge failed, coarse enough to act on without reading the issuer's code:
 * - hard: do not retry this card, ask the customer for another one.
 * - soft_funds: insufficient funds; retry later (after the customer's payday, not in a loop).
 * - soft_sca_required: the issuer wants the customer present; send them through a hosted
 *   checkout session with saveCard instead of charging off-session again.
 * - soft_other: a transient issuer or network condition; one retry later is reasonable.
 */
export const DECLINE_CLASSES = ['hard', 'soft_funds', 'soft_sca_required', 'soft_other'] as const

export type DeclineClass = (typeof DECLINE_CLASSES)[number]

/** What {@link DominaiteClient.chargePaymentMethod} returns. */
export interface PaymentMethodCharge {
  chargeId: string
  /** succeeded, failed or pending. Treat anything you do not recognise as still open. */
  status: ChargeStatus | string
  /** Present when status is failed. */
  declineClass?: DeclineClass | string
  /** The raw decline code, for your logs; branch on declineClass instead. */
  declineCode?: string
  /** The transaction the charge created; readable with {@link DominaiteClient.getStatus}. */
  transactionId: string
  [key: string]: unknown
}

/** What {@link DominaiteClient.ping} returns: proof your key, signing and clock are good. */
export interface Ping {
  /** Always true on a 200. */
  pong: boolean
  /** The merchant id your key authenticated as. */
  merchantId: string
  /** ISO 8601 server time. */
  serverTime?: string
  /** Server time in unix seconds. */
  serverUnixTime?: number
  /** Server time minus your X-Timestamp. Requests start failing at 300. */
  clockSkewSeconds: number
  [key: string]: unknown
}

/** Constructor options for {@link DominaiteClient}. */
export interface DominaiteClientOptions {
  /** Your API key id (dmk_...), from the dashboard's Website integration tab. */
  keyId: string
  /** Your API secret (dms_...). Server-side only. */
  secret: string
  /**
   * Override for non-production environments. Defaults to the production API.
   *
   * Must be https://. Plain http is accepted only for localhost, 127.0.0.1 and ::1,
   * so a local gateway still works while a staging host cannot end up sending your
   * signed headers in the clear.
   */
  baseUrl?: string
  /** Per-request timeout in milliseconds. Defaults to 45000. */
  timeoutMs?: number
  /** Injectable fetch, for tests or a proxy-aware implementation. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch
}

/** Options for {@link DominaiteClient.createCheckoutSessionWithRetry}. */
export interface RetryOptions {
  /** Total attempts including the first. Defaults to 3. */
  attempts?: number
  /** Delay before the first retry; doubles each attempt. Defaults to 500. */
  baseDelayMs?: number
}
