import { describe, expect, test } from 'bun:test'
import { encodeErrorResult, getAddress, getContractError, HttpRequestError, RawContractError, zeroAddress, type Hex } from 'viem'
import { launchpadAbi } from '../abi'
import { laterPageGroups, poolHold, readAllPages, revertErrorName } from '../pairList'

const token = getAddress('0x00000000000000000000000000000000000000b1')

// The error a multicall result carries when curves(token) reverts, built the way viem's multicall builds it.
function curvesRevert(data: Hex) {
  return getContractError(new RawContractError({ data }), { abi: launchpadAbi, address: token, args: [token], functionName: 'curves' })
}

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

describe('held-back launch pools', () => {
  test('holds back a live curve and shows a graduated one', () => {
    expect(poolHold({ status: 'success', result: { token, graduated: false } })).toBe('launch')
    expect(poolHold({ status: 'success', result: { token, graduated: true } })).toBe(undefined)
    expect(poolHold({ status: 'success', result: { token: zeroAddress, graduated: false } })).toBe(undefined)
  })

  test('shows the pool only when the launchpad says UnknownToken', () => {
    const unknown = curvesRevert(encodeErrorResult({ abi: launchpadAbi, errorName: 'UnknownToken' }))
    expect(revertErrorName(unknown)).toBe('UnknownToken')
    expect(poolHold({ status: 'failure', error: unknown })).toBe(undefined)
  })

  test('keeps holding it back until the launchpad answers', () => {
    expect(poolHold(undefined)).toBe('unknown')
    const rateLimited = new HttpRequestError({ url: 'https://rpc.arc.network', status: 429, body: { method: 'eth_call' } })
    expect(poolHold({ status: 'failure', error: rateLimited })).toBe('unknown')
    expect(poolHold({ status: 'failure', error: curvesRevert(encodeErrorResult({ abi: launchpadAbi, errorName: 'Forbidden' })) })).toBe('unknown')
    expect(poolHold({ status: 'failure', error: curvesRevert('0x') })).toBe('unknown')
    expect(poolHold({ status: 'failure', error: new Error('timeout') })).toBe('unknown')
  })
})

describe('the client used for paged lens reads', () => {
  test('does not batch calls into shared multicalls, which would merge page groups back into one request', async () => {
    const { lensClient } = await import('../lensClient')
    expect(Boolean(lensClient.batch?.multicall)).toBe(false)
  })
})
