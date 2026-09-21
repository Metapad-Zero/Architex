import { describe, expect, test } from 'bun:test'
import { getAddress } from 'viem'
import { CURVE, INITIAL_CURVE, quoteBuy, realUsdc } from '../curve'
import type { LaunchRecord } from '../launch'
import { quoteLaunchTrade } from '../launchQuote'

const USDC = 1_000_000n

function launch(creatorFeeBps: number, patch: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    token: getAddress('0x00000000000000000000000000000000000000b1'),
    creator: getAddress('0x00000000000000000000000000000000000000c1'),
    pair: getAddress('0x00000000000000000000000000000000000000f1'),
    ...INITIAL_CURVE,
    createdAt: 0n,
    graduated: false,
    creatorFeeBps,
    pluginHooks: false,
    plugin: getAddress('0x00000000000000000000000000000000000000c1'),
    metadataURI: '',
    name: 'Token',
    symbol: 'TKN',
    ...patch,
  }
}

/** The smallest offer that sells out a fresh curve at this creator fee. */
function sellOutEdge(creatorFeeBps: number): bigint {
  let low = 25_000n * USDC
  let high = 30_000n * USDC
  while (high - low > 1n) {
    const mid = (low + high) / 2n
    if (quoteBuy(INITIAL_CURVE, mid, creatorFeeBps).graduates) high = mid
    else low = mid
  }
  return high
}

describe('launch trade quotes', () => {
  test('the sell-out buy can spend one unit less than the smallest offer that sells out', () => {
    // At 0.37% the curve charges edge − 1 for the last tokens (a Solidity vector pins the same numbers), and an
    // offer of edge − 1 does not sell out. So the trade must be sent with the offer, not the quoted spend.
    const edge = sellOutEdge(37)
    expect(edge).toBe(25_219_408_826n)
    const atEdge = quoteBuy(INITIAL_CURVE, edge, 37)
    expect(atEdge.graduates).toBe(true)
    expect(atEdge.usdcSpent).toBe(edge - 1n)
    expect(quoteBuy(INITIAL_CURVE, atEdge.usdcSpent, 37).graduates).toBe(false)

    const quote = quoteLaunchTrade(launch(37), 'buy', edge, 50)
    expect(quote?.offer).toBe(edge)
    expect(quote?.amountIn).toBe(edge - 1n)
    expect(quote?.graduates).toBe(true)
  })

  test('curve trades quote on the curve, with both fees', () => {
    const buy = quoteLaunchTrade(launch(250), 'buy', 100n * USDC, 50)
    expect(buy?.venue).toBe('curve')
    expect(buy?.platformFee).toBe(500_000n)
    expect(buy?.creatorFee).toBe(2_500_000n)
    expect(buy?.minReceived).toBe(((buy?.amountOut ?? 0n) * 9_950n) / 10_000n)
    expect(quoteLaunchTrade(launch(250), 'sell', 10n ** 18n, 50)).toBe(undefined) // nothing sold yet
  })

  test('a graduated token quotes in its launch pool, and only once the pool is read', () => {
    const end = quoteBuy(INITIAL_CURVE, 1_000_000n * USDC, 100).next
    const graduated = launch(100, { ...end, graduated: true })
    expect(quoteLaunchTrade(graduated, 'buy', 10n * USDC, 50)).toBe(undefined)
    const pooled = { ...graduated, pool: { reserveToken: CURVE.POOL_SUPPLY, reserveUsdc: realUsdc(end) } }
    const buy = quoteLaunchTrade(pooled, 'buy', 10n * USDC, 50)
    expect(buy?.venue).toBe('pool')
    expect(buy?.amountIn).toBe(10n * USDC)
    expect(buy?.platformFee).toBe(50_000n)
    expect(buy?.creatorFee).toBe(100_000n)
    const sell = quoteLaunchTrade(pooled, 'sell', 1_000_000n * 10n ** 18n, 50)
    expect(sell?.venue).toBe('pool')
    expect(sell?.amountIn).toBe(1_000_000n * 10n ** 18n)
  })

  test('nothing to quote for an empty or dust amount', () => {
    expect(quoteLaunchTrade(launch(0), 'buy', 0n, 50)).toBe(undefined)
    expect(quoteLaunchTrade(launch(1_000), 'buy', 2n, 50)).toBe(undefined)
  })
})
