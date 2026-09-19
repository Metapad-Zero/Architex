import { useCallback, useEffect, useState } from 'react'
import { isAddress, type Address } from 'viem'

export type AppRoute =
  | { view: 'swap' }
  | { view: 'pools'; pair?: Address }
  | { view: 'launch'; token?: Address }
  | { view: 'launch-new' }

function hashFor(next: AppRoute): string {
  if (next.view === 'swap') return '#swap'
  if (next.view === 'pools') return next.pair ? `#pools/${next.pair}` : '#pools'
  if (next.view === 'launch-new') return '#launch/new'
  return next.token ? `#launch/${next.token}` : '#launch'
}

function readRoute(): AppRoute {
  const hash = window.location.hash || '#swap'
  if (hash.startsWith('#pools/')) return { view: 'pools', pair: hash.slice('#pools/'.length) as Address }
  if (hash === '#pools') return { view: 'pools' }
  if (hash === '#launch/new') return { view: 'launch-new' }
  if (hash.startsWith('#launch/')) {
    const token = hash.slice('#launch/'.length)
    return isAddress(token) ? { view: 'launch', token } : { view: 'launch' }
  }
  if (hash === '#launch') return { view: 'launch' }
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
      window.location.hash = hashFor(next)
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
