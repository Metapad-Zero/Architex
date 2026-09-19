import { useCallback, useEffect, useState } from 'react'
import type { Address } from 'viem'
import { addressExplorerUrl, txExplorerUrl } from '../chain'
import { useLaunch } from '../hooks/useLaunch'
import { useLaunchTrades } from '../hooks/useLaunchTrades'
import { formatAmount, shortAddress } from '../lib/format'
import { GRADUATES_AT_USD, launchFacts } from '../lib/launch'
import { relativeTime } from '../lib/recent'
import { ExternalLinkIcon } from './Icons'
import { GhostButton } from './GhostButton'
import { LaunchMeter, LaunchTokenMark } from './LaunchBits'
import { LaunchTradeSheet } from './LaunchTradeSheet'
import { TableSkeleton } from './Skeleton'

interface LaunchDetailProps {
  token: Address
  onBack: () => void
}

export function LaunchDetail({ token, onBack }: LaunchDetailProps) {
  const { launch, token: launchToken, usdc, tokenBalance, usdcBalance, usdcAllowance, isLoading, unknown, refetch } = useLaunch(token)
  const { trades } = useLaunchTrades(token)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const refresh = useCallback(async () => {
    await refetch()
  }, [refetch])

  if (isLoading) {
    return (
      <div className="pools-page">
        <TableSkeleton rows={6} />
      </div>
    )
  }

  if (unknown || !launch || !launchToken) {
    return (
      <div className="pools-page">
        <div className="empty-state">
          <p>That token is not on the launchpad.</p>
          <GhostButton onClick={onBack}>All launches</GhostButton>
        </div>
      </div>
    )
  }

  const facts = launchFacts(launch)

  return (
    <div className="pools-page">
      <div className="mb-10 flex items-start gap-4">
        <LaunchTokenMark token={launchToken} uri={launch.metadataURI} />
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-[-0.02em]">{launch.symbol}</h1>
          <p className="mt-1 text-sm text-g500">{launch.name} · {shortAddress(launch.token)}</p>
        </div>
      </div>

      <div className="launch-detail">
        <dl className="receipt-lines">
          <div><dt>Price</dt><dd>{facts.price}</dd></div>
          <div><dt>Market cap</dt><dd>{facts.cap}</dd></div>
          <div>
            <dt>Sold</dt>
            <dd>
              <LaunchMeter tokensSold={launch.tokensSold} graduated={launch.graduated} />
            </dd>
          </div>
          <div><dt>Raised</dt><dd>{facts.raised}</dd></div>
          <div><dt>Graduates at</dt><dd>{GRADUATES_AT_USD}</dd></div>
          <div>
            <dt>Creator</dt>
            <dd>
              <a className="inline-flex items-center gap-1 underline" href={addressExplorerUrl(launch.creator)} target="_blank" rel="noreferrer">
                {shortAddress(launch.creator)} <ExternalLinkIcon className="h-4 w-4" />
              </a>
            </dd>
          </div>
          <div>
            <dt>Contract</dt>
            <dd>
              <a className="inline-flex items-center gap-1 underline" href={addressExplorerUrl(launch.token)} target="_blank" rel="noreferrer">
                {shortAddress(launch.token)} <ExternalLinkIcon className="h-4 w-4" />
              </a>
            </dd>
          </div>
        </dl>
        <LaunchTradeSheet
          launch={launch}
          token={launchToken}
          usdc={usdc}
          tokenBalance={tokenBalance}
          usdcBalance={usdcBalance}
          usdcAllowance={usdcAllowance}
          onConfirmed={refresh}
        />
      </div>

      <section className="ledger" aria-label="Trades">
        <div className="section-heading-row"><h2>Trades</h2><span>{trades.length}</span></div>
        {trades.length === 0 ? (
          <p className="price-history-empty">No trades yet.</p>
        ) : (
          <ol className="ledger-list">
            {trades.map((trade) => (
              <li key={trade.txHash} className="ledger-row">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {trade.isBuy ? 'Buy' : 'Sell'} {formatAmount(trade.tokenAmount, 18)} {launch.symbol} · {formatAmount(trade.isBuy ? trade.usdcAmount : trade.usdcAmount - trade.fee, 6)} USDC
                  </span>
                  <span className="block text-xs text-g500">{shortAddress(trade.trader)} · {relativeTime(trade.time * 1000, now)}</span>
                </span>
                <a className="inline-flex shrink-0 items-center gap-1 font-semibold underline" href={txExplorerUrl(trade.txHash)} target="_blank" rel="noreferrer">
                  View <ExternalLinkIcon className="h-4 w-4" />
                </a>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}
