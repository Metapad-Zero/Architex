import { asks, bestAsk, bestBid, bids, type DepthMarket, type Level } from './depth.js'
import { formatUnits, plain, usd, whole } from './decimal.js'
import type { Market, Snapshot } from './chain.js'
import type { Trade, TradeType } from './trades.js'

/**
 * Response bodies in CoinGecko's exchange API standard for DEXes (spot section, v8): /pairs, /tickers, /orderbook,
 * /historical_trades. Every market is identified by contract addresses: ticker_id is BASE_TARGET, pool_id the pool.
 * Numbers are decimal strings; token amounts are exact, prices carry 12 significant digits.
 */
export interface PairRow {
  ticker_id: string
  base: string
  target: string
  pool_id: string
}

export interface TickerRow {
  ticker_id: string
  base_currency: string
  target_currency: string
  pool_id: string
  last_price: string
  base_volume: string
  target_volume: string
  liquidity_in_usd: string
  bid?: string
  ask?: string
  high: string
  low: string
}

export interface OrderbookBody {
  ticker_id: string
  /** Unix milliseconds of the block the reserves were read at, as a string. */
  timestamp: string
  bids: [string, string][]
  asks: [string, string][]
}

export interface TradeRow {
  trade_id: number
  price: string
  base_volume: string
  target_volume: string
  /** Unix seconds, as a string. */
  trade_timestamp: string
  type: TradeType
}

export interface HistoricalTradesBody {
  buy: TradeRow[]
  sell: TradeRow[]
}

const lower = (address: string) => address.toLowerCase()

/** The market's price now: target per base, whole tokens, no fee. Undefined for an empty pool. */
export function midPrice(market: Market): number | undefined {
  if (market.baseReserve <= 0n || market.targetReserve <= 0n) return undefined
  return whole(market.targetReserve, market.target.decimals) / whole(market.baseReserve, market.base.decimals)
}

export function depthMarket(market: Market): DepthMarket {
  return {
    base: whole(market.baseReserve, market.base.decimals),
    target: whole(market.targetReserve, market.target.decimals),
    fee: market.feeBps / 10_000,
    feeOn: market.feeOn,
    maxBuy: market.curve ? whole(market.curve.tokensLeft, market.base.decimals) : undefined,
    maxSell: market.curve ? whole(market.curve.tokensSold, market.base.decimals) : undefined,
  }
}

/**
 * USD per whole token. USDC is 1. A launch token is priced by its own market (always against USDC). Anything else
 * is priced through core pairs, a hop at a time, each token from the pair where its priced side is deepest in USD;
 * so EURC is priced by the USDC/EURC pool.
 */
export function usdPrices(snapshot: Snapshot): Map<string, number> {
  const prices = new Map<string, number>([[lower(snapshot.network.usdc), 1]])
  for (const market of snapshot.markets) {
    if (market.kind === 'core') continue
    const mid = midPrice(market)
    if (mid !== undefined) prices.set(lower(market.base.address), mid)
  }
  for (let hop = 0; hop < 4; hop += 1) {
    const best = new Map<string, { price: number; depth: number }>()
    for (const market of snapshot.markets) {
      if (market.kind !== 'core') continue
      const mid = midPrice(market)
      if (mid === undefined) continue
      const base = lower(market.base.address)
      const target = lower(market.target.address)
      const basePrice = prices.get(base)
      const targetPrice = prices.get(target)
      const offer = (token: string, price: number, depth: number) => {
        const current = best.get(token)
        if (!current || depth > current.depth) best.set(token, { price, depth })
      }
      if (basePrice === undefined && targetPrice !== undefined) offer(base, mid * targetPrice, whole(market.targetReserve, market.target.decimals) * targetPrice)
      if (targetPrice === undefined && basePrice !== undefined) offer(target, basePrice / mid, whole(market.baseReserve, market.base.decimals) * basePrice)
    }
    if (best.size === 0) break
    for (const [token, { price }] of best) prices.set(token, price)
  }
  return prices
}

/**
 * The value of what a market holds, in USD. A pool: both reserves at their USD prices (one side doubled when only it
 * has a price, 0 when neither does). A curve: the USDC it has raised plus the tokens it has left to sell at the
 * curve's price now; its virtual reserves, which only set the price, are not counted.
 */
export function liquidityUsd(market: Market, prices: ReadonlyMap<string, number>): number {
  const basePrice = prices.get(lower(market.base.address))
  const targetPrice = prices.get(lower(market.target.address))
  if (market.curve) {
    const mid = midPrice(market) ?? 0
    return whole(market.curve.usdcHeld, market.target.decimals) * (targetPrice ?? 1) + whole(market.curve.tokensLeft, market.base.decimals) * mid * (targetPrice ?? 1)
  }
  const baseValue = basePrice === undefined ? undefined : whole(market.baseReserve, market.base.decimals) * basePrice
  const targetValue = targetPrice === undefined ? undefined : whole(market.targetReserve, market.target.decimals) * targetPrice
  if (baseValue !== undefined && targetValue !== undefined) return baseValue + targetValue
  if (baseValue !== undefined) return 2 * baseValue
  if (targetValue !== undefined) return 2 * targetValue
  return 0
}

export function pairsBody(snapshot: Snapshot): PairRow[] {
  return snapshot.markets.map((market) => ({ ticker_id: market.tickerId, base: market.base.address, target: market.target.address, pool_id: market.poolId }))
}

/** A trade's price: what was paid or received in target per base, fees included. */
export function tradePrice(trade: Trade, market: Market): number | undefined {
  if (trade.base <= 0n || trade.target <= 0n) return undefined
  return whole(trade.target, market.target.decimals) / whole(trade.base, market.base.decimals)
}

/**
 * One ticker per market with a price. Volumes are the last 24 hours of trades (see trades.ts for what an amount
 * is). last_price is the pool's price now, which is where the latest trade left it; high and low are the highest
 * and lowest price the pool stood at over the 24 hours (either side of every trade, and now), so last_price always
 * lies between them. bid and ask are the best prices a trader gets now, fees included, and are left out when the
 * market cannot trade that way (a curve with nothing sold has nothing to buy back).
 */
export function tickersBody(snapshot: Snapshot, trades: readonly Trade[], since: number): TickerRow[] {
  const prices = usdPrices(snapshot)
  const byMarket = new Map<string, Trade[]>()
  for (const trade of trades) {
    if (trade.time < since || trade.time > snapshot.time) continue
    const list = byMarket.get(trade.key) ?? []
    list.push(trade)
    byMarket.set(trade.key, list)
  }
  const rows: TickerRow[] = []
  for (const market of snapshot.markets) {
    const mid = midPrice(market)
    if (mid === undefined) continue
    const recent = byMarket.get(market.key) ?? []
    let baseVolume = 0n
    let targetVolume = 0n
    let high = mid
    let low = mid
    for (const trade of recent) {
      baseVolume += trade.base
      targetVolume += trade.target
      for (const price of [trade.before, trade.after]) {
        if (price === undefined || !Number.isFinite(price) || price <= 0) continue
        if (price > high) high = price
        if (price < low) low = price
      }
    }
    const depth = depthMarket(market)
    const canSell = !market.curve || market.curve.tokensSold > 0n
    const canBuy = !market.curve || market.curve.tokensLeft > 0n
    rows.push({
      ticker_id: market.tickerId,
      base_currency: market.base.address,
      target_currency: market.target.address,
      pool_id: market.poolId,
      last_price: plain(mid),
      base_volume: formatUnits(baseVolume, market.base.decimals),
      target_volume: formatUnits(targetVolume, market.target.decimals),
      liquidity_in_usd: usd(liquidityUsd(market, prices)),
      ...(canSell ? { bid: plain(bestBid(depth)) } : {}),
      ...(canBuy ? { ask: plain(bestAsk(depth)) } : {}),
      high: plain(high),
      low: plain(low),
    })
  }
  return rows
}

const printLevel = (level: Level): [string, string] => [plain(level.price), plain(level.quantity)]

/** Levels a side for a requested depth: depth 100 is 50 a side; 0, "full depth", is the most we serve. */
export const MAX_LEVELS_PER_SIDE = 250

export function levelsPerSide(depth: number): number {
  if (depth === 0) return MAX_LEVELS_PER_SIDE
  return Math.min(MAX_LEVELS_PER_SIDE, Math.max(1, Math.ceil(depth / 2)))
}

export function orderbookBody(market: Market, snapshot: Snapshot, depth: number): OrderbookBody {
  const levels = levelsPerSide(depth)
  const book = depthMarket(market)
  return {
    ticker_id: market.tickerId,
    timestamp: String(snapshot.time * 1000),
    bids: bids(book, levels).map(printLevel),
    asks: asks(book, levels).map(printLevel),
  }
}

/** The newest `limit` trades (0 for no limit) of the requested type, or of both, split into buys and sells, newest first. */
export function historicalTradesBody(market: Market, trades: readonly Trade[], options: { type?: TradeType; from: number; to: number; limit: number }): HistoricalTradesBody {
  const body: HistoricalTradesBody = { buy: [], sell: [] }
  const matching = trades
    .filter((trade) => trade.key === market.key && trade.time >= options.from && trade.time <= options.to && (!options.type || trade.type === options.type))
    .filter((trade) => tradePrice(trade, market) !== undefined)
    .sort((a, b) => b.id - a.id)
  for (const trade of options.limit > 0 ? matching.slice(0, options.limit) : matching) {
    const price = tradePrice(trade, market) as number
    body[trade.type].push({
      trade_id: trade.id,
      price: plain(price),
      base_volume: formatUnits(trade.base, market.base.decimals),
      target_volume: formatUnits(trade.target, market.target.decimals),
      trade_timestamp: String(trade.time),
      type: trade.type,
    })
  }
  return body
}
