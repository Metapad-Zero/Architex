import type { ReactNode } from 'react'
import { activeChain } from '../chain'
import type { AppRoute } from '../hooks/useHashRoute'
import { ConnectSheet } from './ConnectSheet'
import { WalletButton } from './WalletButton'

interface AppShellProps {
  route: AppRoute
  onRoute: (route: AppRoute) => void
  children: ReactNode
}

export function AppShell({ route, onRoute, children }: AppShellProps) {
  return (
    <div className="min-h-dvh bg-paper text-ink">
      <header className="masthead">
        <div className="flex min-w-0 items-center gap-3 sm:gap-6">
          <button type="button" className="wordmark" onClick={() => onRoute({ view: 'swap' })}>Architex</button>
          {activeChain.isTestnet && <span className="testnet-chip">Testnet</span>}
          <nav className="ml-1 flex h-14 items-stretch sm:ml-4" aria-label="Primary">
            {(['swap', 'pools'] as const).map((view) => (
              <button
                key={view}
                type="button"
                className="nav-tab"
                data-active={route.view === view}
                aria-current={route.view === view ? 'page' : undefined}
                onClick={() => onRoute({ view })}
              >
                {view === 'swap' ? 'Swap' : 'Pools'}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden text-sm text-g500 lg:inline">{activeChain.name}</span>
          <WalletButton />
        </div>
      </header>
      <main>{children}</main>
      <ConnectSheet />
    </div>
  )
}
