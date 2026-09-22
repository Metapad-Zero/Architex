import type { Hex } from 'viem'
import type { ExplorerLog, LogHistory } from './explorerLogs'
import { knownBlockTime, readBlockTimes, readRange } from './rpcLogs'

/**
 * Explorer history, with the chain's newest blocks read from the RPC while the explorer is behind.
 *
 * Blockscout can fall hours behind the chain while its indexing status still says finished, and an address it has
 * not reached yet answers with an empty last page: a history that looks complete and empty. So every read also
 * takes the explorer's newest indexed block and the RPC's head. When the head is further ahead than a few blocks,
 * the gap is read from the RPC, newest first, a few eth_getLogs windows per read, and merged into the explorer's
 * logs. What was read is kept, so the next poll only reads the blocks that are new since (and, if the gap was too
 * wide for one read, carries on further back).
 */

/** Blocks the explorer may trail the head by (about 10 seconds) before the gap is read from the RPC. */
export const HEAD_TOLERANCE = 20n
/** eth_getLogs windows one read may spend on the gap (about 15,000 blocks, two hours). */
export const MAX_TAIL_WINDOWS = 8
const INDEXED_HEAD_TTL_MS = 10_000
/** A tail that grows past this many logs is dropped and read afresh, so a long-open page stays bounded. */
const MAX_TAIL_LOGS = 5_000

// ─── The explorer's newest indexed block ─────────────────────────────────────

/** `items[0].height` of `GET /api/v2/blocks?type=block`, or null when the body is not shaped like that. */
export function parseIndexedHead(body: unknown): bigint | null {
  if (typeof body !== 'object' || body === null) return null
  const items = (body as { items?: unknown }).items
  if (!Array.isArray(items) || items.length === 0) return null
  const first: unknown = items[0]
  if (typeof first !== 'object' || first === null) return null
  const height = (first as { height?: unknown }).height
  if (typeof height !== 'number' || !Number.isSafeInteger(height) || height < 0) return null
  return BigInt(height)
}

const heads = new Map<string, { at: number; head: Promise<bigint> }>()

/**
 * The newest block the explorer has indexed, cached for about 10 seconds (one request serves every history a page
 * reads at once). Throws when it cannot be read, so the caller treats the explorer as unreachable.
 */
export function fetchIndexedHead(explorerBase: string): Promise<bigint> {
  const cached = heads.get(explorerBase)
  if (cached && Date.now() - cached.at < INDEXED_HEAD_TTL_MS) return cached.head
  const head = (async () => {
    const response = await fetch(`${explorerBase}/api/v2/blocks?type=block`)
    if (!response.ok) throw new Error(`Explorer ${response.status}`)
    const parsed = parseIndexedHead(await response.json())
    if (parsed === null) throw new Error('Explorer returned no block height')
    return parsed
  })()
  heads.set(explorerBase, { at: Date.now(), head })
  // A failed read is not kept: the next caller asks again.
  head.catch(() => {
    if (heads.get(explorerBase)?.head === head) heads.delete(explorerBase)
  })
  return head
}

// ─── Merging the RPC's tail into the explorer's history ──────────────────────

/** An RPC log in the explorer's shape, with time 0 until `fillTimes` reads its block; null while pending. */
export function fromRpcLog(log: {
  blockNumber: bigint | null
  logIndex: number | null
  transactionHash: Hex | null
  topics: readonly Hex[]
  data: Hex
}): ExplorerLog | null {
  if (log.blockNumber === null || log.logIndex === null || log.transactionHash === null || log.topics.length === 0) return null
  return { block: Number(log.blockNumber), time: 0, logIndex: log.logIndex, txHash: log.transactionHash, topics: [...log.topics], data: log.data }
}

function newestFirst(a: ExplorerLog, b: ExplorerLog): number {
  return b.block - a.block || b.logIndex - a.logIndex
}

/** Both lists as one, newest first, each log once (by transaction and log index); the first list's copy wins. */
export function mergeLogs(first: readonly ExplorerLog[], second: readonly ExplorerLog[]): ExplorerLog[] {
  const seen = new Set<string>()
  const merged: ExplorerLog[] = []
  for (const log of [...first, ...second]) {
    const id = `${log.txHash.toLowerCase()}:${log.logIndex}`
    if (seen.has(id)) continue
    seen.add(id)
    merged.push(log)
  }
  return merged.sort(newestFirst)
}

interface Tail {
  /** Every block from `from` to `to` was read. */
  from: bigint
  to: bigint
  /** Newest first. */
  logs: ExplorerLog[]
  /** The read got back past the start of the history (the token's creation), so nothing older can matter. */
  reachedStart: boolean
}

const tails = new Map<string, Tail>()

export interface TailQuery {
  /** Separates kept tails: the address and topic, and for one token's trades, the token. */
  key: string
  /** The explorer's history, as fetchLogHistory read it. */
  history: LogHistory
  /** The explorer's newest indexed block. */
  indexedHead: bigint
  /** The RPC's newest block. */
  head: bigint
  /** eth_getLogs over one window, in the explorer's shape (see fromRpcLog). */
  read: (fromBlock: bigint, toBlock: bigint) => Promise<ExplorerLog[]>
  /** Whether history cannot extend below this block, for example because the token is younger. */
  reachedStart?: (fromBlock: bigint) => Promise<boolean>
  /** Only the newest `limit` logs are wanted: once the tail holds that many, older blocks are not read. */
  limit?: number
  maxWindows?: number
  tolerance?: bigint
}

export interface TailedHistory extends LogHistory {
  /** eth_getLogs windows this read spent (0 when the explorer was current). */
  windows: number
  /** The blocks the RPC covered because the explorer had not indexed them yet; null when it was current. */
  tail: { from: bigint; to: bigint } | null
}

/**
 * The explorer's history with the blocks it has not indexed yet read from the RPC. Complete when the tail got back
 * to the start of the history, or when it covered the whole gap and the explorer's history was complete, or when it
 * already holds the newest `limit` logs.
 */
export async function withRpcTail(query: TailQuery): Promise<TailedHistory> {
  const tolerance = query.tolerance ?? HEAD_TOLERANCE
  if (query.head <= query.indexedHead + tolerance) {
    tails.delete(query.key)
    return { logs: query.history.logs, complete: query.history.complete, windows: 0, tail: null }
  }
  const gapStart = query.indexedHead + 1n
  const full = (logs: ExplorerLog[]) => query.limit !== undefined && logs.length >= query.limit
  let budget = query.maxWindows ?? MAX_TAIL_WINDOWS
  let windows = 0
  let tail = tails.get(query.key)
  // The explorer has caught up past everything the kept tail read: it covers those blocks now.
  if (tail && tail.to + 1n < gapStart) tail = undefined

  // The blocks since the last read first. If they cannot all be read now, the kept tail would have a hole in it, so
  // it is dropped and what was read starts a new one.
  if (tail && tail.to < query.head) {
    const newer = await readRange({ from: tail.to + 1n, to: query.head, windows: budget, read: query.read })
    windows += newer.windows
    budget -= newer.windows
    tail = newer.covered
      ? { ...tail, to: query.head, logs: [...newer.logs.sort(newestFirst), ...tail.logs] }
      : { from: newer.lowest, to: query.head, logs: newer.logs.sort(newestFirst), reachedStart: false }
  }
  if (!tail) {
    const fresh = await readRange({ from: gapStart, to: query.head, windows: budget, read: query.read, reachedStart: query.reachedStart, enough: full })
    windows += fresh.windows
    tail = { from: fresh.lowest, to: query.head, logs: fresh.logs.sort(newestFirst), reachedStart: fresh.reachedStart }
  } else if (!tail.reachedStart && tail.from > gapStart && !full(tail.logs) && budget > 0) {
    // The gap was wider than one read could cover: carry on further back.
    const kept = tail
    const older = await readRange({
      from: gapStart,
      to: kept.from - 1n,
      windows: budget,
      read: query.read,
      reachedStart: query.reachedStart,
      enough: (logs) => full([...kept.logs, ...logs]),
    })
    windows += older.windows
    tail = { from: older.lowest, to: kept.to, logs: [...kept.logs, ...older.logs.sort(newestFirst)], reachedStart: older.reachedStart }
  }
  if (tail.logs.length > MAX_TAIL_LOGS) tails.delete(query.key)
  else tails.set(query.key, tail)

  const coveredGap = tail.from <= gapStart
  return {
    // The explorer's copy of a log first: it carries the block's time.
    logs: mergeLogs(query.history.logs, tail.logs),
    complete: tail.reachedStart || full(tail.logs) || (coveredGap && query.history.complete),
    windows,
    tail: { from: tail.from, to: tail.to },
  }
}

// ─── Block times for what the RPC read ───────────────────────────────────────

/**
 * Gives logs read from the RPC (time 0) their blocks' times. The newest `max - 1` such blocks and the oldest are
 * read (each block once, ever); a block between two known times is placed on the line between them, which on a
 * chain with a steady block time is off by a second or two at most.
 */
export async function fillTimes(
  client: { getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }> },
  logs: readonly ExplorerLog[],
  max = 40,
): Promise<ExplorerLog[]> {
  const known = new Map<number, number>()
  for (const log of logs) if (log.time > 0) known.set(log.block, log.time)
  for (const log of logs) {
    const cached = log.time === 0 ? knownBlockTime(BigInt(log.block)) : undefined
    if (cached !== undefined) known.set(log.block, cached)
  }
  const untimed = [...new Set(logs.filter((log) => !known.has(log.block)).map((log) => log.block))].sort((a, b) => b - a)
  const read = untimed.slice(0, Math.max(1, max - 1))
  const oldest = untimed[untimed.length - 1]
  if (oldest !== undefined && !read.includes(oldest)) read.push(oldest)
  for (const [block, time] of await readBlockTimes(client, read.map(BigInt))) known.set(Number(block), time)
  const anchors = [...known.entries()].sort((a, b) => a[0] - b[0])
  const timeOf = (block: number): number => {
    const exact = known.get(block)
    if (exact !== undefined) return exact
    let below: [number, number] | undefined
    let above: [number, number] | undefined
    for (const anchor of anchors) {
      if (anchor[0] < block) below = anchor
      else if (anchor[0] > block) {
        above = anchor
        break
      }
    }
    if (!below || !above) return 0
    return Math.round(below[1] + ((block - below[0]) * (above[1] - below[1])) / (above[0] - below[0]))
  }
  return logs.map((log) => (log.time === 0 ? { ...log, time: timeOf(log.block) } : log))
}

/** Test hook: forgets every kept tail and indexed head. */
export function resetLogTailCache(): void {
  tails.clear()
  heads.clear()
}
