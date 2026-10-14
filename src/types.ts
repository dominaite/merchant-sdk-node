import type { RefundFailureCode } from './errors.js'

/** Optional payer details. Prefilled fields are hidden from the payer in the widget. */
export interface CheckoutCustomer {
  firstName?: string
  lastName?: string
  email?: string
  phone?: string
}

/**
 * The customer's acceptance of recurring terms, as you recorded it on your own page. Send
 * all three fields together.
 */
export interface AgreementConsent {
  /**
   * Which wording the customer accepted. On createCheckoutSession it is a version of the
   * PLATFORM consent text, one of the contract's recurring.consentTextVersions (for
   * example 'recurring-2026-09'), never your own wording. On createAgreement it is your
   * own label for your wording, 1 to 50 characters.
   */
  textVersion: string
  /** When the customer accepted: ISO 8601 UTC, not in the future. */
  acceptedAt: string
  /** The customer's IPv4 or IPv6 address at acceptance. */
  ip: string
  /** Anything else the API accepts. */
  [key: string]: unknown
}

/** Parameters for {@link DominaiteClient.createCheckoutSession}. */
export interface CreateCheckoutSessionParams {
  /**
   * MINOR units - 2500 is 25.00 EUR. Integers only, never floats. Required and above 0,
   * except with verifyOnly: then send 0 or leave it out.
   */
  amount?: number
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
   * The id (a UUID) of the storefront this payment belongs to. Leave it out and the
   * gateway uses your default storefront. An id that is not one of your storefronts is
   * refused with 404; a key bound to one storefront refuses a different id with
   * STOREFRONT_MISMATCH.
   */
  locationId?: string
  /**
   * Ask the gateway to keep the card on file once this payment is approved, so you can
   * charge it again later with {@link DominaiteClient.chargePaymentMethod}. The stored
   * method shows up on {@link CheckoutStatus.storedPaymentMethod} after the payment
   * succeeds; a declined first payment stores nothing. The card details themselves never
   * reach you: you get an id, a brand and the last four digits.
   */
  saveCard?: boolean
  /**
   * Save the payer's card without a payment. The checkout places a small authorization,
   * saves the card and releases the authorization; nobody is charged. Send amount 0 or
   * leave it out. saveCard is implied, integration must be 'widget', and agreementId is
   * refused. The status read then carries verifyOnly: true, and a storedPaymentMethod is
   * what says the card is verified. Refused with 403 VERIFY_ONLY_NOT_ENABLED (an
   * AuthenticationError) until verify-only is on for your account. We switch it on for
   * your account.
   */
  verifyOnly?: boolean
  /**
   * The agr_ handle of a PENDING agreement from createAgreement(). It makes this the
   * subscription session that takes the agreement's first payment, saves the card and
   * activates the agreement. Amount and currency must be the agreement's own (on a plan
   * with a trial only the currency is held). The card is always saved.
   */
  agreementId?: string
  /**
   * Only with agreementId: the customer's acceptance of the platform consent text.
   * Required unless the agreement already carries consent that names a platform version.
   */
  consent?: AgreementConsent
  /**
   * How the payer enters the card. 'widget' (the default when omitted) is the hosted
   * cashier widget; 'fields' renders card fields in your own page with checkout.js.
   * Card fields are enabled per merchant on request; 'fields' on an account without them
   * is rejected with a 400. Part of the idempotency identity: replaying a key with a
   * different integration is refused with IDEMPOTENCY_KEY_REUSED. Omitted from the body
   * when not set.
   */
  integration?: CheckoutIntegration
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
  /** The integration in effect: 'widget' or 'fields'. Always present on a session. */
  integration: CheckoutIntegration | string
  /**
   * Present only when integration is 'fields': an opaque string of at most 128 characters,
   * the same on every replay of the session. Hand it to the payer's page for checkout.js,
   * which sends it as its bearer credential. Do not log or store it. Absent (null) for
   * 'widget'.
   */
  clientSecret?: string | null
  /**
   * True on a verify-only session: amount is then the platform's verification hold, released
   * once the card is saved. Absent (null) on a payment session.
   */
  verifyOnly?: boolean | null
  /** The agr_ handle of the agreement this session takes the first payment for. Absent (null) on a one-off checkout. */
  agreementId?: string | null
  [key: string]: unknown
}

/**
 * The values {@link CreateCheckoutSessionParams.integration} accepts, pinned against the
 * contract's integrationVocabulary.
 */
export const CHECKOUT_INTEGRATIONS = ['widget', 'fields'] as const

export type CheckoutIntegration = (typeof CHECKOUT_INTEGRATIONS)[number]

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

/**
 * Every payment method category the merchant API reports in paymentMethod, in the
 * gateway's own order.
 *
 * Reporting data, not a money-flow switch: a wallet payment refunds, captures and
 * disputes exactly like a plain card payment.
 */
export const PAYMENT_METHOD_CATEGORIES = ['card', 'wallet', 'bank_transfer', 'sepa'] as const

export type PaymentMethodCategory = (typeof PAYMENT_METHOD_CATEGORIES)[number]

/**
 * The wallets the gateway currently names in walletType, pinned against the contract's
 * wallets.walletTypes. The field can carry a lower-cased identifier not in this list yet:
 * treat an unknown value as a valid wallet, not an error.
 */
export const WALLET_TYPES = ['apple_pay', 'google_pay', 'samsung_pay'] as const

export type WalletType = (typeof WALLET_TYPES)[number]

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
   * Not to be confused with paymentMethod below, which is the category of how the payer
   * paid ('card', 'wallet', ...).
   */
  storedPaymentMethod?: StoredPaymentMethod | null
  /**
   * The payment processor's reference for the transaction. null until known, and null for a
   * sale settled by reconciliation without a processor webhook; refund and cancel events carry
   * the original sale's reference. Absent on a gateway that predates it.
   */
  pspReference?: string | null
  /**
   * How the payer paid: one of {@link PAYMENT_METHOD_CATEGORIES}. null while the payment is
   * still open (no method chosen yet) and on older transactions. Reporting data only: a
   * wallet payment refunds, captures and disputes like a card.
   */
  paymentMethod?: PaymentMethodCategory | (string & {}) | null
  /**
   * Which wallet, when paymentMethod is 'wallet'. A value outside {@link WALLET_TYPES} is a
   * wallet the gateway added after this SDK released: treat it as a valid wallet, not an
   * error. null for non-wallet payments. Do not branch payment handling on it.
   */
  walletType?: WalletType | (string & {}) | null
  /**
   * True on a verify-only session: a card check, not a payment. status stays the raw status
   * (requires_capture, then cancelled once the hold is released); a non-null
   * storedPaymentMethod is what says the card is verified. Absent (null) on every other
   * session.
   */
  verifyOnly?: boolean | null
  /**
   * What to do with a failed payment: one of {@link DECLINE_CLASSES}, or a class the
   * gateway added after this SDK released. Null while the payment is open and on every
   * status other than failed. It can be null on a failed payment too, for example when
   * nobody declined the payment. Never read null as hard; if you retry, retry as you would
   * for soft_other.
   */
  declineClass?: DeclineClass | (string & {}) | null
  /**
   * True when you initiated this charge on a stored card (chargePaymentMethod or an
   * agreement), false for a payer in a hosted checkout session.
   */
  isRecurring: boolean
  /**
   * The agreement this session took the first payment for, or the agreement a charge was
   * made under. Pending until the approval activates it. Absent (null) on a one-off payment.
   */
  agreement?: CheckoutStatusAgreement | null
  /**
   * The data.sequence of the latest charge.* webhook event about this transaction, so you
   * can order this read against those events. 0 on a checkout payment, which announces
   * payment.* events only, and before the first charge.* event.
   */
  sequence: number
  [key: string]: unknown
}

/** The agreement on a status read: enough to know whether the subscription started. */
export interface CheckoutStatusAgreement {
  /** The agr_ handle. */
  id: string
  /** pending until the approval activates it. Treat a value you do not recognise as not active. */
  status: AgreementStatus | (string & {})
  /** When the next charge is due (ISO 8601 UTC). Null while pending and once the agreement ended. */
  nextChargeAt?: string | null
  [key: string]: unknown
}

/**
 * Every status an agreement can report, in the gateway's own order.
 *
 * pending: created, nothing charged; the subscription session activates it. active: the
 * first period is paid. With scheduled charges on, the platform charges each period.
 * past_due: a period's charge failed for good (pastDueReason says why); a new card that pays
 * the period makes it active again. cancelled: ended by you, no further charges. completed:
 * every period of a plan with a fixed periodCount was charged. failed: reserved, the platform
 * does not set it today. Treat a value you do not recognise as not billing.
 */
export const AGREEMENT_STATUSES = ['pending', 'active', 'past_due', 'cancelled', 'completed', 'failed'] as const

export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number]

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
  /** Stored on the payment, at most 500 characters. */
  description?: string
  /**
   * The agr_ handle of the agreement this charge is made under. The gateway then holds the
   * charge to the agreement's terms: its payment method, its currency and its amount (at
   * most maxAmountPerPeriod on a variable agreement). Leave it out for a charge outside an
   * agreement.
   */
  agreementId?: string
  /**
   * Required. Derive it from what you are charging for (the order, the billing period),
   * never per attempt: retrying with the same key never charges the card twice.
   */
  idempotencyKey: string
  /** Anything else the API accepts. */
  [key: string]: unknown
}

/**
 * Every outcome a charge can report, in the gateway's own order.
 *
 * succeeded: the money moved. failed: it did not; on a 402 declineClass says why, and it
 * can be null.
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
  /**
   * The class of a 402 decline, and null on every other status. declineClass can be null,
   * for example when nobody declined the payment. getStatus(transactionId) carries the
   * latest class. Never read null as hard. The SDK reads absent as null.
   */
  declineClass: DeclineClass | string | null
  /** On a decline, the provider's decline code, for your logs; branch on declineClass instead. Null otherwise. */
  declineCode: string | null
  /** The transaction the charge created; readable with {@link DominaiteClient.getStatus}. */
  transactionId: string
  /** The agr_ handle of the agreement the charge was made under; null without one. */
  agreementId: string | null
  /**
   * The charge's outcome counter: the data.sequence of its charge.succeeded or charge.failed
   * webhook when the charge was decided at once, 0 while pending. A replay returns the first
   * answer, so a later webhook can be higher; getStatus() carries the live value.
   */
  sequence: number
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
  /** Anything else the API accepts. */
  [key: string]: unknown
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
   * MINOR units. On pending, the amount requested (null for a full refund); on processing,
   * the amount being refunded (null until a full refund has been sized); on succeeded, the
   * amount actually refunded; always null on failed.
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

/** What {@link DominaiteClient.listRefunds} returns: one payment's refunds and its totals. */
export interface RefundList {
  /** The payment whose refunds these are. */
  transactionId: string
  /** ISO 4217 code of the payment and of every amount here. */
  currency: string
  /** MINOR units refunded so far, from every source: this API, the dashboard and the provider. */
  refundedAmount: number
  /** MINOR units a new refund could take right now. 0 when the payment cannot be refunded. */
  refundableAmount: number
  /**
   * The refunds created through this API, newest first, each in the shape getRefund()
   * returns. Refunds made in the dashboard count in the totals but are not listed.
   */
  refunds: Refund[]
  [key: string]: unknown
}

/** The units a plan's billing interval is counted in, in the gateway's own order. */
export const INTERVAL_UNITS = ['day', 'week', 'month', 'year'] as const

export type IntervalUnit = (typeof INTERVAL_UNITS)[number]

/**
 * Every status a plan can have, in the gateway's own order. Only an active plan accepts new
 * agreements; an archived plan keeps billing the agreements it already has.
 */
export const PLAN_STATUSES = ['active', 'archived'] as const

export type PlanStatus = (typeof PLAN_STATUSES)[number]

/** Parameters for {@link DominaiteClient.createPlan}. */
export interface CreatePlanParams {
  /** Display name, 1 to 100 characters. You can change it later with updatePlan(). */
  name: string
  /** The charge per period in MINOR units of currency: 2500 is 25.00 EUR. You cannot change it later. */
  amount: number
  /** ISO 4217 code, three upper-case letters. You cannot change it later. */
  currency: string
  /** day, week, month or year. You cannot change it later. */
  intervalUnit: IntervalUnit | (string & {})
  /**
   * Units per billing period, 1 when left out: month with 3 bills every 3 months. The
   * interval is at most one year.
   */
  intervalCount?: number
  /** The number of periods after which each agreement completes. Leave it out to bill until cancelled. */
  periodCount?: number
  /** Days from activation to the first charge, 0 to 365. Leave it out or send 0 for no trial. */
  trialDays?: number
  /**
   * Your page where the customer cancels: an absolute https URL of at most 2048 characters.
   * The platform prints it on every receipt and decline notice it emails the customer.
   */
  cancelUrl?: string
  /**
   * Required. Derive it from YOUR plan, never per attempt: the same key with the same body
   * answers the same plan, so a create whose answer you lost is safe to repeat.
   */
  idempotencyKey: string
  /** Anything else the API accepts. */
  [key: string]: unknown
}

/** Parameters for {@link DominaiteClient.updatePlan}. Send at least one field; a field you leave out stays as it is. */
export interface UpdatePlanParams {
  /** The new display name, 1 to 100 characters. */
  name?: string
  /** The new trial, 0 to 365 days (0 removes it). Only agreements created after the change get it. */
  trialDays?: number
  /** The new cancel page (absolute https URL). An empty string removes it. */
  cancelUrl?: string
  /** Optional: the API does not replay a plan update, so the SDK sends a key only when you give one. */
  idempotencyKey?: string
  /** Anything else the API accepts. */
  [key: string]: unknown
}

/** A recurring price you sell, as the plan routes return it. */
export interface Plan {
  /** plan_ followed by 32 hex characters. Case-sensitive: store and send it exactly as returned. */
  id: string
  name: string
  /** The charge per period in MINOR units of currency. */
  amount: number
  currency: string
  intervalUnit: IntervalUnit | (string & {})
  intervalCount: number
  /** The fixed number of periods; null bills until cancelled. */
  periodCount: number | null
  trialDays: number
  /** active or archived. Treat a value you do not recognise as not accepting agreements. */
  status: PlanStatus | (string & {})
  /** Your cancel page; null when you gave none. */
  cancelUrl: string | null
  /** ISO 8601 UTC. */
  createdAt: string
  /** ISO 8601 UTC; null while active. */
  archivedAt: string | null
  [key: string]: unknown
}

/** Parameters for {@link DominaiteClient.createAgreement}. */
export interface CreateAgreementParams {
  /** The plan_ id of one of your active plans. */
  planId: string
  /** Your own id for the customer, 1 to 100 characters, the same for every agreement of that customer. */
  customerReference: string
  /**
   * The pm_ id of an active card this customer already saved, saved from a payment in the
   * plan's currency. Leave it out to let the subscription session save a card. Needs consent.
   */
  storedPaymentMethodId?: string
  /**
   * The customer's acceptance, when you captured it on your own page. textVersion is your
   * own label here. Required with storedPaymentMethodId and with maxAmountPerPeriod.
   */
  consent?: AgreementConsent
  /**
   * For a variable amount only (seat plus usage): the most one charge may be, in MINOR
   * units, at least the plan's amount. Needs consent. Leave it out for a fixed agreement.
   */
  maxAmountPerPeriod?: number
  /**
   * Required. Derive it from YOUR subscription, never per attempt: the same key with the
   * same body answers the same agreement.
   */
  idempotencyKey: string
  /** Anything else the API accepts. */
  [key: string]: unknown
}

/**
 * Why an agreement is past_due, in the gateway's own order. card_expired and card_revoked:
 * the customer can fix it with a new card. hard_decline and dunning_exhausted: the issuer
 * declined. sca_required: the issuer wants the customer present. unprocessable: the charge
 * could not be placed at all. Treat a value you do not recognise as needing a new card.
 */
export const PAST_DUE_REASONS = [
  'card_expired',
  'card_revoked',
  'hard_decline',
  'dunning_exhausted',
  'sca_required',
  'unprocessable',
] as const

export type PastDueReason = (typeof PAST_DUE_REASONS)[number]

/** The consent recorded on an agreement: what was sent, plus the platform's own receipt. */
export interface AgreementConsentRecord {
  /** As it was sent, on createAgreement or on the subscription session. */
  textVersion: string
  /** ISO 8601 UTC, as it was sent. */
  acceptedAt: string | null
  /** The customer's address, as it was sent. */
  ip: string
  /** ISO 8601 UTC, when the consent reached the platform (server clock). */
  receivedAt: string | null
  /** The address of the server that sent the consent, not the customer's. Often null. */
  receivedFromIp: string | null
  [key: string]: unknown
}

/** A customer's subscription to a plan, as the agreement routes return it. */
export interface Agreement {
  /** agr_ followed by 32 hex characters. Case-sensitive: store and send it exactly as returned. */
  id: string
  /** The plan the agreement was created from. */
  planId: string
  customerReference: string
  /** The pm_ id of the card on file; null until a card is saved. */
  storedPaymentMethodId: string | null
  /** Treat a value you do not recognise as not billing. */
  status: AgreementStatus | (string & {})
  /** The charge per period in MINOR units, copied from the plan when the agreement was created. */
  amount: number
  /** The most one charge may be on a variable agreement; null on a fixed one. */
  maxAmountPerPeriod: number | null
  currency: string
  intervalUnit: IntervalUnit | (string & {})
  intervalCount: number
  /** null bills until cancelled. */
  periodCount: number | null
  trialDays: number
  /** ISO 8601 UTC of the next charge; null while pending and once ended. */
  nextChargeAt: string | null
  /** Why the agreement is past_due; null in every other status. */
  pastDueReason: PastDueReason | (string & {}) | null
  /** ISO 8601 UTC, when it went past_due; null in every other status. */
  pastDueAt: string | null
  /** The recorded consent; null until captured. */
  consent: AgreementConsentRecord | null
  /** Starts at 1 and rises when the price changes for a future period. */
  version: number
  /** The agreement's change counter: equal to data.sequence of its latest agreement.* event, 0 before the first. */
  sequence: number
  /** ISO 8601 UTC. */
  createdAt: string
  /** ISO 8601 UTC; null while pending. */
  activatedAt: string | null
  /** ISO 8601 UTC; null unless cancelled. */
  cancelledAt: string | null
  [key: string]: unknown
}

/**
 * Every status a webhook endpoint can have, in the gateway's own order. active: deliveries
 * are sent. inactive: deliveries are paused, because the endpoint was switched off in the
 * dashboard or after repeated failed deliveries. Treat a value you do not recognise as paused.
 */
export const WEBHOOK_ENDPOINT_STATUSES = ['active', 'inactive'] as const

export type WebhookEndpointStatus = (typeof WEBHOOK_ENDPOINT_STATUSES)[number]

/** Parameters for {@link DominaiteClient.createWebhookEndpoint}. */
export interface CreateWebhookEndpointParams {
  /** The HTTPS URL on a public host that receives the deliveries, at most 500 characters. */
  url: string
  /** The event types to deliver, 1 to 50 of them, for example 'payment.succeeded'. */
  events: string[]
  /**
   * Required. Derive it from YOUR endpoint, never per attempt. Repeat a create that got no
   * answer with the SAME key: the API then never keeps two endpoints for one key.
   */
  idempotencyKey: string
  /** Anything else the API accepts. */
  [key: string]: unknown
}

/** A webhook endpoint, as {@link DominaiteClient.listWebhookEndpoints} returns it. */
export interface WebhookEndpoint {
  /** The endpoint id (a UUID). deleteWebhookEndpoint() takes it. */
  id: string
  /** The URL as registered. */
  url: string
  /** The event types delivered to this endpoint. */
  events: string[]
  status: WebhookEndpointStatus | (string & {})
  /** ISO 8601 UTC. */
  createdAt: string
  [key: string]: unknown
}

/** What {@link DominaiteClient.createWebhookEndpoint} returns: the endpoint and, once, its secret. */
export interface CreatedWebhookEndpoint extends WebhookEndpoint {
  /**
   * The whsec_ signing secret for verifyWebhook(). Only the first answer carries it: a
   * repeat with the same key answers the same endpoint with secret null. Store it at once.
   * No route shows it again; to replace a lost secret, delete the endpoint and create a new one.
   */
  secret: string | null
}

/**
 * How a listed payment was taken, in the gateway's own order. payment: the payer paid on the
 * checkout. charge: a saved card was charged, by you or by the subscription schedule.
 * verification: a verify-only session saved a card; it is not a purchase, so leave it out of
 * revenue. Treat a value you do not recognise as not revenue until you have checked it.
 */
export const TRANSACTION_TYPES = ['payment', 'charge', 'verification'] as const

export type TransactionType = (typeof TRANSACTION_TYPES)[number]

/** Parameters for {@link DominaiteClient.listTransactions}. They go in the query string. */
export interface ListTransactionsParams {
  /** Window start, inclusive, on createdAt: ISO 8601 UTC (use the Z form) or a Date. */
  from: string | Date
  /** Window end, exclusive: later than from and at most 31 days after it. ISO 8601 UTC or a Date. */
  to: string | Date
  /**
   * Settlement window start, inclusive: a date (2026-10-13) or a Date, sent as its UTC date.
   * Send it with settledTo. from and to still apply on createdAt.
   */
  settledFrom?: string | Date
  /** Settlement window end, exclusive: later than settledFrom and at most 31 days after it. */
  settledTo?: string | Date
  /** Only payments that are in this status now. */
  status?: TransactionStatus | (string & {})
  /** Items per page, 1 to 100. The API uses 50 when you leave it out. */
  limit?: number
  /** The nextCursor of the previous page, unchanged. Leave it out for the first page. */
  cursor?: string
  /** Any other query parameter the API accepts, sent as given. */
  [key: string]: unknown
}

/** One payment on a {@link TransactionPage}. The fields have the same values as the status read. */
export interface Transaction {
  /** The payment id that the session or the charge returned. */
  transactionId: string
  /** Your own order id from createCheckoutSession(); null when you sent none. */
  orderReference: string | null
  type: TransactionType | (string & {})
  /** The status now, the same value getStatus() answers. */
  status: TransactionStatus | (string & {})
  /** MINOR units of currency. */
  amount: number
  currency: string
  /** ISO 8601 UTC. The window and the order use it. */
  createdAt: string
  /** ISO 8601 UTC, when the payment first succeeded; null when it never did and on older payments. */
  completedAt: string | null
  /** The pm_ id of the saved card a charge used; null on checkout payments. */
  storedPaymentMethodId: string | null
  /** MINOR units refunded so far; null when nothing was refunded. */
  refundedAmount: number | null
  /** The acquirer fee of this payment in MINOR units; null until it is settled. It can change later. */
  fee: number | null
  /** amount minus fee in MINOR units; null when fee is null. Payout deductions are not in it. */
  netAmount: number | null
  /** ISO 8601 UTC at midnight, the date the acquirer settled the payment; null until settled. */
  settledAt: string | null
  /** The id of the payout that paid this money to you; null until it is paid out. */
  payoutId: string | null
  [key: string]: unknown
}

/** What {@link DominaiteClient.listTransactions} returns: one page, oldest first. */
export interface TransactionPage {
  /** The payments of this page, by createdAt then transactionId. Empty when the window has none. */
  items: Transaction[]
  /** Send it back as cursor, with the same from, to, settledFrom, settledTo and status, for the next page. Null on the last page. */
  nextCursor: string | null
  [key: string]: unknown
}

/**
 * The public integration contract, as {@link DominaiteClient.getIntegrationContract} returns
 * it: the API's own description of its routes, fields, statuses, error codes, webhook events
 * and signing rules. Only version is modelled; read the rest by name.
 */
export interface IntegrationContract {
  /** The contract's dated version, for example '2026-09-16'. */
  version: string
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
  /** How the payer paid: 'card', 'wallet', ... Not the stored card; that is storedPaymentMethod. */
  paymentMethod?: string | null
  /** The wallet, e.g. 'apple_pay' or 'google_pay'; set only for wallet payments. */
  walletType?: string | null
  originalTransactionId?: string | null
  idempotencyKey?: string | null
  /** Your own order reference; refund and cancel events carry the original payment's. */
  orderReference?: string | null
  /** The hosted checkout order id; null for refunds, cancellations and payments outside hosted checkout. */
  orderId?: string | null
  /**
   * The payment processor's reference for the transaction. null until known, and null for a
   * sale settled by reconciliation without a processor webhook; refund and cancel events carry
   * the original sale's reference. Absent on a gateway that predates it.
   */
  pspReference?: string | null
  /** The description you sent on create session; null on refund and cancellation events. */
  description?: string | null
  /** Lower-cased card brand once a card payment was attempted. */
  paymentMethodBrand?: string | null
  /** Last four digits once a card payment was attempted. */
  paymentMethodLast4?: string | null
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
  /**
   * True on every verification.* event, false on payment.* events. Absent on deliveries
   * from a gateway that predates it.
   */
  verifyOnly?: boolean
  /**
   * On a failed event (verification.failed, payment.failed): why the issuer declined, with
   * the same values as {@link CheckoutStatus.declineClass}. declineClass can be null, for
   * example when nobody declined the payment.
   */
  declineClass?: DeclineClass | (string & {}) | null
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
 * The events of a verify-only session, on the payment.* data with verifyOnly true. A
 * verify-only session never sends payment.* events. verification.succeeded: the card is
 * checked; data.storedPaymentMethod is the saved card, or null when you must read it with
 * getStatus(). verification.failed: the issuer declined or the payer abandoned the
 * checkout, and no card was saved.
 */
export type VerificationWebhookEvent = WebhookEvent<
  'verification.succeeded' | 'verification.failed',
  PaymentWebhookData
>

/**
 * Every event type this SDK version models; narrow on `type`. A type added to the gateway
 * later still parses, with the same envelope, so check `type` before trusting `data`.
 */
export type DominaiteWebhookEvent =
  | PaymentWebhookEvent
  | AgreementWebhookEvent
  | ChargeWebhookEvent
  | VerificationWebhookEvent
