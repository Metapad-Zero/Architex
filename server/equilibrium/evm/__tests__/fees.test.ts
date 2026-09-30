import { describe, expect, test } from 'bun:test'
import type { TransactionReceipt } from 'viem'
import { l1FeeOf, weiOf } from '../adapter'

const receipt = (l1Fee?: unknown) => ({
  gasUsed: 21_000n, effectiveGasPrice: 1_000_000_000n,
  transactionHash: `0x${'1'.repeat(64)}`, l1Fee,
}) as unknown as TransactionReceipt

describe('receipt fees without an RPC', () => {
  test('decimal strings preserve exact wei, including values beyond Number precision', () => {
    for (const value of ['0', '16', '00016', '9007199254740993', '123456789012345678901234567890']) {
      expect(l1FeeOf(receipt(value))).toBe(BigInt(value))
      expect(weiOf(receipt(value))).toBe(21_000_000_000_000n + BigInt(value))
    }
  })
  test('hex strings, bigint and safe integer fees are added numerically', () => {
    for (const value of ['0x10', '0x0010', 16n, 16]) expect(weiOf(receipt(value))).toBe(21_000_000_000_016n)
    expect(l1FeeOf(receipt('0xAB'))).toBe(171n)
    expect(l1FeeOf(receipt(Number.MAX_SAFE_INTEGER))).toBe(9_007_199_254_740_991n)
  })
  test('absent, null and explicit zero fees contribute zero', () => {
    for (const value of [undefined, null, '0', '0x0', 0, 0n]) expect(weiOf(receipt(value))).toBe(21_000_000_000_000n)
  })
  test('malformed strings cannot be mistaken for a zero fee', () => {
    for (const value of ['', ' ', ' 16', '16 ', '-1', '+16', '1.5', '1e3', '0x', '0xGG', '16wei']) {
      expect(() => l1FeeOf(receipt(value))).toThrow('Unreadable l1Fee')
      expect(() => weiOf(receipt(value))).toThrow('Unreadable l1Fee')
    }
  })
  test('negative, fractional, non-finite and imprecise numbers are refused', () => {
    for (const value of [-1n, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => weiOf(receipt(value))).toThrow('Unreadable l1Fee')
    }
  })
  test('non-numeric types are refused', () => {
    for (const value of [true, false, {}, [], ['16']]) expect(() => weiOf(receipt(value))).toThrow('Unreadable l1Fee')
  })
})
