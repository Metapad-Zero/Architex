import type { Address, Hex } from 'viem'

/**
 * Event logs from the chain's Blockscout explorer, newest first.
 *
 * This reads the v2 REST API. The older `?module=logs&action=getLogs` endpoint answers in one
 * request, but allows an anonymous browser 10 requests an hour, which a polling page spends in two
 * minutes; v2 allows 180 a minute. Polls are incremental: after the first read, a poll stops at the
 * first log it has already seen, so it normally costs one request.
 *
 * Everything the explorer returns is untrusted input: rows that are not shaped like a log are dropped.
 */
export interface ExplorerLog {
  block: number
  time: number // unix seconds
  logIndex: number
  txHash: Hex
  topics: Hex[]
  data: Hex
}

export interface LogHistory {
  /** Newest first. */
  logs: ExplorerLog[]
  /** True when nothing older can exist: the last page was read, or `notBefore` was reached. */
  complete: boolean
}

export interface LogQuery {
  explorerBase: string
  address: Address
  topic0: Hex
  /** Pages of up to 50 logs to read in one call, at most. */
  maxPages: number
  /** Only logs that pass are kept. The explorer can filter by one topic, so a second filter runs here. */
  keep?: (log: ExplorerLog) => boolean
  /** Keep at most this many logs. A full list counts as complete: it is the newest `limit`, by design. */
  limit?: number
  /** Unix seconds. Nothing older can matter (the contract did not exist yet), so reaching it completes the history. */
  notBefore?: number
  /** Separates cached histories that share an address and topic, such as one launchpad's trades per token. */
  cacheKey?: string
  signal?: AbortSignal
}

interface Cached extends LogHistory {
  /** The newest log scanned, kept or not: where the next poll can stop. */
  newest: { block: number; logIndex: number } | null
}

const cache = new Map<string, Cached>()

const HEX = /^0x[0-9a-fA-F]*$/

function isHex(value: unknown): value is Hex {
  return typeof value === 'string' && HEX.test(value)
}

/** One row of `GET /api/v2/addresses/{address}/logs`, or null when it is not shaped like a log. */
export function parseExplorerLog(row: unknown): ExplorerLog | null {
  if (typeof row !== 'object' || row === null) return null
  const { block_number, block_timestamp, index, transaction_hash, topics, data } = row as Record<string, unknown>
  if (typeof block_number !== 'number' || !Number.isSafeInteger(block_number) || block_number < 0) return null
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) return null
  if (!isHex(transaction_hash) || transaction_hash.length !== 66) return null
  if (!isHex(data) || !Array.isArray(topics)) return null
  const present = topics.filter((topic) => topic !== null) // the explorer pads unused topics with null
  if (present.length === 0 || !present.every((topic) => isHex(topic) && topic.length === 66)) return null
  const millis = typeof block_timestamp === 'string' ? Date.parse(block_timestamp) : Number.NaN
  return {
    block: block_number,
    time: Number.isFinite(millis) ? Math.floor(millis / 1000) : 0,
    logIndex: index,
    txHash: transaction_hash,
    topics: present as Hex[],
    data,
  }
}

function isNewer(log: ExplorerLog, than: { block: number; logIndex: number }): boolean {
  return log.block > than.block || (log.block === than.block && log.logIndex > than.logIndex)
}

function pageUrl(query: LogQuery, next: Record<string, unknown> | null): string {
  const params = new URLSearchParams({ topic: query.topic0 })
  for (const [key, value] of Object.entries(next ?? {})) {
    if (typeof value === 'string' || typeof value === 'number') params.set(key, String(value))
  }
  return `${query.explorerBase}/api/v2/addresses/${query.address}/logs?${params.toString()}`
}

/** Reads a history, or brings the cached one up to date. Throws when the explorer cannot be read. */
export async function fetchLogHistory(query: LogQuery): Promise<LogHistory> {
  const key = `${query.explorerBase}|${query.address}|${query.topic0}|${query.cacheKey ?? ''}`.toLowerCase()
  const known = cache.get(key)
  const fresh: ExplorerLog[] = []
  let newest = known?.newest ?? null
  let complete = false
  let reachedKnown = false
  let next: Record<string, unknown> | null = null

  for (let page = 0; page < query.maxPages; page += 1) {
    const response = await fetch(pageUrl(query, next), { signal: query.signal })
    if (!response.ok) throw new Error(`Explorer ${response.status}`)
    const body = (await response.json()) as { items?: unknown; next_page_params?: unknown }
    if (!Array.isArray(body.items)) throw new Error('Explorer returned no items')

    for (const row of body.items) {
      const log = parseExplorerLog(row)
      if (!log || log.topics[0].toLowerCase() !== query.topic0.toLowerCase()) continue
      if (known?.newest && !isNewer(log, known.newest)) {
        reachedKnown = true
        break
      }
      if (query.notBefore !== undefined && log.time > 0 && log.time < query.notBefore) {
        complete = true
        break
      }
      if (newest === null || isNewer(log, newest)) newest = { block: log.block, logIndex: log.logIndex }
      if (!query.keep || query.keep(log)) fresh.push(log)
    }
    if (reachedKnown || complete) break

    next = typeof body.next_page_params === 'object' && body.next_page_params !== null ? (body.next_page_params as Record<string, unknown>) : null
    if (next === null) {
      complete = true
      break
    }
    if (query.limit !== undefined && fresh.length >= query.limit) break
  }

  let logs = reachedKnown && known ? [...fresh, ...known.logs] : fresh
  if (reachedKnown && known) complete = known.complete
  if (query.limit !== undefined && logs.length >= query.limit) {
    logs = logs.slice(0, query.limit)
    complete = true
  }
  cache.set(key, { logs, complete, newest })
  return { logs, complete }
}

/** Test hook: forgets every cached history. */
export function resetLogHistoryCache(): void {
  cache.clear()
}
