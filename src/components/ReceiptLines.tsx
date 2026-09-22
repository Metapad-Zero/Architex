import { useState } from 'react'
import { GHOST, formatAmount, formatPct, shortAddress } from '../lib/format'
import type { QuoteMode } from '../lib/amm'
import type { LocalQuote } from '../hooks/useQuote'
import type { Token } from '../lib/tokens'

interface ReceiptLinesProps {
  quote: LocalQuote | undefined
  mode: QuoteMode
  tokenIn: Token | undefined
  tokenOut: Token | undefined
  tokens: readonly Token[]
}

/**
 * The receipt block is a fixed set of slots: it renders the same five rows whether or not
 * a quote exists, so the sheet never reflows while the user types. Empty slots show the GHOST.
 */
export function ReceiptLines({ quote, mode, tokenIn, tokenOut, tokens }: ReceiptLinesProps) {
  const [reverseRate, setReverseRate] = useState(false)
  const live = Boolean(quote && tokenIn && tokenOut)

  let rate = GHOST
  let impact = GHOST
  let impactShort = GHOST
  let impactClass = ''
  let boundLabel = mode === 'exactIn' ? 'Minimum received' : 'Maximum sent'
  let bound = GHOST
  let route = GHOST

  if (quote && tokenIn && tokenOut) {
    const baseToken = reverseRate ? tokenOut : tokenIn
    const quoteToken = reverseRate ? tokenIn : tokenOut
    const baseAmount = reverseRate ? quote.amountOut : quote.amountIn
    const quoteAmount = reverseRate ? quote.amountIn : quote.amountOut
    const oneBase = 10n ** BigInt(baseToken.decimals)
    const rateRaw = baseAmount > 0n ? (quoteAmount * oneBase) / baseAmount : 0n
    rate = `1 ${baseToken.symbol} = ${formatAmount(rateRaw, quoteToken.decimals)} ${quoteToken.symbol}`
    const highImpact = quote.priceImpactBps > 500n
    const share = quote.poolShareBps >= 100n ? `${(Number(quote.poolShareBps) / 100).toFixed(0)}%` : '<1%'
    const poolContext = quote.priceImpactBps > 100n ? ` · ${share} of the pool` : ''
    impact = `${formatPct(quote.priceImpactBps)}${highImpact ? ' · High price impact' : ''}${poolContext}`
    impactShort = `${formatPct(quote.priceImpactBps)}${highImpact ? ' · High impact' : ''}${quote.priceImpactBps > 100n ? ` · ${share} of pool` : ''}`
    impactClass = highImpact ? 'text-loss' : ''
    boundLabel = mode === 'exactIn' ? 'Minimum received' : 'Maximum sent'
    bound =
      mode === 'exactIn'
        ? `${formatAmount(quote.minReceived, tokenOut.decimals)} ${tokenOut.symbol}`
        : `${formatAmount(quote.maxSent, tokenIn.decimals)} ${tokenIn.symbol}`
    route = quote.path
      .map((address) => tokens.find((token) => token.address.toLowerCase() === address.toLowerCase())?.symbol ?? shortAddress(address))
      .join(' → ')
  }

  return (
    <dl className="receipt-lines" data-live={live}>
      <div>
        <dt>Rate</dt>
        <dd>
          {live ? (
            <button type="button" className="underline" onClick={() => setReverseRate((value) => !value)}>{rate}</button>
          ) : (
            <span className="text-g500">{rate}</span>
          )}
        </dd>
      </div>
      <div>
        <dt>Price impact</dt>
        <dd className={live ? impactClass : 'text-g500'}>
          <span className="hidden sm:inline">{impact}</span>
          <span className="sm:hidden">{impactShort}</span>
        </dd>
      </div>
      <div><dt>Fee</dt><dd>0.30%</dd></div>
      <div>
        <dt>{boundLabel}</dt>
        <dd className={live ? '' : 'text-g500'}>{bound}</dd>
      </div>
      <div><dt>Route</dt><dd className={live ? '' : 'text-g500'}>{route}</dd></div>
    </dl>
  )
}
