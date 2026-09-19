import { lazy, Suspense } from 'react'
import { AppShell } from './components/AppShell'
import { SwapSheet } from './components/SwapSheet'
import { TableSkeleton } from './components/Skeleton'
import { useHashRoute } from './hooks/useHashRoute'
import { isLaunchViewAvailable } from './lib/deployment'

const PoolsView = lazy(() => import('./components/PoolsView').then((module) => ({ default: module.PoolsView })))
const LaunchView = lazy(() => import('./components/LaunchView').then((module) => ({ default: module.LaunchView })))

export default function App() {
  const { route, setRoute } = useHashRoute()
  const launchRoute = isLaunchViewAvailable && (route.view === 'launch' || route.view === 'launch-new')
  return (
    <AppShell route={route} onRoute={setRoute}>
      {route.view === 'pools' ? (
        <Suspense fallback={<div className="pools-page"><TableSkeleton rows={5} /></div>}>
          <PoolsView selectedPair={route.pair} onSelectPair={(pair) => setRoute({ view: 'pools', pair })} />
        </Suspense>
      ) : launchRoute ? (
        <Suspense fallback={<div className="pools-page"><TableSkeleton rows={5} /></div>}>
          <LaunchView
            token={route.view === 'launch' ? route.token : undefined}
            creating={route.view === 'launch-new'}
            onOpen={(token) => setRoute({ view: 'launch', token })}
            onCreate={() => setRoute({ view: 'launch-new' })}
            onCreated={(token) => setRoute({ view: 'launch', token })}
          />
        </Suspense>
      ) : (
        <SwapSheet />
      )}
    </AppShell>
  )
}
