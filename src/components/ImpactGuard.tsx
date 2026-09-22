import { formatPct } from '../lib/format'
import { formatLossUsd, impactTier, isHighImpact } from '../lib/impactGuard'

/**
 * The receipt ink for a price impact (lib/impactGuard.ts): caution is semibold ink, because the Nine-Ink Rule has no
 * amber; high and above is Loss Red. `receipt-impact` lets the value take a second line instead of clipping.
 */
export function impactValueClass(bps: bigint): string {
  const tier = impactTier(bps)
  if (tier === 'normal') return 'receipt-impact'
  return tier === 'caution' ? 'receipt-impact font-semibold' : 'receipt-impact text-loss'
}

interface ImpactValueProps {
  bps: bigint
  /** What the impact costs, in USD (6 decimals); left out below half a cent. */
  lossUsd?: bigint
  /** Swap only: the trade's share of its first pool, said from the caution tier up. */
  poolShareBps?: bigint
}

/**
 * "41.45% (about $83) · High price impact · 71% of the pool", in parts that never break inside themselves, so a
 * narrow sheet wraps it between parts. Below 640px the parts take their short forms ("High impact", "of pool").
 */
export function ImpactValue({ bps, lossUsd, poolShareBps }: ImpactValueProps) {
  const loss = lossUsd === undefined ? undefined : formatLossUsd(lossUsd)
  const share =
    poolShareBps === undefined || impactTier(bps) === 'normal'
      ? undefined
      : poolShareBps >= 100n ? `${(Number(poolShareBps) / 100).toFixed(0)}%` : '<1%'
  return (
    <>
      <span className="whitespace-nowrap">{formatPct(bps)}{loss ? ` (about ${loss})` : ''}</span>
      {isHighImpact(bps) && (
        <>
          {' '}
          <span className="whitespace-nowrap">· High<span className="hidden sm:inline"> price</span> impact</span>
        </>
      )}
      {share && (
        <>
          {' '}
          <span className="whitespace-nowrap">· {share} of<span className="hidden sm:inline"> the</span> pool</span>
        </>
      )}
    </>
  )
}

interface ImpactGuardProps {
  /** The checkbox id, unique on the page. */
  id: string
  /** The trade's price impact; nothing shows without a quote. */
  bps: bigint | undefined
  /** From 5% up: "Under 1% impact here: about 2.85 USDC or less." */
  hint: string | undefined
  /** From 15% up to the refusal line: the sentence the trader ticks. */
  acknowledgment: string | undefined
  acknowledged: boolean
  onAcknowledge: (acknowledged: boolean) => void
}

/**
 * What the guard adds between a sheet's receipt and its button: the size that stays under 1% once the impact is high,
 * and the acknowledgment that Approve and the trade wait for once it passes 15%. A refused trade gets the hint only;
 * its button says the rest.
 */
export function ImpactGuard({ id, bps, hint, acknowledgment, acknowledged, onAcknowledge }: ImpactGuardProps) {
  if (bps === undefined) return null
  const shownHint = isHighImpact(bps) ? hint : undefined
  const shownAcknowledgment = impactTier(bps) === 'acknowledge' ? acknowledgment : undefined
  if (!shownHint && !shownAcknowledgment) return null
  return (
    <div className="impact-guard">
      {shownHint && <p className="quote-message" role="status">{shownHint}</p>}
      {shownAcknowledgment && (
        <label className="impact-accept" htmlFor={id}>
          <input id={id} type="checkbox" checked={acknowledged} onChange={(event) => onAcknowledge(event.target.checked)} />
          <span>{shownAcknowledgment}</span>
        </label>
      )}
    </div>
  )
}
