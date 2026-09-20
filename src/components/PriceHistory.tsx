import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import type { PricePoint } from '../hooks/usePriceHistory'
import type { Token } from '../lib/tokens'
import { TrendDownIcon, TrendUpIcon } from './Icons'

export interface SeriesPoint {
  value: number
  time: number // unix seconds
  block: number
}

interface PriceHistoryProps {
  /** Oldest first. */
  series: SeriesPoint[]
  /** What the chart shows, for example "Price history". */
  title: string
  /** The unit of the values, for example "USDC per EURC"; heads the table column too. */
  unit: string
  formatValue?: (value: number) => string
  loading?: boolean
  /** True when only the recent end of the history could be read, so an empty chart does not mean no trades. */
  partial?: boolean
  loadingText?: string
  emptyText?: string
  partialText?: string
}

/** A pool's reserve history as prices of `base` in `quote`. */
export function pairSeries(points: PricePoint[], base: Token, quote: Token, quoteIsToken1: boolean): SeriesPoint[] {
  return points.map((point) => ({ value: priceOf(point, base, quote, quoteIsToken1), time: point.time, block: point.block })).filter((point) => point.value > 0)
}

interface Plotted extends SeriesPoint {
  x: number
  y: number
}

const HEIGHT = 168
const PAD = { top: 12, right: 12, bottom: 28, left: 56 }

function priceOf(point: PricePoint, base: Token, quote: Token, quoteIsToken1: boolean): number {
  const reserveQuote = quoteIsToken1 ? point.reserve1 : point.reserve0
  const reserveBase = quoteIsToken1 ? point.reserve0 : point.reserve1
  if (reserveBase === 0n) return 0
  return (Number(reserveQuote) / 10 ** quote.decimals) / (Number(reserveBase) / 10 ** base.decimals)
}

function formatPrice(value: number): string {
  if (value === 0) return '0'
  if (value >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (value >= 1) return value.toLocaleString('en-US', { maximumFractionDigits: 4 })
  return value.toLocaleString('en-US', { maximumSignificantDigits: 4 })
}

function formatTime(seconds: number): string {
  if (!seconds) return ''
  return new Date(seconds * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function niceTicks(min: number, max: number): number[] {
  if (!(max > min)) return [min]
  const span = max - min
  const raw = span / 2
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => span / s <= 3) ?? magnitude
  const first = Math.ceil(min / step) * step
  const ticks: number[] = []
  for (let tick = first; tick <= max + step / 1000; tick += step) ticks.push(Number(tick.toFixed(10)))
  return ticks.length ? ticks : [min, max]
}

export function PriceHistory({
  series,
  title,
  unit,
  formatValue = formatPrice,
  loading = false,
  partial = false,
  loadingText = "Reading the pool's history…",
  emptyText = 'No trades yet — the first swap starts the price history.',
  partialText = 'No recent swaps. Older price history could not be loaded.',
}: PriceHistoryProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(480)
  const [active, setActive] = useState<number | null>(null)
  const [showTable, setShowTable] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0]?.contentRect.width ?? 480)
      if (next > 0) setWidth(next)
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  const plotted = useMemo<Plotted[]>(() => {
    const priced = series.filter((point) => point.value > 0)
    if (priced.length === 0) return []
    const innerW = Math.max(1, width - PAD.left - PAD.right)
    const innerH = HEIGHT - PAD.top - PAD.bottom
    const values = priced.map((point) => point.value)
    let min = Math.min(...values)
    let max = Math.max(...values)
    if (min === max) {
      min *= 0.98
      max *= 1.02
    }
    return priced.map((point, index) => ({
      ...point,
      x: PAD.left + (priced.length === 1 ? innerW / 2 : (index / (priced.length - 1)) * innerW),
      y: PAD.top + innerH - ((point.value - min) / (max - min)) * innerH,
    }))
  }, [series, width])

  const ticks = useMemo(() => {
    if (plotted.length === 0) return []
    const values = plotted.map((p) => p.value)
    let min = Math.min(...values)
    let max = Math.max(...values)
    if (min === max) {
      min *= 0.98
      max *= 1.02
    }
    const innerH = HEIGHT - PAD.top - PAD.bottom
    return niceTicks(min, max).map((value) => ({ value, y: PAD.top + innerH - ((value - min) / (max - min)) * innerH }))
  }, [plotted])

  const nearest = (clientX: number) => {
    const host = hostRef.current
    if (!host || plotted.length === 0) return null
    const x = clientX - host.getBoundingClientRect().left
    let best = 0
    for (let index = 1; index < plotted.length; index += 1) {
      if (Math.abs(plotted[index].x - x) < Math.abs(plotted[best].x - x)) best = index
    }
    return best
  }

  const onPointer = (event: PointerEvent<SVGSVGElement>) => setActive(nearest(event.clientX))
  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    if (plotted.length === 0) return
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      setActive((current) => {
        const start = current ?? plotted.length - 1
        return Math.max(0, Math.min(plotted.length - 1, start + (event.key === 'ArrowRight' ? 1 : -1)))
      })
    } else if (event.key === 'Escape') {
      setActive(null)
    }
  }

  const first = plotted[0]
  const last = plotted[plotted.length - 1]
  const current = active === null ? last : plotted[active]
  const showMarkers = plotted.length <= 24
  const path = plotted.map((p, index) => `${index === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
  // Direction over the window drawn. Colour repeats what the arrow and the sign already say.
  const change = first && last && plotted.length > 1 ? (last.value - first.value) / first.value : 0
  const trend = Math.abs(change) < 0.00005 ? 'flat' : change > 0 ? 'up' : 'down'
  const changeLabel = `${change > 0 ? '+' : change < 0 ? '−' : ''}${Math.abs(change * 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`

  return (
    <div className="price-history" ref={hostRef} data-loading={loading} data-trend={trend}>
      <div className="price-history-head">
        <span className="text-sm text-g500">{title} · {unit}</span>
        {current && (
          <span className="text-sm">
            <strong className="font-semibold">{formatValue(current.value)}</strong>
            {active === null && trend !== 'flat' && (
              <span className="price-history-change">
                {trend === 'up' ? <TrendUpIcon className="h-4 w-4" /> : <TrendDownIcon className="h-4 w-4" />}
                {changeLabel}
              </span>
            )}
            <span className="ml-2 text-g500">{formatTime(current.time)}</span>
          </span>
        )}
      </div>
      {plotted.length === 0 ? (
        <p className="price-history-empty">{loading ? loadingText : partial ? partialText : emptyText}</p>
      ) : (
        <svg
          className="price-history-plot"
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={`${title}, ${unit}. Latest ${formatValue(last.value)}${trend === 'flat' ? '' : `, ${trend} ${changeLabel} over the period shown`}. Use left and right arrow keys to read earlier values.`}
          tabIndex={0}
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          onPointerLeave={() => setActive(null)}
          onKeyDown={onKey}
          onBlur={() => setActive(null)}
        >
          {ticks.map((tick) => (
            <g key={tick.value}>
              <line x1={PAD.left} x2={width - PAD.right} y1={tick.y} y2={tick.y} className="grid" />
              <text x={PAD.left - 8} y={tick.y + 4} textAnchor="end" className="axis">{formatValue(tick.value)}</text>
            </g>
          ))}
          <text x={PAD.left} y={HEIGHT - 8} className="axis">{formatTime(plotted[0].time)}</text>
          {plotted.length > 1 && (
            <text x={width - PAD.right} y={HEIGHT - 8} textAnchor="end" className="axis">{formatTime(last.time)}</text>
          )}
          <path d={path} className="series" />
          {showMarkers && plotted.slice(0, -1).map((p, index) => <circle key={p.block + ':' + index} cx={p.x} cy={p.y} r={4} className="marker" />)}
          <circle cx={last.x} cy={last.y} r={5} className="marker marker-now" />
          {current && active !== null && (
            <g>
              <line x1={current.x} x2={current.x} y1={PAD.top} y2={HEIGHT - PAD.bottom} className="crosshair" />
              <circle cx={current.x} cy={current.y} r={5} className="marker marker-active" />
            </g>
          )}
        </svg>
      )}
      {plotted.length > 0 && (
        <div className="price-history-foot">
          <button type="button" className="text-sm underline" onClick={() => setShowTable((value) => !value)}>
            {showTable ? 'Hide table' : 'Show as table'}
          </button>
        </div>
      )}
      {showTable && plotted.length > 0 && (
        <table className="price-table">
          <thead><tr><th>Time</th><th>Block</th><th>{unit}</th></tr></thead>
          <tbody>
            {[...plotted].reverse().slice(0, 50).map((p, index) => (
              <tr key={p.block + ':' + index}><td>{formatTime(p.time)}</td><td>{p.block.toLocaleString('en-US')}</td><td>{formatValue(p.value)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
