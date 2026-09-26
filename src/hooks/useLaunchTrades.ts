import { useQuery } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { pad, toEventSelector, type Address, type Hex, type Log, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { activeChain } from '../chain'
import { deployment, isLaunchpadDeployed, isLaunchpadV14Deployed, launchSuiteV14, type LaunchVersion } from '../lib/deployment'
import { fetchLogHistory } from '../lib/explorerLogs'
import type { LaunchTrade } from '../lib/launch'
import { launchFixtureApi } from '../lib/launchFixtureApi'
import { decodeTradeLog, tradeFeeds, TRADE_EVENTS, type TradeFeed } from '../lib/launchTradeLogs'
import { fetchIndexedHead, fillTimes, fromRpcLog, withRpcTail } from '../lib/logTail'
import { blockTime, blockTimes, readLogWindows } from '../lib/rpcLogs'

export type { LaunchTrade }

const fixtureOn = import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1'

function noopSubscribe(): () => void {
  return () => undefined
}
function zero(): number {
  return 0
}

const MAX_TRADES = 50
// Every token's trades come from one launchpad (and one router or hook) address and the explorer filters by one
// topic, so a token's trades are picked out of the whole feed: 6 pages is the newest 300 trades.
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

/** What is read of an RPC log: where it is, and its raw topics and data. */
type RawLog = Pick<Log, 'blockNumber' | 'logIndex' | 'transactionHash' | 'data'> & { topics: readonly Hex[] }

/** One feed's logs for `token` over a block range, from the RPC (the token is each event's first indexed topic). */
async function readFeedLogs(client: PublicClient, feed: TradeFeed, token: Address, fromBlock: bigint, toBlock: bigint): Promise<RawLog[]> {
  const filter = { address: feed.address, args: { token }, fromBlock, toBlock }
  switch (feed.kind) {
    case 'curve':
      return client.getLogs({ ...filter, event: TRADE_EVENTS.curve })
    case 'pool':
      return client.getLogs({ ...filter, event: TRADE_EVENTS.pool })
    case 'curveV14':
      return client.getLogs({ ...filter, event: TRADE_EVENTS.curveV14 })
    case 'poolV14':
      return client.getLogs({ ...filter, event: TRADE_EVENTS.poolV14 })
  }
}

/**
 * Whether a block is older than the token, so no trade of it can be there or below. Strictly older: blocks come
 * faster than one a second, so the creation block can share its second with the blocks after it.
 */
function beforeCreation(client: PublicClient, createdAt: number | undefined) {
  return createdAt === undefined ? undefined : async (fromBlock: bigint) => (await blockTime(client, fromBlock)) < createdAt
}

/** The explorer's history of one feed, with the blocks it has not indexed yet read from the RPC (lib/logTail.ts). */
async function fromExplorer(client: PublicClient, feed: TradeFeed, token: Address, createdAt: number | undefined, signal: AbortSignal | undefined) {
  const tokenTopic = pad(token, { size: 32 }).toLowerCase()
  const topic0 = toEventSelector(TRADE_EVENTS[feed.kind])
  const [history, indexedHead, head] = await Promise.all([
    fetchLogHistory({
      explorerBase: activeChain.explorerBase,
      address: feed.address,
      topic0,
      maxPages: EXPLORER_PAGES,
      keep: (log) => log.topics[1]?.toLowerCase() === tokenTopic,
      limit: MAX_TRADES,
      notBefore: createdAt,
      cacheKey: token,
      signal,
    }),
    fetchIndexedHead(activeChain.explorerBase),
    client.getBlockNumber(),
  ])
  const merged = await withRpcTail({
    key: `${feed.address}|${topic0}|${token}`.toLowerCase(),
    history,
    indexedHead,
    head,
    read: async (fromBlock, toBlock) => (await readFeedLogs(client, feed, token, fromBlock, toBlock)).flatMap((log) => fromRpcLog(log) ?? []),
    reachedStart: beforeCreation(client, createdAt),
    limit: MAX_TRADES,
  })
  const logs = merged.tail ? await fillTimes(client, merged.logs.slice(0, MAX_TRADES), MAX_TRADES) : merged.logs
  const trades: LaunchTrade[] = []
  for (const log of logs) {
    try {
      trades.push({ ...decodeTradeLog(feed.kind, log.data, log.topics), time: log.time, txHash: log.txHash, block: log.block, logIndex: log.logIndex })
    } catch {
      // skip undecodable explorer rows
    }
  }
  return { trades, complete: merged.complete }
}

async function fromRpc(client: PublicClient, feed: TradeFeed, token: Address, createdAt: number | undefined) {
  const { logs, complete } = await readLogWindows({
    head: await client.getBlockNumber(),
    windows: RPC_WINDOWS,
    read: (fromBlock, toBlock) => readFeedLogs(client, feed, token, fromBlock, toBlock),
    reachedStart: beforeCreation(client, createdAt),
  })
  const trades: LaunchTrade[] = []
  for (const log of logs) {
    if (log.blockNumber === null || log.transactionHash === null) continue
    try {
      trades.push({ ...decodeTradeLog(feed.kind, log.data, log.topics), time: 0, txHash: log.transactionHash, block: Number(log.blockNumber), logIndex: log.logIndex ?? 0 })
    } catch {
      // skip a log that does not decode
    }
  }
  return { trades, complete }
}

/**
 * A launch token's trades, newest first: on its curve (its launchpad's Trade events) and, once it has graduated, in its
 * pool (v1.3: the launch router's PoolTrade events; v1.4: the hook's, whichever router made the swap). `createdAt`
 * (unix seconds, from the curve) bounds the search: no trade can be older than its token. `traded` is the curve's own
 * word that trades exist (tokens sold, or graduated): an empty history is then never complete, whatever the sources
 * said.
 */
export function useLaunchTrades(token: Address | undefined, createdAt: number | undefined, graduated = false, traded = false, version: LaunchVersion = 'v13') {
  const publicClient = usePublicClient()
  const api = launchFixtureApi()
  const fixtureVersion = useSyncExternalStore(api ? api.subscribe : noopSubscribe, api ? api.version : zero, zero)

  const query = useQuery<TradeHistory, Error>({
    queryKey: ['launchTrades', activeChain.id, version, token, createdAt, graduated],
    enabled: !fixtureOn && (version === 'v14' ? isLaunchpadV14Deployed : isLaunchpadDeployed) && Boolean(token) && createdAt !== undefined,
    staleTime: 8_000,
    // The RPC fallback costs several calls a poll, so it polls less often than the explorer.
    refetchInterval: (current) => (current.state.data?.source === 'rpc' ? 30_000 : 12_000),
    placeholderData: (previous) => previous,
    queryFn: async ({ signal }): Promise<TradeHistory> => {
      if (!token) return { trades: [], complete: true, source: 'explorer' }
      const feeds = tradeFeeds(version, graduated, {
        v13: { launchpad: deployment.launchpad, launchRouter: deployment.launchRouter },
        v14: { launchpad: launchSuiteV14.launchpad, hook: launchSuiteV14.hook },
      })
      const combine = (parts: { trades: LaunchTrade[]; complete: boolean }[]) => {
        const trades = parts.flatMap((part) => part.trades).sort(byNewest)
        return { trades: trades.slice(0, MAX_TRADES), complete: parts.every((part) => part.complete) || trades.length >= MAX_TRADES }
      }
      try {
        if (!publicClient) throw new Error('No RPC client')
        const parts = await Promise.all(feeds.map((feed) => fromExplorer(publicClient, feed, token, createdAt, signal)))
        return { ...combine(parts), source: 'explorer' }
      } catch (error) {
        // A cancelled read (the page went away) is not an unreachable explorer: no RPC reads for it.
        if (signal?.aborted) throw error
        // The explorer (or its newest indexed block) could not be read: a few RPC windows from the head, as before.
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
  // The curve says it has traded, so an empty history is a source that has not caught up, never "No trades yet".
  const historyComplete = (query.data?.complete ?? false) && !(traded && trades.length === 0)
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
