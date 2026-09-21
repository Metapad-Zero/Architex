import { useQuery } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { decodeEventLog, pad, parseAbiItem, toEventSelector, type Address, type Hex, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { activeChain } from '../chain'
import { deployment, isLaunchpadDeployed } from '../lib/deployment'
import { fetchLogHistory } from '../lib/explorerLogs'
import type { LaunchTrade, TradeVenue } from '../lib/launch'
import { launchFixtureApi } from '../lib/launchFixtureApi'
import { blockTimes, readLogWindows } from '../lib/rpcLogs'

export type { LaunchTrade }

const fixtureOn = import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1'

function noopSubscribe(): () => void {
  return () => undefined
}
function zero(): number {
  return 0
}

/** A curve trade: the launchpad's event carries the curve's reserves after the trade, which price the token then. */
const CURVE_TRADE = parseAbiItem(
  'event Trade(address indexed token, address indexed trader, bool isBuy, uint256 usdcAmount, uint256 tokenAmount, uint256 platformFee, uint256 creatorFee, uint256 virtualUsdc, uint256 virtualTokens)',
)
/** A launch-pool trade, emitted by the launch router. */
const POOL_TRADE = parseAbiItem(
  'event PoolTrade(address indexed token, address indexed trader, bool isBuy, uint256 usdcAmount, uint256 tokenAmount, uint256 platformFee, uint256 creatorFee)',
)
const MAX_TRADES = 50
// Every token's trades come from one launchpad (and one router) address and the explorer filters by one topic,
// so a token's trades are picked out of the whole feed: 6 pages is the newest 300 trades.
const EXPLORER_PAGES = 6
const RPC_WINDOWS = 3

interface TradeHistory {
  trades: LaunchTrade[]
  /** False when older trades may exist that could not be read; "No trades yet" is only true when complete. */
  complete: boolean
  source: 'explorer' | 'rpc'
}

function byNewest(a: LaunchTrade, b: LaunchTrade): number {
  return b.block - a.block || (b.logIndex ?? 0) - (a.logIndex ?? 0)
}

interface Feed {
  venue: TradeVenue
  address: Address
}

function decodeTrade(venue: TradeVenue, data: Hex, topics: Hex[]): Omit<LaunchTrade, 'time' | 'txHash' | 'block' | 'logIndex'> {
  const typedTopics = topics as [Hex, ...Hex[]]
  if (venue === 'curve') {
    const { args } = decodeEventLog({ abi: [CURVE_TRADE], data, topics: typedTopics })
    return { ...args, venue }
  }
  const { args } = decodeEventLog({ abi: [POOL_TRADE], data, topics: typedTopics })
  return { ...args, venue }
}

async function fromExplorer(feed: Feed, token: Address, createdAt: number | undefined, signal: AbortSignal | undefined) {
  const tokenTopic = pad(token, { size: 32 }).toLowerCase()
  const history = await fetchLogHistory({
    explorerBase: activeChain.explorerBase,
    address: feed.address,
    topic0: toEventSelector(feed.venue === 'curve' ? CURVE_TRADE : POOL_TRADE),
    maxPages: EXPLORER_PAGES,
    keep: (log) => log.topics[1]?.toLowerCase() === tokenTopic,
    limit: MAX_TRADES,
    notBefore: createdAt,
    cacheKey: token,
    signal,
  })
  const trades: LaunchTrade[] = []
  for (const log of history.logs) {
    try {
      trades.push({ ...decodeTrade(feed.venue, log.data, log.topics), time: log.time, txHash: log.txHash, block: log.block, logIndex: log.logIndex })
    } catch {
      // skip undecodable explorer rows
    }
  }
  return { trades, complete: history.complete }
}

async function fromRpc(client: PublicClient, feed: Feed, token: Address, createdAt: number | undefined) {
  const { logs, complete } = await readLogWindows({
    head: await client.getBlockNumber(),
    windows: RPC_WINDOWS,
    read: (fromBlock, toBlock) =>
      client.getLogs({ address: feed.address, event: feed.venue === 'curve' ? CURVE_TRADE : POOL_TRADE, args: { token }, fromBlock, toBlock }),
    reachedStart:
      createdAt === undefined ? undefined : async (fromBlock) => Number((await client.getBlock({ blockNumber: fromBlock })).timestamp) <= createdAt,
  })
  const trades: LaunchTrade[] = []
  for (const log of logs) {
    if (log.blockNumber === null) continue
    try {
      trades.push({ ...decodeTrade(feed.venue, log.data, log.topics as Hex[]), time: 0, txHash: log.transactionHash, block: Number(log.blockNumber), logIndex: log.logIndex ?? 0 })
    } catch {
      // skip a log that does not decode
    }
  }
  return { trades, complete }
}

/**
 * A launch token's trades, newest first: on its curve (the launchpad's Trade events) and, once it has graduated,
 * in its launch pool (the launch router's PoolTrade events). `createdAt` (unix seconds, from the curve) bounds the
 * search: no trade can be older than its token.
 */
export function useLaunchTrades(token: Address | undefined, createdAt: number | undefined, graduated = false) {
  const publicClient = usePublicClient()
  const api = launchFixtureApi()
  const fixtureVersion = useSyncExternalStore(api ? api.subscribe : noopSubscribe, api ? api.version : zero, zero)

  const query = useQuery<TradeHistory, Error>({
    queryKey: ['launchTrades', activeChain.id, token, createdAt, graduated],
    enabled: !fixtureOn && isLaunchpadDeployed && Boolean(token) && createdAt !== undefined,
    staleTime: 8_000,
    // The RPC fallback costs several calls a poll, so it polls less often than the explorer.
    refetchInterval: (current) => (current.state.data?.source === 'rpc' ? 30_000 : 12_000),
    placeholderData: (previous) => previous,
    queryFn: async ({ signal }): Promise<TradeHistory> => {
      if (!token) return { trades: [], complete: true, source: 'explorer' }
      const feeds: Feed[] = [{ venue: 'curve', address: deployment.launchpad }]
      if (graduated) feeds.push({ venue: 'pool', address: deployment.launchRouter })
      const combine = (parts: { trades: LaunchTrade[]; complete: boolean }[]) => {
        const trades = parts.flatMap((part) => part.trades).sort(byNewest)
        return { trades: trades.slice(0, MAX_TRADES), complete: parts.every((part) => part.complete) || trades.length >= MAX_TRADES }
      }
      try {
        const parts = await Promise.all(feeds.map((feed) => fromExplorer(feed, token, createdAt, signal)))
        return { ...combine(parts), source: 'explorer' }
      } catch {
        if (!publicClient) return { trades: [], complete: false, source: 'rpc' }
        const parts = await Promise.all(feeds.map((feed) => fromRpc(publicClient, feed, token, createdAt)))
        const { trades, complete } = combine(parts)
        const times = await blockTimes(publicClient, trades.map((trade) => BigInt(trade.block)), MAX_TRADES)
        return {
          trades: trades.map((trade) => ({ ...trade, time: times.get(BigInt(trade.block)) ?? 0 })),
          complete,
          source: 'rpc',
        }
      }
    },
  })

  if (fixtureOn) {
    return { trades: token && api ? api.trades(token) : [], historyComplete: true, reachesCreation: false, isLoading: false, error: null, version: fixtureVersion }
  }

  const trades = query.data?.trades ?? []
  const historyComplete = query.data?.complete ?? false
  // With no data yet, every refetch puts the query back to pending and clears its error; errorUpdatedAt survives,
  // so a failed first read keeps showing as failed instead of flipping back to "Reading the trades…" each poll.
  const failedFirstRead = !query.data && query.errorUpdatedAt > 0
  return {
    trades,
    historyComplete,
    /** True when `trades` is every trade since the token was created, not just the newest page of them. */
    reachesCreation: Boolean(query.data) && historyComplete && trades.length < MAX_TRADES,
    /** True until the first read has finished, retries included. */
    isLoading: query.isPending && !failedFirstRead,
    /** Set only when no read has succeeded; a failed poll keeps the last good trades. */
    error: query.data ? null : (query.error ?? (failedFirstRead ? new Error('The trades could not be read') : null)),
    version: 0,
  }
}
