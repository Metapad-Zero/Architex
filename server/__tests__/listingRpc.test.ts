import { describe, expect, test } from 'bun:test'
import { scanLogs, windows, type RawLog } from '../listing/logs'
import { RpcError, createRpc, eachLimited, isTooMuchData, type Rpc } from '../listing/rpc'

const noSleep = () => Promise.resolve()

/** An endpoint that answers each JSON-RPC body with `answer(url, method, params)`, counting calls. */
function endpoint(answer: (url: string, method: string, params: unknown[]) => unknown) {
  const calls: string[] = []
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { id: number; method: string; params: unknown[] }
    calls.push(`${url} ${body.method}`)
    const reply = answer(url, body.method, body.params)
    if (reply instanceof Response) return Promise.resolve(reply)
    return Promise.resolve(Response.json({ jsonrpc: '2.0', id: body.id, ...(reply as object) }))
  }) as typeof fetch
  return { fetcher, calls }
}

describe('the RPC client', () => {
  test('a rate limit is retried on the next endpoint, which is then preferred', async () => {
    const { fetcher, calls } = endpoint((url) => (url === 'https://a.example' ? { error: { code: -32005, message: 'rate limit exceeded' } } : { result: '0x1' }))
    const rpc = createRpc({ urls: ['https://a.example', 'https://b.example'], fetcher, sleep: noSleep })
    expect(await rpc.request<string>('eth_blockNumber', [])).toBe('0x1')
    expect(await rpc.request<string>('eth_blockNumber', [])).toBe('0x1')
    expect(calls).toEqual(['https://a.example eth_blockNumber', 'https://b.example eth_blockNumber', 'https://b.example eth_blockNumber'])
  })

  test('HTTP 429, 5xx and network failures are retried; a revert or a bad request is not', async () => {
    let n = 0
    const flaky = endpoint(() => (++n < 3 ? new Response('busy', { status: n === 1 ? 429 : 503 }) : { result: '0x2' }))
    expect(await createRpc({ urls: ['https://a.example'], fetcher: flaky.fetcher, sleep: noSleep }).request('eth_chainId', [])).toBe('0x2')

    const reverting = endpoint(() => ({ error: { code: 3, message: 'execution reverted' } }))
    await expect(createRpc({ urls: ['https://a.example'], fetcher: reverting.fetcher, sleep: noSleep }).request('eth_call', [])).rejects.toThrow('execution reverted')
    expect(reverting.calls).toHaveLength(1)
  })

  test('gives up after its attempts, with the last reason', async () => {
    const down = endpoint(() => new Response('nope', { status: 502 }))
    await expect(createRpc({ urls: ['https://a.example'], fetcher: down.fetcher, sleep: noSleep, attempts: 3 }).request('eth_chainId', [])).rejects.toThrow('HTTP 502')
    expect(down.calls).toHaveLength(3)
  })

  test('a range that is too large is the caller to fix, not a retry', () => {
    expect(isTooMuchData(new RpcError('eth_getLogs: requested range too large', -32012, false))).toBe(true)
    expect(isTooMuchData(new RpcError('eth_getLogs: query returned more than 10000 results', -32602, false))).toBe(true)
    expect(isTooMuchData(new RpcError('eth_getLogs: rate limit exceeded', -32005, true))).toBe(false)
    expect(isTooMuchData(new Error('requested range too large'))).toBe(false)
  })

  test('eachLimited keeps at most `limit` tasks in flight', async () => {
    let running = 0
    let peak = 0
    await eachLimited([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 1))
      running -= 1
    })
    expect(peak).toBe(3)
  })
})

const log = (block: number, logIndex = 0): RawLog => ({
  address: '0x6b27c00db2e1fcbe68955c9194b656768b7cdb06',
  topics: ['0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'],
  data: '0x',
  blockNumber: `0x${block.toString(16)}`,
  logIndex: `0x${logIndex.toString(16)}`,
  transactionHash: `0x${block.toString(16).padStart(64, '0')}`,
})

/** A fake eth_getLogs over a chain with one log every 1,000 blocks, refusing ranges over `limit` blocks. */
function chain(limit: number, failing: (from: number, to: number) => boolean = () => false) {
  const ranges: [number, number][] = []
  const rpc: Rpc = {
    request<T>(method: string, params: readonly unknown[]): Promise<T> {
      if (method !== 'eth_getLogs') throw new Error(method)
      const filter = params[0] as { fromBlock: string; toBlock: string }
      const from = Number(BigInt(filter.fromBlock))
      const to = Number(BigInt(filter.toBlock))
      ranges.push([from, to])
      if (to - from + 1 > limit) return Promise.reject(new RpcError('eth_getLogs: requested range too large', -32012, false))
      if (failing(from, to)) return Promise.reject(new RpcError('eth_getLogs: rate limit exceeded', -32005, true))
      const found: RawLog[] = []
      for (let block = Math.ceil(from / 1000) * 1000; block <= to; block += 1000) found.push(log(block))
      return Promise.resolve(found as T)
    },
  }
  return { rpc, ranges }
}

const options = { addresses: ['0x6b27c00db2e1fcbe68955c9194b656768b7cdb06'] as `0x${string}`[], topics: ['0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'] as `0x${string}`[] }

describe('reading logs in windows', () => {
  test('windows cover the range exactly, both ends included', () => {
    expect(windows(1n, 25n, 10n)).toEqual([
      { from: 1n, to: 10n },
      { from: 11n, to: 20n },
      { from: 21n, to: 25n },
    ])
  })

  test('every log once, oldest first, in 10,000-block windows', async () => {
    const { rpc, ranges } = chain(10_000)
    const scan = await scanLogs(rpc, { ...options, from: 1n, to: 50_000n })
    expect(scan.missing).toEqual([])
    expect(scan.logs.map((entry) => Number(BigInt(entry.blockNumber ?? '0x0')))).toEqual(Array.from({ length: 50 }, (_, index) => (index + 1) * 1000))
    expect(ranges).toHaveLength(5)
  })

  test('an endpoint that allows less gets smaller windows, and later windows start small', async () => {
    const { rpc, ranges } = chain(2_000)
    const scan = await scanLogs(rpc, { ...options, from: 1n, to: 30_000n, concurrency: 1 })
    expect(scan.missing).toEqual([])
    expect(scan.logs).toHaveLength(30)
    expect(ranges.filter(([from, to]) => to - from + 1 > 2_000).length).toBeLessThan(4)
  })

  test('a window that keeps failing is reported missing, and the rest is still read', async () => {
    const { rpc } = chain(10_000, (from) => from === 10_001)
    const scan = await scanLogs(rpc, { ...options, from: 1n, to: 30_000n })
    expect(scan.missing).toEqual([{ from: 10_001n, to: 20_000n }])
    expect(scan.logs).toHaveLength(20)
  })

  test('nothing new starts after the deadline; what is left is missing', async () => {
    const { rpc, ranges } = chain(10_000)
    const scan = await scanLogs(rpc, { ...options, from: 1n, to: 30_000n, deadline: 0, now: () => 1 })
    expect(ranges).toEqual([])
    expect(scan.missing).toEqual([{ from: 1n, to: 30_000n }])
  })

  test('removed logs are dropped', async () => {
    const rpc: Rpc = { request: <T>() => Promise.resolve([{ ...log(5), removed: true }, log(6)] as T) }
    const scan = await scanLogs(rpc, { ...options, from: 1n, to: 10n })
    expect(scan.logs).toHaveLength(1)
  })
})
