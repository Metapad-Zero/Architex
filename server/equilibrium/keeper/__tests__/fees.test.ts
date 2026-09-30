import { describe, expect, test } from 'bun:test'
import { formatTransactionReceipt, type TransactionReceipt } from 'viem'
import { l1FeeOf as launchL1FeeOf, weiOf as launchWeiOf } from '../../evm/adapter'
import { l1FeeOf, weiOf } from '../fees'

const receipt = (l1Fee?: unknown) => ({
  gasUsed: 21_000n, effectiveGasPrice: 1_000_000_000n,
  transactionHash: `0x${'1'.repeat(64)}`, l1Fee,
}) as unknown as TransactionReceipt

describe('keeper receipt fees match the frozen launch numeric rules', () => {
  test('hex, decimal, bigint and safe integers add exact wei', () => {
    for (const value of ['0x10', '0x0010', '0xAB', '16', '00016', '9007199254740993', '123456789012345678901234567890', 16n, 16, Number.MAX_SAFE_INTEGER]) {
      expect(l1FeeOf(receipt(value))).toBe(BigInt(value))
      expect(weiOf(receipt(value))).toBe(21_000_000_000_000n + BigInt(value))
      expect(l1FeeOf(receipt(value))).toBe(launchL1FeeOf(receipt(value)))
      expect(weiOf(receipt(value))).toBe(launchWeiOf(receipt(value)))
    }
  })

  test('absent, null and explicit zero fees add no extra cost', () => {
    for (const value of [undefined, null, '0', '0x0', 0, 0n]) {
      expect(weiOf(receipt(value))).toBe(21_000_000_000_000n)
      expect(weiOf(receipt(value))).toBe(launchWeiOf(receipt(value)))
    }
  })

  test('malformed, negative, fractional, imprecise and non-numeric fees are rejected', () => {
    for (const value of ['', ' ', ' 16', '16 ', '-1', '+16', '1.5', '1e3', '0x', '0xGG', '16wei',
      -1n, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, true, false, {}, [], ['16']]) {
      expect(() => weiOf(receipt(value))).toThrow('Unreadable l1Fee')
      expect(() => launchWeiOf(receipt(value))).toThrow('Unreadable l1Fee')
    }
  })

  test('viem leaves the RPC hex fee a string; the keeper still adds it numerically', () => {
    const raw = {
      gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00',
      transactionHash: `0x${'1'.repeat(64)}`, l1Fee: '0x5af3107a4000',
    } as const
    const formatted = formatTransactionReceipt(raw) as TransactionReceipt & { l1Fee?: unknown }
    expect(formatted.l1Fee).toBe('0x5af3107a4000')
    expect(weiOf(formatted)).toBe(121_000_000_000_000n)
  })
})
