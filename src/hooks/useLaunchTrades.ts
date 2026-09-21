import { useQuery } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { decodeEventLog, pad, parseAbiItem, toEventSelector, type Address } from 'viem'
import { usePublicClient } from 'wagmi'
import { activeChain } from '../chain'
import { deployment, isLaunchpadDeployed } from '../lib/deployment'
import { fetchLogHistory } from '../lib/explorerLogs'
import type { LaunchTrade } from '../lib/launch'
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
const TRADE_EVENT = parseAbiItem(
  'event Trade(address indexed token, address indexed trader, bool isBuy, uint256 usdcAmount, uint256 tokenAmount, uint256 fee, uint256 virtualUsdc, uint256 virtualTokens)',
)
const TRADE_TOPIC = toEventSelector(TRADE_EVENT)
const MAX_TRADES = 50
// Every token's trades come from the one launchpad address and the explorer filters by one topic,
// so a token's trades are picked out of the launchpad's feed: 6 pages is the newest 300 trades.
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

async function fromExplorer(token: Address, createdAt: number | undefined, signal: AbortSignal | undefined): Promise<TradeHistory> {
  const tokenTopic = pad(token, { size: 32 }).toLowerCase()
  const history = await fetchLogHistory({
    explorerBase: activeChain.explorerBase,
    address: deployment.launchpad,
    topic0: TRADE_TOPIC,
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
      const decoded = decodeEventLog({ abi: [TRADE_EVENT], data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] })
      trades.push({
        trader: decoded.args.trader,
        isBuy: decoded.args.isBuy,
        usdcAmount: decoded.args.usdcAmount,
        tokenAmount: decoded.args.tokenAmount,
        fee: decoded.args.fee,
        time: log.time,
        txHash: log.txHash,
        block: log.block,
        logIndex: log.logIndex,
        virtualUsdc: decoded.args.virtualUsdc,
        virtualTokens: decoded.args.virtualTokens,
      })
    } catch {
      // skip undecodable explorer rows
    }
  }
  return { trades: trades.sort(byNewest), complete: history.complete, source: 'explorer' }
}

/** `createdAt` (unix seconds, from the curve) bounds the search: no trade can be older than its token. */
export function useLaunchTrades(token: Address | undefined, createdAt: number | undefined) {
  const publicClient = usePublicClient()
  const api = launchFixtureApi()
  const fixtureVersion = useSyncExternalStore(api ? api.subscribe : noopSubscribe, api ? api.version : zero, zero)

  const query = useQuery<TradeHistory, Error>({
    queryKey: ['launchTrades', activeChain.id, token, createdAt],
    enabled: !fixtureOn && isLaunchpadDeployed && Boolean(token) && createdAt !== undefined,
    staleTime: 8_000,
    // The RPC fallback costs several calls a poll, so it polls less often than the explorer.
    refetchInterval: (current) => (current.state.data?.source === 'rpc' ? 30_000 : 12_000),
    placeholderData: (previous) => previous,
    queryFn: async ({ signal }): Promise<TradeHistory> => {
      if (!token) return { trades: [], complete: true, source: 'explorer' }
      try {
        return await fromExplorer(token, createdAt, signal)
      } catch {
        if (!publicClient) return { trades: [], complete: false, source: 'rpc' }
        const { logs, complete } = await readLogWindows({
          head: await publicClient.getBlockNumber(),
          windows: RPC_WINDOWS,
          read: (fromBlock, toBlock) => publicClient.getLogs({ address: deployment.launchpad, event: TRADE_EVENT, args: { token }, fromBlock, toBlock }),
          reachedStart:
            createdAt === undefined
              ? undefined
              : async (fromBlock) => Number((await publicClient.getBlock({ blockNumber: fromBlock })).timestamp) <= createdAt,
        })
        const trades = logs
          .filter((log) => log.blockNumber !== null && log.args.trader && log.args.tokenAmount !== undefined)
          .map((log) => ({
            trader: log.args.trader!,
            isBuy: Boolean(log.args.isBuy),
            usdcAmount: log.args.usdcAmount ?? 0n,
            tokenAmount: log.args.tokenAmount ?? 0n,
            fee: log.args.fee ?? 0n,
            time: 0,
            txHash: log.transactionHash,
            block: Number(log.blockNumber),
            logIndex: log.logIndex ?? 0,
            virtualUsdc: log.args.virtualUsdc,
            virtualTokens: log.args.virtualTokens,
          }))
          .sort(byNewest)
        const shown = trades.slice(0, MAX_TRADES)
        const times = await blockTimes(publicClient, shown.map((trade) => BigInt(trade.block)), MAX_TRADES)
        return {
          trades: shown.map((trade) => ({ ...trade, time: times.get(BigInt(trade.block)) ?? 0 })),
          complete: complete || trades.length >= MAX_TRADES,
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
