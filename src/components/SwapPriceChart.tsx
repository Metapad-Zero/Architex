import { useMemo } from 'react'
import { activeChain } from '../chain'
import type { AmmPair } from '../lib/amm'
import type { Token } from '../lib/tokens'
import { usePriceHistory } from '../hooks/usePriceHistory'
import { PriceHistory, pairSeries } from './PriceHistory'

interface SwapPriceChartProps {
  tokenIn: Token
  tokenOut: Token
  pairs: readonly AmmPair[]
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * The price history of the pool a swap goes through, under the swap sheet. Drawn only when the two
 * tokens share a pool that holds liquidity: a routed swap crosses two pools and has no single series.
 * Prices are quoted in USDC when USDC is one side, otherwise in the token being paid.
 */
export default function SwapPriceChart({ tokenIn, tokenOut, pairs }: SwapPriceChartProps) {
  const pair = useMemo(
    () =>
      pairs.find(
        (item) =>
          ((same(item.token0, tokenIn.address) && same(item.token1, tokenOut.address)) ||
            (same(item.token0, tokenOut.address) && same(item.token1, tokenIn.address))) &&
          item.reserve0 > 0n &&
          item.reserve1 > 0n,
      ),
    [pairs, tokenIn.address, tokenOut.address],
  )
  const quote = same(tokenOut.address, activeChain.usdc) ? tokenOut : tokenIn
  const base = quote === tokenIn ? tokenOut : tokenIn
  const history = usePriceHistory(pair?.pair, Boolean(pair))
  const series = useMemo(
    () => (pair ? pairSeries(history.data?.points ?? [], base, quote, same(pair.token1, quote.address)) : []),
    [base, history.data, pair, quote],
  )

  if (!pair) return null
  return (
    <section className="mt-14" aria-label="Price history">
      <PriceHistory series={series} title="Price history" unit={`${quote.symbol} per ${base.symbol}`} partial={history.data ? !history.data.complete : false} loading={history.isLoading} />
    </section>
  )
}
