import { describe, expect, test } from 'bun:test'
import { getAddress, HttpRequestError, zeroAddress } from 'viem'
import { laterPageGroups, readAllPages, withoutLaunchPools } from '../pairList'

const token = getAddress('0x00000000000000000000000000000000000000b1')

describe('lens paging', () => {
  test('needs no more pages while the list fits the first', () => {
    expect(laterPageGroups(0n)).toEqual([])
    expect(laterPageGroups(200n)).toEqual([])
  })

  test('groups later pages a few to a request', () => {
    expect(laterPageGroups(201n)).toEqual([[200n]])
    expect(laterPageGroups(1_001n)).toEqual([[200n, 400n, 600n, 800n], [1_000n]])
    expect(laterPageGroups(10n, 3n, 2)).toEqual([[3n, 6n], [9n]])
  })

  test('reads one request for a list that fits a page', async () => {
    const groups: (readonly bigint[])[] = []
    const rows = await readAllPages(
      () => Promise.resolve([2n, ['a', 'b']] as const),
      (starts) => {
        groups.push(starts)
        return Promise.resolve([])
      },
    )
    expect(rows).toEqual(['a', 'b'])
    expect(groups).toEqual([])
  })

  test('reads every later page, in order, past the first 200', async () => {
    const rows = await readAllPages(
      () => Promise.resolve([1_001n, ['p0']] as const),
      (starts) => Promise.resolve(starts.map((start) => [`p${start}`])),
    )
    expect(rows).toEqual(['p0', 'p200', 'p400', 'p600', 'p800', 'p1000'])
  })
})

describe('launch tokens stay out of core pools', () => {
  const usdc = getAddress('0x3600000000000000000000000000000000000000')
  const other = getAddress('0x00000000000000000000000000000000000000c2')
  const pairs = [
    { pair: getAddress('0x00000000000000000000000000000000000000f1'), token0: usdc, token1: token },
    { pair: getAddress('0x00000000000000000000000000000000000000f2'), token0: other, token1: usdc },
    { pair: getAddress('0x00000000000000000000000000000000000000f3'), token0: usdc, token1: getAddress('0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1') },
  ]
  const candidates = [token.toLowerCase(), other.toLowerCase()]
  const plugin = getAddress('0x00000000000000000000000000000000000000e1')

  test('drops a pool holding a launch token and keeps the rest', () => {
    const shown = withoutLaunchPools(pairs, candidates, [
      { status: 'success', result: plugin },
      { status: 'success', result: zeroAddress },
    ])
    expect(shown.map((pair) => pair.pair)).toEqual([pairs[1].pair, pairs[2].pair])
  })

  test('holds a token back until the launchpad has answered for it', () => {
    expect(withoutLaunchPools(pairs, candidates, undefined).map((pair) => pair.pair)).toEqual([pairs[2].pair])
    const rateLimited = new HttpRequestError({ url: 'https://rpc.arc.network', status: 429, body: { method: 'eth_call' } })
    const shown = withoutLaunchPools(pairs, candidates, [{ status: 'success', result: zeroAddress }, { status: 'failure', error: rateLimited }])
    expect(shown.map((pair) => pair.pair)).toEqual([pairs[0].pair, pairs[2].pair])
  })

  test('asks nothing and hides nothing without a launchpad', () => {
    expect(withoutLaunchPools(pairs, [], undefined)).toEqual(pairs)
  })
})

describe('the client used for paged lens reads', () => {
  test('does not batch calls into shared multicalls, which would merge page groups back into one request', async () => {
    const { lensClient } = await import('../lensClient')
    expect(Boolean(lensClient.batch?.multicall)).toBe(false)
  })
})
