import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  failed: boolean
}

/**
 * The last line of defence: without it any render or effect error unmounts the whole app and leaves
 * a blank page. Funds are never at risk from a UI crash (nothing signs without the owner), and the
 * screen says so, because that is the first thing someone mid-swap needs to know.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Architex crashed:', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-[512px] flex-col justify-center px-4">
        <h1 className="text-xl font-semibold tracking-[-0.01em]">Architex stopped unexpectedly</h1>
        <p className="mt-3 text-sm leading-6 text-g700">
          Nothing was signed or sent by this error: a transaction only happens after you confirm it in your wallet. Reload to carry on; a transaction you already confirmed will show in your wallet or on ArcScan.
        </p>
        <button type="button" className="primary-button mt-6 w-full" onClick={() => window.location.reload()}>
          <span>Reload Architex</span>
        </button>
      </main>
    )
  }
}
