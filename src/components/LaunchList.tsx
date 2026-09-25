import { useEffect, useState, type FormEvent } from 'react'
import type { Address } from 'viem'
import { isPriced, launchFacts, type LaunchRecord } from '../lib/launch'
import { parseLaunchAddress } from '../lib/launchPages'
import { destinationLabel, feeDestination } from '../lib/plugins/destination'
import { relativeTime } from '../lib/recent'
import { GHOST, shortAddress } from '../lib/format'
import { useLaunches } from '../hooks/useLaunches'
import { FeeGauge } from './FeeGauge'
import { GhostButton } from './GhostButton'
import { LaunchMeter, LaunchTokenMark } from './LaunchBits'
import { TableSkeleton } from './Skeleton'

interface LaunchListProps {
  onOpen: (token: Address) => void
  onCreate: () => void
}

export function LaunchList({ onOpen, onCreate }: LaunchListProps) {
  const { launches, total, hasMore, isLoadingMore, loadMore, isLoading } = useLaunches()
  const [now, setNow] = useState(() => Date.now())
  const [lookup, setLookup] = useState('')
  const [lookupError, setLookupError] = useState('')
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const openLookup = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const token = parseLaunchAddress(lookup)
    if (!token) {
      setLookupError('That is not a valid token address.')
      return
    }
    onOpen(token)
  }

  return (
    <div className="pools-page">
      <div className="mb-10 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-[-0.02em]">Launch</h1>
          <p className="mt-2 max-w-xl text-sm text-g500">
            Launch a token on a bonding curve, with a creator fee of up to 10% on every trade sent where you choose. When the curve sells out, its liquidity moves to the token’s own launch pool and is locked for good.
          </p>
        </div>
        <GhostButton className="shrink-0 whitespace-nowrap" onClick={onCreate}>Create a token</GhostButton>
      </div>

      <section className="ruled-section">
        <div className="section-heading-row">
          <h2>All launches</h2>
          <span>{total} {total === 1 ? 'launch' : 'launches'}</span>
        </div>
        <form className="mb-6" onSubmit={openLookup}>
          <label htmlFor="launch-lookup" className="amount-label">Open a launch by token address</label>
          <div className="mt-2 flex gap-2">
            <div className="field-with-suffix min-w-0 flex-1">
              <input
                id="launch-lookup"
                placeholder="0x…"
                value={lookup}
                onChange={(event) => {
                  setLookup(event.target.value)
                  setLookupError('')
                }}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(lookupError)}
                aria-describedby={lookupError ? 'launch-lookup-error' : undefined}
              />
            </div>
            <GhostButton type="submit" disabled={!lookup.trim()}>Open</GhostButton>
          </div>
          {lookupError && <p id="launch-lookup-error" className="mt-2 text-sm text-loss" role="alert">{lookupError}</p>}
        </form>
        {isLoading ? (
          <TableSkeleton rows={5} />
        ) : launches.length === 0 ? (
          <div className="empty-state">
            <p>No launches yet. Create the first token.</p>
            <GhostButton onClick={onCreate}>Create a token</GhostButton>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="launches-table">
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Market cap</th>
                  <th>Creator fee</th>
                  <th>Sold</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                {launches.map((launch) => (
                  <LaunchRow key={launch.token} launch={launch} now={now} onOpen={onOpen} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!isLoading && hasMore && (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-4 text-sm text-g500">
            <span>Showing the newest {launches.length} of {total}</span>
            <GhostButton disabled={isLoadingMore} onClick={loadMore}>{isLoadingMore ? 'Loading…' : 'Show older launches'}</GhostButton>
          </div>
        )}
      </section>
    </div>
  )
}

function LaunchRow({ launch, now, onOpen }: { launch: LaunchRecord; now: number; onOpen: (token: Address) => void }) {
  const facts = launchFacts(launch)
  const destination = destinationLabel(feeDestination(launch))
  return (
    <tr className="launch-row">
      <th scope="row">
        <button type="button" className="pool-toggle" onClick={() => onOpen(launch.token)}>
          <LaunchTokenMark token={{ address: launch.token, symbol: launch.symbol }} uri={launch.metadataURI} />
          <span className="min-w-0 text-left">
            <span className="block font-semibold">{launch.symbol}</span>
            <span className="block truncate text-xs font-normal text-g500">{launch.name} · {shortAddress(launch.token)}</span>
          </span>
        </button>
      </th>
      <td data-label="Market cap">{isPriced(launch) ? facts.cap : GHOST}</td>
      <td data-label="Creator fee">
        <span className="launch-fee">
          <FeeGauge bps={launch.creatorFeeBps} label={`${launch.symbol} creator fee`} />
          <span className="launch-fee-to" title={`Fees go to ${destination}`}>{destination}</span>
        </span>
      </td>
      <td data-label="Sold">
        <LaunchMeter tokensSold={launch.tokensSold} graduated={launch.graduated} />
      </td>
      <td data-label="Age">{relativeTime(Number(launch.createdAt) * 1000, now)}</td>
    </tr>
  )
}
