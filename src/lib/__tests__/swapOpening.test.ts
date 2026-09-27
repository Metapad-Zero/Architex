import { describe, expect, test } from 'bun:test'
import type { Address } from 'viem'
import type { AmmPair } from '../amm'
import { SWAP_OPENING_GOAL_USD, goalBps, isPoolOpen, poolLiquidityUsd, swapOpening, wholeUsd } from '../swapOpening'

const USDC = '0x3600000000000000000000000000000000000000' as Address
const EURC = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1' as Address
const WBTC = '0x0000000000000000000000000000000000000b7c' as Address

function pool(token0: Address, token1: Address, reserve0: bigint, reserve1: bigint): AmmPair {
  return { pair: `0x${'1'.repeat(38)}${token0.slice(-2)}` as Address, token0, token1, reserve0, reserve1, totalSupply: 1n }
}

// The live USDC / EURC pool on 2026-09-27: 345.959197 USDC and 301.190155 EURC.
const live = pool(USDC, EURC, 345_959_197n, 301_190_155n)

describe('swaps open at $50,000 of liquidity', () => {
  test("a pool's liquidity is its USDC side, twice, whichever side USDC is on", () => {
    expect(poolLiquidityUsd(live, USDC)).toBe(691_918_394n)
    expect(poolLiquidityUsd(pool(EURC, USDC, 1n, 25_000n * 10n ** 6n), USDC)).toBe(SWAP_OPENING_GOAL_USD)
    expect(poolLiquidityUsd(pool(EURC, WBTC, 1n, 1n), USDC)).toBe(undefined)
  })

  test('the live pool is closed, and a pool opens at exactly the goal', () => {
    expect(isPoolOpen(live, USDC)).toBe(false)
    expect(isPoolOpen(pool(USDC, EURC, 25_000n * 10n ** 6n - 1n, 1n), USDC)).toBe(false)
    expect(isPoolOpen(pool(USDC, EURC, 25_000n * 10n ** 6n, 1n), USDC)).toBe(true)
    expect(isPoolOpen(pool(EURC, WBTC, 10n ** 30n, 10n ** 30n), USDC)).toBe(false)
  })

  test('a swap follows its direct pool, in either direction', () => {
    const opening = swapOpening(EURC, USDC, [live], USDC)
    expect(opening?.pool).toBe(live)
    expect(opening?.open).toBe(false)
    expect(swapOpening(USDC, EURC, [live], USDC)?.liquidityUsd).toBe(691_918_394n)
  })

  test('a route through USDC is as open as its thinnest pool', () => {
    const deep = pool(USDC, WBTC, 40_000n * 10n ** 6n, 1n)
    const opening = swapOpening(WBTC, EURC, [live, deep], USDC)
    expect(opening?.pool).toBe(live)
    expect(opening?.open).toBe(false)
    const deepToo = pool(USDC, EURC, 30_000n * 10n ** 6n, 1n)
    expect(swapOpening(WBTC, EURC, [deepToo, deep], USDC)?.open).toBe(true)
  })

  test('a thin direct pool does not close a swap the deep route through USDC can carry', () => {
    const thinDirect = pool(EURC, WBTC, 1n, 1n)
    const deepEurc = pool(USDC, EURC, 30_000n * 10n ** 6n, 1n)
    const deepWbtc = pool(USDC, WBTC, 40_000n * 10n ** 6n, 1n)
    const opening = swapOpening(WBTC, EURC, [thinDirect, deepEurc, deepWbtc], USDC)
    expect(opening?.open).toBe(true)
    expect(opening?.pool).toBe(deepEurc)
    expect(swapOpening(WBTC, EURC, [thinDirect], USDC)?.open).toBe(false)
  })

  test('nothing to decide without two different tokens and a pool between them', () => {
    expect(swapOpening(undefined, USDC, [live], USDC)).toBe(undefined)
    expect(swapOpening(USDC, USDC, [live], USDC)).toBe(undefined)
    expect(swapOpening(USDC, WBTC, [live], USDC)).toBe(undefined)
    expect(swapOpening(WBTC, EURC, [live], USDC)).toBe(undefined)
  })

  test('the bar fills in basis points of the goal and stops at full', () => {
    expect(goalBps(0n)).toBe(0)
    expect(goalBps(691_918_394n)).toBe(138)
    expect(goalBps(SWAP_OPENING_GOAL_USD)).toBe(10_000)
    expect(goalBps(SWAP_OPENING_GOAL_USD * 3n)).toBe(10_000)
  })

  test('the label shows whole dollars', () => {
    expect(wholeUsd(691_918_394n)).toBe('$692')
    expect(wholeUsd(SWAP_OPENING_GOAL_USD)).toBe('$50,000')
    expect(wholeUsd(0n)).toBe('$0')
  })
})
