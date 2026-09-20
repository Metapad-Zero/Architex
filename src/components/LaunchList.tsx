import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import { formatSwapUrl } from '../lib/swapUrl'
import { launchFacts, type LaunchRecord } from '../lib/launch'
import { relativeTime } from '../lib/recent'
import { shortAddress } from '../lib/format'
import { useLaunches } from '../hooks/useLaunches'
import { GhostButton } from './GhostButton'
import { CheckIcon } from './Icons'
import { LaunchMeter, LaunchTokenMark } from './LaunchBits'
import { TableSkeleton } from './Skeleton'

interface LaunchListProps {
  onOpen: (token: Address) => void
  onCreate: () => void
}

export function LaunchList({ onOpen, onCreate }: LaunchListProps) {
  const { launches, isLoading } = useLaunches()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <div className="pools-page">
      <div className="mb-10 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-[-0.02em]">Launch</h1>
          <p className="mt-2 max-w-xl text-sm text-g500">
            Launch a token on a bonding curve. When the curve sells out, its liquidity moves to an Architex pool and is locked for good.
          </p>
        </div>
        <GhostButton className="shrink-0 whitespace-nowrap" onClick={onCreate}>Create a token</GhostButton>
      </div>

      <section className="ruled-section">
        <div className="section-heading-row">
          <h2>All launches</h2>
          <span>{launches.length} {launches.length === 1 ? 'launch' : 'launches'}</span>
        </div>
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
      </section>
    </div>
  )
}

function LaunchRow({ launch, now, onOpen }: { launch: LaunchRecord; now: number; onOpen: (token: Address) => void }) {
  const facts = launchFacts(launch)
  const swapHref = formatSwapUrl({ in: 'USDC', out: launch.token })
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
      <td data-label="Market cap">{facts.cap}</td>
      <td data-label="Sold">
        {launch.graduated ? (
          <a className="launch-graduated underline" href={swapHref} onClick={(event) => event.stopPropagation()}><CheckIcon className="h-4 w-4" />Graduated</a>
        ) : (
          <LaunchMeter tokensSold={launch.tokensSold} graduated={false} />
        )}
      </td>
      <td data-label="Age">{relativeTime(Number(launch.createdAt) * 1000, now)}</td>
    </tr>
  )
}
