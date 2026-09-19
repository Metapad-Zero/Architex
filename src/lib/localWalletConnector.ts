/**
 * wagmi connector for the browser wallet (src/lib/localWallet.ts).
 *
 * Every signature goes through the confirm sheet (src/lib/unlock.ts): the owner sees the exact
 * request and unlocks the encrypted key with a passkey or password for that one use. Everything
 * that is not a signature is forwarded to the chain's public RPC. The address is read at connect
 * time, so creating or importing a wallet in the connect sheet makes this connector usable without
 * a reload.
 */
import { createConnector } from 'wagmi'
import {
  createPublicClient,
  createWalletClient,
  http,
  numberToHex,
  type Chain,
  type Hex,
  type TypedDataDefinition,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { hasLocalWallet, localWalletAddress, NoLocalWalletError, whenLocalWalletReady } from './localWallet'
import type { TxRequest } from './signingIntent'
import { requestUnlock } from './unlock'

export const LOCAL_WALLET_CONNECTOR_ID = 'local'

interface LocalWalletOptions {
  chain: Chain
  rpcUrl: string
}

interface RequestArgs {
  method: string
  params?: unknown
}

type Listener = (...args: unknown[]) => void

export function localWallet({ chain, rpcUrl }: LocalWalletOptions) {
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
  const listeners = new Map<string, Set<Listener>>()

  const currentAddress = () => {
    const address = localWalletAddress()
    if (!address) throw new NoLocalWalletError()
    return address
  }

  const assertOwner = (claimed: unknown, what: string) => {
    const address = currentAddress()
    if (typeof claimed === 'string' && claimed.toLowerCase() !== address.toLowerCase()) {
      throw new Error(`${what} does not match the browser wallet.`)
    }
    return address
  }

  const provider = {
    async request(args: RequestArgs): Promise<unknown> {
      const params = Array.isArray(args.params) ? (args.params as unknown[]) : []
      switch (args.method) {
        case 'eth_accounts':
        case 'eth_requestAccounts':
          return [currentAddress()]
        case 'eth_chainId':
          return numberToHex(chain.id)
        case 'wallet_switchEthereumChain':
        case 'wallet_addEthereumChain':
          return null
        case 'eth_sign':
        case 'eth_signTransaction':
          throw new Error('The browser wallet does not sign raw messages or offline transactions.')
        case 'eth_sendTransaction': {
          const tx = (params[0] ?? {}) as TxRequest
          assertOwner(tx.from, 'Transaction "from"')
          const key = await requestUnlock({ kind: 'transaction', tx })
          const walletClient = createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(rpcUrl) })
          return walletClient.sendTransaction({
            to: tx.to,
            data: tx.data,
            value: tx.value ? BigInt(tx.value) : undefined,
            gas: tx.gas ? BigInt(tx.gas) : undefined,
          })
        }
        case 'eth_signTypedData_v4': {
          assertOwner(params[0], 'Signer')
          const raw = params[1]
          const typed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as TypedDataDefinition
          const key = await requestUnlock({ kind: 'typedData', typed })
          return privateKeyToAccount(key).signTypedData(typed)
        }
        case 'personal_sign': {
          assertOwner(params[1], 'Signer')
          const message = params[0] as Hex
          const key = await requestUnlock({ kind: 'message', message })
          return privateKeyToAccount(key).signMessage({ message: { raw: message } })
        }
        default:
          return (publicClient.request as (request: RequestArgs) => Promise<unknown>)(args)
      }
    },
    on(event: string, listener: Listener) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(listener)
    },
    removeListener(event: string, listener: Listener) {
      listeners.get(event)?.delete(listener)
    },
  }

  return createConnector<typeof provider>(() => ({
    id: LOCAL_WALLET_CONNECTOR_ID,
    name: 'Browser wallet',
    type: 'local',
    setup() {
      return Promise.resolve()
    },
    connect(parameters?: { withCapabilities?: boolean }) {
      let address: Hex
      try {
        address = currentAddress()
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new NoLocalWalletError())
      }
      const accounts = parameters?.withCapabilities ? [{ address, capabilities: {} }] : [address]
      // wagmi types this return conditionally on `withCapabilities`; both shapes are produced above.
      return Promise.resolve({ accounts, chainId: chain.id } as never)
    },
    disconnect() {
      return Promise.resolve()
    },
    getAccounts() {
      const address = localWalletAddress()
      return Promise.resolve(address ? [address] : [])
    },
    getChainId() {
      return Promise.resolve(chain.id)
    },
    getProvider() {
      return Promise.resolve(provider)
    },
    isAuthorized() {
      return whenLocalWalletReady().then(() => hasLocalWallet())
    },
    switchChain({ chainId }) {
      if (chainId !== chain.id) return Promise.reject(new Error('The browser wallet follows the app chain.'))
      return Promise.resolve(chain)
    },
    onAccountsChanged() {},
    onChainChanged() {},
    onDisconnect() {},
  }))
}
