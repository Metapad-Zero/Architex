/**
 * Reading event history straight from the RPC: when the explorer cannot be reached, and for the newest blocks
 * when the explorer has not indexed them yet (lib/logTail.ts).
 *
 * Arc's public RPC refuses `eth_getLogs` over more than about 2,000 blocks, and a block takes about
 * half a second, so one window is roughly 16 minutes. A few windows are read newest first; the
 * result says whether that reached the start of the history or only its recent end.
 */

/** One eth_getLogs window spans WINDOW + 1 blocks, both ends included. */
export const WINDOW = 1_900n

export interface WindowedLogs<T> {
  logs: T[]
  /** True when the windows reached block 0 or the point `reachedStart` recognises. */
  complete: boolean
}

export interface RangeRead<T> {
  /** Newest window first; within a window, as the RPC returned them. */
  logs: T[]
  /** The oldest block read: every block from here to `to` was read. */
  lowest: bigint
  /** True when the windows got down to `from`. */
  covered: boolean
  /** True when `reachedStart` recognised a window's first block as older than the history. */
  reachedStart: boolean
  /** Windows spent. */
  windows: number
}

/**
 * Reads blocks `from`..`to` in windows, newest first, until the range is covered, `reachedStart` says the history
 * cannot reach further back, `enough` is satisfied, or `windows` windows are spent.
 */
export async function readRange<T>(options: {
  from: bigint
  to: bigint
  windows: number
  read: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>
  /** Whether history cannot extend below this block, for example because the contract is younger. */
  reachedStart?: (fromBlock: bigint) => Promise<boolean>
  /** Stop early once the logs read so far are all that is wanted (they are the newest, being read newest first). */
  enough?: (logs: T[]) => boolean
}): Promise<RangeRead<T>> {
  const logs: T[] = []
  let toBlock = options.to
  let windows = 0
  while (toBlock >= options.from && windows < options.windows) {
    const fromBlock = toBlock - options.from > WINDOW ? toBlock - WINDOW : options.from
    logs.push(...(await options.read(fromBlock, toBlock)))
    windows += 1
    const covered = fromBlock === options.from
    const reachedStart = Boolean(options.reachedStart && (await options.reachedStart(fromBlock)))
    if (covered || reachedStart || options.enough?.(logs)) return { logs, lowest: fromBlock, covered, reachedStart, windows }
    toBlock = fromBlock - 1n
  }
  return { logs, lowest: toBlock + 1n, covered: toBlock < options.from, reachedStart: false, windows }
}

export async function readLogWindows<T>(options: {
  head: bigint
  windows: number
  read: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>
  /** Whether history cannot extend below this block, for example because the contract is younger. */
  reachedStart?: (fromBlock: bigint) => Promise<boolean>
}): Promise<WindowedLogs<T>> {
  const range = await readRange({ from: 0n, to: options.head, windows: options.windows, read: options.read, reachedStart: options.reachedStart })
  return { logs: range.logs, complete: range.covered || range.reachedStart }
}

interface BlockClient {
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>
}

// A block's time never changes, so each is read once. Bounded: cleared when it grows past MAX_CACHED_TIMES.
const MAX_CACHED_TIMES = 20_000
const times = new Map<bigint, number>()

/** A block's unix-second timestamp if it has been read before; never asks the RPC. */
export function knownBlockTime(blockNumber: bigint): number | undefined {
  return times.get(blockNumber)
}

/** A block's unix-second timestamp, read once. */
export async function blockTime(client: BlockClient, blockNumber: bigint): Promise<number> {
  const known = times.get(blockNumber)
  if (known !== undefined) return known
  const block = await client.getBlock({ blockNumber })
  if (times.size >= MAX_CACHED_TIMES) times.clear()
  times.set(blockNumber, Number(block.timestamp))
  return Number(block.timestamp)
}

/** Arc's public RPC answers bursts with 429, so block reads go a few at a time. */
const BLOCK_READS_AT_ONCE = 6

/** Reads the times of `blockNumbers` (each once, a few at a time) into a map. */
export async function readBlockTimes(client: BlockClient, blockNumbers: bigint[]): Promise<Map<bigint, number>> {
  const found = new Map<bigint, number>()
  for (let start = 0; start < blockNumbers.length; start += BLOCK_READS_AT_ONCE) {
    await Promise.all(
      blockNumbers.slice(start, start + BLOCK_READS_AT_ONCE).map(async (blockNumber) => {
        found.set(blockNumber, await blockTime(client, blockNumber))
      }),
    )
  }
  return found
}

/** Unix-second timestamps for the newest `max` distinct blocks; older blocks are left out of the map. */
export async function blockTimes(client: BlockClient, blockNumbers: (bigint | null)[], max = 40): Promise<Map<bigint, number>> {
  const wanted = [...new Set(blockNumbers.filter((block): block is bigint => block !== null))]
    .sort((a, b) => (a === b ? 0 : a > b ? -1 : 1))
    .slice(0, max)
  return readBlockTimes(client, wanted)
}

/** Test hook: forgets every cached block time. */
export function resetBlockTimeCache(): void {
  times.clear()
}
