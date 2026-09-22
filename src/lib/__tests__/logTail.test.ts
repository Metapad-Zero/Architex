import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Hex } from 'viem'
import type { ExplorerLog, LogHistory } from '../explorerLogs'
import { fetchIndexedHead, fillTimes, fromRpcLog, mergeLogs, parseIndexedHead, resetLogTailCache, withRpcTail } from '../logTail'
import { readRange, resetBlockTimeCache, WINDOW } from '../rpcLogs'

const TOPIC = `0x${'2c'.repeat(32)}` as const

function log(block: number, logIndex = 0, time = 0): ExplorerLog {
  return { block, time, logIndex, txHash: `0x${block.toString(16).padStart(62, '0')}${logIndex.toString(16).padStart(2, '0')}` as Hex, topics: [TOPIC], data: '0x' }
}

/** An RPC over a fixed set of logs: eth_getLogs answers a window oldest first, as the node does; every window is recorded. */
function chain(logs: ExplorerLog[]) {
  const windows: [bigint, bigint][] = []
  const read = (fromBlock: bigint, toBlock: bigint) => {
    windows.push([fromBlock, toBlock])
    return Promise.resolve(logs.filter((entry) => BigInt(entry.block) >= fromBlock && BigInt(entry.block) <= toBlock).sort((a, b) => a.block - b.block || a.logIndex - b.logIndex))
  }
  return { read, windows }
}

const EMPTY_BUT_COMPLETE: LogHistory = { logs: [], complete: true }
const blocksOf = (logs: ExplorerLog[]) => logs.map((entry) => entry.block)

beforeEach(() => {
  resetLogTailCache()
  resetBlockTimeCache()
})

describe('withRpcTail', () => {
  test('a lagging explorer answers empty and "complete"; the tail finds the trades, complete once it reaches the creation', async () => {
    // Blockscout at block 1,000, the chain at 5,000, the token created at block 3,400 with three trades since.
    const rpc = chain([log(3_500), log(4_000), log(4_900, 3), log(4_900, 1)])
    const history = await withRpcTail({
      key: 'token',
      history: EMPTY_BUT_COMPLETE,
      indexedHead: 1_000n,
      head: 5_000n,
      read: rpc.read,
      reachedStart: (fromBlock) => Promise.resolve(fromBlock < 3_400n),
    })
    expect(blocksOf(history.logs)).toEqual([4_900, 4_900, 4_000, 3_500])
    expect(history.logs.map((entry) => entry.logIndex).slice(0, 2)).toEqual([3, 1])
    expect(history.complete).toBe(true)
    // One window reached back past the creation: the rest of the gap is never read.
    expect(rpc.windows).toEqual([[5_000n - WINDOW, 5_000n]])
    expect(history.tail).toEqual({ from: 5_000n - WINDOW, to: 5_000n })
  })

  test('covering the whole gap completes the history only when the explorer’s part was complete', async () => {
    const trades = [log(900, 0, 1_700_000_000), log(2_000)]
    const whole = await withRpcTail({ key: 'a', history: { logs: [trades[0]], complete: true }, indexedHead: 1_000n, head: 3_000n, read: chain([trades[1]]).read })
    expect(blocksOf(whole.logs)).toEqual([2_000, 900])
    expect(whole.complete).toBe(true)

    const partial = await withRpcTail({ key: 'b', history: { logs: [trades[0]], complete: false }, indexedHead: 1_000n, head: 3_000n, read: chain([trades[1]]).read })
    expect(partial.complete).toBe(false)
  })

  test('a gap wider than the cap, with the creation not reached: the newest logs, and not complete', async () => {
    const rpc = chain([log(50_000), log(99_000)])
    const history = await withRpcTail({ key: 'wide', history: EMPTY_BUT_COMPLETE, indexedHead: 0n, head: 100_000n, read: rpc.read, maxWindows: 8 })
    expect(blocksOf(history.logs)).toEqual([99_000])
    expect(history.complete).toBe(false)
    expect(history.windows).toBe(8)
    expect(rpc.windows).toHaveLength(8)
  })

  test('the explorer caught up (within the tolerance): the RPC is not asked for logs', async () => {
    const rpc = chain([log(1_010)])
    const explorer: LogHistory = { logs: [log(990, 0, 1_700_000_000)], complete: true }
    const history = await withRpcTail({ key: 'current', history: explorer, indexedHead: 1_000n, head: 1_020n, read: rpc.read })
    expect(rpc.windows).toEqual([])
    expect(history).toEqual({ logs: explorer.logs, complete: true, windows: 0, tail: null })

    await withRpcTail({ key: 'current', history: explorer, indexedHead: 1_000n, head: 1_021n, read: rpc.read })
    expect(rpc.windows).toEqual([[1_001n, 1_021n]])
  })

  test('a log the explorer and the tail both have appears once, with the explorer’s time', async () => {
    const rpc = chain([log(2_000, 4), log(2_900)])
    await withRpcTail({ key: 'dup', history: EMPTY_BUT_COMPLETE, indexedHead: 1_000n, head: 3_000n, read: rpc.read })
    // The explorer has since indexed up to 2,500, including the log at 2,000.
    const indexed = log(2_000, 4, 1_700_000_123)
    const history = await withRpcTail({ key: 'dup', history: { logs: [indexed], complete: true }, indexedHead: 2_500n, head: 3_010n, read: rpc.read })
    expect(blocksOf(history.logs)).toEqual([2_900, 2_000])
    expect(history.logs[1].time).toBe(1_700_000_123)
    expect(history.complete).toBe(true)
  })

  test('the next poll reads only the blocks that are new since', async () => {
    const rpc = chain([log(4_000), log(5_030)])
    await withRpcTail({ key: 'poll', history: EMPTY_BUT_COMPLETE, indexedHead: 3_000n, head: 5_000n, read: rpc.read })
    rpc.windows.length = 0
    const history = await withRpcTail({ key: 'poll', history: EMPTY_BUT_COMPLETE, indexedHead: 3_000n, head: 5_040n, read: rpc.read })
    expect(rpc.windows).toEqual([[5_001n, 5_040n]])
    expect(blocksOf(history.logs)).toEqual([5_030, 4_000])
    expect(history.complete).toBe(true)
  })

  test('a gap too wide for one read is finished by the next', async () => {
    const rpc = chain([log(2_000), log(19_000)])
    const first = await withRpcTail({ key: 'resume', history: EMPTY_BUT_COMPLETE, indexedHead: 0n, head: 20_000n, read: rpc.read })
    expect(first.complete).toBe(false)
    expect(blocksOf(first.logs)).toEqual([19_000])
    const second = await withRpcTail({ key: 'resume', history: EMPTY_BUT_COMPLETE, indexedHead: 0n, head: 20_010n, read: rpc.read })
    expect(second.complete).toBe(true)
    expect(blocksOf(second.logs)).toEqual([19_000, 2_000])
    expect(second.tail?.from).toBe(1n)
  })

  test('once the tail holds the newest `limit` logs, older blocks are not read and the list counts as complete', async () => {
    const rpc = chain([log(100), log(4_950), log(4_990)])
    const history = await withRpcTail({ key: 'limit', history: EMPTY_BUT_COMPLETE, indexedHead: 0n, head: 5_000n, read: rpc.read, limit: 2 })
    expect(rpc.windows).toHaveLength(1)
    expect(blocksOf(history.logs)).toEqual([4_990, 4_950])
    expect(history.complete).toBe(true)
  })
})

describe('mergeLogs', () => {
  test('one copy per transaction and log index, newest first', () => {
    const a = log(10, 2)
    const sameUpperCase = { ...a, txHash: a.txHash.toUpperCase().replace('0X', '0x') as Hex, time: 99 }
    const merged = mergeLogs([log(5), a], [sameUpperCase, log(10, 1), log(12)])
    expect(merged.map((entry) => [entry.block, entry.logIndex])).toEqual([[12, 0], [10, 2], [10, 1], [5, 0]])
    expect(merged[1].time).toBe(0) // the first list's copy
  })
})

describe('the explorer’s indexed head', () => {
  test('reads items[0].height and refuses anything else', () => {
    expect(parseIndexedHead({ items: [{ height: 63_312_953 }, { height: 63_312_952 }] })).toBe(63_312_953n)
    expect(parseIndexedHead(null)).toBeNull()
    expect(parseIndexedHead({ items: [] })).toBeNull()
    expect(parseIndexedHead({ items: [{ height: '63312953' }] })).toBeNull()
    expect(parseIndexedHead({ items: [{ height: -1 }] })).toBeNull()
    expect(parseIndexedHead({ items: [{ height: 1.5 }] })).toBeNull()
    expect(parseIndexedHead({ items: [{ height: 2 ** 53 }] })).toBeNull()
    expect(parseIndexedHead({ items: ['block'] })).toBeNull()
  })

  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('one request serves every read for about ten seconds; a failure is not kept', async () => {
    const requested: string[] = []
    globalThis.fetch = ((input: RequestInfo | URL) => {
      requested.push(input instanceof Request ? input.url : input.toString())
      return Promise.resolve(new Response(JSON.stringify({ items: [{ height: 42 }] }), { status: 200 }))
    })
    expect(await Promise.all([fetchIndexedHead('https://explorer.test'), fetchIndexedHead('https://explorer.test')])).toEqual([42n, 42n])
    expect(await fetchIndexedHead('https://explorer.test')).toBe(42n)
    expect(requested).toEqual(['https://explorer.test/api/v2/blocks?type=block'])

    globalThis.fetch = (() => Promise.resolve(new Response('{"message":"Too many requests"}', { status: 429 })))
    await expect(fetchIndexedHead('https://other.test')).rejects.toThrow('Explorer 429')
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ items: [{ height: 7 }] }), { status: 200 })))
    expect(await fetchIndexedHead('https://other.test')).toBe(7n)
  })
})

describe('reading the tail', () => {
  test('windows stay within the RPC’s limit, newest first, and never leave the range', async () => {
    const rpc = chain([])
    const range = await readRange({ from: 1_001n, to: 5_000n, windows: 8, read: rpc.read })
    expect(rpc.windows).toEqual([
      [5_000n - WINDOW, 5_000n],
      [5_000n - 2n * WINDOW - 1n, 5_000n - WINDOW - 1n],
      [1_001n, 5_000n - 2n * WINDOW - 2n],
    ])
    expect([range.covered, range.lowest, range.windows]).toEqual([true, 1_001n, 3])
  })

  test('an RPC log takes the explorer’s shape; a pending one is skipped', () => {
    const hash: Hex = `0x${'ab'.repeat(32)}`
    expect(fromRpcLog({ blockNumber: 7n, logIndex: 3, transactionHash: hash, topics: [TOPIC], data: '0x01' })).toEqual({
      block: 7,
      time: 0,
      logIndex: 3,
      txHash: hash,
      topics: [TOPIC],
      data: '0x01',
    })
    expect(fromRpcLog({ blockNumber: null, logIndex: null, transactionHash: null, topics: [TOPIC], data: '0x' })).toBeNull()
  })

  test('block times: the newest blocks and the oldest are read once each, the rest placed between them', async () => {
    const asked: bigint[] = []
    const client = {
      getBlock: ({ blockNumber }: { blockNumber: bigint }) => {
        asked.push(blockNumber)
        return Promise.resolve({ timestamp: blockNumber * 2n })
      },
    }
    const timed = await fillTimes(client, [log(200), log(150), log(100), log(90, 0, 1_234)], 2)
    expect(timed.map((entry) => entry.time)).toEqual([400, 300, 200, 1_234])
    expect(asked.sort()).toEqual([100n, 200n])
    await fillTimes(client, [log(200), log(100)], 2)
    expect(asked).toHaveLength(2)
  })
})
