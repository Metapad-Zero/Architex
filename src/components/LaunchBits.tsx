import { useState } from 'react'
import type { Token } from '../lib/tokens'
import { parseHttpsUrl, soldLabel } from '../lib/launch'
import { progressBps } from '../lib/curve'
import { CheckIcon } from './Icons'
import { TokenMark } from './TokenMark'

export function LaunchTokenMark({ token, uri, className }: { token: Pick<Token, 'address' | 'symbol'>; uri?: string; className?: string }) {
  const https = uri ? parseHttpsUrl(uri) : undefined
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  if (!https || failed) return <TokenMark token={token} className={className} />
  // The stamp holds the place, so a slow or broken image never leaves a hole; the image covers it once it has loaded.
  return (
    <span className="token-image">
      <TokenMark token={token} className={className} />
      <img
        src={https}
        alt=""
        width={24}
        height={24}
        referrerPolicy="no-referrer"
        loading="lazy"
        decoding="async"
        data-loaded={loaded}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
    </span>
  )
}

export function LaunchMeter({
  tokensSold,
  graduated,
}: {
  tokensSold: bigint
  graduated: boolean
}) {
  const pct = graduated ? 100 : Math.min(100, Number(progressBps({ virtualUsdc: 0n, virtualTokens: 1n, tokensSold })) / 100)
  const label = graduated ? 'Graduated' : soldLabel(tokensSold)
  return (
    <div className="launch-sold">
      <div
        role="meter"
        className="launch-meter"
        data-graduated={graduated}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={label}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
      {graduated ? (
        <span className="launch-graduated"><CheckIcon className="h-4 w-4" />{label}</span>
      ) : (
        <span>{label}</span>
      )}
    </div>
  )
}
