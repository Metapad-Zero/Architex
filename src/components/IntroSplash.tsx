import { useCallback, useRef, useState } from 'react'
import { ARCH_PATH } from '../lib/logomark'

type Phase = 'playing' | 'exiting' | 'done'

/**
 * A one-time brand moment on load: the arch draws in, the bar and wordmark follow, then the
 * whole thing fades to reveal the app underneath (already mounted and rendered — this only ever
 * covers it, never blocks it from loading). `prefers-reduced-motion` collapses every animation
 * here to near-zero duration globally (see the media query in index.css), so this still runs
 * the same phase transitions, just almost instantly, rather than needing a separate code path.
 */
export function IntroSplash() {
  const [phase, setPhase] = useState<Phase>('playing')
  const advanced = useRef(false)

  const startExit = useCallback(() => {
    if (advanced.current) return
    advanced.current = true
    setPhase('exiting')
  }, [])

  if (phase === 'done') return null

  return (
    <div
      className="intro-splash"
      data-phase={phase}
      aria-hidden="true"
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget && phase === 'exiting') setPhase('done')
      }}
    >
      <div className="intro-mark">
        <svg viewBox="0 0 64 64" focusable="false">
          <path className="intro-arch" d={ARCH_PATH} fill="none" stroke="#fff" strokeWidth="9" pathLength={1} />
          <rect className="intro-bar" x="0" y="36" width="64" height="8" fill="#ffd400" />
        </svg>
        <span className="intro-wordmark" onAnimationEnd={startExit}>
          Architex
        </span>
      </div>
    </div>
  )
}
