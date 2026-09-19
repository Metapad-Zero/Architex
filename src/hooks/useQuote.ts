import { useMemo } from 'react'
import type { Address } from 'viem'
import {
  findBestRoute,
  maxSent,
  minReceived,
  priceImpactBps,
  type AmmPair,
  type QuoteMode,
  type RouteQuote,
  pairKey,
  reservesFor,
} from '../lib/amm'
import { parseAmount } from '../lib/format'
import type { Token } from '../lib/tokens'

export type NoQuoteReason = 'NoRoute' | 'InsufficientLiquidity' | 'ZeroAmount'

export interface LocalQuote extends RouteQuote {
  priceImpactBps: bigint
  minReceived: bigint
  maxSent: bigint
  /** amountIn as a share of the first hop's input reserve, in bps — "this trade uses 10% of the pool". */
  poolShareBps: bigint
}

export function useQuote(
  tokenIn: Token | undefined,
  tokenOut: Token | undefined,
  amount: string,
  mode: QuoteMode,
  pairs: readonly AmmPair[],
  usdc: Address,
  slippageBps: number,
): { quote: LocalQuote | undefined; reason: NoQuoteReason | undefined } {
  return useMemo(() => {
    if (!tokenIn || !tokenOut || !amount) return { quote: undefined, reason: 'ZeroAmount' as const }
    let parsed: bigint
    try {
      parsed = parseAmount(amount, mode === 'exactIn' ? tokenIn.decimals : tokenOut.decimals)
    } catch {
      return { quote: undefined, reason: 'ZeroAmount' as const }
    }
    if (parsed === 0n) return { quote: undefined, reason: 'ZeroAmount' as const }

    const route = findBestRoute(mode, parsed, tokenIn.address, tokenOut.address, usdc, pairs)
    if (!route) {
      const keys = new Set(pairs.map((pair) => pairKey(pair.token0, pair.token1)))
      const hasDirect = keys.has(pairKey(tokenIn.address, tokenOut.address))
      const hasViaUsdc =
        tokenIn.address.toLowerCase() !== usdc.toLowerCase()
        && tokenOut.address.toLowerCase() !== usdc.toLowerCase()
        && keys.has(pairKey(tokenIn.address, usdc))
        && keys.has(pairKey(usdc, tokenOut.address))
      return { quote: undefined, reason: hasDirect || hasViaUsdc ? ('InsufficientLiquidity' as const) : ('NoRoute' as const) }
    }
    const [reserveIn] = reservesFor(route.pairs[0], route.path[0])
    return {
      quote: {
        ...route,
        priceImpactBps: priceImpactBps(route),
        minReceived: minReceived(route.amountOut, slippageBps),
        maxSent: maxSent(route.amountIn, slippageBps),
        poolShareBps: reserveIn > 0n ? (route.amountIn * 10_000n) / reserveIn : 0n,
      },
      reason: undefined,
    }
  }, [amount, mode, pairs, slippageBps, tokenIn, tokenOut, usdc])
}
