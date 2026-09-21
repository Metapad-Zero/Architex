import { useId } from 'react'
import { hashFor } from '../hooks/useHashRoute'
import { useLaunches } from '../hooks/useLaunches'
import { shortAddress } from '../lib/format'
import { destinationLabel, feeDestination } from '../lib/plugins/destination'
import { FeeGauge } from './FeeGauge'
import { TokenMark } from './TokenMark'

if (import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1') {
  await import('../lib/launchFixtures')
}

interface LaunchPickerGroupProps {
  query: string
  /** The side the token page's trade sheet opens on: picked to pay with, a sell; picked to receive, a buy. */
  side: 'buy' | 'sell'
}

/**
 * Graduated launch tokens in the Swap picker [D12]. They trade against USDC only, in their own launch pool through
 * the launch router, which charges their creator fee, so they are not swapped here: each row opens the token's own
 * trade sheet, on the side the picker was opened for. Mounted only while the picker is open, so the list is read
 * then and not polled from the Swap page. It holds the graduated tokens among the newest launches the page reads.
 */
export default function LaunchPickerGroup({ query, side }: LaunchPickerGroupProps) {
  const titleId = useId()
  const { launches, isLoading } = useLaunches()
  const needle = query.trim().toLowerCase()
  const matches = launches
    .filter((launch) => launch.graduated)
    .filter((launch) => !needle || `${launch.symbol} ${launch.name} ${launch.token}`.toLowerCase().includes(needle))
  if (isLoading) return null
  return (
    <div className="launch-picker" role="group" aria-labelledby={titleId}>
      <p id={titleId} className="launch-picker-head">
        <span className="font-semibold text-ink">Launch tokens</span> trade against USDC on their own page, where their creator fee applies.
      </p>
      {matches.length > 0 && (
        <ul className="m-0 list-none p-0">
          {matches.map((launch) => (
            <li key={launch.token}>
              <a className="token-row" href={hashFor({ view: 'launch', token: launch.token, side })}>
                <TokenMark token={{ address: launch.token, symbol: launch.symbol }} />
                <span className="min-w-0 text-left">
                  <span className="block font-semibold">{launch.symbol}</span>
                  <span className="block truncate text-xs text-g500">{launch.name} · {shortAddress(launch.token)}</span>
                </span>
                <span className="launch-fee ml-auto pl-4">
                  <FeeGauge bps={launch.creatorFeeBps} label={`${launch.symbol} creator fee`} />
                  <span className="launch-fee-to">{destinationLabel(feeDestination(launch))}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
      <a className="launch-picker-all" href="#launch">
        All launches
      </a>
    </div>
  )
}
