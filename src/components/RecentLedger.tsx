import { useEffect, useState } from 'react'
import { txExplorerUrl } from '../chain'
import { relativeTime, type RecentEntry } from '../lib/recent'
import { ExternalLinkIcon } from './Icons'

interface RecentLedgerProps {
  entries: RecentEntry[]
}

/** The printed record of what this browser did here: last few confirmed transactions, newest first. */
export function RecentLedger({ entries }: RecentLedgerProps) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  if (entries.length === 0) return null
  return (
    <section className="ledger" aria-label="Recent transactions">
      <div className="section-heading-row"><h2>Recent</h2><span>from this browser</span></div>
      <ol className="ledger-list">
        {entries.slice(0, 5).map((entry) => (
          <li key={entry.hash} className="ledger-row">
            <span className="min-w-0 flex-1">
              <span className="block truncate">{entry.summary}</span>
              <span className="block text-xs text-g500">{relativeTime(entry.time, now)}</span>
            </span>
            <a className="inline-flex shrink-0 items-center gap-1 font-semibold underline" href={txExplorerUrl(entry.hash)} target="_blank" rel="noreferrer">
              View <ExternalLinkIcon className="h-4 w-4" />
            </a>
          </li>
        ))}
      </ol>
    </section>
  )
}
