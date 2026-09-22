import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Address } from 'viem'
import { addressExplorerUrl, txExplorerUrl } from '../chain'
import { useLaunch } from '../hooks/useLaunch'
import { useLaunchTrades } from '../hooks/useLaunchTrades'
import { usePriceHistory } from '../hooks/usePriceHistory'
import { useTokenMetadata } from '../hooks/useTokenMetadata'
import { GHOST, formatAmount, shortAddress } from '../lib/format'
import { INITIAL_CURVE, marketCap, poolMarketCap } from '../lib/curve'
import { GRADUATES_AT_USD, launchFacts, tradeUsdc } from '../lib/launch'
import { destinationLabel, destinationName, feeDestination } from '../lib/plugins/destination'
import { relativeTime } from '../lib/recent'
import { linkLabel } from '../lib/tokenMetadata'
import { CreatorFeesPanel } from './CreatorFeesPanel'
import { FeeGauge } from './FeeGauge'
import { ExternalLinkIcon } from './Icons'
import { GhostButton } from './GhostButton'
import { LaunchMeter, LaunchTokenMark } from './LaunchBits'
import { LaunchTradeSheet } from './LaunchTradeSheet'
import { PriceHistory, type SeriesPoint } from './PriceHistory'
import { TableSkeleton } from './Skeleton'

const fixtureOn = import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1'

interface LaunchDetailProps {
  token: Address
  onBack: () => void
  /** Which side the trade sheet opens on (a link from Swap can ask for sell). */
  side?: 'buy' | 'sell'
}

function formatCap(value: number): string {
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: value >= 100 ? 0 : 2 })}`
}

export function LaunchDetail({ token, onBack, side }: LaunchDetailProps) {
  const { launch, token: launchToken, usdc, tokenBalance, usdcBalance, usdcAllowance, isLoading, unknown, refetch } = useLaunch(token)
  const graduated = Boolean(launch?.graduated)
  const { trades, historyComplete, reachesCreation, isLoading: tradesLoading, error: tradesError } = useLaunchTrades(
    token,
    launch ? Number(launch.createdAt) : undefined,
    graduated,
    Boolean(launch && (launch.tokensSold > 0n || launch.graduated)),
  )
  // After graduation the launch pool's reserve history carries the chart on: its Sync event has the core pair's shape.
  const poolHistory = usePriceHistory(graduated ? launch?.pair : undefined, !fixtureOn && graduated)
  // Market cap after each trade, oldest first: the curve's (from the reserves each curve Trade carries), then the
  // pool's. The creation point is only drawn when every trade since is known.
  const capSeries = useMemo<SeriesPoint[]>(() => {
    const curvePoints = trades
      .filter((trade) => trade.venue === 'curve' && trade.virtualUsdc !== undefined && trade.virtualTokens !== undefined)
      .map((trade) => ({ value: Number(marketCap({ virtualUsdc: trade.virtualUsdc!, virtualTokens: trade.virtualTokens! })) / 1e6, time: trade.time, block: trade.block }))
      .reverse()
    if (launch && reachesCreation) curvePoints.unshift({ value: Number(marketCap(INITIAL_CURVE)) / 1e6, time: Number(launch.createdAt), block: 0 })
    const poolPoints = (poolHistory.data?.points ?? [])
      .filter((point) => point.reserve0 > 0n)
      .map((point) => ({ value: Number(poolMarketCap({ reserveToken: point.reserve0, reserveUsdc: point.reserve1 })) / 1e6, time: point.time, block: point.block }))
    return [...curvePoints, ...poolPoints].sort((a, b) => a.block - b.block)
  }, [launch, poolHistory.data?.points, reachesCreation, trades])
  const details = useTokenMetadata(launch?.metadataURI)
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
  const destination = feeDestination(launch)
  const about = details.metadata
  const links = [['Website', about?.external_link], ['X', about?.twitter], ['Telegram', about?.telegram]].flatMap(([label, url]) => (label && url ? [[label, url] as const] : []))

  return (
    <div className="pools-page">
      <div className="mb-10 flex items-start gap-4">
        <LaunchTokenMark token={launchToken} uri={launch.metadataURI} className="token-mark-lg" />
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-[-0.02em]">{launch.symbol}</h1>
          <p className="mt-1 text-sm text-g500">{launch.name} · {shortAddress(launch.token)}</p>
        </div>
      </div>

      {about && (about.description || links.length > 0) && (
        <section className="launch-about" aria-label="From the creator">
          {about.description && <p className="whitespace-pre-line">{about.description}</p>}
          {links.length > 0 && (
            <ul>
              {links.map(([label, url]) => (
                <li key={url}>
                  <a className="inline-flex items-center gap-1 underline" href={url} target="_blank" rel="noopener noreferrer nofollow ugc">
                    {label} · {linkLabel(url)} <ExternalLinkIcon className="h-4 w-4" />
                  </a>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-g500">Written by the creator. Architex has not checked it.</p>
        </section>
      )}

      <div className="launch-detail">
        <div className="launch-chart">
          <PriceHistory
            series={capSeries}
            title="Market cap"
            unit="USDC"
            formatValue={formatCap}
            loading={tradesLoading}
            partial={!historyComplete || Boolean(tradesError)}
            loadingText="Reading the trades…"
            emptyText="No trades yet. The first buy starts the chart."
            partialText={tradesError ? 'The trades could not be loaded.' : 'No recent trades. Older history could not be loaded.'}
          />
        </div>
        <dl className="receipt-lines launch-facts">
          <div><dt>Price</dt><dd>{graduated && !launch.pool ? GHOST : facts.price}</dd></div>
          <div><dt>Market cap</dt><dd>{graduated && !launch.pool ? GHOST : facts.cap}</dd></div>
          <div>
            <dt>Sold</dt>
            <dd>
              <LaunchMeter tokensSold={launch.tokensSold} graduated={launch.graduated} />
            </dd>
          </div>
          {graduated ? (
            <div><dt>Launch pool</dt><dd>{facts.pooled ?? GHOST}</dd></div>
          ) : (
            <>
              <div><dt>Raised</dt><dd>{facts.raised}</dd></div>
              <div><dt>Graduates at</dt><dd>{GRADUATES_AT_USD}</dd></div>
            </>
          )}
          <div>
            <dt>Creator fee</dt>
            <dd><FeeGauge bps={launch.creatorFeeBps} label={`${launch.symbol} creator fee`} /></dd>
          </div>
          <div>
            <dt>Fees go to</dt>
            <dd>
              <a className="inline-flex items-center gap-1 underline" href={addressExplorerUrl(destination.address)} target="_blank" rel="noreferrer">
                {destination.kind === 'listed' ? destinationName(destination) : destinationLabel(destination)} <ExternalLinkIcon className="h-4 w-4" />
              </a>
            </dd>
          </div>
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
        <div className="launch-trade">
          <LaunchTradeSheet
            launch={launch}
            token={launchToken}
            usdc={usdc}
            tokenBalance={tokenBalance}
            usdcBalance={usdcBalance}
            usdcAllowance={usdcAllowance}
            initialSide={side}
            onConfirmed={refresh}
          />
        </div>
      </div>

      <CreatorFeesPanel launch={launch} onChanged={refresh} />

      <section className="ledger" aria-label="Trades">
        <div className="section-heading-row"><h2>Trades</h2>{!tradesLoading && !tradesError && <span>{trades.length}</span>}</div>
        {trades.length === 0 ? (
          <p className="price-history-empty">
            {tradesLoading ? 'Reading the trades…' : tradesError ? (
              <>The trades could not be loaded. <a className="underline" href={addressExplorerUrl(token)} target="_blank" rel="noreferrer">The explorer</a> has the full history.</>
            ) : historyComplete ? 'No trades yet.' : (
              <>No recent trades. Older trades could not be loaded; <a className="underline" href={addressExplorerUrl(token)} target="_blank" rel="noreferrer">the explorer</a> has the full history.</>
            )}
          </p>
        ) : (
          <ol className="ledger-list">
            {trades.map((trade) => (
              <li key={`${trade.txHash}:${trade.logIndex ?? 0}`} className="ledger-row">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    <span className={trade.isBuy ? 'trade-buy' : 'trade-sell'}>{trade.isBuy ? 'Buy' : 'Sell'}</span> {formatAmount(trade.tokenAmount, 18)} {launch.symbol} · {formatAmount(tradeUsdc(trade), 6)} USDC
                  </span>
                  <span className="block truncate text-xs text-g500">
                    {shortAddress(trade.trader)}
                    {trade.time > 0 && ` · ${relativeTime(trade.time * 1000, now)}`}
                    {` · ${trade.venue === 'pool' ? 'pool' : 'curve'}`}
                    {trade.creatorFee > 0n && ` · ${formatAmount(trade.creatorFee, 6)} USDC creator fee`}
                  </span>
                </span>
                <a className="inline-flex shrink-0 items-center gap-1 font-semibold underline" href={txExplorerUrl(trade.txHash)} target="_blank" rel="noreferrer">
                  View <ExternalLinkIcon className="h-4 w-4" />
                </a>
              </li>
            ))}
          </ol>
        )}
        {trades.length > 0 && !historyComplete && (
          <p className="mt-3 text-xs text-g500">
            Recent trades only. <a className="underline" href={addressExplorerUrl(token)} target="_blank" rel="noreferrer">The explorer</a> has the full history.
          </p>
        )}
      </section>
    </div>
  )
}
