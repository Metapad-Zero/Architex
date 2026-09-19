import { useCallback, useEffect, useState } from 'react'
import type { Address } from 'viem'

export type AppRoute = { view: 'swap' } | { view: 'pools'; pair?: Address }

function readRoute(): AppRoute {
  const hash = window.location.hash || '#swap'
  if (hash.startsWith('#pools/')) return { view: 'pools', pair: hash.slice('#pools/'.length) as Address }
  if (hash === '#pools') return { view: 'pools' }
  return { view: 'swap' }
}

export function useHashRoute() {
  const [route, setRouteState] = useState<AppRoute>(readRoute)

  useEffect(() => {
    const onHashChange = () => setRouteState(readRoute())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const setRoute = useCallback((next: AppRoute) => {
    const update = () => {
      window.location.hash = next.view === 'swap' ? '#swap' : next.pair ? `#pools/${next.pair}` : '#pools'
      setRouteState(next)
    }
    if ('startViewTransition' in document) {
      document.startViewTransition(update)
    } else {
      update()
    }
  }, [])

  return { route, setRoute }
}
