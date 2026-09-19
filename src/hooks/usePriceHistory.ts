import { useQuery } from '@tanstack/react-query'
import { decodeAbiParameters, parseAbiItem, type Address, type Hex } from 'viem'
import { usePublicClient } from 'wagmi'
import { activeChain } from '../chain'
import { fetchLogHistory } from '../lib/explorerLogs'
import { blockTimes, readLogWindows } from '../lib/rpcLogs'

export interface PricePoint {
  block: number
  time: number // unix seconds
  reserve0: bigint
  reserve1: bigint
}

export interface PriceHistoryData {
  /** Oldest first. */
  points: PricePoint[]
  /** False when older swaps may exist that could not be read; "No trades yet" is only true when complete. */
  complete: boolean
  source: 'explorer' | 'rpc'
}

const SYNC_TOPIC = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'
const SYNC_EVENT = parseAbiItem('event Sync(uint112 reserve0, uint112 reserve1)')
const MAX_POINTS = 240
// 5 pages of 50: the chart draws the most recent 250 reserve updates.
const EXPLORER_PAGES = 5
const RPC_WINDOWS = 3

function thin<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points
  const step = points.length / max
  const out: T[] = []
  for (let index = 0; index < max; index += 1) out.push(points[Math.floor(index * step)])
  const last = points[points.length - 1]
  if (out[out.length - 1] !== last) out[out.length - 1] = last
  return out
}

function decodeSync(data: Hex): [bigint, bigint] {
  const [reserve0, reserve1] = decodeAbiParameters([{ type: 'uint112' }, { type: 'uint112' }], data)
  return [reserve0, reserve1]
}

function oldestFirst(a: PricePoint, b: PricePoint): number {
  return a.block - b.block
}

async function fromExplorer(pair: Address, signal: AbortSignal | undefined): Promise<PriceHistoryData> {
  const history = await fetchLogHistory({ explorerBase: activeChain.explorerBase, address: pair, topic0: SYNC_TOPIC, maxPages: EXPLORER_PAGES, signal })
  const points: PricePoint[] = []
  // Newest first from the explorer; reversing keeps the order of several syncs inside one block.
  for (const log of [...history.logs].reverse()) {
    try {
      const [reserve0, reserve1] = decodeSync(log.data)
      points.push({ block: log.block, time: log.time, reserve0, reserve1 })
    } catch {
      // skip undecodable explorer rows
    }
  }
  return { points: thin(points, MAX_POINTS), complete: history.complete, source: 'explorer' }
}

export function usePriceHistory(pair: Address | undefined, enabled = true) {
  const publicClient = usePublicClient()
  return useQuery<PriceHistoryData, Error>({
    queryKey: ['priceHistory', activeChain.id, pair],
    enabled: enabled && Boolean(pair),
    staleTime: 20_000,
    // The RPC fallback costs several calls a poll, so it polls less often than the explorer.
    refetchInterval: (current) => (current.state.data?.source === 'rpc' ? 60_000 : 30_000),
    placeholderData: (previous) => previous,
    queryFn: async ({ signal }): Promise<PriceHistoryData> => {
      if (!pair) return { points: [], complete: true, source: 'explorer' }
      try {
        return await fromExplorer(pair, signal)
      } catch {
        if (!publicClient) return { points: [], complete: false, source: 'rpc' }
        const { logs, complete } = await readLogWindows({
          head: await publicClient.getBlockNumber(),
          windows: RPC_WINDOWS,
          read: (fromBlock, toBlock) => publicClient.getLogs({ address: pair, event: SYNC_EVENT, fromBlock, toBlock }),
        })
        const times = await blockTimes(publicClient, logs.map((log) => log.blockNumber))
        const points = logs
          .filter((log) => log.blockNumber !== null && log.args.reserve0 !== undefined && log.args.reserve1 !== undefined)
          .map((log) => ({
            block: Number(log.blockNumber),
            time: times.get(log.blockNumber) ?? 0,
            reserve0: log.args.reserve0!,
            reserve1: log.args.reserve1!,
          }))
          .sort(oldestFirst)
        return { points: thin(points, MAX_POINTS), complete, source: 'rpc' }
      }
    },
  })
}
