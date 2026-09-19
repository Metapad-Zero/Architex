import type { Config, Connector, CreateConnectorFn } from 'wagmi'
import { walletConnect } from 'wagmi/connectors'

/**
 * WalletConnect (phone wallets by QR code or deep link) through Reown's relay.
 *
 * The connector is small; the WalletConnect provider and Reown's QR modal behind it are a large
 * lazy chunk that wagmi imports only when the connector is first used. So the connector joins the
 * wagmi config on demand: at startup only for a browser that used WalletConnect last time (to
 * restore its session), otherwise the moment someone picks the WalletConnect row.
 */
export const WALLETCONNECT_CONNECTOR_ID = 'walletConnect'

// A Reown project id is a public identifier: it ships to every browser and is guarded by the
// project's domain allowlist (dashboard.reown.com), not by secrecy. VITE_REOWN_PROJECT_ID overrides it.
const DEFAULT_REOWN_PROJECT_ID = '6961f02e49244d0b68d06345eafedb1c'
const configuredProjectId: unknown = import.meta.env.VITE_REOWN_PROJECT_ID
export const reownProjectId = typeof configuredProjectId === 'string' && configuredProjectId.length > 0 ? configuredProjectId : DEFAULT_REOWN_PROJECT_ID

function prefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function walletConnectConnector(): CreateConnectorFn {
  const origin = typeof window === 'undefined' ? 'https://architex.app' : window.location.origin
  const dark = prefersDark()
  return walletConnect({
    projectId: reownProjectId,
    showQrModal: true,
    metadata: {
      name: 'Architex',
      description: 'Swap and provide liquidity on Arc.',
      url: origin,
      icons: [`${origin}/icon.svg`],
    },
    qrModalOptions: {
      themeMode: dark ? 'dark' : 'light',
      themeVariables: {
        '--wcm-font-family': '"Public Sans Variable", "Public Sans", system-ui, sans-serif',
        '--wcm-container-border-radius': '1px',
        '--wcm-z-index': '2147483000',
        // The accent also colours the QR dots, which sit on a white card in both themes, so it
        // stays ink in light mode and is left at Reown's default in dark mode to keep the code scannable.
        ...(dark ? {} : { '--wcm-accent-color': '#000000' }),
      },
    },
  })
}

/** True when this browser's last connection was WalletConnect, so its session can be restored on load. */
export function hadWalletConnectSession(): boolean {
  try {
    return (window.localStorage.getItem('wagmi.recentConnectorId') ?? '').includes(WALLETCONNECT_CONNECTOR_ID)
  } catch {
    return false
  }
}

/** The one WalletConnect connector of this config, created and registered on first use. */
export function ensureWalletConnectConnector(config: Config): Connector {
  const existing = config.connectors.find((connector) => connector.id === WALLETCONNECT_CONNECTOR_ID)
  if (existing) return existing
  const connector = config._internal.connectors.setup(walletConnectConnector())
  config._internal.connectors.setState((current) => [...current, connector])
  return connector
}
