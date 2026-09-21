type SplashListener = () => void

const listeners = new Set<SplashListener>()
let finished = false

export function isSplashFinished(): boolean {
  return finished
}

/** Subscribe before IntroSplash mounts so the finish signal is not missed. */
export function onSplashFinished(listener: SplashListener): () => void {
  if (finished) {
    const frame = requestAnimationFrame(() => listener())
    return () => cancelAnimationFrame(frame)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function markSplashFinished(): void {
  if (finished) return
  finished = true
  for (const listener of listeners) listener()
  listeners.clear()
}
