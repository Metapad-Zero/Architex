import type { Address } from 'viem'

export const FEE_NUMERATOR = 997n
export const FEE_DENOMINATOR = 1000n
export const BPS_DENOMINATOR = 10_000n
const PRICE_SCALE = 10n ** 18n

export interface AmmPair {
  pair: Address
  token0: Address
  token1: Address
  reserve0: bigint
  reserve1: bigint
  totalSupply: bigint
}

export interface RouteQuote {
  path: Address[]
  amountIn: bigint
  amountOut: bigint
  pairs: AmmPair[]
}

export type QuoteMode = 'exactIn' | 'exactOut'

export function quote(amountA: bigint, reserveA: bigint, reserveB: bigint): bigint {
  if (amountA <= 0n || reserveA <= 0n || reserveB <= 0n) return 0n
  return (amountA * reserveB) / reserveA
}

export function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n
  const amountInWithFee = amountIn * FEE_NUMERATOR
  return (amountInWithFee * reserveOut) / (reserveIn * FEE_DENOMINATOR + amountInWithFee)
}

export function getAmountIn(amountOut: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountOut <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n
  if (amountOut >= reserveOut) throw new Error('InsufficientLiquidity')
  return (reserveIn * amountOut * FEE_DENOMINATOR) / ((reserveOut - amountOut) * FEE_NUMERATOR) + 1n
}

export function minReceived(amountOut: bigint, slippageBps: bigint | number): bigint {
  const bps = BigInt(slippageBps)
  return (amountOut * (BPS_DENOMINATOR - bps)) / BPS_DENOMINATOR
}

export function maxSent(amountIn: bigint, slippageBps: bigint | number): bigint {
  const bps = BigInt(slippageBps)
  return (amountIn * (BPS_DENOMINATOR + bps)) / BPS_DENOMINATOR
}

export function pairKey(tokenA: Address, tokenB: Address): string {
  const a = tokenA.toLowerCase()
  const b = tokenB.toLowerCase()
  return a < b ? `${a}:${b}` : `${b}:${a}`
}

export function reservesFor(pair: AmmPair, tokenIn: Address): [bigint, bigint] {
  return pair.token0.toLowerCase() === tokenIn.toLowerCase()
    ? [pair.reserve0, pair.reserve1]
    : [pair.reserve1, pair.reserve0]
}

export function pairFor(pairs: readonly AmmPair[], tokenA: Address, tokenB: Address): AmmPair | undefined {
  const key = pairKey(tokenA, tokenB)
  return pairs.find((pair) => pairKey(pair.token0, pair.token1) === key)
}

function candidatePaths(tokenIn: Address, tokenOut: Address, usdc: Address): Address[][] {
  const direct = [tokenIn, tokenOut]
  const canRouteViaUsdc =
    tokenIn.toLowerCase() !== usdc.toLowerCase() && tokenOut.toLowerCase() !== usdc.toLowerCase()
  return canRouteViaUsdc ? [direct, [tokenIn, usdc, tokenOut]] : [direct]
}

function pairsForPath(path: Address[], pairs: readonly AmmPair[]): AmmPair[] | undefined {
  const routePairs: AmmPair[] = []
  for (let index = 0; index < path.length - 1; index += 1) {
    const pair = pairFor(pairs, path[index], path[index + 1])
    if (!pair || pair.reserve0 === 0n || pair.reserve1 === 0n) return undefined
    routePairs.push(pair)
  }
  return routePairs
}

export function findBestRoute(
  mode: QuoteMode,
  amount: bigint,
  tokenIn: Address,
  tokenOut: Address,
  usdc: Address,
  pairs: readonly AmmPair[],
): RouteQuote | undefined {
  if (amount <= 0n || tokenIn.toLowerCase() === tokenOut.toLowerCase()) return undefined

  const routes: RouteQuote[] = []
  for (const path of candidatePaths(tokenIn, tokenOut, usdc)) {
    const routePairs = pairsForPath(path, pairs)
    if (!routePairs) continue
    try {
      if (mode === 'exactIn') {
        let amountOut = amount
        for (let index = 0; index < routePairs.length; index += 1) {
          const [reserveIn, reserveOut] = reservesFor(routePairs[index], path[index])
          amountOut = getAmountOut(amountOut, reserveIn, reserveOut)
        }
        if (amountOut > 0n) routes.push({ path, amountIn: amount, amountOut, pairs: routePairs })
      } else {
        let amountIn = amount
        for (let index = routePairs.length - 1; index >= 0; index -= 1) {
          const [reserveIn, reserveOut] = reservesFor(routePairs[index], path[index])
          amountIn = getAmountIn(amountIn, reserveIn, reserveOut)
        }
        if (amountIn > 0n) routes.push({ path, amountIn, amountOut: amount, pairs: routePairs })
      }
    } catch {
      continue
    }
  }

  return routes.reduce<RouteQuote | undefined>((best, current) => {
    if (!best) return current
    if (mode === 'exactIn') return current.amountOut > best.amountOut ? current : best
    return current.amountIn < best.amountIn ? current : best
  }, undefined)
}

/**
 * Price impact = how far the execution price falls below the pool mid-price, in bps.
 * The 0.30% fee per hop is removed from the mid-price first so the impact line measures
 * only the trade's own effect on the pool; the fee is shown on its own receipt line.
 */
export function priceImpactBps(route: RouteQuote): bigint {
  if (route.amountIn <= 0n || route.amountOut <= 0n) return 0n
  let midPriceScaled = PRICE_SCALE
  for (let index = 0; index < route.pairs.length; index += 1) {
    const [reserveIn, reserveOut] = reservesFor(route.pairs[index], route.path[index])
    const legPrice = (reserveOut * PRICE_SCALE) / reserveIn
    midPriceScaled = (midPriceScaled * legPrice * FEE_NUMERATOR) / (PRICE_SCALE * FEE_DENOMINATOR)
  }
  if (midPriceScaled === 0n) return 0n
  const executionPriceScaled = (route.amountOut * PRICE_SCALE) / route.amountIn
  if (executionPriceScaled >= midPriceScaled) return 0n
  return ((midPriceScaled - executionPriceScaled) * BPS_DENOMINATOR) / midPriceScaled
}

export function sqrt(value: bigint): bigint {
  if (value < 0n) throw new Error('Square root of negative value')
  if (value < 2n) return value
  let x0 = value / 2n
  let x1 = (x0 + value / x0) / 2n
  while (x1 < x0) {
    x0 = x1
    x1 = (x0 + value / x0) / 2n
  }
  return x0
}

export function liquidityMinted(
  amountA: bigint,
  amountB: bigint,
  reserveA: bigint,
  reserveB: bigint,
  totalSupply: bigint,
): bigint {
  if (amountA <= 0n || amountB <= 0n) return 0n
  if (totalSupply === 0n) {
    const initial = sqrt(amountA * amountB)
    return initial > 1000n ? initial - 1000n : 0n
  }
  if (reserveA === 0n || reserveB === 0n) return 0n
  const fromA = (amountA * totalSupply) / reserveA
  const fromB = (amountB * totalSupply) / reserveB
  return fromA < fromB ? fromA : fromB
}

export function liquidityShareBps(lpOut: bigint, totalSupply: bigint): bigint {
  const nextSupply = totalSupply + lpOut
  return nextSupply === 0n ? 0n : (lpOut * BPS_DENOMINATOR) / nextSupply
}

export function removeAmounts(
  liquidity: bigint,
  reserve0: bigint,
  reserve1: bigint,
  totalSupply: bigint,
): [bigint, bigint] {
  if (liquidity <= 0n || totalSupply <= 0n) return [0n, 0n]
  return [(liquidity * reserve0) / totalSupply, (liquidity * reserve1) / totalSupply]
}
