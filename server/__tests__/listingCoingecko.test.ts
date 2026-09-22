import { describe, expect, test } from 'bun:test'
import { historicalTradesBody, levelsPerSide, liquidityUsd, orderbookBody, pairsBody, tickersBody, usdPrices, MAX_LEVELS_PER_SIDE } from '../listing/coingecko'
import { plain } from '../listing/decimal'
import type { Trade } from '../listing/trades'
import { BLOCK, CORE_PAIR, CURVED, EURC, POOLED, POOLED_PAIR, TIME, USDC, makeSnapshot } from './listingFixtures'

const E18 = 10n ** 18n
const snapshot = makeSnapshot()
const [core, pool, curve] = snapshot.markets

function trade(overrides: Partial<Trade> & Pick<Trade, 'key' | 'type' | 'base' | 'target'>, n: number): Trade {
  return { id: Number(BLOCK) * 1_000_000 + n, block: BLOCK, logIndex: n, txHash: '0x00', time: TIME - 3600 + n, ...overrides }
}

const trades: Trade[] = [
  trade({ key: core.key, type: 'buy', base: 8_316_598n, target: 10_000_000n, before: 1.15, after: 1.2 }, 1),
  trade({ key: core.key, type: 'sell', base: 12_000_000n, target: 13_129_701n, before: 1.2, after: 1.1 }, 2),
  // Older than 24 hours: in no ticker.
  trade({ key: core.key, type: 'sell', base: 1_000_000n, target: 1_000_000n, before: 9, after: 0.1, time: TIME - 90_000 }, 3),
  trade({ key: pool.key, type: 'buy', base: 790_000n * E18, target: 100_000_000n, before: 0.000125, after: 0.000126 }, 4),
]

describe('/pairs', () => {
  test('every market by contract address; a curve is identified by its token', () => {
    expect(pairsBody(snapshot)).toEqual([
      { ticker_id: `${EURC.address}_${USDC.address}`, base: EURC.address, target: USDC.address, pool_id: CORE_PAIR },
      { ticker_id: `${POOLED.address}_${USDC.address}`, base: POOLED.address, target: USDC.address, pool_id: POOLED_PAIR },
      { ticker_id: `${CURVED.address}_${USDC.address}`, base: CURVED.address, target: USDC.address, pool_id: CURVED.address },
    ])
  })
})

describe('/tickers', () => {
  const rows = tickersBody(snapshot, trades, TIME - 86_400)
  const [eurc, pooled, curved] = rows

  test('volumes are the last 24 hours, exact, single-sided in each token', () => {
    expect(eurc.base_volume).toBe('20.316598')
    expect(eurc.target_volume).toBe('23.129701')
    expect(pooled.base_volume).toBe('790000')
    expect(pooled.target_volume).toBe('100')
    expect(curved.base_volume).toBe('0')
    expect(curved.target_volume).toBe('0')
  })

  test('last_price is the pool now; high and low bound it with every price the pool stood at', () => {
    expect(eurc.last_price).toBe('1.15177646147')
    expect(eurc.high).toBe('1.2')
    expect(eurc.low).toBe('1.1')
    // No trades: high and low are the price now.
    expect(curved.high).toBe(curved.last_price)
    expect(curved.low).toBe(curved.last_price)
  })

  test('bid and ask are the price now with the fee on either side', () => {
    expect(eurc.bid).toBe('1.14832113208')
    expect(eurc.ask).toBe('1.15524218803')
    // A 1.5% launch fee (0.5% platform + 1% creator) on the pool, taken from USDC.
    expect(pooled.bid).toBe('0.000123125')
    expect(pooled.ask).toBe('0.000126903553299')
  })

  test('a curve with nothing sold has no bid: there is nothing it can buy back', () => {
    expect('bid' in curved).toBe(false)
    expect(curved.ask).toBe(plain(8_333.333333 / 1_066_666_667 / 0.97))
  })

  test('liquidity in USD: EURC priced by the USDC/EURC pool; a curve counts what it really holds', () => {
    expect(eurc.liquidity_in_usd).toBe('563.28')
    expect(pooled.liquidity_in_usd).toBe('50000')
    // Nothing raised yet: 800M tokens left to sell at the opening price.
    expect(curved.liquidity_in_usd).toBe('6250')
  })

  test('the fields CoinGecko asks for, all strings', () => {
    expect(Object.keys(eurc)).toEqual(['ticker_id', 'base_currency', 'target_currency', 'pool_id', 'last_price', 'base_volume', 'target_volume', 'liquidity_in_usd', 'bid', 'ask', 'high', 'low'])
    for (const value of Object.values(eurc)) expect(typeof value).toBe('string')
  })

  test('an empty pool has no price and no ticker', () => {
    const empty = makeSnapshot({ markets: [{ ...core, baseReserve: 0n }] })
    expect(tickersBody(empty, [], 0)).toEqual([])
  })
})

describe('USD prices', () => {
  test('USDC is 1, EURC comes from the pool, launch tokens from their own market', () => {
    const prices = usdPrices(snapshot)
    expect(prices.get(USDC.address.toLowerCase())).toBe(1)
    expect(prices.get(EURC.address.toLowerCase())).toBe(281.638016 / 244.524893)
    expect(prices.get(POOLED.address.toLowerCase())).toBe(0.000125)
  })

  test('two hops: a token paired only with EURC is priced through EURC', () => {
    const other = { address: '0x5555555555555555555555555555555555555555' as const, symbol: 'OTH', name: 'Other', decimals: 18 }
    const hop = { ...core, tickerId: 'x', key: 'x', poolId: '0x6666666666666666666666666666666666666666' as const, base: other, target: EURC, baseReserve: 1000n * E18, targetReserve: 500_000_000n }
    const prices = usdPrices(makeSnapshot({ markets: [core, hop] }))
    expect(prices.get(other.address.toLowerCase())).toBe(0.5 * (281.638016 / 244.524893))
    expect(liquidityUsd(hop, prices)).toBe(2 * 500 * (281.638016 / 244.524893))
  })

  test('a pair nothing can price is worth 0 rather than a guess', () => {
    const a = { address: '0x7777777777777777777777777777777777777777' as const, symbol: 'A', name: 'A', decimals: 18 }
    const b = { address: '0x8888888888888888888888888888888888888888' as const, symbol: 'B', name: 'B', decimals: 18 }
    const lonely = { ...core, base: a, target: b }
    expect(liquidityUsd(lonely, usdPrices(makeSnapshot({ markets: [lonely] })))).toBe(0)
  })
})

describe('/orderbook', () => {
  test('depth 100 is 50 a side, 0 the most served, anything else half a side, rounded up', () => {
    expect(levelsPerSide(100)).toBe(50)
    expect(levelsPerSide(0)).toBe(MAX_LEVELS_PER_SIDE)
    expect(levelsPerSide(3)).toBe(2)
    expect(levelsPerSide(100_000)).toBe(MAX_LEVELS_PER_SIDE)
  })

  test('levels as [price, quantity] strings, bids falling and asks rising, stamped in milliseconds', () => {
    const book = orderbookBody(core, snapshot, 100)
    expect(book.ticker_id).toBe(core.tickerId)
    expect(book.timestamp).toBe(String(TIME * 1000))
    expect(book.bids).toHaveLength(50)
    expect(book.asks).toHaveLength(50)
    expect(Number(book.bids[0][0])).toBeLessThan(Number(book.asks[0][0]))
    expect(Number(book.bids[1][0])).toBeLessThan(Number(book.bids[0][0]))
    expect(Number(book.asks[1][0])).toBeGreaterThan(Number(book.asks[0][0]))
    for (const [price, quantity] of [...book.bids, ...book.asks]) {
      expect(/^\d+(\.\d+)?$/.test(price) && /^\d+(\.\d+)?$/.test(quantity)).toBe(true)
    }
  })

  test('a fresh curve can only be bought from', () => {
    const book = orderbookBody(curve, snapshot, 20)
    expect(book.bids).toEqual([])
    expect(book.asks).toHaveLength(10)
  })
})

describe('/historical_trades', () => {
  const window = { from: TIME - 86_400, to: TIME }

  test('buys and sells, newest first, as the spec shapes them', () => {
    const body = historicalTradesBody(core, trades, { ...window, limit: 200 })
    expect(body.buy).toEqual([{ trade_id: Number(BLOCK) * 1_000_000 + 1, price: '1.20241473737', base_volume: '8.316598', target_volume: '10', trade_timestamp: String(TIME - 3599), type: 'buy' }])
    expect(body.sell.map((row) => row.trade_id)).toEqual([Number(BLOCK) * 1_000_000 + 2])
  })

  test('type picks one side; limit counts the newest trades of both', () => {
    expect(historicalTradesBody(core, trades, { ...window, type: 'sell', limit: 200 }).buy).toEqual([])
    const newest = historicalTradesBody(core, trades, { ...window, limit: 1 })
    expect(newest.buy).toEqual([])
    expect(newest.sell).toHaveLength(1)
  })

  test('only the window asked for', () => {
    const older = historicalTradesBody(core, trades, { from: TIME - 100_000, to: TIME - 80_000, limit: 0 })
    expect(older.sell.map((row) => row.base_volume)).toEqual(['1'])
    expect(older.buy).toEqual([])
  })
})
