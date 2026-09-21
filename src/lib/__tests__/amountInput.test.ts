import { describe, expect, test } from 'bun:test'
import { parseOptionalAmount, sanitizeAmount } from '../amountInput'

describe('amount field edits', () => {
  test('rejects more decimals than the token has, so the amount is never cut short', () => {
    expect(sanitizeAmount('25.1234567', 6)).toBe(undefined)
    expect(sanitizeAmount('100.0000001', 6)).toBe(undefined)
    expect(sanitizeAmount('25.123456', 6)).toBe('25.123456')
  })

  test('rejects text that is not a number', () => {
    expect(sanitizeAmount('1e3', 6)).toBe(undefined)
    expect(sanitizeAmount('-1', 6)).toBe(undefined)
  })

  test('normalises separators, a leading dot and leading zeros', () => {
    expect(sanitizeAmount('1,000.5', 6)).toBe('1000.5')
    expect(sanitizeAmount('.5', 6)).toBe('0.5')
    expect(sanitizeAmount('007', 6)).toBe('7')
    expect(sanitizeAmount(' ', 6)).toBe('')
  })
})

describe('optional amounts', () => {
  test('an empty field is no amount', () => {
    expect(parseOptionalAmount('', 6)).toEqual({ amount: 0n })
    expect(parseOptionalAmount('  ', 6)).toEqual({ amount: 0n })
  })

  test('a valid amount parses exactly', () => {
    expect(parseOptionalAmount('25.123456', 6)).toEqual({ amount: 25_123_456n })
    expect(parseOptionalAmount('0', 6)).toEqual({ amount: 0n })
  })

  test('text that does not parse is an error, not 0', () => {
    for (const text of ['25.1234567', '100.0000001', '.', 'abc']) {
      const result = parseOptionalAmount(text, 6)
      expect(result.amount).toBe(undefined)
      expect(result.error).toContain('6 decimal places')
    }
  })
})
