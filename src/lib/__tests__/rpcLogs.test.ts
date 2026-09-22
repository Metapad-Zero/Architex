import { beforeEach, describe, expect, test } from 'bun:test'
import { blockTimes, readLogWindows, resetBlockTimeCache } from '../rpcLogs'

beforeEach(() => resetBlockTimeCache())

const HEAD = 1_000_000n

/** Fake client whose block `n` has timestamp `n + 7`; records every block asked for. */
function client() {
  const asked: bigint[] = []
  return {
    asked,
    getBlock: ({ blockNumber }: { blockNumber: bigint }) => {
      asked.push(blockNumber)
      return Promise.resolve({ timestamp: blockNumber + 7n })
    },
  }
}

describe('blockTimes', () => {
  test('times the newest blocks when there are more than it may read', async () => {
    // eth_getLogs returns each window oldest first, so the newest block comes last.
    const { logs } = await readLogWindows({
      head: HEAD,
      windows: 1,
      read: () => Promise.resolve(Array.from({ length: 60 }, (_, index) => HEAD - 59n + BigInt(index))),
    })
    const fake = client()
    const times = await blockTimes(fake, logs, 40)
    expect(fake.asked.length).toBe(40)
    expect(times.get(HEAD)).toBe(Number(HEAD + 7n))
    expect(times.get(HEAD - 39n)).toBe(Number(HEAD - 32n))
    expect(times.has(HEAD - 40n)).toBe(false)
  })

  test('reads each block once and skips pending logs', async () => {
    const fake = client()
    const times = await blockTimes(fake, [5n, null, 9n, 5n, 9n, 7n])
    expect(fake.asked.length).toBe(3)
    expect(new Set(fake.asked)).toEqual(new Set([5n, 7n, 9n]))
    expect(times.get(5n)).toBe(12)
    expect(times.get(9n)).toBe(16)
  })
})
