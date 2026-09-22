import { isTooMuchData, type Rpc } from './rpc.js'

type Hex = `0x${string}`

/** An eth_getLogs entry as the RPC sends it. Arc's nodes include `blockTimestamp`. */
export interface RawLog {
  address: Hex
  topics: Hex[]
  data: Hex
  blockNumber: Hex | null
  logIndex: Hex | null
  transactionHash: Hex | null
  blockTimestamp?: Hex
  removed?: boolean
}

export interface BlockRange {
  from: bigint
  to: bigint
}

export interface LogScan {
  /** Oldest first. */
  logs: RawLog[]
  /** Ranges that could not be read in time or at all, oldest first; empty when the scan is complete. */
  missing: BlockRange[]
  /** eth_getLogs calls spent. */
  calls: number
}

export interface ScanOptions {
  addresses: readonly Hex[]
  /** topic0 alternatives: a log matches when its first topic is any of these. */
  topics: readonly Hex[]
  from: bigint
  to: bigint
  /** Blocks per call to start with. Halved whenever the endpoint says a range is too much. */
  windowBlocks?: number
  concurrency?: number
  /** Epoch ms after which no new call starts; what is left is reported missing. */
  deadline?: number
  now?: () => number
  /** Addresses per call, so a long list never becomes one oversized filter. */
  addressesPerCall?: number
}

const toHex = (value: bigint): Hex => `0x${value.toString(16)}`

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size))
  return out
}

/** `from`..`to` (both included) cut into windows of at most `size` blocks, oldest first. */
export function windows(from: bigint, to: bigint, size: bigint): BlockRange[] {
  const out: BlockRange[] = []
  for (let start = from; start <= to; start += size) out.push({ from: start, to: start + size - 1n < to ? start + size - 1n : to })
  return out
}

function byPosition(a: RawLog, b: RawLog): number {
  const blockA = BigInt(a.blockNumber ?? '0x0')
  const blockB = BigInt(b.blockNumber ?? '0x0')
  if (blockA !== blockB) return blockA < blockB ? -1 : 1
  return Number(BigInt(a.logIndex ?? '0x0') - BigInt(b.logIndex ?? '0x0'))
}

function mergeRanges(ranges: BlockRange[]): BlockRange[] {
  const sorted = [...ranges].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
  const out: BlockRange[] = []
  for (const range of sorted) {
    const last = out[out.length - 1]
    if (last && range.from <= last.to + 1n) last.to = range.to > last.to ? range.to : last.to
    else out.push({ ...range })
  }
  return out
}

/**
 * Every log from `addresses` whose topic0 is one of `topics`, over `from`..`to`, read in windows a few at a time.
 * A window the endpoint calls too large is split in half (and later windows start at the smaller size); a window
 * that still fails after the client's retries, or that would start after the deadline, is reported in `missing`
 * instead of failing the scan, so a caller can serve what it has and say it is partial.
 */
export async function scanLogs(rpc: Rpc, options: ScanOptions): Promise<LogScan> {
  const now = options.now ?? Date.now
  const addressGroups = chunk(options.addresses, options.addressesPerCall ?? 200)
  let size = BigInt(options.windowBlocks ?? 10_000)
  const queue = options.from <= options.to ? windows(options.from, options.to, size) : []
  const logs: RawLog[] = []
  const missing: BlockRange[] = []
  let calls = 0
  if (addressGroups.length === 0 || options.topics.length === 0) return { logs, missing, calls }

  const worker = async () => {
    for (let range = queue.shift(); range; range = queue.shift()) {
      if (options.deadline !== undefined && now() > options.deadline) {
        missing.push(range)
        continue
      }
      if (range.to - range.from + 1n > size) {
        const [first, ...rest] = windows(range.from, range.to, size)
        queue.unshift(first, ...rest)
        continue
      }
      try {
        const found: RawLog[] = []
        for (const group of addressGroups) {
          calls += 1
          const part = await rpc.request<RawLog[]>('eth_getLogs', [
            { fromBlock: toHex(range.from), toBlock: toHex(range.to), address: group, topics: [[...options.topics]] },
          ])
          if (!Array.isArray(part)) throw new Error('eth_getLogs did not answer with a list')
          found.push(...part)
        }
        logs.push(...found.filter((log) => !log.removed))
      } catch (error) {
        const blocks = range.to - range.from + 1n
        if (isTooMuchData(error) && blocks > 1n) {
          const half = blocks / 2n
          if (half < size) size = half
          queue.unshift({ from: range.from, to: range.from + half - 1n }, { from: range.from + half, to: range.to })
        } else {
          missing.push(range)
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 3) }, worker))
  logs.sort(byPosition)
  return { logs, missing: mergeRanges(missing), calls }
}
