/** A short burst for the moments worth marking: a new pool, a new token. Loaded only when it fires; skipped under prefers-reduced-motion. */
export async function celebrate(): Promise<void> {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const { default: confetti } = await import('canvas-confetti')
  // canvas-confetti needs literal colours; the ink token is a light-dark() pair, not a resolvable value.
  const ink = window.matchMedia('(prefers-color-scheme: dark)').matches ? '#ffffff' : '#000000'
  const burst = { particleCount: 70, spread: 60, startVelocity: 48, ticks: 220, colors: ['#ffd400', '#ffd400', ink], disableForReducedMotion: true }
  void confetti({ ...burst, angle: 60, origin: { x: 0, y: 0.9 } })
  void confetti({ ...burst, angle: 120, origin: { x: 1, y: 0.9 } })
}
