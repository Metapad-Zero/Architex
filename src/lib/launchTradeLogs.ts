import { decodeEventLog, getAbiItem, type Address, type Hex } from 'viem'
import { launchHookAbi, launchRouterAbi, launchpadAbi, launchpadV14Abi } from './abi'
import type { LaunchVersion } from './deployment'
import type { LaunchTrade, TradeVenue } from './launch'

/**
 * Where a launch token's trades are read from (hooks/useLaunchTrades.ts), and how each event becomes a trade. Every
 * token's trades come from one contract per feed and the explorer filters by one topic, so a token's trades are
 * picked out of each feed by their first indexed topic, the token.
 */
export type TradeFeedKind = 'curve' | 'pool' | 'curveV14' | 'poolV14'

export const TRADE_EVENTS = {
  /** v1.3 launchpad: a curve trade, with the curve's virtual reserves after it. */
  curve: getAbiItem({ abi: launchpadAbi, name: 'Trade' }),
  /** v1.3 launch router: a trade in the token's launch pool. */
  pool: getAbiItem({ abi: launchRouterAbi, name: 'PoolTrade' }),
  /** v1.4 launchpad: a curve trade, with its snipe fee and the curve's virtual reserves after it. */
  curveV14: getAbiItem({ abi: launchpadV14Abi, name: 'Trade' }),
  /** v1.4 hook: a trade in the token's Uniswap pool, with its fees; `sender` is the router that called the PoolManager. */
  poolV14: getAbiItem({ abi: launchHookAbi, name: 'PoolTrade' }),
} as const

export interface TradeFeed {
  kind: TradeFeedKind
  /** The contract that emits the feed's events. */
  address: Address
}

/** The contracts a token's trades are emitted by, per launchpad. */
export interface TradeSources {
  v13: { launchpad: Address; launchRouter: Address }
  v14: { launchpad: Address; hook: Address }
}

/**
 * A token's feeds: its curve's, and once it has graduated its pool's. v1.3 pool trades are the launch router's
 * PoolTrade events; v1.4 pool trades are the hook's, which every router's swaps pass through.
 */
export function tradeFeeds(version: LaunchVersion, graduated: boolean, sources: TradeSources): TradeFeed[] {
  if (version === 'v14') {
    const feeds: TradeFeed[] = [{ kind: 'curveV14', address: sources.v14.launchpad }]
    if (graduated) feeds.push({ kind: 'poolV14', address: sources.v14.hook })
    return feeds
  }
  const feeds: TradeFeed[] = [{ kind: 'curve', address: sources.v13.launchpad }]
  if (graduated) feeds.push({ kind: 'pool', address: sources.v13.launchRouter })
  return feeds
}

export function feedVenue(kind: TradeFeedKind): TradeVenue {
  return kind === 'curve' || kind === 'curveV14' ? 'curve' : 'pool'
}

export type DecodedTrade = Omit<LaunchTrade, 'time' | 'txHash' | 'block' | 'logIndex'>

/** One log of a feed as a trade (the token it names is the caller's). Throws when the log is not that feed's event. */
export function decodeTradeLog(kind: TradeFeedKind, data: Hex, topics: readonly Hex[]): DecodedTrade {
  const typed = [...topics] as [Hex, ...Hex[]]
  switch (kind) {
    case 'curve': {
      const { args } = decodeEventLog({ abi: [TRADE_EVENTS.curve], data, topics: typed })
      return {
        trader: args.trader,
        isBuy: args.isBuy,
        usdcAmount: args.usdcAmount,
        tokenAmount: args.tokenAmount,
        platformFee: args.platformFee,
        creatorFee: args.creatorFee,
        virtualUsdc: args.virtualUsdc,
        virtualTokens: args.virtualTokens,
        venue: 'curve',
      }
    }
    case 'pool': {
      const { args } = decodeEventLog({ abi: [TRADE_EVENTS.pool], data, topics: typed })
      return {
        trader: args.trader,
        isBuy: args.isBuy,
        usdcAmount: args.usdcAmount,
        tokenAmount: args.tokenAmount,
        platformFee: args.platformFee,
        creatorFee: args.creatorFee,
        venue: 'pool',
      }
    }
    case 'curveV14': {
      const { args } = decodeEventLog({ abi: [TRADE_EVENTS.curveV14], data, topics: typed })
      return {
        trader: args.trader,
        isBuy: args.isBuy,
        usdcAmount: args.usdcAmount,
        tokenAmount: args.tokenAmount,
        platformFee: args.platformFee,
        creatorFee: args.creatorFee,
        snipeFee: args.snipeFee,
        virtualUsdc: args.virtualUsdc,
        virtualTokens: args.virtualTokens,
        venue: 'curve',
      }
    }
    case 'poolV14': {
      const { args } = decodeEventLog({ abi: [TRADE_EVENTS.poolV14], data, topics: typed })
      return {
        trader: args.sender,
        viaRouter: true,
        isBuy: args.isBuy,
        usdcAmount: args.usdcAmount,
        tokenAmount: args.tokenAmount,
        platformFee: args.platformFee,
        creatorFee: args.creatorFee,
        snipeFee: args.snipeFee,
        venue: 'pool',
      }
    }
  }
}
