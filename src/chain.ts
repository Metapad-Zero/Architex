import { arc, arcTestnet } from 'viem/chains'
import { requireChain } from './onchain-facts'

export type ArcNetwork = 'testnet' | 'mainnet'

const requestedNetwork: unknown = import.meta.env.VITE_ARC_NETWORK

export const arcNetwork: ArcNetwork = requestedNetwork === 'mainnet' ? 'mainnet' : 'testnet'
export const activeViemChain = arcNetwork === 'mainnet' ? arc : arcTestnet

const facts = requireChain(activeViemChain.id)

if (!facts.usdc) {
  throw new Error(`USDC is not configured for ${facts.name}`)
}

// The public endpoint is rate-limited; production can point at a dedicated one without a code change.
const configuredRpc: unknown = import.meta.env.VITE_ARC_RPC_URL

export const activeChain = {
  id: facts.chainId,
  name: facts.name,
  explorerBase: facts.explorerBase,
  rpc: typeof configuredRpc === 'string' && configuredRpc.startsWith('https://') ? configuredRpc : facts.rpcUrls[0],
  usdc: facts.usdc.address as `0x${string}`,
  isTestnet: facts.isTestnet,
} as const

export function txExplorerUrl(hash: string): string {
  return `${activeChain.explorerBase}/tx/${hash}`
}

export function addressExplorerUrl(address: string): string {
  return `${activeChain.explorerBase}/address/${address}`
}
