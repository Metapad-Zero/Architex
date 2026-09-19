import { describe, expect, test } from 'bun:test'
import type { Address } from 'viem'
import {
  findBestRoute,
  getAmountIn,
  getAmountOut,
  liquidityMinted,
  maxSent,
  minReceived,
  priceImpactBps,
  quote,
  removeAmounts,
  type AmmPair,
} from '../amm'

const address = (value: number): Address => `0x${value.toString(16).padStart(40, '0')}`

const tokenA = address(1)
const tokenB = address(2)
const usdc = address(3)

function pair(pairAddress: number, token0: Address, token1: Address, reserve0: bigint, reserve1: bigint): AmmPair {
  return { pair: address(pairAddress), token0, token1, reserve0, reserve1, totalSupply: 1_000_000n }
}

describe('constant product math', () => {
  test('matches known Uniswap V2 amount out and in vectors', () => {
    expect(getAmountOut(1_000n, 10_000n, 10_000n)).toBe(906n)
    expect(getAmountIn(906n, 10_000n, 10_000n)).toBe(1_000n)
    expect(getAmountOut(10_000n, 1_000_000n, 2_000_000n)).toBe(19_743n)
  })

  test('quotes ratios, slippage bounds, liquidity and removal', () => {
    expect(quote(5n, 10n, 20n)).toBe(10n)
    expect(minReceived(10_000n, 50)).toBe(9_950n)
    expect(maxSent(10_000n, 50)).toBe(10_050n)
    expect(liquidityMinted(10_000n, 10_000n, 0n, 0n, 0n)).toBe(9_000n)
    expect(removeAmounts(100n, 5_000n, 10_000n, 1_000n)).toEqual([500n, 1_000n])
  })

  test('rejects exact output at or above the reserve', () => {
    expect(() => getAmountIn(10_000n, 1_000n, 10_000n)).toThrow('InsufficientLiquidity')
  })
})

describe('route selection', () => {
  const pairs = [
    pair(10, tokenA, tokenB, 1_000_000n, 1_000_000n),
    pair(11, tokenA, usdc, 1_000_000n, 2_000_000n),
    pair(12, usdc, tokenB, 2_000_000n, 2_000_000n),
  ]

  test('chooses maximum output for exact in', () => {
    const route = findBestRoute('exactIn', 10_000n, tokenA, tokenB, usdc, pairs)
    expect(route?.path).toEqual([tokenA, usdc, tokenB])
    expect(route?.amountOut).toBeGreaterThan(9_000n)
  })

  test('chooses minimum input for exact out', () => {
    const route = findBestRoute('exactOut', 10_000n, tokenA, tokenB, usdc, pairs)
    expect(route?.path).toEqual([tokenA, usdc, tokenB])
    expect(route?.amountIn).toBeLessThan(10_500n)
  })

  test('computes positive price impact using bigint ratios', () => {
    const route = findBestRoute('exactIn', 100_000n, tokenA, tokenB, usdc, pairs)
    expect(route).toBeDefined()
    expect(priceImpactBps(route!)).toBeGreaterThan(0n)
  })

  test('excludes the swap fee from price impact', () => {
    const deep = [pair(20, tokenA, tokenB, 10n ** 24n, 10n ** 24n)]
    const route = findBestRoute('exactIn', 10n ** 15n, tokenA, tokenB, usdc, deep)
    expect(route?.path).toEqual([tokenA, tokenB])
    // A trade of 1e-9 of the pool moves the price by ~0.0000002%; the 0.30% fee must not show up here.
    expect(priceImpactBps(route!)).toBeLessThan(2n)
    const big = findBestRoute('exactIn', 10n ** 23n, tokenA, tokenB, usdc, deep)
    // 10% of the pool: impact ≈ 9.1% (1 - 1/1.1), well clear of the fee.
    expect(priceImpactBps(big!)).toBeGreaterThan(880n)
    expect(priceImpactBps(big!)).toBeLessThan(940n)
  })
})
