import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CURRENCY_EXPONENTS, toMinorUnits } from '../dist/esm/index.js'

test('two-decimal currencies scale by 100', () => {
  for (const currency of ['EUR', 'USD', 'GBP', 'CAD', 'AUD', 'CHF', 'BGN', 'RON', 'PLN', 'CZK', 'SEK', 'DKK', 'NOK']) {
    assert.equal(toMinorUnits('25.00', currency), 2500, currency)
  }
  assert.equal(toMinorUnits('25', 'EUR'), 2500)
  assert.equal(toMinorUnits('25.5', 'EUR'), 2550)
  assert.equal(toMinorUnits('0.01', 'EUR'), 1)
})

test('zero-decimal currencies are already minor units', () => {
  for (const currency of ['JPY', 'HUF']) {
    assert.equal(toMinorUnits('2500', currency), 2500, currency)
  }
})

test('HUF follows the gateway (whole forints), not ISO 4217, so it is never 100x too much', () => {
  assert.equal(toMinorUnits('2500', 'HUF'), 2500)
  assert.throws(() => toMinorUnits('2500.00', 'HUF'), TypeError)
  assert.equal(CURRENCY_EXPONENTS.HUF, 0)
})

test('currencies where ISO and the gateway disagree are refused as not supported', () => {
  for (const currency of ['ISK', 'KRW', 'OMR', 'JOD', 'TND', 'krw']) {
    assert.throws(() => toMinorUnits('25', currency), /not supported/, currency)
    assert.equal(Object.hasOwn(CURRENCY_EXPONENTS, currency.toUpperCase()), false, currency)
  }
})

test('three-decimal currencies scale by 1000', () => {
  for (const currency of ['BHD', 'KWD']) {
    assert.equal(toMinorUnits('1.5', currency), 1500, currency)
    assert.equal(toMinorUnits('1.234', currency), 1234, currency)
  }
})

test('0.30 EUR is exactly 30, with no float drift', () => {
  assert.equal(toMinorUnits('0.30', 'EUR'), 30)
  assert.equal(toMinorUnits('0.3', 'EUR'), 30)
  // The float sum 0.1 + 0.2 is 0.30000000000000004: refused, never silently rounded.
  assert.throws(() => toMinorUnits(String(0.1 + 0.2), 'EUR'), TypeError)
  // A float the SDK would have to trust is refused outright.
  assert.throws(() => toMinorUnits(0.3, 'EUR'), TypeError)
  // Classic float traps come out exact from the string.
  assert.equal(toMinorUnits('19.99', 'EUR'), 1999)
  assert.equal(toMinorUnits('1.15', 'EUR'), 115)
  assert.equal(toMinorUnits('4.35', 'EUR'), 435)
})

test('more fractional digits than the currency has is refused, zeros included', () => {
  assert.throws(() => toMinorUnits('25.001', 'EUR'), TypeError)
  assert.throws(() => toMinorUnits('25.000', 'EUR'), TypeError)
  assert.throws(() => toMinorUnits('100.5', 'JPY'), TypeError)
  assert.throws(() => toMinorUnits('100.0', 'JPY'), TypeError)
  assert.throws(() => toMinorUnits('1.2345', 'BHD'), TypeError)
})

test('an unknown currency is an error, not a default of two decimals', () => {
  assert.throws(() => toMinorUnits('25.00', 'XYZ'), TypeError)
  assert.throws(() => toMinorUnits('25.00', ''), TypeError)
  assert.throws(() => toMinorUnits('25.00', undefined), TypeError)
  assert.throws(() => toMinorUnits('25.00', 'toString'), TypeError)
})

test('the currency code is case-insensitive', () => {
  assert.equal(toMinorUnits('25.00', 'eur'), 2500)
  assert.equal(toMinorUnits('2500', 'jpy'), 2500)
})

test('anything but a plain non-negative decimal is refused', () => {
  for (const amount of ['', ' 25.00', '25.00 ', '-25.00', '+25', '25,00', '1e3', '.5', '25.', 'NaN', 'Infinity', '0x10']) {
    assert.throws(() => toMinorUnits(amount, 'EUR'), TypeError, JSON.stringify(amount))
  }
})

test('a result past the safe integer range is refused rather than rounded', () => {
  assert.equal(toMinorUnits('90071992547409.91', 'EUR'), Number.MAX_SAFE_INTEGER)
  assert.throws(() => toMinorUnits('90071992547409.92', 'EUR'), TypeError)
})

test('the exponent table carries the currencies above and cannot be changed at runtime', () => {
  assert.equal(CURRENCY_EXPONENTS.EUR, 2)
  assert.equal(CURRENCY_EXPONENTS.JPY, 0)
  assert.equal(CURRENCY_EXPONENTS.KWD, 3)
  assert.ok(Object.isFrozen(CURRENCY_EXPONENTS))
})
