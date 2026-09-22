import { describe, expect, test } from 'bun:test'
import { formatUnits, plain, usd } from '../listing/decimal'
import { asks, bestAsk, bestBid, bids, costToBuy, proceedsOfSell, type DepthMarket, type Level } from '../listing/depth'

const close = (a: number, b: number, relative = 1e-9) => Math.abs(a - b) <= relative * Math.max(Math.abs(a), Math.abs(b))
const sum = (levels: Level[], pick: (level: Level) => number) => levels.reduce((total, level) => total + pick(level), 0)

/** Uniswap V2's getAmountOut, in whole units: the pair's own formula. */
const v2Out = (amountIn: number, reserveIn: number, reserveOut: number) => (amountIn * 0.997 * reserveOut) / (reserveIn + amountIn * 0.997)

const core: DepthMarket = { base: 244.524893, target: 281.638016, fee: 0.003, feeOn: 'input' }
const pool: DepthMarket = { base: 200_000_000, target: 25_000, fee: 0.03, feeOn: 'usdc' }

describe('numbers print as plain decimals', () => {
  test('12 significant digits, no exponent, no trailing zeros', () => {
    expect(plain(1.151777)).toBe('1.151777')
    expect(plain(7.8125e-6)).toBe('0.0000078125')
    expect(plain(1 / 3)).toBe('0.333333333333')
    expect(plain(123456789012345)).toBe('123456789012000')
    expect(plain(2500)).toBe('2500')
    expect(plain(0)).toBe('0')
    expect(plain(Number.NaN)).toBe('0')
    expect(plain(-0.5)).toBe('-0.5')
  })

  test('token amounts are exact and USD is to the cent', () => {
    expect(formatUnits(54_446_057_766_727_255_489_401_660n, 18)).toBe('54446057.76672725548940166')
    expect(formatUnits(0n, 6)).toBe('0')
    expect(usd(563.2749)).toBe('563.27')
    expect(usd(6250)).toBe('6250')
    expect(usd(0.5)).toBe('0.5')
    expect(usd(0.004)).toBe('0')
  })
})

describe('an order book derived from reserves', () => {
  test('the best prices are the mid price with the fee on either side', () => {
    const mid = core.target / core.base
    expect(close(bestAsk(core), mid / 0.997)).toBe(true)
    expect(close(bestBid(core), mid * 0.997)).toBe(true)
    expect(close(bestAsk(pool), pool.target / pool.base / 0.97)).toBe(true)
  })

  test('core: buying and selling cost exactly what the pair charges', () => {
    // Buying q base: the pair's getAmountOut for the cost we quote gives back q.
    const q = 10
    expect(close(v2Out(costToBuy(core, q), core.target, core.base), q)).toBe(true)
    expect(close(proceedsOfSell(core, 10), v2Out(10, core.base, core.target))).toBe(true)
  })

  test('launch: fees come out of the USDC side both ways', () => {
    const tokens = 1_000_000
    const gross = (tokens * pool.target) / (pool.base + tokens)
    expect(close(proceedsOfSell(pool, tokens), gross * 0.97)).toBe(true)
    const usdcIn = 100
    const net = usdcIn * 0.97
    const bought = (net * pool.base) / (pool.target + net)
    expect(close(costToBuy(pool, bought), usdcIn)).toBe(true)
  })

  for (const [name, market] of [
    ['core', core],
    ['launch pool', pool],
  ] as const) {
    test(`${name}: taking the first n levels costs what one trade of that size would`, () => {
      const book = { asks: asks(market, 50), bids: bids(market, 50) }
      expect(book.asks).toHaveLength(50)
      expect(book.bids).toHaveLength(50)
      for (const n of [1, 7, 50]) {
        const bought = sum(book.asks.slice(0, n), (level) => level.quantity)
        const paid = sum(book.asks.slice(0, n), (level) => level.quantity * level.price)
        expect(close(paid, costToBuy(market, bought), 1e-8)).toBe(true)
        const sold = sum(book.bids.slice(0, n), (level) => level.quantity)
        const received = sum(book.bids.slice(0, n), (level) => level.quantity * level.price)
        expect(close(received, proceedsOfSell(market, sold), 1e-8)).toBe(true)
      }
    })

    test(`${name}: asks rise and bids fall, both away from the mid`, () => {
      const mid = market.target / market.base
      const up = asks(market, 50)
      const down = bids(market, 50)
      expect(up[0].price).toBeGreaterThan(bestAsk(market))
      expect(bestBid(market)).toBeGreaterThan(down[0].price)
      for (let index = 1; index < 50; index += 1) {
        expect(up[index].price).toBeGreaterThan(up[index - 1].price)
        expect(down[index - 1].price).toBeGreaterThan(down[index].price)
      }
      expect(down[0].price).toBeLessThan(mid)
      expect(up[0].price).toBeGreaterThan(mid)
      // 50 levels of 0.1% reach past 2% on both sides of the mid, which is what depth measures.
      expect(up[49].price).toBeGreaterThan(mid * 1.02)
      expect(mid * 0.98).toBeGreaterThan(down[49].price)
    })
  }

  test('a curve cannot sell more than it has left or buy back more than it sold', () => {
    const curve: DepthMarket = { base: 1_066_666_667, target: 8_333.333334, fee: 0.03, feeOn: 'usdc', maxBuy: 800_000_000, maxSell: 0 }
    expect(bids(curve, 50)).toEqual([])
    const fresh = asks(curve, 50)
    expect(fresh).toHaveLength(50)
    const nearlyDone: DepthMarket = { ...curve, maxBuy: 1_000_000, maxSell: 5_000_000 }
    const left = asks(nearlyDone, 250)
    expect(close(sum(left, (level) => level.quantity), 1_000_000)).toBe(true)
    const back = bids(nearlyDone, 250)
    expect(close(sum(back, (level) => level.quantity), 5_000_000)).toBe(true)
  })

  test('an empty pool has no book', () => {
    expect(asks({ ...core, base: 0 }, 10)).toEqual([])
    expect(bids({ ...core, target: 0 }, 10)).toEqual([])
  })
})
