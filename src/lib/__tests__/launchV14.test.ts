import { describe, expect, test } from 'bun:test'
import { decodeErrorResult, decodeEventLog, encodeErrorResult, getAbiItem, getAddress, toEventSelector, zeroAddress, type Address, type Hex } from 'viem'
import mainnet from '../../deployments/arc-mainnet.json'
import testnet from '../../deployments/arc-testnet.json'
import { launchHookAbi, launchpadV14Abi } from '../abi'
import { CURVE, INITIAL_CURVE, marketCap, quoteBuy, spotPrice, type CurveState } from '../curve'
import { UNISWAP_V4_ARC, pluginSuiteOf, type LaunchSuiteV14 } from '../deployment'
import { explainRevert, wrappedErrorName } from '../errors'
import { asLaunchCurveV14, isPriced, launchFacts, launchVersion, tradeUsdc, type LaunchRecord } from '../launch'
import { mergeNewestFirst } from '../launchPages'
import { quoteLaunchTrade, quoteV4Trade } from '../launchQuote'
import { decodeTradeLog, feedVenue, tradeFeeds, TRADE_EVENTS } from '../launchTradeLogs'
import {
  V14,
  bidRange,
  canLockBid,
  grossOfSell,
  launchPoolKey,
  maxV4Trade,
  poolFeesOnGross,
  poolIdOf,
  poolTradeMarketCap,
  secondsUntil,
  snipeBps,
  snipeWindowEnd,
  usdcIsCurrency0,
  v4MarketCap,
  v4SpotPrice,
  v4Value,
} from '../launchV14'
import vectors from './fixtures/v14-vectors.json'

type Vector = { k: string; [key: string]: unknown }
const all = vectors as Vector[]
const big = (value: unknown) => BigInt(value as string)
const suiteVector = all.find((v) => v.k === 'suite') as unknown as { usdc: Address; launchpad: Address; hook: Address; router: Address; poolManager: Address }
const USDC = suiteVector.usdc

function outcome<T>(fn: () => T): T | string {
  try {
    return fn()
  } catch (error) {
    return (error as Error).message
  }
}

function logsOf(step: string, emitter: 'launchpad' | 'hook') {
  return all
    .filter((v) => v.k === 'log' && v.step === step && v.emitter === emitter)
    .map((v) => ({ topics: v.topics as Hex[], data: v.data as Hex }))
}

function v14Launch(patch: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    version: 'v14',
    token: getAddress('0x00000000000000000000000000000000000000b1'),
    creator: getAddress('0x00000000000000000000000000000000000000c1'),
    pair: zeroAddress,
    ...INITIAL_CURVE,
    createdAt: 0n,
    createdBlock: 1_000n,
    graduated: false,
    openPool: false,
    creatorFeeBps: 250,
    pluginHooks: false,
    plugin: getAddress('0x00000000000000000000000000000000000000c1'),
    metadataURI: '',
    name: 'Token',
    symbol: 'TKN',
    ...patch,
  }
}

/**
 * The vectors come from the v1.4 contracts themselves (contracts-v14/test/SiteVectorsV14.t.sol: the launchpad, the
 * hook and the router over Uniswap's own PoolManager code, with USDC at Arc's address 0x3600…).
 */
describe('the anti-sniping fee matches the contracts block by block', () => {
  test('90% in the opening block, falling by 4.5 points a block to 0 after 20, capped by the 99% total', () => {
    const schedule = all.filter((v) => v.k === 'snipe')
    expect(schedule.length).toBe(44)
    for (const v of schedule) expect(snipeBps(big(v.open), big(v.block), v.c as number)).toBe(v.bps as number)
    // At a 10% creator fee the total binds in the opening block: 99% - 0.5% - 10% = 88.5%.
    expect(snipeBps(0n, 0n, 1_000)).toBe(8_850)
    expect(snipeBps(0n, 1n, 1_000)).toBe(8_550)
  })

  test('a clock behind the window reads as its opening block, and the window ends 20 blocks on', () => {
    expect(snipeBps(100n, 90n, 0)).toBe(9_000)
    expect(snipeWindowEnd(100n)).toBe(120n)
    expect(snipeBps(100n, 119n, 0)).toBe(450)
    expect(snipeBps(100n, 120n, 0)).toBe(0)
    expect(secondsUntil(120n, 100n)).toBe(10)
    expect(secondsUntil(120n, 119n)).toBe(1)
    expect(secondsUntil(120n, 121n)).toBe(0)
  })
})

describe('curve buys with the snipe fee match the v1.4 launchpad to the unit', () => {
  const buys = all.filter((v) => v.k === 'cb14')
  const stateOf = (v: Vector): CurveState => ({ virtualUsdc: big(v.vu), virtualTokens: big(v.vt), tokensSold: big(v.sold) })

  test('quotes at every rate, creator fee and size, the sell-out buy and its three-way split included', () => {
    expect(buys.length).toBe(108)
    expect(buys.filter((v) => (v.r as unknown[] | undefined)?.[5] === true).length).toBeGreaterThan(10)
    expect(buys.filter((v) => (v.s as number) > 0 && (v.r as unknown[] | undefined)?.[5] === true).length).toBeGreaterThan(5)
    for (const v of buys) {
      const got = outcome(() => quoteBuy(stateOf(v), big(v.in), v.c as number, v.s as number))
      if (v.e) {
        const name = decodeErrorResult({ abi: launchpadV14Abi, data: (v.e as string).slice(0, 10) as Hex }).errorName
        expect(got).toBe(name)
        continue
      }
      if (typeof got === 'string') throw new Error(`${JSON.stringify(v)} threw ${got}`)
      expect([got.tokensOut, got.platformFee, got.creatorFee, got.snipeFee, got.usdcSpent, got.graduates].map(String)).toEqual((v.r as unknown[]).map(String))
    }
  })

  test('with no snipe fee the v1.4 curve is v1.3’s, unit for unit', () => {
    for (const v of buys.filter((row) => row.s === 0 && row.r)) {
      const withV14 = quoteBuy(stateOf(v), big(v.in), v.c as number, 0)
      const withV13 = quoteBuy(stateOf(v), big(v.in), v.c as number)
      expect(withV14).toEqual(withV13)
      expect(withV14.snipeFee).toBe(0n)
    }
  })

  test('the site’s quote for a v1.4 curve buy carries the fee, a sell never does, and v1.3 ignores the rate', () => {
    const v = buys.find((row) => row.s === 8550 && row.c === 250 && row.in === '5000000000')!
    const launch = v14Launch({ ...stateOf(v) })
    const quote = quoteLaunchTrade(launch, 'buy', big(v.in), 50, 8550)!
    const r = v.r as string[]
    expect([quote.amountOut, quote.platformFee, quote.creatorFee, quote.snipeFee, quote.amountIn].map(String)).toEqual(r.slice(0, 5))
    expect(quote.snipeBps).toBe(8550)
    const sell = quoteLaunchTrade({ ...launch, tokensSold: 10n ** 24n }, 'sell', 10n ** 21n, 50, 8550)!
    expect([sell.snipeFee, sell.snipeBps]).toEqual([0n, 0])
    const v13 = quoteLaunchTrade({ ...launch, version: undefined }, 'buy', big(v.in), 50, 8550)!
    expect([v13.snipeFee, v13.snipeBps]).toEqual([0n, 0])
  })
})

describe('the Uniswap v4 pool a token graduates into', () => {
  test('the key and id match the hook’s, with USDC on either side of the token', () => {
    const keys = all.filter((v) => v.k === 'key')
    expect(keys.map((v) => usdcIsCurrency0(USDC, v.token as Address)).sort()).toEqual([false, true])
    for (const v of keys) {
      const key = launchPoolKey(v.token as Address, USDC, suiteVector.hook)
      expect(key).toEqual({
        currency0: v.currency0 as Address,
        currency1: v.currency1 as Address,
        fee: v.fee as number,
        tickSpacing: v.tickSpacing as number,
        hooks: v.hooks as Address,
      })
      expect(poolIdOf(key)).toBe(v.poolId as Hex)
    }
    expect([V14.LP_FEE, V14.TICK_SPACING]).toEqual([0, 200])
  })

  test('a pool opens at the curve’s last price: the same price and a $100,000 market cap either way round', () => {
    for (const v of all.filter((row) => row.k === 'grad')) {
      const pool = { sqrtPriceX96: big(v.sqrtPriceX96), usdcIs0: v.usdcIs0 as boolean }
      expect(pool.usdcIs0).toBe(usdcIsCurrency0(USDC, v.token as Address))
      const curve = { virtualUsdc: big(v.vu), virtualTokens: big(v.vt) }
      const curvePrice = spotPrice(curve)
      const poolPrice = v4SpotPrice(pool)
      // The pool's price is a square root rounded to 96 bits: equal to about one part in 10^9.
      expect(Number(poolPrice > curvePrice ? poolPrice - curvePrice : curvePrice - poolPrice) / Number(curvePrice)).toBeLessThan(1e-9)
      const cap = v4MarketCap(pool)
      expect(Number(cap > marketCap(curve) ? cap - marketCap(curve) : marketCap(curve) - cap) / Number(marketCap(curve))).toBeLessThan(1e-9)
      expect(cap / 1_000_000n).toBe(99_999n)
      expect(v4Value(CURVE.POOL_SUPPLY, pool) / 1_000_000n).toBe(24_999n)
    }
  })

  test('a price reads the same whichever currency USDC is', () => {
    // 0.000125 USDC a token: 125 USDC units per 10^18 token units, as each ordering writes it.
    const price1 = 125n * (1n << 192n) / 10n ** 18n
    const sqrt = (value: bigint) => {
      let x = value
      let y = (x + 1n) / 2n
      while (y < x) {
        x = y
        y = (x + value / x) / 2n
      }
      return x
    }
    const asCurrency1 = { sqrtPriceX96: sqrt(price1), usdcIs0: false }
    const asCurrency0 = { sqrtPriceX96: sqrt(((1n << 192n) * 10n ** 18n) / 125n), usdcIs0: true }
    for (const pool of [asCurrency0, asCurrency1]) {
      expect(Math.abs(Number(v4SpotPrice(pool)) / 1e20 - 1.25)).toBeLessThan(1e-8)
      expect(Math.abs(Number(v4MarketCap(pool)) / 1e6 - 100_000)).toBeLessThan(0.01)
    }
    expect(v4SpotPrice({ sqrtPriceX96: 0n, usdcIs0: true })).toBe(0n)
  })
})

describe('pool trades through the router match the hook’s fees', () => {
  const quotes = all.filter((v) => v.k === 'pq')
  const decode = (log: { topics: Hex[]; data: Hex }) => decodeTradeLog('poolV14', log.data, log.topics)

  test('the router’s quote is what the trade got, and the hook’s event carries the fees the site works out', () => {
    expect(quotes.filter((v) => (v.s as number) > 0).length).toBe(8)
    let index = 0
    const steps = [0, 1].flatMap((s) => [0, 1].flatMap((w) => [...[0, 1, 2, 3].map((b) => `pool buy ${s}-${w}-${b}`), ...[0, 1, 2].map((b) => `pool sell ${s}-${w}-${b}`)]))
    expect(steps.length).toBe(quotes.length)
    for (const v of quotes) {
      const step = steps[index++]
      expect(step.startsWith(`pool ${v.side as string}`)).toBe(true)
      const hookLog = logsOf(step, 'hook')
      expect(hookLog.length).toBe(1)
      // A swap never reaches the launchpad: its fees wait as the hook's claims, and PoolFeesAccrued marks a sync.
      expect(logsOf(step, 'launchpad')).toEqual([])
      const trade = decode(hookLog[0])
      expect(v.quote).toBe(v.out)
      expect(trade.viaRouter).toBe(true)
      expect(getAddress(trade.trader)).toBe(getAddress(suiteVector.router))
      if (v.side === 'buy') {
        const fees = poolFeesOnGross(big(v.in), v.c as number, v.s as number)
        expect([trade.isBuy, trade.usdcAmount, trade.tokenAmount]).toEqual([true, big(v.in), big(v.out)])
        expect([trade.platformFee, trade.creatorFee, trade.snipeFee]).toEqual([fees.platformFee, fees.creatorFee, fees.snipeFee])
      } else {
        const gross = grossOfSell(big(v.out), v.c as number)
        const fees = poolFeesOnGross(gross, v.c as number)
        expect([trade.isBuy, trade.tokenAmount, trade.snipeFee]).toEqual([false, big(v.in), 0n])
        // Rounding can leave two grosses with the same net; either way the fees and the net are the hook's.
        expect(gross - fees.platformFee - fees.creatorFee).toBe(big(v.out))
        expect(trade.usdcAmount - trade.platformFee - trade.creatorFee).toBe(big(v.out))
        expect(trade.usdcAmount - gross < 2n && gross - trade.usdcAmount < 2n).toBe(true)
        expect(tradeUsdc(trade)).toBe(big(v.out))
      }
    }
  })

  test('the site’s pool quote: the fees, the minimum, and the impact against the price before, either way round', () => {
    for (const v of quotes) {
      const pool = { poolId: '0x' as Hex, sqrtPriceX96: big(v.sqrtBefore), usdcIs0: v.usdcIs0 as boolean, openBlock: 0n }
      const launch = v14Launch({ graduated: true, tokensSold: CURVE.CURVE_SUPPLY, v4: pool })
      const side = v.side as 'buy' | 'sell'
      const quote = quoteV4Trade(launch, side, big(v.in), big(v.out), 100, v.s as number)!
      expect(quote.venue).toBe('pool')
      expect(quote.minReceived).toBe((big(v.out) * 9_900n) / 10_000n)
      // The impact, in floating point: what the trade got against what the pool's price before it said.
      const ratio = Number(big(v.sqrtBefore)) / 2 ** 96
      const tokenPrice = v.usdcIs0 ? 1 / (ratio * ratio) : ratio * ratio
      const fees = Number(quote.platformFee + quote.creatorFee + quote.snipeFee)
      const float = side === 'buy'
        ? 1 - (Number(big(v.out)) * tokenPrice) / (Number(big(v.in)) - fees)
        : 1 - (Number(big(v.out)) + fees) / (Number(big(v.in)) * tokenPrice)
      expect(Math.abs(Number(quote.priceImpactBps) - float * 10_000)).toBeLessThan(1.01)
    }
    // A dollar barely moves a $100,000 pool; 40,000 USDC moves it a long way.
    const small = quotes.find((v) => v.side === 'buy' && v.in === '1000000' && v.s === 0)!
    const large = quotes.find((v) => v.side === 'buy' && v.in === '40000000000' && v.s === 0)!
    const impact = (v: Vector) =>
      quoteV4Trade(
        v14Launch({ graduated: true, v4: { poolId: '0x', sqrtPriceX96: big(v.sqrtBefore), usdcIs0: v.usdcIs0 as boolean, openBlock: 0n } }),
        'buy',
        big(v.in),
        big(v.out),
        50,
      )!.priceImpactBps
    expect(impact(small)).toBeLessThan(2n)
    expect(impact(large)).toBeGreaterThan(3_000n)
  })

  test('the hook holds a pool’s fees until a sync books them: creator fees ready = the launchpad’s + the hook’s', () => {
    const pending = all.filter((v) => v.k === 'pending')
    expect(pending.length).toBe(2)
    pending.forEach((v, s) => {
      const trades = all
        .filter((row) => row.k === 'log' && row.emitter === 'hook' && String(row.step).startsWith('pool ') && String(row.step).includes(` ${s}-`))
        .map((row) => decodeTradeLog('poolV14', row.data as Hex, row.topics as Hex[]))
      expect(trades.length).toBe(14)
      const platform = trades.reduce((sum, trade) => sum + trade.platformFee, 0n)
      const creator = trades.reduce((sum, trade) => sum + trade.creatorFee, 0n)
      expect([big(v.hookPlatform), big(v.hookCreator)]).toEqual([platform, creator])
      // The sync: the hook releases exactly that to the launchpad, which books it.
      const [released] = logsOf(`sync ${s}`, 'hook')
      const releasedEvent = decodeEventLog({ abi: launchHookAbi, data: released.data, topics: released.topics as [Hex, ...Hex[]] })
      if (releasedEvent.eventName !== 'FeesReleased') throw new Error(releasedEvent.eventName)
      expect([releasedEvent.args.platformFee, releasedEvent.args.creatorFee]).toEqual([platform, creator])
      const [booked] = logsOf(`sync ${s}`, 'launchpad')
      const bookedEvent = decodeEventLog({ abi: launchpadV14Abi, data: booked.data, topics: booked.topics as [Hex, ...Hex[]] })
      if (bookedEvent.eventName !== 'PoolFeesAccrued') throw new Error(bookedEvent.eventName)
      expect([bookedEvent.args.platformFee, bookedEvent.args.creatorFee]).toEqual([platform, creator])
    })
  })

  test('a bid is anchored to the graduation tick, and lock places nothing while the price is under its top', () => {
    const locks = all.filter((v) => v.k === 'lock')
    expect(locks.length).toBe(4)
    expect(locks.map((v) => v.usdcIs0).sort()).toEqual([false, false, true, true])
    locks.forEach((v, index) => {
      const s = Math.floor(index / 2)
      const step = index % 2
      const placed = big(v.bidsAfter) > big(v.bidsBefore)
      expect(canLockBid(v.tick as number, v.graduationTick as number, v.usdcIs0 as boolean)).toBe(placed)
      // The dump first (under half the graduation price: nothing placed, the USDC waits), then the buy back.
      expect(placed).toBe(step === 1)
      expect(big(v.heldAfter)).toBe(placed ? 0n : big(v.held))
      const bids = logsOf(`lock ${s}-${step}`, 'hook')
      expect(bids.length).toBe(placed ? 1 : 0)
      if (placed) {
        const event = decodeEventLog({ abi: launchHookAbi, data: bids[0].data, topics: bids[0].topics as [Hex, ...Hex[]] })
        if (event.eventName !== 'BidLocked') throw new Error(event.eventName)
        const range = bidRange(v.graduationTick as number, v.usdcIs0 as boolean)
        expect([event.args.tickLower, event.args.tickUpper]).toEqual([range.lower, range.upper])
        expect(event.args.usdc).toBe(big(v.held))
        expect(range.upper - range.lower).toBe(V14.BID_SPAN_TICKS)
      }
    })
    // Half the graduation price is 6,932 ticks away, in whichever direction makes the token cheaper.
    expect(bidRange(366_200, true)).toEqual({ lower: 373_200, upper: 465_400 })
    expect(bidRange(-366_201, false)).toEqual({ lower: -465_400, upper: -373_200 })
    expect(canLockBid(373_199, 366_200, true)).toBe(true)
    expect(canLockBid(373_200, 366_200, true)).toBe(false)
    expect(canLockBid(-373_200, -366_201, false)).toBe(true)
    expect(canLockBid(-373_201, -366_201, false)).toBe(false)
    // A range that would run past Uniswap's usable ticks stops at the edge.
    expect(bidRange(850_000, true).upper).toBe(V14.MAX_USABLE_TICK)
    expect(bidRange(-850_000, false).lower).toBe(V14.MIN_USABLE_TICK)
  })

  test('the hook refuses fees that take everything, and so does the site', () => {
    expect(outcome(() => poolFeesOnGross(1n, 0, 9_000))).toBe('FeesExceedAmount')
    expect(outcome(() => poolFeesOnGross(100n, 1_000, 8_850))).toBe('FeesExceedAmount')
    expect(poolFeesOnGross(1_000_000n, 250, 0)).toEqual({ platformFee: 5_000n, creatorFee: 25_000n, snipeFee: 0n })
    expect(quoteV4Trade(v14Launch({ graduated: true, v4: { poolId: '0x', sqrtPriceX96: 1n << 96n, usdcIs0: true, openBlock: 0n } }), 'buy', 1n, 1n, 50, 9_000)).toBe(undefined)
    expect(quoteV4Trade(v14Launch({ graduated: true }), 'buy', 1_000_000n, 1n, 50)).toBe(undefined)
  })

  test('the largest trade under 1% impact, from the liquidity in range, lands just under it', () => {
    const pool = { sqrtPriceX96: 885_797_785_004_567_968_533n, usdcIs0: false, liquidity: 2_236_067_977_499_789_696n }
    for (const side of ['buy', 'sell'] as const) {
      const most = maxV4Trade(side, pool, 300, 100n)
      expect(most).toBeGreaterThan(0n)
      const reserve1 = (pool.liquidity * pool.sqrtPriceX96) / (1n << 96n)
      const reserve0 = (pool.liquidity * (1n << 96n)) / pool.sqrtPriceX96
      const net = side === 'buy' ? (most * 9_700n) / 10_000n : most
      const reserve = side === 'buy' ? reserve1 : reserve0
      // net / (reserve + net) under 1%, and over 0.99%.
      expect(net * 10_000n < 100n * (reserve + net)).toBe(true)
      expect(net * 10_000n > 99n * (reserve + net)).toBe(true)
    }
    expect(maxV4Trade('buy', { ...pool, liquidity: undefined }, 300, 100n)).toBe(0n)
  })
})

describe('the v1.4 events decode', () => {
  test('every event the site reads has the contracts’ topic', () => {
    const topic = (step: string, emitter: 'launchpad' | 'hook', index = 0) => logsOf(step, emitter)[index].topics[0]
    expect(toEventSelector(getAbiItem({ abi: launchpadV14Abi, name: 'TokenCreated' }))).toBe(topic('create', 'launchpad', 0))
    expect(toEventSelector(TRADE_EVENTS.curveV14)).toBe(topic('create', 'launchpad', 1))
    expect(toEventSelector(getAbiItem({ abi: launchHookAbi, name: 'PoolOpened' }))).toBe(topic('graduation', 'hook', 0))
    expect(toEventSelector(getAbiItem({ abi: launchHookAbi, name: 'BidLocked' }))).toBe(topic('graduation', 'hook', 1))
    expect(toEventSelector(getAbiItem({ abi: launchpadV14Abi, name: 'Graduated' }))).toBe(topic('graduation', 'launchpad', 1))
    expect(toEventSelector(TRADE_EVENTS.poolV14)).toBe(topic('pool buy 0-0-0', 'hook'))
    expect(toEventSelector(getAbiItem({ abi: launchHookAbi, name: 'BidLocked' }))).toBe(topic('lock 0-1', 'hook'))
    expect(toEventSelector(getAbiItem({ abi: launchHookAbi, name: 'FeesReleased' }))).toBe(topic('sync 0', 'hook'))
    expect(toEventSelector(getAbiItem({ abi: launchpadV14Abi, name: 'PoolFeesAccrued' }))).toBe(topic('sync 0', 'launchpad'))
    // v1.4's Trade and PoolTrade carry one more field than v1.3's, so their topics differ from them.
    expect(toEventSelector(TRADE_EVENTS.curveV14)).not.toBe(toEventSelector(TRADE_EVENTS.curve))
    expect(toEventSelector(TRADE_EVENTS.poolV14)).not.toBe(toEventSelector(TRADE_EVENTS.pool))
  })

  test('a launch, its sniped buy, a sell and its graduation, from the raw logs', () => {
    const [created, firstBuy] = logsOf('create', 'launchpad')
    const creation = decodeEventLog({ abi: launchpadV14Abi, data: created.data, topics: created.topics as [Hex, ...Hex[]] })
    if (creation.eventName !== 'TokenCreated') throw new Error(creation.eventName)
    expect(creation.args.openPool).toBe(true)
    expect([creation.args.creatorFeeBps, creation.args.name, creation.args.symbol, creation.args.metadataURI]).toEqual([125, 'Log Token', 'LOG', 'ipfs://bafkreilog'])

    // The creator's first buy, in the launch transaction, pays no snipe fee.
    const first = decodeTradeLog('curveV14', firstBuy.data, firstBuy.topics)
    expect([first.isBuy, first.snipeFee, first.venue, first.usdcAmount]).toEqual([true, 0n, 'curve', 50_000_000n])

    // The next buy, two blocks on, pays 81%: the curve the event left, quoted by the site, gives the same numbers.
    const [sniped] = logsOf('sniped buy', 'launchpad')
    const trade = decodeTradeLog('curveV14', sniped.data, sniped.topics)
    const state: CurveState = { virtualUsdc: first.virtualUsdc!, virtualTokens: first.virtualTokens!, tokensSold: CURVE.VIRTUAL_TOKENS_0 - first.virtualTokens! }
    const quote = quoteBuy(state, 300_000_000n, 125, snipeBps(0n, 2n, 125))
    expect(snipeBps(0n, 2n, 125)).toBe(8_100)
    expect([trade.tokenAmount, trade.platformFee, trade.creatorFee, trade.snipeFee, trade.usdcAmount]).toEqual([
      quote.tokensOut,
      quote.platformFee,
      quote.creatorFee,
      quote.snipeFee,
      quote.usdcSpent,
    ])
    expect([trade.virtualUsdc, trade.virtualTokens]).toEqual([quote.next.virtualUsdc, quote.next.virtualTokens])

    const [sold] = logsOf('sell', 'launchpad')
    const sell = decodeTradeLog('curveV14', sold.data, sold.topics)
    expect([sell.isBuy, sell.snipeFee]).toEqual([false, 0n])

    const [, graduatedLog] = logsOf('graduation', 'launchpad')
    const graduated = decodeEventLog({ abi: launchpadV14Abi, data: graduatedLog.data, topics: graduatedLog.topics as [Hex, ...Hex[]] })
    if (graduated.eventName !== 'Graduated') throw new Error(graduated.eventName)
    const token = graduated.args.token
    expect(graduated.args.poolId).toBe(poolIdOf(launchPoolKey(token, USDC, suiteVector.hook)))
    expect(graduated.args.snipeLocked).toEqual(trade.snipeFee)
    expect(graduated.args.tokensSeeded).toBe(CURVE.POOL_SUPPLY)
  })

  test('each feed decodes into a trade on its venue; a pool trade names its router', () => {
    const sources = {
      v13: { launchpad: getAddress('0x00000000000000000000000000000000000000d1'), launchRouter: getAddress('0x00000000000000000000000000000000000000d3') },
      v14: { launchpad: suiteVector.launchpad, hook: suiteVector.hook },
    }
    expect(tradeFeeds('v13', false, sources)).toEqual([{ kind: 'curve', address: sources.v13.launchpad }])
    expect(tradeFeeds('v13', true, sources).map((feed) => feed.kind)).toEqual(['curve', 'pool'])
    expect(tradeFeeds('v14', false, sources)).toEqual([{ kind: 'curveV14', address: suiteVector.launchpad }])
    expect(tradeFeeds('v14', true, sources)).toEqual([
      { kind: 'curveV14', address: suiteVector.launchpad },
      { kind: 'poolV14', address: suiteVector.hook },
    ])
    expect((['curve', 'pool', 'curveV14', 'poolV14'] as const).map(feedVenue)).toEqual(['curve', 'pool', 'curve', 'pool'])
    // A log of one feed is not read as another's.
    const [sniped] = logsOf('sniped buy', 'launchpad')
    expect(typeof outcome(() => decodeTradeLog('curve', sniped.data, sniped.topics))).toBe('string')
    expect(typeof outcome(() => decodeTradeLog('poolV14', sniped.data, sniped.topics))).toBe('string')
  })

  test('a pool trade’s market cap is its own price, fees left out, times the curve supply', () => {
    const [log] = logsOf('pool buy 0-1-0', 'hook')
    const trade = decodeTradeLog('poolV14', log.data, log.topics)
    const cap = poolTradeMarketCap(trade)
    const v = all.find((row) => row.k === 'pq' && row.side === 'buy' && row.in === '1000000' && row.s === 0)!
    const before = v4MarketCap({ sqrtPriceX96: big(v.sqrtBefore), usdcIs0: v.usdcIs0 as boolean })
    const after = v4MarketCap({ sqrtPriceX96: big(v.sqrtAfter), usdcIs0: v.usdcIs0 as boolean })
    expect(cap >= before && cap <= after + 1n).toBe(true)
    expect(poolTradeMarketCap({ ...trade, tokenAmount: 0n })).toBe(0n)
  })
})

describe('a v1.4 launch record', () => {
  test('reads the Curve struct as an object or a tuple', () => {
    const token = getAddress('0x00000000000000000000000000000000000000b1')
    const row = {
      token,
      creator: token,
      virtualUsdc: 9n,
      virtualTokens: 8n,
      tokensSold: 7n,
      createdAt: 6n,
      createdBlock: 5n,
      graduated: true,
      openPool: true,
      creatorFeeBps: 250,
      pluginHooks: false,
      plugin: token,
      metadataURI: 'ipfs://x',
    }
    const expected = { ...row, version: 'v14' as const, pair: zeroAddress }
    expect(asLaunchCurveV14(row)).toEqual(expected)
    expect(asLaunchCurveV14(Object.values(row))).toEqual(expected)
    expect(launchVersion(expected)).toBe('v14')
    expect(launchVersion({})).toBe('v13')
  })

  test('is priced by its Uniswap pool once graduated, carrying on from $100,000', () => {
    const grad = all.find((v) => v.k === 'grad')!
    const launch = v14Launch({ graduated: true, tokensSold: CURVE.CURVE_SUPPLY })
    expect(isPriced(launch)).toBe(false)
    expect(isPriced(v14Launch())).toBe(true)
    const priced = { ...launch, v4: { poolId: '0x' as Hex, sqrtPriceX96: big(grad.sqrtPriceX96), usdcIs0: grad.usdcIs0 as boolean, openBlock: 0n } }
    expect(isPriced(priced)).toBe(true)
    expect(launchFacts(priced).cap).toBe('$100,000')
    expect(launchFacts(priced).price).toBe('$0.000125')
    // A v1.3 record that happens to carry a v4 state is still priced by its own launch pool.
    expect(isPriced({ ...priced, version: undefined })).toBe(false)
  })
})

describe('the launch list across both launchpads', () => {
  const row = (createdAt: number, id: string) => ({ createdAt: BigInt(createdAt), id })

  test('newest first, and nothing older than an unread page of another launchpad', () => {
    const v14 = { rows: [row(90, 'a'), row(80, 'b'), row(70, 'c')], hasMore: true }
    const v13 = { rows: [row(85, 'x'), row(60, 'y'), row(10, 'z')], hasMore: false }
    const merged = mergeNewestFirst([v14, v13])
    expect(merged.rows.map((r) => r.id)).toEqual(['a', 'x', 'b', 'c'])
    expect(merged.held).toBe(2)
    expect(mergeNewestFirst([{ ...v14, hasMore: false }, v13]).rows.map((r) => r.id)).toEqual(['a', 'x', 'b', 'c', 'y', 'z'])
  })

  test('one launchpad alone is its own list; ties keep the given order; empty lists are fine', () => {
    const only = { rows: [row(3, 'a'), row(2, 'b')], hasMore: true }
    expect(mergeNewestFirst([only])).toEqual({ rows: only.rows, held: 0 })
    expect(mergeNewestFirst([{ rows: [row(5, 'a')], hasMore: false }, { rows: [row(5, 'b')], hasMore: false }]).rows.map((r) => r.id)).toEqual(['a', 'b'])
    expect(mergeNewestFirst([{ rows: [], hasMore: false }, { rows: [], hasMore: true }])).toEqual({ rows: [], held: 0 })
  })
})

describe('deployment', () => {
  const keys = ['launchpad', 'hook', 'router', 'splitPlugin', 'holderPlugin', 'comboPlugin', 'poolManager', 'stateView'] as const

  test('both networks list a v1.4 suite, all of it zero until v1.4 is deployed there', () => {
    for (const file of [mainnet, testnet]) {
      expect(Object.keys(file.v14).sort()).toEqual([...keys].sort())
      const core = [file.v14.launchpad, file.v14.hook, file.v14.router, file.v14.poolManager, file.v14.stateView]
      // All or nothing: the site needs every one of these to run v1.4.
      expect(core.every((address) => address === zeroAddress) || core.every((address) => address !== zeroAddress)).toBe(true)
    }
    // The PoolManager and StateView are Uniswap's own, at the same addresses on both networks.
    for (const file of [mainnet, testnet]) {
      for (const key of ['poolManager', 'stateView'] as const) {
        if (file.v14[key] !== zeroAddress) expect(getAddress(file.v14[key])).toBe(getAddress(UNISWAP_V4_ARC[key]))
      }
    }
  })

  test('the v1.4 suite in the plugin registry’s shape: the hook and router in v1.3’s seats, no Buyback or Deepen', () => {
    const suite: LaunchSuiteV14 = {
      launchpad: getAddress('0x00000000000000000000000000000000000000f1'),
      hook: getAddress('0x00000000000000000000000000000000000000f2'),
      router: getAddress('0x00000000000000000000000000000000000000f3'),
      splitPlugin: getAddress('0x00000000000000000000000000000000000000f4'),
      holderPlugin: getAddress('0x00000000000000000000000000000000000000f5'),
      comboPlugin: getAddress('0x00000000000000000000000000000000000000f6'),
      poolManager: UNISWAP_V4_ARC.poolManager,
      stateView: UNISWAP_V4_ARC.stateView,
    }
    expect(pluginSuiteOf(suite)).toEqual({
      launchpad: suite.launchpad,
      launchPairFactory: suite.hook,
      launchRouter: suite.router,
      splitPlugin: suite.splitPlugin,
      buybackPlugin: zeroAddress,
      holderPlugin: suite.holderPlugin,
      comboPlugin: suite.comboPlugin,
      deepenPlugin: zeroAddress,
    })
  })
})

describe('v1.4 refusals in a sentence', () => {
  test('the hook’s own, and one the PoolManager wraps', () => {
    expect(explainRevert('FeesExceedAmount')).toBe('The fees would take the whole amount. Enter a larger amount.')
    expect(explainRevert('NothingToLock')).toBe('No anti-sniping fees are waiting to be locked for this token.')
    expect(explainRevert('PoolLockedUntilGraduation')).toBe('Transfers to the pool are locked until the curve graduates.')
    const inner = encodeErrorResult({ abi: launchHookAbi, errorName: 'PartialFill' })
    expect(wrappedErrorName(inner)).toBe('PartialFill')
    expect(wrappedErrorName('0x12345678')).toBe(undefined)
    expect(wrappedErrorName(undefined)).toBe(undefined)
    expect(explainRevert(wrappedErrorName(inner))).toBe('The pool could not fill the whole trade. Try a smaller amount.')
  })
})
