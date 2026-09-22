import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Abi, type Hex } from 'viem'
import { launchPairAbi, launchRouterAbi, launchpadAbi, lensAbi, pairAbi } from '../../src/lib/abi'
import type { RawLog } from '../listing/logs'
import { MULTICALL3 } from '../listing/multicall'
import { RpcError, type Rpc } from '../listing/rpc'
import { CACHE, createListingService } from '../listing/service'
import { CORE_PAIR, CURVED, EURC, POOLED, POOLED_PAIR, TIME, USDC, makeLog, network, tx } from './listingFixtures'

const E18 = 10n ** 18n
const HEAD = 22_000_000n
const CURVED_PAIR = '0x4444444444444444444444444444444444444444'
const ORIGIN = 'https://architex.fun'

/** Half-second blocks ending at TIME. */
const timeOf = (block: bigint) => TIME - Math.ceil(Number(HEAD - block) / 2)

const multicallAbi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
])

interface FakeChainOptions {
  chainId?: number
  logs?: RawLog[]
  /** eth_getLogs over a range that includes this block fails as rate limited. */
  failLogsAt?: bigint
  down?: boolean
}

/** Arc mainnet in miniature, answering exactly the calls the listing API makes. */
function fakeChain(options: FakeChainOptions = {}) {
  const counts = new Map<string, number>()
  const answer = (target: string, data: Hex): Hex => {
    const call = (abi: Abi) => decodeFunctionData({ abi, data })
    const to = target.toLowerCase()
    if (to === network.lens.toLowerCase()) {
      const { functionName, args } = call(lensAbi)
      if (functionName === 'pairsLength') return encodeFunctionResult({ abi: lensAbi, functionName, result: 1n })
      if (functionName === 'pairs') {
        return encodeFunctionResult({
          abi: lensAbi,
          functionName,
          result: [{ pair: CORE_PAIR, token0: USDC.address, token1: EURC.address, reserve0: 281_638_016n, reserve1: 244_524_893n, blockTimestampLast: TIME, totalSupply: 1n }],
        })
      }
      if (functionName === 'tokenMeta') {
        const all = [USDC, EURC, POOLED, CURVED]
        const asked = (args?.[0] ?? []) as string[]
        return encodeFunctionResult({
          abi: lensAbi,
          functionName,
          result: asked.map((address) => {
            const token = all.find((entry) => entry.address.toLowerCase() === address.toLowerCase())
            return { token: address as Hex, symbol: token?.symbol ?? '', name: token?.name ?? '', decimals: token?.decimals ?? 18 }
          }),
        })
      }
    }
    if (to === network.launchpad.toLowerCase()) {
      const { functionName } = call(launchpadAbi)
      if (functionName === 'tokensLength') return encodeFunctionResult({ abi: launchpadAbi, functionName, result: 2n })
      if (functionName === 'FEE_BPS') return encodeFunctionResult({ abi: launchpadAbi, functionName, result: 50n })
      if (functionName === 'CURVE_SUPPLY') return encodeFunctionResult({ abi: launchpadAbi, functionName, result: 800_000_000n * E18 })
      if (functionName === 'VIRTUAL_USDC_0') return encodeFunctionResult({ abi: launchpadAbi, functionName, result: 8_333_333_333n })
      if (functionName === 'curvesPage') {
        const curve = (token: Hex, pair: Hex, graduated: boolean, creatorFeeBps: number) => ({
          token,
          creator: USDC.address,
          pair,
          virtualUsdc: graduated ? 33_333_333_333n : 8_333_333_333n,
          virtualTokens: graduated ? 266_666_667n * E18 : 1_066_666_667n * E18,
          tokensSold: graduated ? 800_000_000n * E18 : 0n,
          createdAt: BigInt(TIME - 5000),
          graduated,
          creatorFeeBps,
          pluginHooks: false,
          plugin: USDC.address,
          metadataURI: '',
        })
        return encodeFunctionResult({ abi: launchpadAbi, functionName, result: [curve(POOLED.address, POOLED_PAIR, true, 100), curve(CURVED.address, CURVED_PAIR, false, 250)] })
      }
    }
    if (to === POOLED_PAIR.toLowerCase()) {
      return encodeFunctionResult({ abi: launchPairAbi, functionName: 'getReserves', result: [200_000_000n * E18, 25_000_000_000n, TIME] })
    }
    throw new Error(`unexpected call to ${target}`)
  }

  const rpc: Rpc = {
    request<T>(method: string, params: readonly unknown[]): Promise<T> {
      counts.set(method, (counts.get(method) ?? 0) + 1)
      if (options.down) return Promise.reject(new RpcError(`${method}: HTTP 503`, undefined, true))
      if (method === 'eth_chainId') return Promise.resolve(`0x${(options.chainId ?? network.chainId).toString(16)}` as T)
      if (method === 'eth_getBlockByNumber') {
        const tag = params[0] as string
        const block = tag === 'latest' ? HEAD : BigInt(tag)
        return Promise.resolve({ number: `0x${block.toString(16)}`, timestamp: `0x${timeOf(block).toString(16)}` } as T)
      }
      if (method === 'eth_call') {
        const { to, data } = params[0] as { to: string; data: Hex }
        if (to.toLowerCase() !== MULTICALL3.toLowerCase()) throw new Error('not multicall')
        const { args } = decodeFunctionData({ abi: multicallAbi, data })
        const results = args[0].map((call) => {
          try {
            return { success: true, returnData: answer(call.target, call.callData) }
          } catch {
            return { success: false, returnData: '0x' as const }
          }
        })
        return Promise.resolve(encodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', result: results }) as T)
      }
      if (method === 'eth_getLogs') {
        const filter = params[0] as { fromBlock: string; toBlock: string; address: string[]; topics: string[][] }
        const from = BigInt(filter.fromBlock)
        const to = BigInt(filter.toBlock)
        if (options.failLogsAt !== undefined && options.failLogsAt >= from && options.failLogsAt <= to) {
          return Promise.reject(new RpcError('eth_getLogs: rate limit exceeded', -32005, true))
        }
        const addresses = new Set(filter.address.map((address) => address.toLowerCase()))
        const found = (options.logs ?? []).filter((entry) => {
          const block = BigInt(entry.blockNumber ?? '0x0')
          return block >= from && block <= to && addresses.has(entry.address.toLowerCase()) && filter.topics[0].includes(entry.topics[0])
        })
        return Promise.resolve(found as T)
      }
      return Promise.reject(new Error(`unexpected ${method}`))
    },
  }
  return { rpc, counts }
}

const at = (block: bigint, logIndex: number, n: number) => ({ block, logIndex, tx: tx(n), time: timeOf(block) })
const RECENT = HEAD - 7_200n // an hour ago
const OLD = HEAD - 250_000n // about 35 hours ago

const LOGS: RawLog[] = [
  makeLog(CORE_PAIR, pairAbi, 'Sync', { reserve0: 271_638_016n, reserve1: 256_524_893n }, at(OLD, 0, 1)),
  makeLog(CORE_PAIR, pairAbi, 'Swap', { sender: USDC.address, amount0In: 0n, amount1In: 12_000_000n, amount0Out: 10_000_000n, amount1Out: 0n, to: USDC.address }, at(OLD, 1, 1)),
  makeLog(CORE_PAIR, pairAbi, 'Sync', { reserve0: 291_638_016n, reserve1: 236_208_295n }, at(RECENT, 4, 2)),
  makeLog(CORE_PAIR, pairAbi, 'Swap', { sender: USDC.address, amount0In: 10_000_000n, amount1In: 0n, amount0Out: 0n, amount1Out: 8_316_598n, to: USDC.address }, at(RECENT, 5, 2)),
  makeLog(network.launchRouter, launchRouterAbi, 'PoolTrade', { token: POOLED.address, trader: EURC.address, isBuy: true, usdcAmount: 100_000_000n, tokenAmount: 790_000n * E18, platformFee: 500_000n, creatorFee: 1_000_000n }, at(RECENT + 10n, 1, 3)),
  makeLog(POOLED_PAIR, launchPairAbi, 'Sync', { reserveToken: 199_210_000n * E18, reserveUsdc: 25_098_500_000n }, at(RECENT + 10n, 6, 3)),
]

function service(options: FakeChainOptions = {}) {
  const chain = fakeChain({ logs: LOGS, ...options })
  let clock = TIME * 1000
  const api = createListingService({ network, rpc: chain.rpc, now: () => clock, imageLookup: () => () => Promise.resolve(undefined) })
  const get = async (path: string) => {
    const response = await api.handle(new Request(`${ORIGIN}${path}`))
    return { response, body: (await response.json()) as unknown }
  }
  return { get, chain, advance: (ms: number) => (clock += ms) }
}

const EURC_TICKER = `${EURC.address}_${USDC.address}`

describe('the listing API end to end, on a fake chain', () => {
  test('/api/v1/pairs: every market, public, cached at the CDN, stamped with network and block', async () => {
    const { get } = service()
    const { response, body } = await get('/api/v1/pairs')
    expect(response.status).toBe(200)
    expect((body as unknown[]).length).toBe(3)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('cache-control')).toBe(CACHE.pairs)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('x-architex-network')).toBe('mainnet')
    expect(response.headers.get('x-architex-block')).toBe(String(HEAD - 2n))
    expect(response.headers.get('x-architex-partial')).toBeNull()
  })

  test('/api/v1/tickers: the last 24 hours only, and a second call reads nothing new', async () => {
    const { get, chain } = service()
    const { body } = await get('/api/v1/tickers')
    const rows = body as { ticker_id: string; base_volume: string; target_volume: string }[]
    const eurc = rows.find((row) => row.ticker_id === EURC_TICKER)
    expect(eurc?.base_volume).toBe('8.316598')
    expect(eurc?.target_volume).toBe('10')
    expect(rows.find((row) => row.ticker_id.startsWith(POOLED.address))?.target_volume).toBe('100')
    const logCalls = chain.counts.get('eth_getLogs')
    await get('/api/v1/tickers')
    expect(chain.counts.get('eth_getLogs')).toBe(logCalls)
  })

  test('/api/v1/orderbook: validates its query and clamps depth', async () => {
    const { get } = service()
    expect((await get('/api/v1/orderbook')).response.status).toBe(400)
    const unknown = await get('/api/v1/orderbook?ticker_id=0x1_0x2')
    expect(unknown.response.status).toBe(404)
    expect((unknown.body as { error: string }).error).toContain('/api/v1/pairs')
    expect((await get(`/api/v1/orderbook?ticker_id=${EURC_TICKER}&depth=deep`)).response.status).toBe(400)
    const book = (await get(`/api/v1/orderbook?ticker_id=${EURC_TICKER.toLowerCase()}&depth=100000`)).body as { bids: unknown[]; asks: unknown[]; ticker_id: string }
    expect(book.ticker_id).toBe(EURC_TICKER)
    expect(book.bids).toHaveLength(250)
    expect(book.asks).toHaveLength(250)
  })

  test('/api/v1/historical_trades: type, limit and window', async () => {
    const { get } = service()
    const recent = (await get(`/api/v1/historical_trades?ticker_id=${EURC_TICKER}&type=buy`)).body as { buy: { base_volume: string }[]; sell: unknown[] }
    expect(recent.buy.map((row) => row.base_volume)).toEqual(['8.316598'])
    expect(recent.sell).toEqual([])
    expect((await get(`/api/v1/historical_trades?ticker_id=${EURC_TICKER}&type=hold`)).response.status).toBe(400)
    expect((await get(`/api/v1/historical_trades?ticker_id=${EURC_TICKER}&start_time=${TIME}&end_time=${TIME - 10}`)).response.status).toBe(400)
    // A window older than the kept 24 hours is read for the request.
    const oldTime = timeOf(OLD)
    const older = await get(`/api/v1/historical_trades?ticker_id=${EURC_TICKER}&start_time=${oldTime - 60}&end_time=${oldTime + 60}`)
    expect(older.response.headers.get('x-architex-window')).toBe(`${oldTime - 60}-${oldTime + 60}`)
    expect((older.body as { sell: { base_volume: string }[] }).sell.map((row) => row.base_volume)).toEqual(['12'])
  })

  test('/tokenlist.json and /api/v1/tokenlist are the same list', async () => {
    const { get } = service()
    const rewritten = (await get('/tokenlist.json')).body as { tokens: { symbol: string }[] }
    const direct = await get('/api/v1/tokenlist')
    expect(rewritten.tokens.map((token) => token.symbol)).toEqual(['USDC', 'EURC', 'POOL', 'CRV'])
    expect(direct.response.headers.get('cache-control')).toBe(CACHE.tokenlist)
  })

  test('a log window that cannot be read: the answer still goes out, flagged partial and cached briefly', async () => {
    const { get } = service({ failLogsAt: RECENT })
    const { response, body } = await get('/api/v1/tickers')
    expect(response.status).toBe(200)
    expect((body as unknown[]).length).toBe(3)
    expect(response.headers.get('x-architex-partial')).toBe('trades')
    expect(response.headers.get('cache-control')).toBe(CACHE.partial)
  })

  test('a chain that cannot be read at all is a 503 nobody caches; so is the wrong chain', async () => {
    const down = await service({ down: true }).get('/api/v1/pairs')
    expect(down.response.status).toBe(503)
    expect(down.response.headers.get('cache-control')).toBe('no-store')
    expect((down.body as { error: string }).error).toBe('The chain could not be read just now. Try again in a minute.')
    expect((await service({ chainId: 1 }).get('/api/v1/pairs')).response.status).toBe(503)
  })

  test('an unknown endpoint is a 404 that names the real ones', async () => {
    const { response, body } = await service().get('/api/v1/summary')
    expect(response.status).toBe(404)
    expect((body as { error: string }).error).toContain('/api/v1/tickers')
  })
})
