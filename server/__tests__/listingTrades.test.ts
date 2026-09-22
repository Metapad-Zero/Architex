import { describe, expect, test } from 'bun:test'
import { launchRouterAbi, launchpadAbi, pairAbi, launchPairAbi } from '../../src/lib/abi'
import { coreTrade, launchReservesBefore, launchTrade, priceOf, readTrades, tradeId, tradeSources, TRADE_TOPICS } from '../listing/trades'
import { BLOCK, CORE_PAIR, CURVED, CURVED_PAIR, EURC, POOLED, POOLED_PAIR, TIME, USDC, makeLog, makeSnapshot, network, tx } from './listingFixtures'

const E18 = 10n ** 18n
const close = (a: number | undefined, b: number, relative = 1e-9) => a !== undefined && Math.abs(a - b) <= relative * Math.abs(b)

describe('a core Swap as a trade between base and target', () => {
  // USDC is token0 and EURC token1 in the real pair; the market is EURC (base) in USDC (target).
  test('USDC in, EURC out is a buy of EURC', () => {
    expect(coreTrade({ amount0In: 10_000_000n, amount1In: 0n, amount0Out: 0n, amount1Out: 8_316_598n }, false)).toEqual({ type: 'buy', base: 8_316_598n, target: 10_000_000n })
  })

  test('EURC in, USDC out is a sell of EURC', () => {
    expect(coreTrade({ amount0In: 0n, amount1In: 12_000_000n, amount0Out: 13_129_701n, amount1Out: 0n }, false)).toEqual({ type: 'sell', base: 12_000_000n, target: 13_129_701n })
  })

  test('with base as token0 the sides swap', () => {
    expect(coreTrade({ amount0In: 5n, amount1In: 0n, amount0Out: 0n, amount1Out: 7n }, true)).toEqual({ type: 'sell', base: 5n, target: 7n })
  })

  test('a flash loan repaid in the same token is not a trade', () => {
    expect(coreTrade({ amount0In: 101n, amount1In: 0n, amount0Out: 100n, amount1Out: 0n }, false)).toBe(undefined)
  })
})

describe('a launch trade from the trader side', () => {
  const fees = { platformFee: 500_000n, creatorFee: 2_500_000n }
  test('a buyer paid the gross USDC, fees included', () => {
    expect(launchTrade({ isBuy: true, usdcAmount: 100_000_000n, tokenAmount: 5n * E18, ...fees })).toEqual({ type: 'buy', base: 5n * E18, target: 100_000_000n })
  })

  test('a seller received the gross USDC less both fees', () => {
    expect(launchTrade({ isBuy: false, usdcAmount: 100_000_000n, tokenAmount: 5n * E18, ...fees })).toEqual({ type: 'sell', base: 5n * E18, target: 97_000_000n })
  })

  test('the reserves before a trade: fees never enter the pool', () => {
    const after = { token: 100n * E18, usdc: 1_000_000_000n }
    expect(launchReservesBefore(after, { isBuy: true, usdcAmount: 100_000_000n, tokenAmount: 5n * E18, ...fees })).toEqual({ token: 105n * E18, usdc: 903_000_000n })
    expect(launchReservesBefore(after, { isBuy: false, usdcAmount: 100_000_000n, tokenAmount: 5n * E18, ...fees })).toEqual({ token: 95n * E18, usdc: 1_100_000_000n })
  })
})

describe('reading trades from logs', () => {
  const snapshot = makeSnapshot()
  const place = (offset: number, logIndex: number, time = TIME - 100 + offset) => ({ block: BLOCK - 1000n + BigInt(offset), logIndex, tx: tx(offset), time })

  const logs = [
    // A core buy: Sync then Swap, as ArchitexPair emits them.
    makeLog(CORE_PAIR, pairAbi, 'Sync', { reserve0: 291_638_016n, reserve1: 236_208_295n }, place(1, 4)),
    makeLog(CORE_PAIR, pairAbi, 'Swap', { sender: USDC.address, amount0In: 10_000_000n, amount1In: 0n, amount0Out: 0n, amount1Out: 8_316_598n, to: USDC.address }, place(1, 5)),
    // A launch pool buy: the router's PoolTrade first, the pool's Sync (token first) and Swap after.
    makeLog(network.launchRouter, launchRouterAbi, 'PoolTrade', { token: POOLED.address, trader: EURC.address, isBuy: true, usdcAmount: 100_000_000n, tokenAmount: 790_000n * E18, platformFee: 500_000n, creatorFee: 1_000_000n }, place(2, 1)),
    makeLog(POOLED_PAIR, launchPairAbi, 'Sync', { reserveToken: 199_210_000n * E18, reserveUsdc: 25_098_500_000n }, place(2, 6)),
    makeLog(POOLED_PAIR, launchPairAbi, 'Swap', { sender: network.launchRouter, tokenIn: 0n, usdcIn: 98_500_000n, tokenOut: 790_000n * E18, usdcOut: 0n, to: EURC.address }, place(2, 7)),
    // A curve sell.
    makeLog(network.launchpad, launchpadAbi, 'Trade', { token: CURVED.address, trader: EURC.address, isBuy: false, usdcAmount: 211_702_499n, tokenAmount: 27_223_028n * E18, platformFee: 1_058_513n, creatorFee: 5_292_563n, virtualUsdc: 8_333_333_334n, virtualTokens: 1_066_666_667n * E18 }, place(3, 30)),
  ]

  const trades = readTrades(logs, snapshot)

  test('one trade per swap, keyed to its market, with the pool Swap of a launch trade skipped', () => {
    expect(trades.map((trade) => trade.key)).toEqual([snapshot.markets[0].key, snapshot.markets[1].key, snapshot.markets[2].key])
    expect(trades.map((trade) => trade.type)).toEqual(['buy', 'buy', 'sell'])
  })

  test('ids are integers from the block and log index; times come from the log', () => {
    expect(trades[0].id).toBe(tradeId(BLOCK - 999n, 5))
    expect(Number.isSafeInteger(trades[0].id)).toBe(true)
    expect(trades[0].time).toBe(TIME - 99)
  })

  test('core: the price either side of the swap comes from its Sync', () => {
    expect(close(trades[0].after, 291.638016 / 236.208295)).toBe(true)
    expect(close(trades[0].before, 281.638016 / 244.524893)).toBe(true)
  })

  test('launch pool: the Sync after the PoolTrade, with the fees kept out of the pool', () => {
    expect(trades[1].target).toBe(100_000_000n)
    expect(close(trades[1].after, 25_098.5 / 199_210_000)).toBe(true)
    expect(close(trades[1].before, 25_000 / 200_000_000)).toBe(true)
  })

  test('curve: prices from the virtual reserves the Trade carries', () => {
    expect(trades[2].target).toBe(211_702_499n - 1_058_513n - 5_292_563n)
    expect(close(trades[2].after, 8_333.333334 / 1_066_666_667)).toBe(true)
    expect(close(trades[2].before, (8_333.333334 + 211.702499) / (1_066_666_667 - 27_223_028))).toBe(true)
  })

  test('without blockTimestamp, the time comes from the lookup, and a log with no time is skipped', () => {
    const bare = logs.slice(0, 2).map((log) => ({ ...log, blockTimestamp: undefined }))
    expect(readTrades(bare, snapshot, () => 42)[0].time).toBe(42)
    expect(readTrades(bare, snapshot)).toEqual([])
  })

  test('a Swap from a pool that is not one of our markets, or garbage, is not a trade', () => {
    const stranger = { ...logs[1], address: '0x9999999999999999999999999999999999999999' as const }
    const garbage = { ...logs[1], data: '0x1234' as const }
    expect(readTrades([stranger, garbage], snapshot)).toEqual([])
  })

  test('the sources are the core pairs, the graduated pools, the launchpad and the launch router', () => {
    const sources = tradeSources(snapshot).map((address) => address.toLowerCase())
    expect(sources).toContain(CORE_PAIR.toLowerCase())
    expect(sources).toContain(POOLED_PAIR.toLowerCase())
    expect(sources).toContain(network.launchpad.toLowerCase())
    expect(sources).toContain(network.launchRouter.toLowerCase())
    expect(sources.includes(CURVED_PAIR.toLowerCase())).toBe(false)
    expect(TRADE_TOPICS).toHaveLength(4)
  })
})

describe('prices in whole tokens', () => {
  test('decimals are applied on both sides', () => {
    expect(close(priceOf(244_524_893n, 281_638_016n, 6, 6), 281.638016 / 244.524893)).toBe(true)
    expect(close(priceOf(1_066_666_667n * E18, 8_333_333_333n, 18, 6), 7.8125e-6)).toBe(true)
    expect(priceOf(0n, 1n, 6, 6)).toBe(undefined)
  })
})
