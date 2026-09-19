import { useQuery } from '@tanstack/react-query'
import { decodeAbiParameters, parseAbiItem, type Address, type Hex } from 'viem'
import { usePublicClient } from 'wagmi'
import { activeChain } from '../chain'

export interface PricePoint {
  block: number
  time: number // unix seconds
  reserve0: bigint
  reserve1: bigint
}

const SYNC_TOPIC = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'
const SYNC_EVENT = parseAbiItem('event Sync(uint112 reserve0, uint112 reserve1)')
const MAX_POINTS = 240
// Arc's public RPC refuses eth_getLogs over more than ~2k blocks; the explorer keeps the full history.
const RPC_FALLBACK_SPAN = 1_900n

interface ExplorerLog {
  blockNumber: string
  timeStamp: string
  data: string
}

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

async function fromExplorer(pair: Address, signal: AbortSignal | undefined): Promise<PricePoint[]> {
  const url = `${activeChain.explorerBase}/api?module=logs&action=getLogs&address=${pair}&fromBlock=0&toBlock=latest&topic0=${SYNC_TOPIC}`
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`Explorer ${response.status}`)
  const body = (await response.json()) as { result?: ExplorerLog[] | string | null; message?: string }
  // "No logs found" still carries an empty array. Anything else is an error inside a 200, and
  // throwing sends the caller to its RPC fallback instead of showing an empty history.
  if (!Array.isArray(body.result)) throw new Error(body.message ?? 'Explorer returned no result')
  const points = body.result.map((log) => {
    const [reserve0, reserve1] = decodeSync(log.data as Hex)
    return { block: Number(log.blockNumber), time: Number(log.timeStamp), reserve0, reserve1 }
  })
  points.sort((a, b) => a.block - b.block)
  return points
}

export function usePriceHistory(pair: Address | undefined, enabled = true) {
  const publicClient = usePublicClient()
  return useQuery<PricePoint[], Error, PricePoint[]>({
    queryKey: ['priceHistory', activeChain.id, pair],
    enabled: enabled && Boolean(pair),
    staleTime: 20_000,
    refetchInterval: 30_000,
    placeholderData: (previous) => previous,
    queryFn: async ({ signal }): Promise<PricePoint[]> => {
      if (!pair) return []
      try {
        return thin(await fromExplorer(pair, signal), MAX_POINTS)
      } catch {
        if (!publicClient) return []
        const head = await publicClient.getBlockNumber()
        const logs = await publicClient.getLogs({
          address: pair,
          event: SYNC_EVENT,
          fromBlock: head > RPC_FALLBACK_SPAN ? head - RPC_FALLBACK_SPAN : 0n,
          toBlock: head,
        })
        const blocks = new Map<bigint, number>()
        const wanted = [...new Set(logs.map((log) => log.blockNumber))].filter((b): b is bigint => b !== null)
        await Promise.all(
          wanted.slice(0, 40).map(async (blockNumber) => {
            const block = await publicClient.getBlock({ blockNumber })
            blocks.set(blockNumber, Number(block.timestamp))
          }),
        )
        return thin(
          logs
            .filter((log) => log.blockNumber !== null && log.args.reserve0 !== undefined && log.args.reserve1 !== undefined)
            .map((log) => ({
              block: Number(log.blockNumber),
              time: blocks.get(log.blockNumber) ?? 0,
              reserve0: log.args.reserve0!,
              reserve1: log.args.reserve1!,
            })),
          MAX_POINTS,
        )
      }
    },
  })
}
