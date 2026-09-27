import type { Address } from 'viem'
import { pairFor, type AmmPair } from './amm'

/**
 * Architex's own pools open for swaps once they hold $50,000 of liquidity (the owner's goal, 2026-09-27). Until then
 * the swap sheet says "Coming soon" and shows a bar filling toward it. Adding liquidity stays open, since that is what
 * fills the bar, and launch tokens are not gated at all: they trade in their own pools, from their own pages.
 */
export const SWAP_OPENING_GOAL_USD = 50_000n * 10n ** 6n

const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase()

/** A pool's liquidity in USD (6 decimals): its USDC side, twice. Undefined for a pool without a USDC side. */
export function poolLiquidityUsd(pair: AmmPair, usdc: Address): bigint | undefined {
  if (same(pair.token0, usdc)) return pair.reserve0 * 2n
  if (same(pair.token1, usdc)) return pair.reserve1 * 2n
  return undefined
}

/** Whether a pool holds the goal. A pool without a USDC side cannot be valued, so it stays closed. */
export function isPoolOpen(pair: AmmPair, usdc: Address): boolean {
  return (poolLiquidityUsd(pair, usdc) ?? 0n) >= SWAP_OPENING_GOAL_USD
}

export interface SwapOpening {
  /** The pool the bar follows: the thinnest pool on the deepest route. */
  pool: AmmPair
  liquidityUsd: bigint
  open: boolean
}

/**
 * Whether a swap between two tokens is open. The router tries the direct pool and the route through USDC
 * (lib/amm.ts), so a swap is open when either route's pools all hold the goal, and the bar follows the deeper route.
 * Undefined when no pool connects the two (the sheet already says so).
 */
export function swapOpening(
  tokenIn: Address | undefined,
  tokenOut: Address | undefined,
  pairs: readonly AmmPair[],
  usdc: Address,
): SwapOpening | undefined {
  if (!tokenIn || !tokenOut || same(tokenIn, tokenOut)) return undefined
  const viaUsdc = same(tokenIn, usdc) || same(tokenOut, usdc) ? [] : [[pairFor(pairs, tokenIn, usdc), pairFor(pairs, usdc, tokenOut)]]
  const routes = [[pairFor(pairs, tokenIn, tokenOut)], ...viaUsdc].filter((route): route is AmmPair[] => route.every(Boolean))
  if (routes.length === 0) return undefined
  const thinnestOf = (route: AmmPair[]) =>
    route
      .map((pool) => ({ pool, liquidityUsd: poolLiquidityUsd(pool, usdc) ?? 0n }))
      .reduce((a, b) => (b.liquidityUsd < a.liquidityUsd ? b : a))
  const best = routes.map(thinnestOf).reduce((a, b) => (b.liquidityUsd > a.liquidityUsd ? b : a))
  return { ...best, open: best.liquidityUsd >= SWAP_OPENING_GOAL_USD }
}

/** How full the bar is, in basis points of the goal: 0 to 10,000. */
export function goalBps(liquidityUsd: bigint): number {
  return Number(liquidityUsd >= SWAP_OPENING_GOAL_USD ? 10_000n : (liquidityUsd * 10_000n) / SWAP_OPENING_GOAL_USD)
}

/** Whole dollars for the bar's label: "$692", "$50,000". */
export function wholeUsd(value: bigint): string {
  return `$${Math.round(Number(value) / 1e6).toLocaleString('en-US')}`
}
