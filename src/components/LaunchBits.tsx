import { useState } from 'react'
import { tokenMonogram, type Token } from '../lib/tokens'
import { parseHttpsUrl, soldLabel } from '../lib/launch'
import { progressBps } from '../lib/curve'

export function LaunchTokenMark({ token, uri, className }: { token: Pick<Token, 'symbol' | 'name'>; uri?: string; className?: string }) {
  const https = uri ? parseHttpsUrl(uri) : undefined
  const [failed, setFailed] = useState(false)
  const monogram = tokenMonogram({ address: '0x0000000000000000000000000000000000000001', symbol: token.symbol, name: token.name, decimals: 18, faucet: false })
  if (https && !failed) {
    return (
      <img
        src={https}
        alt=""
        width={24}
        height={24}
        referrerPolicy="no-referrer"
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className={className ?? 'h-6 w-6 shrink-0 rounded object-cover'}
      />
    )
  }
  return (
    <span className={className ?? 'token-mark'} aria-hidden="true">{monogram}</span>
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
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={label}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
      <span>{label}</span>
    </div>
  )
}
