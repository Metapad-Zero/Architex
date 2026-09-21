import { describe, expect, test } from 'bun:test'
import { formatAmount, formatLp, formatPct, parseAmount, shortAddress } from '../format'

describe('amount parsing and formatting', () => {
  test('round trips six-decimal values', () => {
    const value = parseAmount('1251.2', 6)
    expect(value).toBe(1_251_200_000n)
    expect(formatAmount(value, 6)).toBe('1,251.2')
  })

  test('round trips eighteen-decimal values without floating point', () => {
    const value = parseAmount('0.123456789123456789', 18)
    expect(value).toBe(123_456_789_123_456_789n)
    expect(formatAmount(value, 18)).toBe('0.123457')
  })

  test('uses six significant figures and removes trailing zeros', () => {
    expect(formatAmount(parseAmount('1234567.89', 6), 6)).toBe('1,234,570')
    expect(formatAmount(parseAmount('12.340000', 6), 6)).toBe('12.34')
    expect(formatAmount(0n, 18)).toBe('0')
    expect(formatAmount(1n, 18)).toBe('<0.000001')
  })

  test('rejects precision loss and invalid values', () => {
    expect(() => parseAmount('1.0000001', 6)).toThrow()
    expect(() => parseAmount('1e3', 18)).toThrow()
  })

  test('formats percentages and addresses', () => {
    expect(formatPct(50)).toBe('0.50%')
    const value = `0x${'1'.repeat(40)}`
    expect(shortAddress(value)).toBe('0x1111…1111')
  })
})

describe('six-decimal amounts under one', () => {
  test('keep their fraction instead of collapsing to 0', () => {
    expect(formatAmount(855_000n, 6)).toBe('0.855')
    expect(formatAmount(100_000n, 6)).toBe('0.1')
    expect(formatAmount(1n, 6)).toBe('0.000001')
    expect(formatAmount(999_999n, 6)).toBe('0.999999')
  })
})

describe('LP amounts', () => {
  test('a six-decimal pair mints LP below 0.000001 and it still reads as a number', () => {
    // sqrt(1,000 USDC * 855 EURC) at 6 decimals each, minus MINIMUM_LIQUIDITY
    expect(formatLp(924_661_054n)).toBe('0.000000000924661')
  })

  test('large LP amounts format like any other 18-decimal amount', () => {
    expect(formatLp(1_500_000_000_000_000_000n)).toBe(formatAmount(1_500_000_000_000_000_000n, 18))
    expect(formatLp(0n)).toBe('0')
  })
})
