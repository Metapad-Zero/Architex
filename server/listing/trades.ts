import { decodeEventLog, getAddress, toEventSelector, zeroAddress, type Address, type Hex } from 'viem'
import { launchRouterAbi, launchpadAbi, pairAbi } from '../../src/lib/abi.js'
import { tickerOf, type Market, type Snapshot } from './chain.js'
import type { RawLog } from './logs.js'

/**
 * Trades, read from event logs.
 *
 * Amounts are what the trader paid and received, with the fees inside the amount paid, the same convention as a
 * Uniswap V2 Swap event:
 *   core   the pair's Swap (0.30% of the input stays in the pool, so it is inside the amount paid in)
 *   pool   the launch router's PoolTrade: a buyer paid `usdcAmount`; a seller received usdcAmount - both fees
 *   curve  the launchpad's Trade, with the same meaning
 * `type` is from the base token's side: a buy takes base out of the market. `before` and `after` are the market's
 * price (target per base, fee excluded) either side of the trade, read from the pool's Sync (core, pool) or the
 * curve's virtual reserves (curve); they bound the 24-hour high and low.
 */
export type TradeType = 'buy' | 'sell'

export interface Trade {
  /** The market's key: its ticker_id, lowercased. */
  key: string
  /** block * 1,000,000 + log index: unique, increasing, and an integer as the spec asks. */
  id: number
  block: bigint
  logIndex: number
  txHash: Hex
  /** Unix seconds. */
  time: number
  type: TradeType
  /** Raw units of the base and target tokens. */
  base: bigint
  target: bigint
  before?: number
  after?: number
}

const SWAP = toEventSelector('Swap(address,uint256,uint256,uint256,uint256,address)')
const SYNC = toEventSelector('Sync(uint112,uint112)')
const CURVE_TRADE = toEventSelector('Trade(address,address,bool,uint256,uint256,uint256,uint256,uint256,uint256)')
const POOL_TRADE = toEventSelector('PoolTrade(address,address,bool,uint256,uint256,uint256,uint256)')

/** topic0 of every event the trade reader needs. */
export const TRADE_TOPICS: readonly Hex[] = [SWAP, SYNC, CURVE_TRADE, POOL_TRADE]

const lower = (address: string) => address.toLowerCase()

/** Addresses whose logs hold every trade of the snapshot's markets. */
export function tradeSources(snapshot: Snapshot): Address[] {
  const sources = new Map<string, Address>()
  for (const market of snapshot.markets) {
    if (market.kind === 'core') sources.set(lower(market.poolId), market.poolId)
    if (market.kind === 'pool' && market.launchPair) sources.set(lower(market.launchPair), market.launchPair)
  }
  const { launchpad, launchRouter } = snapshot.network
  if (launchpad !== zeroAddress && launchRouter !== zeroAddress && snapshot.launches.length > 0) {
    sources.set(lower(launchpad), launchpad)
    sources.set(lower(launchRouter), launchRouter)
  }
  return [...sources.values()]
}

/** target per base, in whole tokens. */
export function priceOf(baseRaw: bigint, targetRaw: bigint, baseDecimals: number, targetDecimals: number): number | undefined {
  if (baseRaw <= 0n || targetRaw <= 0n) return undefined
  return (Number(targetRaw) / Number(baseRaw)) * 10 ** (baseDecimals - targetDecimals)
}

interface SwapAmounts {
  amount0In: bigint
  amount1In: bigint
  amount0Out: bigint
  amount1Out: bigint
}

/** A core Swap as a trade between base and target: base out and target in is a buy, the reverse a sell. */
export function coreTrade(swap: SwapAmounts, baseIsToken0: boolean): { type: TradeType; base: bigint; target: bigint } | undefined {
  const [baseIn, baseOut, targetIn, targetOut] = baseIsToken0
    ? [swap.amount0In, swap.amount0Out, swap.amount1In, swap.amount1Out]
    : [swap.amount1In, swap.amount1Out, swap.amount0In, swap.amount0Out]
  const baseNet = baseOut - baseIn
  const targetNet = targetIn - targetOut
  if (baseNet > 0n && targetNet > 0n) return { type: 'buy', base: baseNet, target: targetNet }
  if (baseNet < 0n && targetNet < 0n) return { type: 'sell', base: -baseNet, target: -targetNet }
  return undefined
}

interface LaunchTradeFields {
  isBuy: boolean
  usdcAmount: bigint
  tokenAmount: bigint
  platformFee: bigint
  creatorFee: bigint
}

/** A launch trade (curve or pool) from the trader's side. */
export function launchTrade(event: LaunchTradeFields): { type: TradeType; base: bigint; target: bigint } {
  const fees = event.platformFee + event.creatorFee
  return event.isBuy
    ? { type: 'buy', base: event.tokenAmount, target: event.usdcAmount }
    : { type: 'sell', base: event.tokenAmount, target: event.usdcAmount > fees ? event.usdcAmount - fees : 0n }
}

/**
 * The token and USDC on the market's own side of a launch trade: what the pool or curve received and paid. A buy
 * puts the USDC after fees in and takes the tokens out; a sell puts the tokens in and pays out the gross USDC, from
 * which the router or launchpad then takes the fees.
 */
export function launchReservesBefore(after: { token: bigint; usdc: bigint }, event: LaunchTradeFields): { token: bigint; usdc: bigint } {
  const fees = event.platformFee + event.creatorFee
  return event.isBuy
    ? { token: after.token + event.tokenAmount, usdc: after.usdc - (event.usdcAmount - fees) }
    : { token: after.token - event.tokenAmount, usdc: after.usdc + event.usdcAmount }
}

function position(log: RawLog): { block: bigint; logIndex: number } | undefined {
  if (log.blockNumber === null || log.logIndex === null) return undefined
  return { block: BigInt(log.blockNumber), logIndex: Number(BigInt(log.logIndex)) }
}

export const tradeId = (block: bigint, logIndex: number) => Number(block) * 1_000_000 + logIndex

/**
 * Turns logs (oldest first, from `tradeSources`) into trades for the snapshot's markets. `timeOf` gives a block's
 * time when a log does not carry `blockTimestamp`; a trade whose time is unknown is left out.
 */
export function readTrades(logs: readonly RawLog[], snapshot: Snapshot, timeOf: (block: bigint) => number | undefined = () => undefined): Trade[] {
  const corePairs = new Map<string, Market>()
  for (const market of snapshot.markets) if (market.kind === 'core') corePairs.set(lower(market.poolId), market)
  const usdc = snapshot.tokens.get(lower(snapshot.network.usdc))
  const usdcDecimals = usdc?.decimals ?? 6
  const launchByToken = new Map(snapshot.launches.map((launch) => [lower(launch.token), launch]))
  const launchpad = lower(snapshot.network.launchpad)
  const router = lower(snapshot.network.launchRouter)
  const tokenDecimals = (token: string) => snapshot.tokens.get(token)?.decimals ?? 18

  // Every Sync by pool and transaction, in log order, so a trade finds the reserves it left behind.
  const syncs = new Map<string, { logIndex: number; reserve0: bigint; reserve1: bigint; used: boolean }[]>()
  for (const log of logs) {
    if (log.topics[0] !== SYNC || !log.transactionHash) continue
    const at = position(log)
    if (!at) continue
    try {
      const { args } = decodeEventLog({ abi: pairAbi, eventName: 'Sync', topics: log.topics as [Hex, ...Hex[]], data: log.data })
      const key = `${lower(log.address)}:${log.transactionHash}`
      const list = syncs.get(key) ?? []
      list.push({ logIndex: at.logIndex, reserve0: args.reserve0, reserve1: args.reserve1, used: false })
      syncs.set(key, list)
    } catch {
      // Not a Sync this reader understands; the trade that needed it goes without a price range.
    }
  }
  const syncAfter = (pool: string, txHash: Hex, logIndex: number, immediatelyBefore: boolean) => {
    const list = syncs.get(`${pool}:${txHash}`) ?? []
    const found = immediatelyBefore
      ? list.find((sync) => sync.logIndex === logIndex - 1 && !sync.used)
      : list.find((sync) => sync.logIndex > logIndex && !sync.used)
    if (found) found.used = true
    return found
  }

  const trades: Trade[] = []
  for (const log of logs) {
    const at = position(log)
    if (!at || !log.transactionHash) continue
    const time = log.blockTimestamp ? Number(BigInt(log.blockTimestamp)) : timeOf(at.block)
    if (time === undefined) continue
    const address = lower(log.address)
    const topic = log.topics[0]
    const base = { block: at.block, logIndex: at.logIndex, txHash: log.transactionHash, time, id: tradeId(at.block, at.logIndex) }
    const market = topic === SWAP ? corePairs.get(address) : undefined
    try {
      if (market) {
        const { args } = decodeEventLog({ abi: pairAbi, eventName: 'Swap', topics: log.topics as [Hex, ...Hex[]], data: log.data })
        const trade = coreTrade(args, market.baseIsToken0 ?? true)
        if (!trade) continue
        // ArchitexPair emits Sync immediately before Swap.
        const sync = syncAfter(address, log.transactionHash, at.logIndex, true)
        let before: number | undefined
        let after: number | undefined
        if (sync) {
          const before0 = sync.reserve0 - args.amount0In + args.amount0Out
          const before1 = sync.reserve1 - args.amount1In + args.amount1Out
          const [afterBase, afterTarget, beforeBase, beforeTarget] = market.baseIsToken0
            ? [sync.reserve0, sync.reserve1, before0, before1]
            : [sync.reserve1, sync.reserve0, before1, before0]
          after = priceOf(afterBase, afterTarget, market.base.decimals, market.target.decimals)
          before = priceOf(beforeBase, beforeTarget, market.base.decimals, market.target.decimals)
        }
        trades.push({ ...base, key: market.key, ...trade, before, after })
      } else if (topic === POOL_TRADE && address === router) {
        const { args } = decodeEventLog({ abi: launchRouterAbi, eventName: 'PoolTrade', topics: log.topics as [Hex, ...Hex[]], data: log.data })
        const launch = launchByToken.get(lower(args.token))
        if (!launch || !usdc) continue
        const decimals = tokenDecimals(lower(args.token))
        const sync = syncAfter(lower(launch.pair), log.transactionHash, at.logIndex, false)
        let before: number | undefined
        let after: number | undefined
        if (sync) {
          // LaunchPair's Sync is (reserveToken, reserveUsdc), whatever the address order.
          const reservesAfter = { token: sync.reserve0, usdc: sync.reserve1 }
          const reservesBefore = launchReservesBefore(reservesAfter, args)
          after = priceOf(reservesAfter.token, reservesAfter.usdc, decimals, usdcDecimals)
          before = priceOf(reservesBefore.token, reservesBefore.usdc, decimals, usdcDecimals)
        }
        trades.push({ ...base, key: tickerOf(launch.token, usdc.address).toLowerCase(), ...launchTrade(args), before, after })
      } else if (topic === CURVE_TRADE && address === launchpad) {
        const { args } = decodeEventLog({ abi: launchpadAbi, eventName: 'Trade', topics: log.topics as [Hex, ...Hex[]], data: log.data })
        if (!usdc) continue
        const token = getAddress(args.token)
        const decimals = tokenDecimals(lower(token))
        const reservesAfter = { token: args.virtualTokens, usdc: args.virtualUsdc }
        const reservesBefore = launchReservesBefore(reservesAfter, args)
        trades.push({
          ...base,
          key: tickerOf(token, usdc.address).toLowerCase(),
          ...launchTrade(args),
          after: priceOf(reservesAfter.token, reservesAfter.usdc, decimals, usdcDecimals),
          before: priceOf(reservesBefore.token, reservesBefore.usdc, decimals, usdcDecimals),
        })
      }
      // A launch pool's own Swap is skipped: the router's PoolTrade in the same transaction records that trade.
    } catch {
      // A log that does not decode as the event its topic names is not a trade.
    }
  }
  return trades
}
