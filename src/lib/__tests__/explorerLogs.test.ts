import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { fetchLogHistory, parseExplorerLog, resetLogHistoryCache } from '../explorerLogs'

const TOPIC = `0x${'2c'.repeat(32)}` as const
const OTHER = `0x${'ab'.repeat(32)}` as const
const TOKEN_A = `0x${'00'.repeat(12)}${'a1'.repeat(20)}` as const
const TOKEN_B = `0x${'00'.repeat(12)}${'b2'.repeat(20)}` as const
const ADDRESS = '0xd9a7b70085AFE91c4868587899824048d933736e'

function row(block: number, index: number, topic1: string = TOKEN_A, seconds = 1_000 + block) {
  return {
    block_number: block,
    block_timestamp: new Date(seconds * 1000).toISOString(),
    index,
    transaction_hash: `0x${block.toString(16).padStart(62, '0')}${index.toString(16).padStart(2, '0')}`,
    topics: [TOPIC, topic1, null, null],
    data: '0x01',
  }
}

/** Serves pages keyed by the `block_number` cursor; records every URL requested. */
function serve(pages: Record<string, { items: unknown[]; next_page_params: Record<string, number> | null }>) {
  const requested: string[] = []
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input)
    requested.push(url.toString())
    const page = pages[url.searchParams.get('block_number') ?? 'first']
    return Promise.resolve(new Response(JSON.stringify(page), { status: 200 }))
  })
  return requested
}

const realFetch = globalThis.fetch
beforeEach(() => resetLogHistoryCache())
afterEach(() => {
  globalThis.fetch = realFetch
})

const base = { explorerBase: 'https://explorer.test', address: ADDRESS, topic0: TOPIC, maxPages: 6 } as const

describe('parseExplorerLog', () => {
  test('reads a v2 row and drops the null topic padding', () => {
    const log = parseExplorerLog(row(62983688, 44))
    expect(log).not.toBeNull()
    expect(log!.block).toBe(62983688)
    expect(log!.logIndex).toBe(44)
    expect(log!.time).toBe(1_000 + 62983688)
    expect(log!.topics).toEqual([TOPIC, TOKEN_A])
  })

  test('refuses rows that are not shaped like a log', () => {
    expect(parseExplorerLog(null)).toBeNull()
    expect(parseExplorerLog('log')).toBeNull()
    expect(parseExplorerLog({ ...row(1, 0), block_number: '1' })).toBeNull()
    expect(parseExplorerLog({ ...row(1, 0), index: -1 })).toBeNull()
    expect(parseExplorerLog({ ...row(1, 0), transaction_hash: '0x1234' })).toBeNull()
    expect(parseExplorerLog({ ...row(1, 0), data: '<script>' })).toBeNull()
    expect(parseExplorerLog({ ...row(1, 0), topics: [null] })).toBeNull()
    expect(parseExplorerLog({ ...row(1, 0), topics: [TOPIC, 'javascript:alert(1)'] })).toBeNull()
  })

  test('an unreadable timestamp becomes 0, not NaN', () => {
    expect(parseExplorerLog({ ...row(1, 0), block_timestamp: 'yesterday' })!.time).toBe(0)
  })
})

describe('fetchLogHistory', () => {
  test('uses the v2 endpoint with the topic filter', async () => {
    const requested = serve({ first: { items: [], next_page_params: null } })
    await fetchLogHistory(base)
    expect(requested[0]).toBe(`https://explorer.test/api/v2/addresses/${ADDRESS}/logs?topic=${TOPIC}`)
  })

  test('an empty last page is a complete, empty history', async () => {
    serve({ first: { items: [], next_page_params: null } })
    expect(await fetchLogHistory(base)).toEqual({ logs: [], complete: true })
  })

  test('follows the cursor to the end, newest first', async () => {
    const requested = serve({
      first: { items: [row(30, 1), row(30, 0)], next_page_params: { block_number: 30, index: 0, items_count: 50 } },
      '30': { items: [row(20, 5)], next_page_params: null },
    })
    const history = await fetchLogHistory(base)
    expect(history.complete).toBe(true)
    expect(history.logs.map((log) => [log.block, log.logIndex])).toEqual([[30, 1], [30, 0], [20, 5]])
    expect(requested[1]).toContain('block_number=30')
    expect(requested[1]).toContain('items_count=50')
  })

  test('stopping at the page cap is an incomplete history', async () => {
    serve({
      first: { items: [row(30, 0)], next_page_params: { block_number: 30 } },
      '30': { items: [row(20, 0)], next_page_params: { block_number: 20 } },
    })
    const history = await fetchLogHistory({ ...base, maxPages: 2 })
    expect(history.logs).toHaveLength(2)
    expect(history.complete).toBe(false)
  })

  test('keeps one token out of a shared feed, and other tokens do not make it look empty-and-complete', async () => {
    serve({ first: { items: [row(30, 0, TOKEN_B), row(29, 0, TOKEN_A), row(28, 0, TOKEN_B)], next_page_params: { block_number: 28 } } })
    const history = await fetchLogHistory({ ...base, maxPages: 1, keep: (log) => log.topics[1] === TOKEN_A, cacheKey: TOKEN_A })
    expect(history.logs.map((log) => log.block)).toEqual([29])
    expect(history.complete).toBe(false)
  })

  test('reaching the creation time completes the history without reading further', async () => {
    const requested = serve({
      first: { items: [row(30, 0, TOKEN_A, 5_000), row(10, 0, TOKEN_B, 900)], next_page_params: { block_number: 10 } },
    })
    const history = await fetchLogHistory({ ...base, notBefore: 1_000 })
    expect(history.logs.map((log) => log.block)).toEqual([30])
    expect(history.complete).toBe(true)
    expect(requested).toHaveLength(1)
  })

  test('a full list is the newest N by design, so it counts as complete', async () => {
    serve({ first: { items: [row(5, 0), row(4, 0), row(3, 0)], next_page_params: { block_number: 3 } } })
    const history = await fetchLogHistory({ ...base, limit: 2 })
    expect(history.logs.map((log) => log.block)).toEqual([5, 4])
    expect(history.complete).toBe(true)
  })

  test('a poll stops at the first log it has seen and keeps the older ones', async () => {
    serve({
      first: { items: [row(30, 0)], next_page_params: { block_number: 30 } },
      '30': { items: [row(20, 0)], next_page_params: null },
    })
    await fetchLogHistory(base)

    const requested = serve({ first: { items: [row(31, 2), row(30, 0)], next_page_params: { block_number: 30 } } })
    const history = await fetchLogHistory(base)
    expect(history.logs.map((log) => log.block)).toEqual([31, 30, 20])
    expect(history.complete).toBe(true)
    expect(requested).toHaveLength(1)
  })

  test('ignores logs of another event and rows that do not parse', async () => {
    serve({ first: { items: [{ ...row(9, 0), topics: [OTHER] }, 'garbage', row(8, 0)], next_page_params: null } })
    expect((await fetchLogHistory(base)).logs.map((log) => log.block)).toEqual([8])
  })

  test('a rate limit or an error body throws, so the caller falls back to the RPC', async () => {
    globalThis.fetch = (() => Promise.resolve(new Response('{"message":"Too many requests"}', { status: 429 })))
    await expect(fetchLogHistory(base)).rejects.toThrow('Explorer 429')
    globalThis.fetch = (() => Promise.resolve(new Response('{"message":"nope","result":null}', { status: 200 })))
    await expect(fetchLogHistory(base)).rejects.toThrow('Explorer returned no items')
  })
})
