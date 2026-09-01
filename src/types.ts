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

/**
 * Every payment method category the merchant API reports, in the gateway's own order.
 *
 * Reporting data, not a money-flow switch: a wallet payment refunds, captures and
 * disputes exactly like a plain card payment.
 */
export const PAYMENT_METHOD_CATEGORIES = ['card', 'wallet', 'bank_transfer', 'sepa'] as const

export type PaymentMethodCategory = (typeof PAYMENT_METHOD_CATEGORIES)[number]

/**
 * The wallets the gateway currently names in walletType, pinned against the published
 * contract fixture. The field can carry a lower-cased identifier not in this list yet -
 * treat unknown values as a valid wallet, not an error.
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
  /**
   * How the payer paid. Null while the payment is still open (no method chosen yet)
   * and on transactions older than the field. Also inside data on every payment.*
   * webhook event.
   */
  paymentMethod?: PaymentMethodCategory | (string & {}) | null
  /**
   * Which wallet, when paymentMethod is 'wallet'. Values outside {@link WALLET_TYPES}
   * are valid wallets the gateway learned about after this SDK released. Null for
   * non-wallet payments. Also inside data on every payment.* webhook event.
   */
  walletType?: WalletType | (string & {}) | null
  createdAt: string
  updatedAt?: string
  /** Present while the session is still payable. */
  expiresAt?: string
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
