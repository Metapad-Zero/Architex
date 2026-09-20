import { describe, expect, test } from 'bun:test'
import { CURVE, INITIAL_CURVE, marketCap, progressBps, quoteBuy, quoteSell, realUsdc, spotPrice, type CurveState } from '../curve'

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

describe('bonding curve', () => {
  test('opens near a $6,250 market cap and a first $100 buys about 1.26% of supply', () => {
    expect(marketCap(INITIAL_CURVE)).toBe(6_249_999_997n)
    const quote = quoteBuy(INITIAL_CURVE, 100n * USDC)
    expect(quote.fee).toBe(500_000n)
    expect(quote.usdcSpent).toBe(100n * USDC)
    expect(quote.graduates).toBe(false)
    const percentOfSupplyX1000 = (quote.tokensOut * 100_000n) / CURVE.TOTAL_SUPPLY
    expect(percentOfSupplyX1000 > 1_200n && percentOfSupplyX1000 < 1_300n).toBe(true)
  })

  test('the buy that sells out fills exactly the remainder and is charged only for it', () => {
    const quote = quoteBuy(INITIAL_CURVE, 1_000_000n * USDC)
    expect(quote.tokensOut).toBe(CURVE.CURVE_SUPPLY)
    expect(quote.graduates).toBe(true)
    expect(quote.next.tokensSold).toBe(CURVE.CURVE_SUPPLY)
    // about 25,000 USDC raised plus the 0.5% fee on top, nowhere near the 1,000,000 offered
    expect(quote.usdcSpent > 25_125n * USDC && quote.usdcSpent < 25_126n * USDC).toBe(true)
    expect(realUsdc(quote.next) > 24_999n * USDC && realUsdc(quote.next) <= 25_000n * USDC).toBe(true)
    expect(progressBps(quote.next)).toBe(10_000n)
  })

  test('graduation lands on a $100,000 market cap and the pool opens at the same price', () => {
    const end = quoteBuy(INITIAL_CURVE, 1_000_000n * USDC).next
    const cap = marketCap(end)
    expect(cap > 99_999n * USDC && cap < 100_001n * USDC).toBe(true)
    // pool price = raised USDC / POOL_SUPPLY, compared with the curve's final spot price
    const poolPrice = (realUsdc(end) * 10n ** 36n) / CURVE.POOL_SUPPLY
    const curvePrice = spotPrice(end)
    const gap = poolPrice > curvePrice ? poolPrice - curvePrice : curvePrice - poolPrice
    expect(gap * 1_000_000n < curvePrice).toBe(true)
  })

  test('buying then selling the same tokens never returns more than was paid', () => {
    const next = stream(7)
    for (let round = 0; round < 300; round += 1) {
      const usdcIn = BigInt((next() % 5_000_000_000) + 1)
      const buy = quoteBuy(INITIAL_CURVE, usdcIn)
      if (buy.graduates || buy.tokensOut === 0n) continue
      const sell = quoteSell(buy.next, buy.tokensOut)
      expect(sell.usdcOut <= buy.usdcSpent).toBe(true)
    }
  })

  test('random trading keeps the curve solvent, k non-decreasing and within supply', () => {
    const next = stream(42)
    let state = INITIAL_CURVE
    let paidIn = 0n
    let paidOut = 0n
    for (let step = 0; step < 2_000 && state.tokensSold < CURVE.CURVE_SUPPLY; step += 1) {
      const before = k(state)
      if (next() % 3 !== 0 || state.tokensSold === 0n) {
        const quote = quoteBuy(state, BigInt((next() % 400_000_000) + 1))
        paidIn += quote.usdcSpent - quote.fee
        state = quote.next
      } else {
        const tokensIn = (state.tokensSold * BigInt((next() % 1000) + 1)) / 1000n
        if (tokensIn === 0n) continue
        const quote = quoteSell(state, tokensIn)
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
  })

  test('many small buys never beat one large buy by more than rounding dust', () => {
    const single = quoteBuy(INITIAL_CURVE, 1_000n * USDC)
    let state = INITIAL_CURVE
    let tokens = 0n
    for (let part = 0; part < 1_000; part += 1) {
      const quote = quoteBuy(state, 1n * USDC)
      tokens += quote.tokensOut
      state = quote.next
    }
    expect(tokens <= single.tokensOut).toBe(true)
  })

  test('the smallest sell-out buy is never charged more than it offered', () => {
    // walk down to the smallest input that still sells out the whole curve
    let low = 25_000n * USDC
    let high = 26_000n * USDC
    while (high - low > 1n) {
      const mid = (low + high) / 2n
      if (quoteBuy(INITIAL_CURVE, mid).graduates) high = mid
      else low = mid
    }
    const atBoundary = quoteBuy(INITIAL_CURVE, high)
    expect(atBoundary.graduates).toBe(true)
    expect(atBoundary.tokensOut).toBe(CURVE.CURVE_SUPPLY)
    expect(atBoundary.usdcSpent <= high).toBe(true)
    expect(quoteBuy(INITIAL_CURVE, low).graduates).toBe(false)
    // and with one token-wei left, a 2-unit buy finishes the curve without over-charging
    const almost: CurveState = { ...quoteBuy(INITIAL_CURVE, low).next }
    const finish = quoteBuy(almost, 1_000n * USDC)
    expect(finish.graduates).toBe(true)
    expect(finish.usdcSpent <= 1_000n * USDC).toBe(true)
    expect(finish.next.tokensSold).toBe(CURVE.CURVE_SUPPLY)
  })

  test('no trade is free: fees round up, and dust that buys nothing is refused', () => {
    expect(quoteBuy(INITIAL_CURVE, 199n).fee).toBe(1n)
    expect(quoteBuy(INITIAL_CURVE, 1_000_000n).fee).toBe(5_000n)
    expect(() => quoteBuy(INITIAL_CURVE, 1n)).toThrow('ZeroAmount')
    const held = quoteBuy(INITIAL_CURVE, 100n * USDC)
    expect(() => quoteSell(held.next, 1n)).toThrow('ZeroAmount')
    expect(quoteSell(held.next, held.tokensOut).fee > 0n).toBe(true)
  })

  test('refuses what the contract refuses', () => {
    const soldOut = quoteBuy(INITIAL_CURVE, 1_000_000n * USDC).next
    expect(() => quoteBuy(soldOut, USDC)).toThrow('CurveGraduated')
    expect(() => quoteSell(soldOut, 1n)).toThrow('CurveGraduated')
    expect(() => quoteBuy(INITIAL_CURVE, 0n)).toThrow('ZeroAmount')
    expect(() => quoteSell(INITIAL_CURVE, 1n)).toThrow('InsufficientSold')
  })
})
