import { describe, expect, test } from 'bun:test'
import { activeChain } from '../../chain'
import { spendableBalance, USDC_GAS_RESERVE } from '../gasReserve'

describe('USDC gas reserve', () => {
  test('USDC keeps the reserve back, because it also pays for gas', () => {
    expect(spendableBalance(activeChain.usdc, 10_000_000n)).toBe(10_000_000n - USDC_GAS_RESERVE)
    expect(spendableBalance(activeChain.usdc.toUpperCase().replace('0X', '0x'), 10_000_000n)).toBe(10_000_000n - USDC_GAS_RESERVE)
  })

  test('a balance at or under the reserve has nothing spendable', () => {
    expect(spendableBalance(activeChain.usdc, USDC_GAS_RESERVE)).toBe(0n)
    expect(spendableBalance(activeChain.usdc, 1n)).toBe(0n)
  })

  test('other tokens are fully spendable', () => {
    expect(spendableBalance('0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1', 5_000_000n)).toBe(5_000_000n)
  })
})
