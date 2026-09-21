import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, type Address, type Hex } from 'viem'
import {
  CURVE,
  INITIAL_CURVE,
  marketCap,
  poolMarketCap,
  poolSpotPrice,
  progressBps,
  quoteBuy,
  quotePoolBuy,
  quotePoolSell,
  quoteSell,
  realUsdc,
  splitSellOutFee,
  spotPrice,
  type CurveState,
  type PoolReserves,
} from '../curve'
import vectors from './fixtures/v13-vectors.json'

const USDC = 1_000_000n
const k = (state: CurveState) => state.virtualUsdc * state.virtualTokens

// Deterministic pseudo-random stream so the fuzz below is reproducible.
function stream(seed: number) {
  let value = seed >>> 0
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0
    return value
  }
}

function outcome<T>(fn: () => T): T | string {
  try {
    return fn()
  } catch (error) {
    return (error as Error).message
  }
}

type Vector = { k: string; c?: number; in?: string; e?: string; r?: (string | boolean)[]; next?: unknown; [key: string]: unknown }
const all = vectors as Vector[]
const big = (value: unknown) => BigInt(value as string)
const stateOf = (v: Vector): CurveState => ({ virtualUsdc: big(v.vu), virtualTokens: big(v.vt), tokensSold: big(v.sold) })
const reservesOf = (v: Vector): PoolReserves => ({ reserveToken: big(v.rt), reserveUsdc: big(v.ru) })

/**
 * Vectors produced by the v1.3 contracts themselves (a Foundry run of ArchitexLaunchpad.quoteBuy/quoteSell,
 * LaunchRouter.quoteBuy/quoteSell and executed buys and sells, at creator fees 0, 0.01, 0.37, 0.5, 2.5, 9.99 and
 * 10%, plus Solidity's abi.encode of Split and Combo plugin data). `e` is the contract's revert, `r` its return,
 * `next` the curve or pool state an executed trade left.
 */
describe('matches the v1.3 contracts to the unit', () => {
  test('curve buys, including the sell-out buy and its fee split', () => {
    const buys = all.filter((v) => v.k === 'cb' || v.k === 'cbx')
    expect(buys.length).toBeGreaterThan(90)
    for (const v of buys) {
      const got = outcome(() => quoteBuy(stateOf(v), big(v.in), v.c ?? 0))
      if (v.e) {
        expect(got).toBe(v.e)
        continue
      }
      if (typeof got === 'string') throw new Error(`${JSON.stringify(v)} threw ${got}`)
      expect([got.tokensOut, got.platformFee, got.creatorFee, got.usdcSpent, got.graduates].map(String)).toEqual(v.r!.map(String))
      if (v.next) expect([got.next.virtualUsdc, got.next.virtualTokens, got.next.tokensSold].map(String)).toEqual(v.next)
    }
  })

  test('curve sells', () => {
    const sells = all.filter((v) => v.k === 'cs' || v.k === 'csx')
    expect(sells.length).toBeGreaterThan(40)
    for (const v of sells) {
      const got = outcome(() => quoteSell(stateOf(v), big(v.in), v.c ?? 0))
      if (v.e) {
        expect(got).toBe(v.e)
        continue
      }
      if (typeof got === 'string') throw new Error(`${JSON.stringify(v)} threw ${got}`)
      expect([got.usdcOut, got.platformFee, got.creatorFee].map(String)).toEqual(v.r!.map(String))
      if (v.next) expect([got.next.virtualUsdc, got.next.virtualTokens, got.next.tokensSold].map(String)).toEqual(v.next)
    }
  })

  test('launch-pool buys and sells through the router', () => {
    const pool = all.filter((v) => ['pb', 'pbx', 'ps', 'psx'].includes(v.k))
    expect(pool.length).toBeGreaterThan(90)
    for (const v of pool) {
      const buy = v.k.startsWith('pb')
      const got = outcome(() => (buy ? quotePoolBuy(reservesOf(v), big(v.in), v.c ?? 0) : quotePoolSell(reservesOf(v), big(v.in), v.c ?? 0)))
      if (v.e) {
        expect(got).toBe(v.e)
        continue
      }
      if (typeof got === 'string') throw new Error(`${JSON.stringify(v)} threw ${got}`)
      const out = 'tokensOut' in got ? got.tokensOut : got.usdcOut
      expect([out, got.platformFee, got.creatorFee].map(String)).toEqual(v.r!.map(String))
      if (v.next) {
        const next = v.next as { rt: string; ru: string }
        expect([got.next.reserveToken, got.next.reserveUsdc].map(String)).toEqual([next.rt, next.ru])
      }
    }
  })

  test('plugin data encodes byte for byte like abi.encode', () => {
    const splits = all.filter((v) => v.k === 'split')
    const combos = all.filter((v) => v.k === 'combo')
    expect(splits.length).toBe(3)
    expect(combos.length).toBe(3)
    for (const v of splits) {
      const hex = encodeAbiParameters([{ type: 'address[]' }, { type: 'uint256[]' }], [v.payees as Address[], (v.shares as string[]).map(BigInt)])
      expect(hex).toBe(v.hex as Hex)
    }
    for (const v of combos) {
      const hex = encodeAbiParameters(
        [{ type: 'address[]' }, { type: 'uint16[]' }, { type: 'bytes[]' }],
        [v.targets as Address[], v.bps as number[], v.datas as Hex[]],
      )
      expect(hex).toBe(v.hex as Hex)
    }
  })
})

describe('bonding curve', () => {
  test('opens near a $6,250 market cap and a first $100 buys about 1.26% of supply', () => {
    expect(marketCap(INITIAL_CURVE)).toBe(6_249_999_997n)
    const quote = quoteBuy(INITIAL_CURVE, 100n * USDC, 0)
    expect(quote.platformFee).toBe(500_000n)
    expect(quote.creatorFee).toBe(0n)
    expect(quote.usdcSpent).toBe(100n * USDC)
    expect(quote.graduates).toBe(false)
    const percentOfSupplyX1000 = (quote.tokensOut * 100_000n) / CURVE.TOTAL_SUPPLY
    expect(percentOfSupplyX1000 > 1_200n && percentOfSupplyX1000 < 1_300n).toBe(true)
  })

  test('a 10% creator fee comes off the USDC in, beside the 0.5% platform fee', () => {
    const quote = quoteBuy(INITIAL_CURVE, 100n * USDC, 1_000)
    expect(quote.platformFee).toBe(500_000n)
    expect(quote.creatorFee).toBe(10_000_000n)
    expect(quote.next.virtualUsdc - INITIAL_CURVE.virtualUsdc).toBe(89_500_000n)
  })

  test('the buy that sells out fills exactly the remainder and is charged only for it', () => {
    for (const fee of [0, 250, 1_000]) {
      const quote = quoteBuy(INITIAL_CURVE, 1_000_000n * USDC, fee)
      expect(quote.tokensOut).toBe(CURVE.CURVE_SUPPLY)
      expect(quote.graduates).toBe(true)
      expect(quote.next.tokensSold).toBe(CURVE.CURVE_SUPPLY)
      expect(realUsdc(quote.next) > 24_999n * USDC && realUsdc(quote.next) <= 25_000n * USDC).toBe(true)
      expect(quote.platformFee + quote.creatorFee).toBe(quote.usdcSpent - realUsdc(quote.next))
      expect(progressBps(quote.next)).toBe(10_000n)
    }
    // With no creator fee: about 25,000 USDC raised plus the 0.5% fee on top, the figure the forge suite pins.
    expect(quoteBuy(INITIAL_CURVE, 1_000_000n * USDC, 0).usdcSpent).toBe(25_125_628_109n)
  })

  test('the sell-out split gives the platform ceil(total·50/(50+c)) and the creator the rest', () => {
    expect(splitSellOutFee(1_000n, 0)).toEqual({ platformFee: 1_000n, creatorFee: 0n })
    expect(splitSellOutFee(1_050n, 1_000)).toEqual({ platformFee: 50n, creatorFee: 1_000n })
    expect(splitSellOutFee(1n, 1_000)).toEqual({ platformFee: 1n, creatorFee: 0n })
    expect(splitSellOutFee(1_051n, 1_000)).toEqual({ platformFee: 51n, creatorFee: 1_000n })
  })

  test('graduation lands on a $100,000 market cap and the pool opens at the same price', () => {
    const end = quoteBuy(INITIAL_CURVE, 1_000_000n * USDC, 0).next
    const cap = marketCap(end)
    expect(cap > 99_999n * USDC && cap < 100_001n * USDC).toBe(true)
    const pool = { reserveToken: CURVE.POOL_SUPPLY, reserveUsdc: realUsdc(end) }
    const gap = poolSpotPrice(pool) > spotPrice(end) ? poolSpotPrice(pool) - spotPrice(end) : spotPrice(end) - poolSpotPrice(pool)
    expect(gap * 1_000_000n < spotPrice(end)).toBe(true)
    const poolCap = poolMarketCap(pool)
    expect(poolCap > 99_999n * USDC && poolCap < 100_001n * USDC).toBe(true)
  })

  test('buying then selling the same tokens never returns more than was paid, at any creator fee', () => {
    const next = stream(7)
    for (let round = 0; round < 300; round += 1) {
      const fee = next() % 1_001
      const usdcIn = BigInt((next() % 5_000_000_000) + 1)
      const buy = outcome(() => quoteBuy(INITIAL_CURVE, usdcIn, fee))
      if (typeof buy === 'string' || buy.graduates) continue
      const sell = outcome(() => quoteSell(buy.next, buy.tokensOut, fee))
      if (typeof sell === 'string') continue
      expect(sell.usdcOut <= buy.usdcSpent).toBe(true)
    }
  })

  test('random trading keeps the curve solvent, k non-decreasing and within supply', () => {
    const next = stream(42)
    for (const fee of [0, 137, 1_000]) {
      let state = INITIAL_CURVE
      let paidIn = 0n
      let paidOut = 0n
      for (let step = 0; step < 1_500 && state.tokensSold < CURVE.CURVE_SUPPLY; step += 1) {
        const before = k(state)
        if (next() % 3 !== 0 || state.tokensSold === 0n) {
          const quote = outcome(() => quoteBuy(state, BigInt((next() % 400_000_000) + 1), fee))
          if (typeof quote === 'string') continue
          paidIn += quote.usdcSpent - quote.platformFee - quote.creatorFee
          state = quote.next
        } else {
          const tokensIn = (state.tokensSold * BigInt((next() % 1000) + 1)) / 1000n
          const quote = outcome(() => quoteSell(state, tokensIn, fee))
          if (typeof quote === 'string') continue
          paidOut += quote.gross
          state = quote.next
        }
        expect(k(state) >= before).toBe(true)
        expect(state.tokensSold <= CURVE.CURVE_SUPPLY).toBe(true)
        expect(state.virtualUsdc >= CURVE.VIRTUAL_USDC_0).toBe(true)
        // what the curve holds is exactly what came in minus what went out
        expect(realUsdc(state)).toBe(paidIn - paidOut)
        expect(state.virtualTokens + state.tokensSold).toBe(CURVE.VIRTUAL_TOKENS_0)
      }
    }
  })

  test('the smallest sell-out buy is never charged more than it offered', () => {
    for (const fee of [0, 1_000]) {
      let low = 25_000n * USDC
      let high = 30_000n * USDC
      while (high - low > 1n) {
        const mid = (low + high) / 2n
        if (quoteBuy(INITIAL_CURVE, mid, fee).graduates) high = mid
        else low = mid
      }
      const atBoundary = quoteBuy(INITIAL_CURVE, high, fee)
      expect(atBoundary.graduates).toBe(true)
      expect(atBoundary.tokensOut).toBe(CURVE.CURVE_SUPPLY)
      expect(atBoundary.usdcSpent <= high).toBe(true)
      expect(quoteBuy(INITIAL_CURVE, low, fee).graduates).toBe(false)
    }
  })

  test('no trade is free: both fees round up, and dust that buys nothing is refused', () => {
    expect(quoteBuy(INITIAL_CURVE, 199n, 0).platformFee).toBe(1n)
    expect(quoteBuy(INITIAL_CURVE, 199n, 1).creatorFee).toBe(1n)
    expect(quoteBuy(INITIAL_CURVE, 1_000_000n, 250).creatorFee).toBe(25_000n)
    expect(() => quoteBuy(INITIAL_CURVE, 1n, 0)).toThrow('ZeroAmount')
    // 2 units at a 10% fee: 1 + 1 of fees eat the whole input.
    expect(() => quoteBuy(INITIAL_CURVE, 2n, 1_000)).toThrow('ZeroAmount')
    const held = quoteBuy(INITIAL_CURVE, 100n * USDC, 0)
    expect(() => quoteSell(held.next, 1n, 0)).toThrow('ZeroAmount')
    expect(quoteSell(held.next, held.tokensOut, 0).platformFee > 0n).toBe(true)
  })

  test('refuses what the contract refuses', () => {
    const soldOut = quoteBuy(INITIAL_CURVE, 1_000_000n * USDC, 0).next
    expect(() => quoteBuy(soldOut, USDC, 0)).toThrow('CurveGraduated')
    expect(() => quoteSell(soldOut, 1n, 0)).toThrow('CurveGraduated')
    expect(() => quoteBuy(INITIAL_CURVE, 0n, 0)).toThrow('ZeroAmount')
    expect(() => quoteSell(INITIAL_CURVE, 1n, 0)).toThrow('ExceedsSold')
    expect(() => quoteBuy(INITIAL_CURVE, USDC, 1_001)).toThrow('CreatorFeeTooHigh')
  })
})

describe('launch pool', () => {
  const opening: PoolReserves = { reserveToken: CURVE.POOL_SUPPLY, reserveUsdc: 25_000n * USDC }

  test('a buy pays both fees out of the USDC in and the pool the rest', () => {
    const quote = quotePoolBuy(opening, 1_000n * USDC, 250)
    expect(quote.platformFee).toBe(5n * USDC)
    expect(quote.creatorFee).toBe(25n * USDC)
    expect(quote.next.reserveUsdc - opening.reserveUsdc).toBe(970n * USDC)
    expect(quote.tokensOut).toBe((970n * USDC * opening.reserveToken) / (opening.reserveUsdc + 970n * USDC))
  })

  test('a sell pays both fees out of the USDC the pool gives up', () => {
    const quote = quotePoolSell(opening, 1_000_000n * 10n ** 18n, 1_000)
    expect(quote.gross).toBe((1_000_000n * 10n ** 18n * opening.reserveUsdc) / (opening.reserveToken + 1_000_000n * 10n ** 18n))
    expect(quote.usdcOut).toBe(quote.gross - quote.platformFee - quote.creatorFee)
    expect(quote.next.reserveUsdc).toBe(opening.reserveUsdc - quote.gross)
  })

  test('the product of the reserves never falls, and a round trip never profits', () => {
    const next = stream(9)
    let reserves = opening
    for (let step = 0; step < 500; step += 1) {
      const fee = next() % 1_001
      const before = reserves.reserveToken * reserves.reserveUsdc
      const buy = outcome(() => quotePoolBuy(reserves, BigInt((next() % 2_000_000_000) + 1), fee))
      if (typeof buy === 'string') continue
      const back = outcome(() => quotePoolSell(buy.next, buy.tokensOut, fee))
      if (typeof back !== 'string') expect(back.usdcOut <= buy.usdcIn).toBe(true)
      reserves = buy.next
      expect(reserves.reserveToken * reserves.reserveUsdc >= before).toBe(true)
    }
  })
})
