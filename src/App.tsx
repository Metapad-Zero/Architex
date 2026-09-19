import { lazy, Suspense } from 'react'
import { AppShell } from './components/AppShell'
import { SwapSheet } from './components/SwapSheet'
import { TableSkeleton } from './components/Skeleton'
import { useHashRoute } from './hooks/useHashRoute'

const PoolsView = lazy(() => import('./components/PoolsView').then((module) => ({ default: module.PoolsView })))

export default function App() {
  const { route, setRoute } = useHashRoute()
  return (
    <AppShell route={route} onRoute={setRoute}>
      {route.view === 'swap' ? (
        <SwapSheet />
      ) : (
        <Suspense fallback={<div className="pools-page"><TableSkeleton rows={5} /></div>}>
          <PoolsView selectedPair={route.pair} onSelectPair={(pair) => setRoute({ view: 'pools', pair })} />
        </Suspense>
      )}
    </AppShell>
  )
}
