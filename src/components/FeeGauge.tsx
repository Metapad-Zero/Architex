import { clsx } from 'clsx'
import { formatPct } from '../lib/format'

/**
 * A launch token's creator fee on a needle gauge from 0% to 10% [D18]. The dial is data, drawn in the page's
 * inks: a Warm Gray 300 hairline track, the fee so far as a 2px ink arc, an ink needle. No colour: the fee is not a
 * signal (Signal Yellow means money moving or graduation progress).
 *
 * It is a `meter` with the fee as its value text, so a screen reader hears "Creator fee, 2.50%"; the dial and the
 * printed figure are hidden from it so nothing is read twice. `live` lets the needle and arc follow an input over
 * 200ms (the builder); under reduced motion the global rule removes that transition.
 */

const MAX_BPS = 1_000

interface Geometry {
  width: number
  height: number
  cx: number
  cy: number
  r: number
  needle: number
  hub: number
  ticks: boolean
}

const SIZES: Record<'sm' | 'lg', Geometry> = {
  sm: { width: 32, height: 18, cx: 16, cy: 16, r: 13, needle: 10.5, hub: 1.75, ticks: false },
  lg: { width: 144, height: 80, cx: 72, cy: 72, r: 64, needle: 54, hub: 3, ticks: true },
}

function point(g: Geometry, degrees: number, radius: number): [number, number] {
  const radians = (degrees * Math.PI) / 180
  return [g.cx + radius * Math.cos(radians), g.cy - radius * Math.sin(radians)]
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

interface FeeGaugeProps {
  /** Creator fee in basis points, 0–1000. */
  bps: number
  size?: 'sm' | 'lg'
  /** What the meter is called; the gauge reads "{label}, 2.50%". */
  label?: string
  /** The builder: the needle follows the input. */
  live?: boolean
  /** Print the figure beside (sm) or under (lg) the dial. */
  showValue?: boolean
  /** The figure is printed right beside the gauge by its parent: hide the dial from assistive tech entirely. */
  decorative?: boolean
  className?: string
}

export function FeeGauge({ bps, size = 'sm', label = 'Creator fee', live = false, showValue = true, decorative = false, className }: FeeGaugeProps) {
  const g = SIZES[size]
  const value = Math.min(MAX_BPS, Math.max(0, Math.round(bps)))
  const [left, right] = [point(g, 180, g.r), point(g, 0, g.r)]
  const track = `M${round(left[0])} ${round(left[1])} A${g.r} ${g.r} 0 0 1 ${round(right[0])} ${round(right[1])}`
  const text = formatPct(value)
  const meter = decorative
    ? { 'aria-hidden': true }
    : { role: 'meter', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 10, 'aria-valuenow': value / 100, 'aria-valuetext': text }

  return (
    // Class names spelled out whole: Tailwind drops component rules for classes it cannot find in the source.
    <span {...meter} className={clsx('fee-gauge', size === 'lg' ? 'fee-gauge-lg' : 'fee-gauge-sm', className)} data-live={live || undefined}>
      <svg width={g.width} height={g.height} viewBox={`0 0 ${g.width} ${g.height}`} aria-hidden="true" focusable="false">
        <path className="fee-gauge-track" d={track} />
        {g.ticks &&
          Array.from({ length: 11 }, (_, index) => {
            const major = index % 5 === 0
            const [x1, y1] = point(g, 180 - index * 18, g.r - (major ? 9 : 5))
            const [x2, y2] = point(g, 180 - index * 18, g.r - 1)
            return <line key={index} className={major ? 'fee-gauge-tick-major' : 'fee-gauge-tick'} x1={round(x1)} y1={round(y1)} x2={round(x2)} y2={round(y2)} />
          })}
        {/* pathLength 1000 makes the dash the fee in basis points. */}
        <path className="fee-gauge-arc" d={track} pathLength={MAX_BPS} strokeDasharray={`${value} ${MAX_BPS}`} />
        <g className="fee-gauge-needle" style={{ transform: `rotate(${(value / MAX_BPS) * 180}deg)`, transformOrigin: `${g.cx}px ${g.cy}px` }}>
          <line x1={g.cx} y1={g.cy} x2={g.cx - g.needle} y2={g.cy} />
        </g>
        <circle className="fee-gauge-hub" cx={g.cx} cy={g.cy} r={g.hub} />
      </svg>
      {size === 'lg' && (
        <span className="fee-gauge-scale" aria-hidden="true">
          <span>0%</span>
          <span>10%</span>
        </span>
      )}
      {showValue && (
        <span className="fee-gauge-value" aria-hidden="true">
          {text}
        </span>
      )}
    </span>
  )
}
