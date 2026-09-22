import { describe, expect, test } from 'bun:test'
import { getAddress, type Address } from 'viem'
import { findBestRoute, priceImpactBps, quote as ratioQuote, type AmmPair } from '../amm'
import { CURVE, INITIAL_CURVE, quoteBuy, realUsdc } from '../curve'
import {
  IMPACT_ACKNOWLEDGE_BPS,
  IMPACT_CAUTION_BPS,
  IMPACT_HIGH_BPS,
  IMPACT_HINT_TARGET_BPS,
  IMPACT_REFUSE_BPS,
  acknowledgmentKey,
  acknowledgmentText,
  floorToSignificant,
  formatLossUsd,
  impactAllows,
  impactSizeHint,
  impactTier,
  isHighImpact,
  launchImpactLossUsd,
  maxLaunchBuy,
  maxLaunchSell,
  maxLaunchTrade,
  maxRouteInput,
  maxSingleHopInput,
  swapImpactLossUsd,
  swapImpactLossUsdFromOutput,
  wholePercent,
} from '../impactGuard'
import type { LaunchRecord } from '../launch'
import { quoteLaunchTrade } from '../launchQuote'

const USDC = 1_000_000n
const address = (value: number): Address => `0x${value.toString(16).padStart(40, '0')}`
const usdc = address(0x3600)
const eurc = address(0xe0)
const weth = address(0xe1)
const wbtc = address(0xe2)

function pair(pairAddress: number, token0: Address, token1: Address, reserve0: bigint, reserve1: bigint): AmmPair {
  return { pair: address(pairAddress), token0, token1, reserve0, reserve1, totalSupply: 1_000_000n }
}

// The mainnet USDC/EURC pool the owner traded against on 2026-09-22: 281.638016 USDC / 244.524893 EURC.
const mainnetPool = pair(1, usdc, eurc, 281_638_016n, 244_524_893n)

/** Constant product with the 0.30% fee on every hop, in floating point: the formula the guard is held to. */
function floatImpact(amountIn: number, hops: readonly { reserveIn: number; reserveOut: number }[]): number {
  let amount = amountIn
  let mid = 1
  for (const hop of hops) {
    const withFee = amount * 0.997
    amount = (withFee * hop.reserveOut) / (hop.reserveIn + withFee)
    mid *= (hop.reserveOut / hop.reserveIn) * 0.997
  }
  return 1 - amount / amountIn / mid
}

/** The input at which `floatImpact` reaches `target`, by bisection. */
function floatMaxInput(hops: readonly { reserveIn: number; reserveOut: number }[], target: number): number {
  let low = 0
  let high = hops[0].reserveIn
  while (floatImpact(high, hops) < target) high *= 2
  for (let step = 0; step < 200; step += 1) {
    const middle = (low + high) / 2
    if (floatImpact(middle, hops) < target) low = middle
    else high = middle
  }
  return low
}

function impactAt(amount: bigint, tokenIn: Address, tokenOut: Address, pairs: readonly AmmPair[]): bigint {
  const route = findBestRoute('exactIn', amount, tokenIn, tokenOut, usdc, pairs)
  if (!route) throw new Error('no route')
  return priceImpactBps(route)
}

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

const scaled = (value: bigint, perMille: bigint) => (value * perMille) / 1_000n

describe('impact tiers', () => {
  test('the thresholds are 1%, 5%, 15% and 50%, and the hint aims under 1%', () => {
    expect(IMPACT_CAUTION_BPS).toBe(100n)
    expect(IMPACT_HIGH_BPS).toBe(500n)
    expect(IMPACT_ACKNOWLEDGE_BPS).toBe(1_500n)
    expect(IMPACT_REFUSE_BPS).toBe(5_000n)
    expect(IMPACT_HINT_TARGET_BPS).toBe(100n)
  })

  test('each bound belongs to the tier above it', () => {
    expect(impactTier(0n)).toBe('normal')
    expect(impactTier(99n)).toBe('normal')
    expect(impactTier(100n)).toBe('caution')
    expect(impactTier(499n)).toBe('caution')
    expect(impactTier(500n)).toBe('high')
    expect(impactTier(1_499n)).toBe('high')
    expect(impactTier(1_500n)).toBe('acknowledge')
    expect(impactTier(4_999n)).toBe('acknowledge')
    expect(impactTier(5_000n)).toBe('refused')
    expect(impactTier(9_999n)).toBe('refused')
    // A launch sheet's impact is a price move, which can pass 100% on a big buy.
    expect(impactTier(150_000n)).toBe('refused')
    expect(isHighImpact(499n)).toBe(false)
    expect(isHighImpact(500n)).toBe(true)
  })

  test('approval and the trade wait for the acknowledgment from 15%, and never happen from 50%', () => {
    for (const bps of [0n, 99n, 100n, 499n, 500n, 1_499n]) {
      expect(impactAllows(bps, false)).toBe(true)
      expect(impactAllows(bps, true)).toBe(true)
    }
    for (const bps of [1_500n, 4_145n, 4_999n]) {
      expect(impactAllows(bps, false)).toBe(false)
      expect(impactAllows(bps, true)).toBe(true)
    }
    for (const bps of [5_000n, 6_390n, 150_000n]) {
      expect(impactAllows(bps, false)).toBe(false)
      expect(impactAllows(bps, true)).toBe(false)
    }
  })

  test('an acknowledgment is kept against the trade and the sentence, and lapses when either changes', () => {
    const sentence = 'I accept losing about $83 to a 41% price impact'
    const given = acknowledgmentKey([usdc, eurc, 'exactIn', 200n * USDC, `${usdc}>${eurc}`], sentence)
    expect(acknowledgmentKey([usdc, eurc, 'exactIn', 200n * USDC, `${usdc}>${eurc}`], sentence)).toBe(given)
    expect(acknowledgmentKey([usdc, eurc, 'exactIn', 201n * USDC, `${usdc}>${eurc}`], sentence)).not.toBe(given)
    expect(acknowledgmentKey([usdc, weth, 'exactIn', 200n * USDC, `${usdc}>${weth}`], sentence)).not.toBe(given)
    expect(acknowledgmentKey([usdc, eurc, 'exactIn', 200n * USDC, `${usdc}>${weth}>${eurc}`], sentence)).not.toBe(given)
    expect(acknowledgmentKey([usdc, eurc, 'exactOut', 200n * USDC, `${usdc}>${eurc}`], sentence)).not.toBe(given)
    expect(acknowledgmentKey([usdc, eurc, 'exactIn', 200n * USDC, `${usdc}>${eurc}`], 'I accept losing about $90 to a 44% price impact')).not.toBe(given)
  })
})

describe('what price impact costs in dollars', () => {
  test('200 USDC into the mainnet pool: 41.45% impact, about $83', () => {
    const route = findBestRoute('exactIn', 200n * USDC, usdc, eurc, usdc, [mainnetPool])!
    expect(route.amountOut).toBe(101_360_520n)
    const impact = priceImpactBps(route)
    expect(impact).toBe(4_145n)
    const loss = swapImpactLossUsd(200n * USDC, impact, 1)
    // 200 x 0.997 (the fee) x 41.45%.
    expect(loss).toBe(82_651_300n)
    expect(formatLossUsd(loss)).toBe('$83')
    // The same figure from the definition: what the trade would get at the pool's price before it, after the fee,
    // less what it gets, both valued at that price (the sheet's "$116.745" under You receive).
    const received = ratioQuote(route.amountOut, mainnetPool.reserve1, mainnetPool.reserve0)
    expect(received).toBe(116_744_661n)
    const byDefinition = (200n * USDC * 997n) / 1_000n - received
    expect(loss > byDefinition - 10_000n && loss < byDefinition + 10_000n).toBe(true)
    // From the receive side, for a pay token without a USD price: within a cent.
    const fromOutput = swapImpactLossUsdFromOutput(received, impact)
    expect(fromOutput > loss - 10_000n && fromOutput < loss + 10_000n).toBe(true)
  })

  test('each hop takes its fee before the impact is measured, and nothing is lost without impact', () => {
    expect(swapImpactLossUsd(200n * USDC, 4_145n, 2)).toBe(82_403_346n)
    expect(swapImpactLossUsd(200n * USDC, 0n, 1)).toBe(0n)
    expect(swapImpactLossUsd(0n, 4_145n, 1)).toBe(0n)
    expect(swapImpactLossUsdFromOutput(116n * USDC, 10_000n)).toBe(0n)
  })

  test('the loss is said in cents under $10 and in whole dollars above, and not at all under half a cent', () => {
    expect(formatLossUsd(4_999n)).toBe(undefined)
    expect(formatLossUsd(5_000n)).toBe('$0.01')
    expect(formatLossUsd(604_000n)).toBe('$0.60')
    expect(formatLossUsd(4_370_000n)).toBe('$4.37')
    expect(formatLossUsd(9_994_999n)).toBe('$9.99')
    expect(formatLossUsd(9_995_000n)).toBe('$10')
    expect(formatLossUsd(1_204_400_000n)).toBe('$1,204')
    expect(formatLossUsd(1_234_567_890_000n)).toBe('$1,234,568')
  })

  test('the acknowledgment names the loss and the impact, rounded to a whole percent', () => {
    expect(acknowledgmentText(4_145n, 82_651_300n)).toBe('I accept losing about $83 to a 41% price impact')
    expect(acknowledgmentText(4_145n, undefined)).toBe('I accept a 41% price impact')
    expect(acknowledgmentText(4_145n, 1_000n)).toBe('I accept a 41% price impact')
    expect(acknowledgmentText(1_800n, 5_000_000n)).toBe('I accept losing about $5.00 to an 18% price impact')
    expect(acknowledgmentText(1_549n, 20_000_000n)).toBe('I accept losing about $20 to a 15% price impact')
    expect(wholePercent(1_550n)).toBe('16%')
    expect(wholePercent(100n)).toBe('1%')
  })
})

describe('the largest trade that stays under 1%', () => {
  test('one pool: t·R / (f·(1 - t)), 2.853 USDC for the mainnet pool', () => {
    const max = maxSingleHopInput(mainnetPool.reserve0)
    expect(max).toBe(2_853_388n)
    const float = floatMaxInput([{ reserveIn: 281_638_016, reserveOut: 244_524_893 }], 0.01)
    expect(Math.abs(Number(max) - float)).toBeLessThan(1)
    expect(Math.abs(floatImpact(Number(max), [{ reserveIn: 281_638_016, reserveOut: 244_524_893 }]) - 0.01)).toBeLessThan(1e-6)
    // The pool's own quote agrees on either side of it.
    expect(impactAt(scaled(max, 999n), usdc, eurc, [mainnetPool])).toBeLessThan(100n)
    expect(impactAt(scaled(max, 1_001n), usdc, eurc, [mainnetPool])).toBeGreaterThan(99n)
    expect(impactSizeHint(max, 6, 'USDC')).toBe('Under 1% impact here: about 2.85 USDC or less.')
  })

  test('the route of a quote uses the closed form for one pool', () => {
    const route = findBestRoute('exactIn', 200n * USDC, usdc, eurc, usdc, [mainnetPool])!
    expect(maxRouteInput(route)).toBe(maxSingleHopInput(mainnetPool.reserve0))
    const reverse = findBestRoute('exactOut', 100n * USDC, eurc, usdc, usdc, [mainnetPool])!
    expect(maxRouteInput(reverse)).toBe(maxSingleHopInput(mainnetPool.reserve1))
  })

  test('two pools through USDC: a bounded search over the route quote lands where the formula does', () => {
    const pairs = [
      pair(2, weth, usdc, 50n * 10n ** 18n, 150_000n * USDC),
      pair(3, usdc, wbtc, 80_000n * USDC, 2n * 10n ** 8n),
    ]
    const route = findBestRoute('exactIn', 10n * 10n ** 18n, weth, wbtc, usdc, pairs)!
    expect(route.path).toEqual([weth, usdc, wbtc])
    expect(priceImpactBps(route)).toBeGreaterThan(IMPACT_HIGH_BPS)
    const max = maxRouteInput(route)
    const float = floatMaxInput(
      [
        { reserveIn: 50e18, reserveOut: 150_000e6 },
        { reserveIn: 80_000e6, reserveOut: 2e8 },
      ],
      0.01,
    )
    // Within 0.1%: the quote works in whole units, and WBTC's 8 decimals leave its impact coarser than the formula's.
    expect(Math.abs(Number(max) / float - 1)).toBeLessThan(1e-3)
    expect(impactAt(max, weth, wbtc, pairs)).toBeLessThan(100n)
    expect(impactAt(scaled(max, 1_001n), weth, wbtc, pairs)).toBeGreaterThan(99n)
    // A route already under 1% searches upward to the same place (within the quote's whole-unit steps).
    const small = findBestRoute('exactIn', 10n ** 15n, weth, wbtc, usdc, pairs)!
    const upward = maxRouteInput(small)
    expect(Math.abs(Number(upward) / Number(max) - 1)).toBeLessThan(1e-3)
    expect(impactAt(upward, weth, wbtc, pairs)).toBeLessThan(100n)
  })

  test('the hint rounds down to three significant digits and is left out when that is zero', () => {
    expect(floorToSignificant(2_853_383n)).toBe(2_850_000n)
    expect(floorToSignificant(999n)).toBe(999n)
    expect(floorToSignificant(0n)).toBe(0n)
    expect(impactSizeHint(0n, 6, 'USDC')).toBe(undefined)
    expect(impactSizeHint(10n ** 11n, 18, 'TKN')).toBe(undefined)
    expect(impactSizeHint(5_372_981n * 10n ** 18n, 18, 'TKN')).toBe('Under 1% impact here: about 5,370,000 TKN or less.')
  })
})

describe('launch trades', () => {
  test('a curve buy: the largest offer that moves the price under 1%, after both fees', () => {
    const fresh = launch(100)
    const max = maxLaunchTrade(fresh, 'buy')
    // n < U·(√1.01 - 1), and the 0.5% + 1% fees come off the offer first.
    const float = (8_333_333_333 * (Math.sqrt(1.01) - 1)) / (1 - 0.015)
    expect(Math.abs(Number(max) - float)).toBeLessThan(2)
    expect(quoteLaunchTrade(fresh, 'buy', max, 50)!.priceImpactBps).toBeLessThan(100n)
    expect(quoteLaunchTrade(fresh, 'buy', scaled(max, 1_002n), 50)!.priceImpactBps).toBeGreaterThan(99n)
    expect(impactSizeHint(max, 6, 'USDC')).toBe('Under 1% impact here: about 42.1 USDC or less.')
  })

  test('a curve sell: the largest amount of tokens that moves the price under 1%', () => {
    const bought = launch(100, quoteBuy(INITIAL_CURVE, 5_000n * USDC, 100).next)
    const max = maxLaunchTrade(bought, 'sell')
    const float = Number(bought.virtualTokens) * (1 / Math.sqrt(0.99) - 1)
    expect(Math.abs(Number(max) / float - 1)).toBeLessThan(1e-9)
    expect(quoteLaunchTrade(bought, 'sell', max, 50)!.priceImpactBps).toBeLessThan(100n)
    expect(quoteLaunchTrade(bought, 'sell', scaled(max, 1_002n), 50)!.priceImpactBps).toBeGreaterThan(99n)
  })

  test('the launch pool after graduation, both ways', () => {
    const end = quoteBuy(INITIAL_CURVE, 1_000_000n * USDC, 100).next
    const pooled = launch(100, { ...end, graduated: true, pool: { reserveToken: CURVE.POOL_SUPPLY, reserveUsdc: realUsdc(end) } })
    const buy = maxLaunchTrade(pooled, 'buy')
    expect(buy).toBe(maxLaunchBuy(realUsdc(end), 100))
    expect(quoteLaunchTrade(pooled, 'buy', buy, 50)!.priceImpactBps).toBeLessThan(100n)
    expect(quoteLaunchTrade(pooled, 'buy', scaled(buy, 1_002n), 50)!.priceImpactBps).toBeGreaterThan(99n)
    const sell = maxLaunchTrade(pooled, 'sell')
    expect(sell).toBe(maxLaunchSell(CURVE.POOL_SUPPLY))
    expect(quoteLaunchTrade(pooled, 'sell', sell, 50)!.priceImpactBps).toBeLessThan(100n)
    expect(quoteLaunchTrade(pooled, 'sell', scaled(sell, 1_002n), 50)!.priceImpactBps).toBeGreaterThan(99n)
    // Not read yet: no hint rather than a wrong one.
    expect(maxLaunchTrade(launch(100, { ...end, graduated: true }), 'buy')).toBe(0n)
  })

  test('a curve buy costs the tokens it did not get at the price before it, fees aside', () => {
    const fresh = launch(100)
    const quote = quoteLaunchTrade(fresh, 'buy', 1_000n * USDC, 50)!
    // 985 USDC after fees into 8,333.33 USDC of virtual reserve: the price moves 25%, and n²/(U + n) is lost.
    expect(impactTier(quote.priceImpactBps)).toBe('acknowledge')
    const net = 985
    const float = (net * net) / (8_333.333333 + net)
    const loss = launchImpactLossUsd(fresh, 'buy', quote)
    expect(Math.abs(Number(loss) / 1e6 - float)).toBeLessThan(0.0001)
    expect(acknowledgmentText(quote.priceImpactBps, loss)).toBe('I accept losing about $104 to a 25% price impact')
  })

  test('a sell costs the USDC it did not get at the price before it, fees aside, on the curve and in the pool', () => {
    const bought = launch(100, quoteBuy(INITIAL_CURVE, 5_000n * USDC, 100).next)
    const tokens = bought.tokensSold / 2n
    const quote = quoteLaunchTrade(bought, 'sell', tokens, 50)!
    const [u, t, x] = [Number(bought.virtualUsdc), Number(bought.virtualTokens), Number(tokens)]
    const float = (u * x * x) / (t * (t + x))
    expect(Math.abs(Number(launchImpactLossUsd(bought, 'sell', quote)) - float)).toBeLessThan(2)

    const end = quoteBuy(INITIAL_CURVE, 1_000_000n * USDC, 100).next
    const pool = { reserveToken: CURVE.POOL_SUPPLY, reserveUsdc: realUsdc(end) }
    const pooled = launch(100, { ...end, graduated: true, pool })
    const poolBuy = quoteLaunchTrade(pooled, 'buy', 2_000n * USDC, 50)!
    const n = Number(poolBuy.amountIn - poolBuy.platformFee - poolBuy.creatorFee)
    const floatBuy = (n * n) / (Number(pool.reserveUsdc) + n)
    expect(Math.abs(Number(launchImpactLossUsd(pooled, 'buy', poolBuy)) - floatBuy)).toBeLessThan(2)
  })
})
