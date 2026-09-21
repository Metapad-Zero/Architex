import type { ReactNode } from 'react'
import { activeChain } from '../chain'
import type { AppRoute } from '../hooks/useHashRoute'
import { isLaunchViewAvailable } from '../lib/deployment'
import { ARCH_PATH } from '../lib/logomark'
import { ConnectSheet } from './ConnectSheet'
import { WalletButton } from './WalletButton'

interface AppShellProps {
  route: AppRoute
  onRoute: (route: AppRoute) => void
  children: ReactNode
}

export function AppShell({ route, onRoute, children }: AppShellProps) {
  return (
    <div className="min-h-dvh overflow-x-hidden bg-paper text-ink">
      <header className="masthead">
        <div className="flex min-w-0 items-center gap-3 sm:gap-6">
          <button type="button" className="wordmark" onClick={() => onRoute({ view: 'swap' })}>
            <svg className="wordmark-mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
              <path d={ARCH_PATH} fill="none" stroke="currentColor" strokeWidth="9" />
              <rect x="2" y="36" width="60" height="8" fill="var(--accent)" />
            </svg>
            <span className="wordmark-text">Architex</span>
          </button>
          <span className="testnet-chip">{activeChain.isTestnet ? 'Testnet' : 'Beta'}</span>
          <nav className="ml-1 flex h-14 items-stretch sm:ml-4" aria-label="Primary">
            {(['swap', 'pools', ...(isLaunchViewAvailable ? (['launch'] as const) : []), 'bridge', 'docs'] as const).map((view) => (
              <button
                key={view}
                type="button"
                className="nav-tab"
                data-active={view === 'launch' ? route.view === 'launch' || route.view === 'launch-new' : route.view === view}
                aria-current={(view === 'launch' ? route.view === 'launch' || route.view === 'launch-new' : route.view === view) ? 'page' : undefined}
                onClick={() => onRoute(view === 'launch' ? { view: 'launch' } : { view })}
              >
                {view === 'swap' ? 'Swap' : view === 'pools' ? 'Pools' : view === 'launch' ? 'Launch' : view === 'bridge' ? 'Bridge' : 'Docs'}
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
      {!activeChain.isTestnet && (
        <footer className="mx-auto w-full max-w-[512px] px-4 pb-24 text-sm leading-6 text-g500">
          Beta. The Architex contracts have not been audited by a third party, so only use funds you can afford to lose.
        </footer>
      )}
      <ConnectSheet />
    </div>
  )
}
