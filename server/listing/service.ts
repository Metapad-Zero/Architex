import { readSnapshot, type Market, type Snapshot } from './chain.js'
import { historicalTradesBody, orderbookBody, pairsBody, tickersBody } from './coingecko.js'
import { scanLogs, type BlockRange } from './logs.js'
import { readBlock, type BlockHeader } from './multicall.js'
import { NETWORKS, networkFromEnv, rpcUrlsFromEnv, type ListingNetwork } from './network.js'
import { createRpc, type Rpc } from './rpc.js'
import { buildTokenList, createImageLookup, type ImageLookup } from './tokenlist.js'
import { TRADE_TOPICS, readTrades, tradeSources, type Trade, type TradeType } from './trades.js'

/**
 * The public listing API: CoinGecko's DEX endpoints and a token list, read straight from the chain.
 *
 *   GET /api/v1/pairs
 *   GET /api/v1/tickers
 *   GET /api/v1/orderbook?ticker_id=BASE_TARGET&depth=100
 *   GET /api/v1/historical_trades?ticker_id=BASE_TARGET&type=buy&limit=200&start_time=…&end_time=…
 *   GET /tokenlist.json                  (rewritten to /api/v1/tokenlist)
 *
 * The CDN keeps every answer for a minute or more (see CACHE), so the chain is read at most every few minutes per
 * region. Inside a running instance the markets are kept for 15 seconds and the last 24 hours of trades are kept and
 * extended block by block, so a refresh reads only what is new. When part of the chain could not be read, the answer
 * still goes out with what was read, marked `x-architex-partial`, and is cached for seconds instead of minutes.
 */
export interface ListingServiceOptions {
  network: ListingNetwork
  rpc: Rpc
  /** Epoch milliseconds. */
  now?: () => number
  /** Finds launch images; by default through the site's own /api/ipfs on the origin the request came in on. */
  imageLookup?: (origin: string) => ImageLookup
  /** How long one refresh may spend reading logs before it answers with what it has. */
  scanBudgetMs?: number
  /** Blocks per eth_getLogs call to start with. */
  windowBlocks?: number
}

/** The rolling window tickers cover: 24 hours. */
export const DAY_SECONDS = 86_400
const SNAPSHOT_TTL_MS = 15_000
const TAPE_TTL_MS = 15_000
/** Extra seconds read before a window's start, since a block's time is found by estimate. */
const WINDOW_MARGIN_SECONDS = 300
const MAX_TRADES_KEPT = 200_000

export const CACHE = {
  pairs: 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600',
  tickers: 'public, max-age=30, s-maxage=120, stale-while-revalidate=600',
  orderbook: 'public, max-age=15, s-maxage=60, stale-while-revalidate=300',
  trades: 'public, max-age=30, s-maxage=120, stale-while-revalidate=600',
  tokenlist: 'public, max-age=300, s-maxage=900, stale-while-revalidate=86400',
  partial: 'public, max-age=0, s-maxage=15, stale-while-revalidate=60',
  refusal: 'public, max-age=60, s-maxage=60',
  unavailable: 'no-store',
} as const

const BASE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'x-content-type-options': 'nosniff',
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

interface Tape {
  /** First and last block read; the window's trades are all in here. */
  from: bigint
  to: bigint
  trades: Trade[]
  missing: BlockRange[]
  /** Lowercased addresses whose logs were read over the whole tape. */
  sources: Set<string>
  /** Measured seconds per block, for placing a time on the block line. */
  secondsPerBlock: number
  at: number
}

/** A whole number from the query; larger than `max` counts as `max`. */
function parseWhole(value: string | null, name: string, fallback: number, max: number): number {
  if (value === null || value.trim() === '') return fallback
  if (!/^\d{1,15}$/.test(value.trim())) throw new Refusal(400, `${name} must be a whole number (0 or more).`)
  return Math.min(Number(value.trim()), max)
}

function parseTime(value: string | null, name: string): number | undefined {
  if (value === null || value.trim() === '') return undefined
  if (!/^\d{1,12}$/.test(value.trim())) throw new Refusal(400, `${name} must be a Unix time in seconds.`)
  return Number(value.trim())
}

export function createListingService(options: ListingServiceOptions) {
  const { network, rpc } = options
  const now = options.now ?? Date.now
  const scanBudgetMs = options.scanBudgetMs ?? 20_000
  const imageLookups = new Map<string, ImageLookup>()
  const imageLookupFor = (origin: string) => {
    let lookup = imageLookups.get(origin)
    if (!lookup) {
      lookup = options.imageLookup ? options.imageLookup(origin) : createImageLookup({ origin })
      imageLookups.set(origin, lookup)
    }
    return lookup
  }

  let chainChecked = false
  let snapshot: { value: Snapshot; at: number } | undefined
  let snapshotLoading: Promise<Snapshot> | undefined
  let tape: Tape | undefined
  let tapeLoading: Promise<Tape> | undefined
  let historyQueue: Promise<unknown> = Promise.resolve()

  async function checkChain(): Promise<void> {
    if (chainChecked) return
    const id = Number(BigInt(await rpc.request<string>('eth_chainId', [])))
    if (id !== network.chainId) throw new Error(`The RPC serves chain ${id}, not ${network.chainId}.`)
    chainChecked = true
  }

  /** The markets now; a failed read falls back to the last good one, marked partial. */
  function currentSnapshot(): Promise<Snapshot> {
    if (snapshot && now() - snapshot.at < SNAPSHOT_TTL_MS) return Promise.resolve(snapshot.value)
    snapshotLoading ??= (async () => {
      try {
        await checkChain()
        const value = await readSnapshot(rpc, network)
        snapshot = { value, at: now() }
        return value
      } catch (error) {
        if (snapshot) return { ...snapshot.value, problems: [...new Set([...snapshot.value.problems, 'markets (showing an earlier read)'])] }
        throw error
      } finally {
        snapshotLoading = undefined
      }
    })()
    return snapshotLoading
  }

  /** The block at or a little before `time`, found from the measured block rate in a few header reads. */
  async function blockNear(time: number, head: BlockHeader, secondsPerBlock: number): Promise<BlockHeader> {
    if (time >= head.timestamp) return head
    let rate = secondsPerBlock
    let guess = head.number - BigInt(Math.ceil((head.timestamp - time) / rate))
    for (let step = 0; step < 6; step += 1) {
      if (guess <= 0n) return { number: 0n, timestamp: 0 }
      const header = await readBlock(rpc, guess)
      if (header.timestamp <= time) return header
      if (head.number > header.number) rate = Math.max(0.05, (head.timestamp - header.timestamp) / Number(head.number - header.number))
      guess = header.number - BigInt(Math.ceil((header.timestamp - time) / rate)) - 50n
    }
    return { number: guess > 0n ? guess : 0n, timestamp: time }
  }

  async function measuredRate(head: BlockHeader): Promise<number> {
    const span = head.number > 100_000n ? 100_000n : head.number
    if (span === 0n) return 0.5
    const earlier = await readBlock(rpc, head.number - span)
    return Math.max(0.05, (head.timestamp - earlier.timestamp) / Number(span))
  }

  async function scanTrades(snap: Snapshot, from: bigint, to: bigint, deadline: number, addresses = tradeSources(snap)): Promise<{ trades: Trade[]; missing: BlockRange[] }> {
    if (addresses.length === 0) return { trades: [], missing: [] }
    const scan = await scanLogs(rpc, {
      addresses,
      topics: TRADE_TOPICS,
      from,
      to,
      windowBlocks: options.windowBlocks ?? 10_000,
      concurrency: 3,
      deadline,
      now,
    })
    return { trades: readTrades(scan.logs, snap), missing: scan.missing }
  }

  /** The last 24 hours of trades, read once and then extended with each new block. */
  function recentTape(snap: Snapshot): Promise<Tape> {
    const sources = tradeSources(snap)
    const covered = (current: Tape) => sources.every((address) => current.sources.has(address.toLowerCase()))
    if (tape && (now() - tape.at < TAPE_TTL_MS || tape.to >= snap.block) && tape.missing.length === 0 && covered(tape)) return Promise.resolve(tape)
    tapeLoading ??= (async () => {
      try {
        const deadline = now() + scanBudgetMs
        const head: BlockHeader = { number: snap.block, timestamp: snap.time }
        const windowStart = snap.time - DAY_SECONDS - WINDOW_MARGIN_SECONDS
        let current = tape
        if (!current) {
          const rate = await measuredRate(head)
          const start = await blockNear(windowStart, head, rate)
          const read = await scanTrades(snap, start.number, snap.block, deadline, sources)
          current = {
            from: start.number,
            to: snap.block,
            trades: read.trades,
            missing: read.missing,
            sources: new Set(sources.map((address) => address.toLowerCase())),
            secondsPerBlock: rate,
            at: now(),
          }
        } else {
          const trades = [...current.trades]
          const missing: BlockRange[] = []
          // A pool that appeared since the tape began: read its whole window once.
          const added = sources.filter((address) => !current?.sources.has(address.toLowerCase()))
          if (added.length > 0) {
            const read = await scanTrades(snap, current.from, current.to, deadline, added)
            trades.push(...read.trades)
            missing.push(...read.missing)
          }
          // Retry what an earlier refresh could not read, then read what is new.
          for (const range of current.missing) {
            const read = await scanTrades(snap, range.from, range.to, deadline)
            trades.push(...read.trades)
            missing.push(...read.missing)
          }
          if (snap.block > current.to) {
            const read = await scanTrades(snap, current.to + 1n, snap.block, deadline)
            trades.push(...read.trades)
            missing.push(...read.missing)
          }
          const firstKept = snap.block - BigInt(Math.ceil((DAY_SECONDS + WINDOW_MARGIN_SECONDS) / current.secondsPerBlock))
          current = {
            ...current,
            from: firstKept > current.from ? firstKept : current.from,
            to: snap.block > current.to ? snap.block : current.to,
            trades: dedupe(trades).filter((trade) => trade.time >= windowStart),
            missing: missing.filter((range) => range.to >= firstKept),
            sources: new Set([...current.sources, ...sources.map((address) => address.toLowerCase())]),
            at: now(),
          }
        }
        if (current.trades.length > MAX_TRADES_KEPT) current.trades = current.trades.slice(-MAX_TRADES_KEPT)
        tape = current
        return current
      } finally {
        tapeLoading = undefined
      }
    })()
    return tapeLoading
  }

  /** Trades in any window of up to 24 hours: from the kept tape when it covers the window, else read for it. */
  async function tradesBetween(snap: Snapshot, from: number, to: number): Promise<{ trades: Trade[]; partial: boolean }> {
    const recent = await recentTape(snap)
    const tapeStart = snap.time - DAY_SECONDS
    if (from >= tapeStart) return { trades: recent.trades, partial: recent.missing.length > 0 }
    // One older window at a time per instance, so a burst of odd windows cannot flood the RPC.
    const run = historyQueue.then(async () => {
      const deadline = now() + scanBudgetMs
      const head: BlockHeader = { number: snap.block, timestamp: snap.time }
      const start = await blockNear(from - WINDOW_MARGIN_SECONDS, head, recent.secondsPerBlock)
      const end = await blockNear(to + WINDOW_MARGIN_SECONDS, head, recent.secondsPerBlock)
      const last = end.number + BigInt(Math.ceil((2 * WINDOW_MARGIN_SECONDS) / recent.secondsPerBlock))
      const read = await scanTrades(snap, start.number, last < snap.block ? last : snap.block, deadline)
      return { trades: read.trades, partial: read.missing.length > 0 }
    })
    historyQueue = run.catch(() => undefined)
    return run
  }

  function respond(body: unknown, cache: string, extra: Record<string, string> = {}, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, 'cache-control': cache, 'x-architex-network': network.name, ...extra } })
  }

  function stamp(snap: Snapshot, problems: readonly string[]): Record<string, string> {
    const headers: Record<string, string> = { 'x-architex-chain-id': String(network.chainId), 'x-architex-block': String(snap.block) }
    if (problems.length > 0) headers['x-architex-partial'] = [...new Set(problems)].join(', ')
    return headers
  }

  function marketFor(snap: Snapshot, tickerId: string | null): Market {
    if (!tickerId || tickerId.trim() === '') throw new Refusal(400, 'ticker_id is required. The list of tickers is at /api/v1/pairs.')
    const market = snap.markets.find((entry) => entry.key === tickerId.trim().toLowerCase())
    if (!market) throw new Refusal(404, 'No market has that ticker_id. The list of tickers is at /api/v1/pairs.')
    return market
  }

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const endpoint = url.pathname.split('/').filter(Boolean).pop() ?? ''
    const query = url.searchParams

    switch (endpoint) {
      case 'pairs': {
        const snap = await currentSnapshot()
        return respond(pairsBody(snap), snap.problems.length ? CACHE.partial : CACHE.pairs, stamp(snap, snap.problems))
      }
      case 'tickers': {
        const snap = await currentSnapshot()
        const recent = await recentTape(snap)
        const problems = [...snap.problems, ...(recent.missing.length ? ['trades'] : [])]
        return respond(tickersBody(snap, recent.trades, snap.time - DAY_SECONDS), problems.length ? CACHE.partial : CACHE.tickers, stamp(snap, problems))
      }
      case 'orderbook': {
        const depth = parseWhole(query.get('depth'), 'depth', 100, 500)
        const snap = await currentSnapshot()
        const market = marketFor(snap, query.get('ticker_id'))
        return respond(orderbookBody(market, snap, depth), snap.problems.length ? CACHE.partial : CACHE.orderbook, stamp(snap, snap.problems))
      }
      case 'historical_trades': {
        const typeParam = query.get('type')?.trim().toLowerCase() || undefined
        if (typeParam !== undefined && typeParam !== 'buy' && typeParam !== 'sell') throw new Refusal(400, 'type must be buy or sell.')
        const type: TradeType | undefined = typeParam
        const limit = parseWhole(query.get('limit'), 'limit', 200, 5000)
        const startTime = parseTime(query.get('start_time'), 'start_time')
        const endTime = parseTime(query.get('end_time'), 'end_time')
        const snap = await currentSnapshot()
        const market = marketFor(snap, query.get('ticker_id'))
        const to = Math.min(endTime ?? snap.time, snap.time)
        if (startTime !== undefined && startTime > to) throw new Refusal(400, 'start_time must not be later than end_time.')
        // At most 24 hours a request: a longer range is cut to the 24 hours that end at end_time.
        const from = Math.max(startTime ?? to - DAY_SECONDS, to - DAY_SECONDS)
        const read = await tradesBetween(snap, from, to)
        const problems = [...snap.problems, ...(read.partial ? ['trades'] : [])]
        const body = historicalTradesBody(market, read.trades, { type, from, to, limit: limit === 0 ? 5000 : limit })
        return respond(body, problems.length ? CACHE.partial : CACHE.trades, { ...stamp(snap, problems), 'x-architex-window': `${from}-${to}` })
      }
      case 'tokenlist':
      case 'tokenlist.json': {
        const snap = await currentSnapshot()
        const { list, complete } = await buildTokenList(snap, url.origin, imageLookupFor(url.origin))
        const problems = [...snap.problems, ...(complete ? [] : ['logos'])]
        return respond(list, problems.length ? CACHE.partial : CACHE.tokenlist, stamp(snap, problems))
      }
      default:
        throw new Refusal(404, 'Unknown endpoint. Try /api/v1/pairs, /api/v1/tickers, /api/v1/orderbook, /api/v1/historical_trades or /tokenlist.json.')
    }
  }

  return {
    async handle(request: Request): Promise<Response> {
      try {
        return await route(request)
      } catch (error) {
        if (error instanceof Refusal) return respond({ error: error.message }, CACHE.refusal, {}, error.status)
        console.error('listing API:', error instanceof Error ? error.message : 'unknown error')
        return respond({ error: 'The chain could not be read just now. Try again in a minute.' }, CACHE.unavailable, {}, 503)
      }
    },
  }
}

function dedupe(trades: Trade[]): Trade[] {
  const seen = new Set<number>()
  const out: Trade[] = []
  for (const trade of trades.sort((a, b) => a.id - b.id)) {
    if (seen.has(trade.id)) continue
    seen.add(trade.id)
    out.push(trade)
  }
  return out
}

/** The service the Vercel function runs: network and RPC from the environment. */
export function listingServiceFromEnv(env: Readonly<Record<string, string | undefined>> = process.env) {
  const network = NETWORKS[networkFromEnv(env)]
  return createListingService({ network, rpc: createRpc({ urls: rpcUrlsFromEnv(env, network) }) })
}
