import { useMemo } from 'react'
import { activeChain, addressExplorerUrl } from '../chain'
import { quote as ratioQuote, reservesFor, type AmmPair } from '../lib/amm'
import { formatAmount, formatLp, formatPct, shortAddress } from '../lib/format'
import type { Token } from '../lib/tokens'
import { usePriceHistory } from '../hooks/usePriceHistory'
import { ExternalLinkIcon } from './Icons'
import { PriceHistory, pairSeries } from './PriceHistory'

interface PoolDetailProps {
  pair: AmmPair
  token0: Token
  token1: Token
  /** The connected wallet's LP balance in this pool, when known. */
  lpBalance?: bigint
}

/** Picks the reading direction: USDC (or token1) is the quote, the other token is the base. */
function orientation(token0: Token, token1: Token): { base: Token; quote: Token; quoteIsToken1: boolean } {
  const usdc = activeChain.usdc.toLowerCase()
  if (token0.address.toLowerCase() === usdc) return { base: token1, quote: token0, quoteIsToken1: false }
  return { base: token0, quote: token1, quoteIsToken1: true }
}

export function PoolDetail({ pair, token0, token1, lpBalance = 0n }: PoolDetailProps) {
  const { base, quote, quoteIsToken1 } = orientation(token0, token1)
  const history = usePriceHistory(pair.pair)
  const series = useMemo(() => pairSeries(history.data?.points ?? [], base, quote, quoteIsToken1), [base, history.data, quote, quoteIsToken1])
  const [reserveBase, reserveQuote] = reservesFor(pair, base.address)
  const spot = reserveBase > 0n && reserveQuote > 0n ? ratioQuote(10n ** BigInt(base.decimals), reserveBase, reserveQuote) : 0n
  const shareBps = pair.totalSupply > 0n ? (lpBalance * 10_000n) / pair.totalSupply : 0n
  const pooledBase = pair.totalSupply > 0n ? (lpBalance * reserveBase) / pair.totalSupply : 0n
  const pooledQuote = pair.totalSupply > 0n ? (lpBalance * reserveQuote) / pair.totalSupply : 0n

  return (
    <div className="pool-detail">
      <dl className="receipt-lines">
        <div>
          <dt>Pair contract</dt>
          <dd>
            <a className="inline-flex items-center gap-1 underline" href={addressExplorerUrl(pair.pair)} target="_blank" rel="noreferrer">
              {shortAddress(pair.pair)} <ExternalLinkIcon className="h-4 w-4" />
            </a>
          </dd>
        </div>
        <div><dt>Price</dt><dd>{spot > 0n ? `1 ${base.symbol} = ${formatAmount(spot, quote.decimals)} ${quote.symbol}` : '—'}</dd></div>
        <div><dt>LP supply</dt><dd>{formatLp(pair.totalSupply)} LP</dd></div>
        <div>
          <dt>Your share</dt>
          <dd>{lpBalance > 0n ? `${formatPct(shareBps)} · ${formatAmount(pooledBase, base.decimals)} ${base.symbol} + ${formatAmount(pooledQuote, quote.decimals)} ${quote.symbol}` : 'None yet'}</dd>
        </div>
      </dl>
      <PriceHistory series={series} title="Price history" unit={`${quote.symbol} per ${base.symbol}`} partial={history.data ? !history.data.complete : false} loading={history.isLoading} />
    </div>
  )
}
