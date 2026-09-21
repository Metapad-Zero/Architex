/*
 *  ███████╗████████╗██╗   ██╗██████╗ ██╗ ██████╗
 *  ██╔════╝╚══██╔══╝██║   ██║██╔══██╗██║██╔═══██╗
 *  ███████╗   ██║   ██║   ██║██║  ██║██║██║   ██║
 *  ╚════██║   ██║   ██║   ██║██║  ██║██║██║   ██║
 *  ███████║   ██║   ╚██████╔╝██████╔╝██║╚██████╔╝
 *  ╚══════╝   ╚═╝    ╚═════╝ ╚═════╝ ╚═╝ ╚═════╝
 *
 *  Built with Arc Studio
 *  https://studio.arc.io
 */

// Arc Studio's trace panel and console capture serve the dev preview only; production ships without them.
if (import.meta.env.DEV) {
  void import('./tracing')
  void import('./console-capture')
}

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { config } from './config'
import { ConnectSheetProvider } from './hooks/useConnectSheet'
import { ErrorBoundary } from './components/ErrorBoundary'
import { IntroSplash } from './components/IntroSplash'
import { UnlockSheet } from './components/UnlockSheet'
import { UpdatesSheet } from './components/UpdatesSheet'
import App from './App'
import './index.css'

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>
          <ConnectSheetProvider>
            <div className="app-reveal">
              <App />
            </div>
            <UnlockSheet />
            <UpdatesSheet />
            <IntroSplash />
          </ConnectSheetProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </ErrorBoundary>
  </StrictMode>,
)

