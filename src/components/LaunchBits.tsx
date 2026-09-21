import { useEffect, useRef, useState } from 'react'
import type { Token } from '../lib/tokens'
import { useTokenMetadata } from '../hooks/useTokenMetadata'
import { soldLabel } from '../lib/launch'
import { progressBps } from '../lib/curve'
import { CheckIcon } from './Icons'
import { TokenMark } from './TokenMark'

export function LaunchTokenMark({ token, uri, className }: { token: Pick<Token, 'address' | 'symbol'>; uri?: string; className?: string }) {
  const holder = useRef<HTMLSpanElement>(null)
  const [seen, setSeen] = useState(false)
  // A long list does not fetch fifty files at once: a row asks for its details when it first scrolls into view.
  useEffect(() => {
    const node = holder.current
    if (!node || seen) return
    const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && setSeen(true), { rootMargin: '200px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [seen])
  const details = useTokenMetadata(uri, seen)
  const imageUrl = details.imageUrl
  // The stamp holds the place, so a slow or missing image never leaves a hole. The image is a `blob:` URL of
  // bytes already checked against their address; nothing is ever loaded from a host the creator chose.
  return (
    <span className="token-image" ref={holder}>
      <TokenMark token={token} className={className} />
      {imageUrl && <img src={imageUrl} alt="" width={24} height={24} decoding="async" data-loaded="true" />}
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
  const pct = graduated ? 100 : Math.min(100, Number(progressBps({ tokensSold })) / 100)
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
