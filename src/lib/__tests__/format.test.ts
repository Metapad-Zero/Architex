import { describe, expect, test } from 'bun:test'
import { formatAmount, formatPct, parseAmount, shortAddress } from '../format'

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
