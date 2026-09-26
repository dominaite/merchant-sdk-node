import type { RefundFailureCode } from './errors.js'

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
   * method shows up on {@link CheckoutStatus.storedPaymentMethod} after the payment
   * succeeds; a declined first payment stores nothing. The card details themselves never
   * reach you: you get an id, a brand and the last four digits.
   */
  saveCard?: boolean
  /**
   * Required. Derive it from the order with orderIdempotencyKey(), never per attempt:
   * the same key replays the same session, so a reload, a back button or a retry after
   * a timeout never creates a second payment. A new amount needs a new key.
   */
  idempotencyKey: string
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
   * saveCard has been approved, and it stays present after a revoke with status
   * 'revoked'; null (absent on the wire) until then, for sessions without saveCard,
   * and for declined or abandoned ones. Store storedPaymentMethod.id against your
   * customer - it is what {@link DominaiteClient.chargePaymentMethod} takes.
   *
   * Not to be confused with the gateway's paymentMethod field, which is the string
   * category of how the payer paid ('card', 'wallet', ...) and passes through untyped.
   */
  storedPaymentMethod?: StoredPaymentMethod | null
  [key: string]: unknown
}

/**
 * Every state a stored payment method can be in, in the gateway's own order.
 *
 * Only active methods can be charged. revoked is what {@link DominaiteClient.revokePaymentMethod}
 * leaves behind; expired means the card's expiry date has passed; retired means the platform
 * stopped the card on its own (retiredReason says why) and it never becomes active again, so
 * ask the customer to save a card again.
 */
export const STORED_PAYMENT_METHOD_STATUSES = ['active', 'revoked', 'expired', 'retired'] as const

export type StoredPaymentMethodStatus = (typeof STORED_PAYMENT_METHOD_STATUSES)[number]

/**
 * Why the platform retired a stored payment method, in the gateway's own order.
 *
 * hard_decline: a charge on it was declined as final. chargeback: a charge on it was
 * disputed. source_sale_reversed: the payment that saved it was fully refunded or disputed.
 */
export const STORED_PAYMENT_METHOD_RETIRED_REASONS = [
  'hard_decline',
  'chargeback',
  'source_sale_reversed',
] as const

export type StoredPaymentMethodRetiredReason = (typeof STORED_PAYMENT_METHOD_RETIRED_REASONS)[number]

/**
 * A card kept on file. Never the card number, never the PSP token - only what you may
 * show a customer. brand, last4 and the expiry are null when the provider did not
 * report them (the gateway omits null fields on the wire; the SDK reads absent as null).
 */
export interface StoredPaymentMethod {
  /** Opaque id: pm_ followed by 32 hex characters, case-sensitive. The handle you charge and revoke with. */
  id: string
  /** Card brand as the gateway reports it, e.g. 'visa', 'mastercard'. */
  brand: string | null
  /** Last four digits of the card number, for display only. */
  last4: string | null
  /** 1 to 12. */
  expiryMonth: number | null
  /** Four digits, e.g. 2029. */
  expiryYear: number | null
  /** Treat any value you do not recognise as not chargeable. */
  status: StoredPaymentMethodStatus | string
  /**
   * Set when the platform retired the card, and kept if you revoke it afterwards; null on
   * every other card. Treat a value you do not recognise as retired for an unknown reason.
   */
  retiredReason: StoredPaymentMethodRetiredReason | string | null
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
   * Required. Derive it from what you are charging for (the order, the billing period),
   * never per attempt: retrying with the same key never charges the card twice.
   */
  idempotencyKey: string
}

/**
 * Every outcome a charge can report, in the gateway's own order.
 *
 * succeeded: the money moved. failed: it did not; on a 402 declineClass says why.
 * pending: the provider has not answered yet, poll getStatus(transactionId). cancelled:
 * an authorization voided before capture, no money moved. Treat an unknown value as
 * still open.
 */
export const CHARGE_STATUSES = ['succeeded', 'failed', 'pending', 'cancelled'] as const

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

/**
 * What {@link DominaiteClient.chargePaymentMethod} returns, for a placed charge (HTTP 201)
 * and for a provider decline (HTTP 402, status 'failed') alike. Also carried on a
 * {@link ChargeError} when the gateway attached the charge row to its answer.
 */
export interface PaymentMethodCharge {
  /** ch_ followed by 32 hex characters. Store it against the order; it is what support asks for. */
  chargeId: string
  /** succeeded, failed, pending or cancelled. Treat anything you do not recognise as still open. */
  status: ChargeStatus | string
  /** Set on a 402 decline; null everywhere else (the SDK reads absent as null). */
  declineClass: DeclineClass | string | null
  /** The raw decline code, for your logs; branch on declineClass instead. Null when declineClass is. */
  declineCode: string | null
  /** The transaction the charge created; readable with {@link DominaiteClient.getStatus}. */
  transactionId: string
  [key: string]: unknown
}

/** Parameters for {@link DominaiteClient.createRefund}. */
export interface CreateRefundParams {
  /**
   * MINOR units of the payment's currency, at least 1: 2500 is 25.00 EUR, 1500 is 1,500 HUF.
   * Omit it to refund everything still refundable; the SDK then sends no amount at all.
   * Partial refunds add up, and may not exceed what is left after earlier refunds and
   * refunds still in progress.
   */
  amount?: number
  /** Free text stored with the refund, at most 500 characters. */
  reason?: string
  /**
   * Required. Derive it from YOUR refund (the return or credit-note id), never per attempt:
   * the same key answers the same refund and never refunds twice. A failed refund is final
   * for its key, so a new attempt needs a new key.
   */
  idempotencyKey: string
}

/**
 * Every state a refund can be in, in the gateway's own order.
 *
 * pending: queued. processing: with the payment provider. succeeded and failed are final;
 * failed is final for that idempotency key, so a new attempt needs a new key. Treat an
 * unknown value as still open.
 */
export const REFUND_STATUSES = ['pending', 'processing', 'succeeded', 'failed'] as const

export type RefundStatus = (typeof REFUND_STATUSES)[number]

/**
 * What {@link DominaiteClient.createRefund} and {@link DominaiteClient.getRefund} return. The
 * gateway omits null fields on the wire; the SDK reads absent as null.
 */
export interface Refund {
  /** re_ followed by 32 hex characters. The same key on the same payment always names the same refund. */
  refundId: string
  /** The payment being refunded. */
  transactionId: string
  status: RefundStatus | string
  /**
   * MINOR units. Before success, the amount requested (null for a full refund); on
   * succeeded, the amount actually refunded; always null on failed.
   */
  amount: number | null
  /** ISO 4217 code of the payment. */
  currency: string
  /** On failed only. Treat a value you do not recognise as REFUND_FAILED. */
  failureCode: RefundFailureCode | string | null
  /** On failed only: a fixed English explanation of failureCode. */
  failureMessage: string | null
  /** ISO 8601 UTC, when the refund reached succeeded or failed; null before that. */
  completedAt: string | null
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

/**
 * The signed body of every webhook delivery, whatever its type. Parse it with
 * {@link parseWebhookEvent} after {@link verifyWebhook} has accepted the raw bytes.
 */
export interface WebhookEvent<TType extends string = string, TData = Record<string, unknown>> {
  /** Delivery id, stable across retries of the same delivery. Dedupe on it. */
  id: string
  type: TType
  /**
   * Dated version of the payload shapes, e.g. '2026-09-25'. A new date means a breaking
   * change to the envelope or a data shape; added fields keep the current one. Absent on
   * deliveries from a gateway that predates it.
   */
  apiVersion?: string
  /**
   * ISO 8601, when the change happened. Several events can share the same value, so it
   * is not an ordering key: order agreement and charge events by data.sequence instead.
   */
  createdAt: string
  data: TData
  [key: string]: unknown
}

/** The data of a payment.* event. Amounts are minor units. */
export interface PaymentWebhookData {
  transactionId: string
  status: TransactionStatus | string
  previousStatus?: TransactionStatus | string | null
  kind?: string
  /** What you are paid; on payment.refunded, what went back to the customer. */
  amount: number
  /** The card movement, surcharge included. */
  grossAmount?: number
  surchargeAmount?: number
  currency: string
  originalTransactionId?: string | null
  idempotencyKey?: string | null
  /**
   * The card a saveCard payment stored, the same object as
   * {@link CheckoutStatus.storedPaymentMethod}. Set on payment.succeeded (and
   * payment.requires_capture for an authorization) when the card was stored together with
   * the approval; null or absent on every other event and when no card was saved.
   *
   * It can also be null when a card WAS saved: a card can be stored after the approval was
   * already announced. The status read is the source of truth, so on a saveCard payment
   * whose event has no storedPaymentMethod, call getStatus() to pick the card up.
   */
  storedPaymentMethod?: StoredPaymentMethod | null
  [key: string]: unknown
}

/**
 * The data of an agreement.* event: the agreement as the agreement routes return it,
 * plus previousStatus.
 */
export interface AgreementWebhookData {
  /** The agreement id. It is the object data.sequence counts for. */
  id: string
  planId: string
  customerReference: string
  storedPaymentMethodId: string | null
  status: string
  previousStatus: string | null
  /** Minor units. */
  amount: number
  currency: string
  intervalUnit: string
  intervalCount: number
  periodCount: number | null
  trialDays: number
  nextChargeAt: string | null
  activatedAt: string | null
  cancelledAt: string | null
  version: number
  /**
   * Per-agreement counter; process an event only when it is higher than the highest one
   * you have handled for this agreement. 0 means the event was recorded before the counter
   * existed and is older than any positive value. Absent on deliveries from a gateway that
   * predates it.
   */
  sequence?: number
  [key: string]: unknown
}

/** The data of a charge.* event: the charge as the stored-card routes return it, plus the outcome detail. */
export interface ChargeWebhookData {
  chargeId: string
  transactionId: string
  storedPaymentMethodId: string
  /** Set for a platform (agreement) charge, null for a one-off charge. */
  agreementId: string | null
  customerReference: string | null
  outcome: 'succeeded' | 'failed' | 'retrying' | string
  /** Set with agreementId: the billing period this charge is for. */
  periodNumber: number | null
  attemptNumber: number
  /** Minor units. */
  amount: number
  currency: string
  paymentMethod: { brand: string | null; last4: string | null; [key: string]: unknown }
  orderReference: string | null
  description: string | null
  declineClass: DeclineClass | string | null
  declineCode: string | null
  nextAttemptAt: string | null
  nextChargeAt: string | null
  /**
   * Per-object counter, where the object is the agreement period (agreementId +
   * periodNumber) for a platform charge and chargeId for a one-off charge. Process an event
   * only when it is higher than the highest one you have handled for that object. 0 means
   * the event was recorded before the counter existed and is older than any positive value.
   * Absent on deliveries from a gateway that predates it.
   */
  sequence?: number
  [key: string]: unknown
}

export type PaymentWebhookEvent = WebhookEvent<
  | 'payment.succeeded'
  | 'payment.failed'
  | 'payment.requires_capture'
  | 'payment.cancelled'
  | 'payment.abandoned'
  | 'payment.refunded'
  | 'payment.disputed',
  PaymentWebhookData
>

export type AgreementWebhookEvent = WebhookEvent<
  'agreement.activated' | 'agreement.past_due' | 'agreement.cancelled',
  AgreementWebhookData
>

export type ChargeWebhookEvent = WebhookEvent<
  'charge.succeeded' | 'charge.failed' | 'charge.retrying',
  ChargeWebhookData
>

/**
 * Every event type this SDK version models; narrow on `type`. A type added to the gateway
 * later still parses, with the same envelope, so check `type` before trusting `data`.
 */
export type DominaiteWebhookEvent = PaymentWebhookEvent | AgreementWebhookEvent | ChargeWebhookEvent
