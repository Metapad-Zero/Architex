import { http, createConfig, type CreateConnectorFn } from 'wagmi'
import { arc, arcTestnet } from 'viem/chains'
import { injected } from 'wagmi/connectors'
import { activeChain, arcNetwork } from './chain'
import { seedLocalWallet } from './lib/localWallet'
import { localWallet } from './lib/localWalletConnector'
import { hadWalletConnectSession, walletConnectConnector } from './lib/walletConnect'

// Development only. `import.meta.env.DEV` is a compile-time constant, so in a production build this
// whole branch (and the env keys it names) is dead code and never reaches the bundle. The seeded
// wallet is password-protected like any other; the password is VITE_DEV_BURNER_PASSWORD.
if (import.meta.env.DEV) {
  if (import.meta.env.VITE_DEV_BURNER_KEY && import.meta.env.VITE_DEV_BURNER_PASSWORD) {
    void seedLocalWallet(String(import.meta.env.VITE_DEV_BURNER_KEY), String(import.meta.env.VITE_DEV_BURNER_PASSWORD))
  }
  void import('./tracing').then((tracing) => tracing.registerChain(activeChain.id, activeChain.rpc))
}

const chain = arcNetwork === 'mainnet' ? arc : arcTestnet

// Injected (EIP-6963) wallets first; the browser wallet is always offered so a visitor with no
// extension can still get keys (created or imported in the connect sheet). WalletConnect joins at
// startup only to restore a previous session; otherwise the connect sheet adds it on demand, which
// keeps its large provider chunk off every other visitor's load.
const connectors: CreateConnectorFn[] = [injected(), localWallet({ chain, rpcUrl: activeChain.rpc })]
if (hadWalletConnectSession()) connectors.push(walletConnectConnector())

export const config =
  arcNetwork === 'mainnet'
    ? createConfig({
        chains: [arc],
        connectors,
        transports: { [arc.id]: http(activeChain.rpc) },
      })
    : createConfig({
        chains: [arcTestnet],
        connectors,
        transports: { [arcTestnet.id]: http(activeChain.rpc) },
      })

export const ARC_CHAIN_ID = activeChain.id
