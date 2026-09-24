/**
 * ISO 4217 minor-unit exponents: how many digits a currency has after the decimal point.
 * 25.00 EUR is 2500 minor units; 2500 JPY is 2500 minor units, because the yen has no
 * minor unit; 25.000 BHD is 25000.
 *
 * Deliberately a closed list. A currency missing here is an error in
 * {@link toMinorUnits}, never a guessed default of 2: guessing wrong charges 100 times
 * too much or too little.
 */
export const CURRENCY_EXPONENTS: Readonly<Record<string, 0 | 2 | 3>> = Object.freeze({
  BGN: 2,
  CHF: 2,
  CZK: 2,
  DKK: 2,
  EUR: 2,
  GBP: 2,
  HUF: 2,
  NOK: 2,
  PLN: 2,
  RON: 2,
  SEK: 2,
  USD: 2,
  ISK: 0,
  JPY: 0,
  KRW: 0,
  BHD: 3,
  JOD: 3,
  KWD: 3,
  OMR: 3,
  TND: 3,
})

const DECIMAL_PATTERN = /^([0-9]+)(?:\.([0-9]+))?$/

/**
 * Converts a decimal amount to the integer MINOR units every amount field takes:
 * toMinorUnits('25.00', 'EUR') is 2500, toMinorUnits('2500', 'JPY') is 2500,
 * toMinorUnits('1.5', 'BHD') is 1500.
 *
 * Takes the amount as a decimal STRING, never a number: binary floats cannot hold most
 * prices exactly (0.1 + 0.2 is 0.30000000000000004), so the conversion is done on the
 * digits and never touches floating point. Pass the string your database or price list
 * already has.
 *
 * Throws TypeError for anything it would have to guess about: a number instead of a
 * string, a sign, an exponent or other non-plain-decimal text, more fractional digits
 * than the currency has (25.001 EUR, 100.5 JPY), a result past Number.MAX_SAFE_INTEGER,
 * or a currency not in {@link CURRENCY_EXPONENTS}.
 */
export function toMinorUnits(amount: string, currency: string): number {
  const code = typeof currency === 'string' ? currency.toUpperCase() : ''
  const exponent = Object.hasOwn(CURRENCY_EXPONENTS, code) ? CURRENCY_EXPONENTS[code] : undefined
  if (exponent === undefined) {
    throw new TypeError(`Unknown currency ${String(currency)}: no ISO 4217 minor-unit exponent on file`)
  }

  if (typeof amount !== 'string') {
    throw new TypeError("amount must be a decimal string, e.g. '25.00' - floats cannot hold prices exactly")
  }
  const match = DECIMAL_PATTERN.exec(amount)
  if (match === null) {
    throw new TypeError(`amount must be a plain non-negative decimal like '25.00', got '${amount}'`)
  }

  const whole = match[1] as string
  const fraction = match[2] ?? ''
  if (fraction.length > exponent) {
    throw new TypeError(
      `${code} has ${exponent} decimal places; '${amount}' has ${fraction.length}`,
    )
  }

  const minor = BigInt(whole + fraction.padEnd(exponent, '0'))
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`amount '${amount}' is too large`)
  }
  return Number(minor)
}
