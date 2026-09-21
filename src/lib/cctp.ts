/**
 * Circle CCTP v2: native USDC in and out of Arc. Ethereum and Solana are the two foreign
 * books this DEX opens. Kit chain names and domains come from Circle; Arc's contracts come
 * from onchain-facts.
 */
import { type Address, type EIP1193Provider, type Hex } from 'viem'
import { activeChain, arcNetwork } from '../chain'
import { EVM_PROTOCOL_CONTRACTS } from '../onchain-facts'

export type ForeignChain = 'ethereum' | 'solana'
export type BridgeSide = 'in' | 'out'
export type BridgeChainId = 'arc' | ForeignChain

export interface BridgeChain {
  id: BridgeChainId
  /** Identifier App Kit / Bridge Kit accept as `chain`. */
  kit: string
  label: string
  domain: number
  kind: 'evm' | 'solana'
  usdc: string
  decimals: 6
  explorerTx: (hash: string) => string
  chainId?: number
  rpc?: string
  tokenMessenger?: Address
  messageTransmitter?: Address
}

const TESTNET = arcNetwork !== 'mainnet'

// The public mainnet-beta endpoint refuses browser origins (403), so mainnet Solana needs a keyed
// RPC that allows this site's origin. Without one, Solana is left out of the bridge entirely.
const configuredSolanaRpc: unknown = import.meta.env.VITE_SOLANA_RPC_URL
const SOLANA_MAINNET_RPC = typeof configuredSolanaRpc === 'string' && configuredSolanaRpc.startsWith('https://') ? configuredSolanaRpc : undefined

const protocol = (name: string, networkKind: 'testnet' | 'mainnet'): Address | undefined => {
  const row = EVM_PROTOCOL_CONTRACTS.find((item) => item.name === name && item.networkKind === networkKind)
  return row?.address as Address | undefined
}

const TESTNET_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' as Address
const TESTNET_TRANSMITTER = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275' as Address
const MAINNET_MESSENGER = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d' as Address
const MAINNET_TRANSMITTER = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64' as Address

export const IRIS_BASE = TESTNET ? 'https://iris-api-sandbox.circle.com' : 'https://iris-api.circle.com'

export const BRIDGE_CHAINS: Record<BridgeChainId, BridgeChain> = TESTNET
  ? {
      arc: {
        id: 'arc',
        kit: 'Arc_Testnet',
        label: 'Arc Testnet',
        domain: 26,
        kind: 'evm',
        usdc: '0x3600000000000000000000000000000000000000',
        decimals: 6,
        chainId: 5042002,
        rpc: activeChain.rpc,
        explorerTx: (hash) => `https://explorer.testnet.arc.io/tx/${hash}`,
        tokenMessenger: protocol('TokenMessengerV2', 'testnet') ?? TESTNET_MESSENGER,
        messageTransmitter: protocol('MessageTransmitterV2', 'testnet') ?? TESTNET_TRANSMITTER,
      },
      ethereum: {
        id: 'ethereum',
        kit: 'Ethereum_Sepolia',
        label: 'Ethereum Sepolia',
        domain: 0,
        kind: 'evm',
        usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        decimals: 6,
        chainId: 11155111,
        rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
        explorerTx: (hash) => `https://sepolia.etherscan.io/tx/${hash}`,
        tokenMessenger: TESTNET_MESSENGER,
        messageTransmitter: TESTNET_TRANSMITTER,
      },
      solana: {
        id: 'solana',
        kit: 'Solana_Devnet',
        label: 'Solana Devnet',
        domain: 5,
        kind: 'solana',
        usdc: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        decimals: 6,
        rpc: 'https://api.devnet.solana.com',
        explorerTx: (hash) => `https://solscan.io/tx/${hash}?cluster=devnet`,
      },
    }
  : {
      arc: {
        id: 'arc',
        kit: 'Arc',
        label: 'Arc',
        domain: 26,
        kind: 'evm',
        usdc: '0x3600000000000000000000000000000000000000',
        decimals: 6,
        chainId: 5042,
        rpc: activeChain.rpc,
        explorerTx: (hash) => `https://explorer.arc.io/tx/${hash}`,
        tokenMessenger: protocol('TokenMessengerV2', 'mainnet') ?? MAINNET_MESSENGER,
        messageTransmitter: protocol('MessageTransmitterV2', 'mainnet') ?? MAINNET_TRANSMITTER,
      },
      ethereum: {
        id: 'ethereum',
        kit: 'Ethereum',
        label: 'Ethereum',
        domain: 0,
        kind: 'evm',
        usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        decimals: 6,
        chainId: 1,
        rpc: 'https://ethereum.publicnode.com',
        explorerTx: (hash) => `https://etherscan.io/tx/${hash}`,
        tokenMessenger: MAINNET_MESSENGER,
        messageTransmitter: MAINNET_TRANSMITTER,
      },
      solana: {
        id: 'solana',
        kit: 'Solana',
        label: 'Solana',
        domain: 5,
        kind: 'solana',
        usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        decimals: 6,
        rpc: SOLANA_MAINNET_RPC,
        explorerTx: (hash) => `https://solscan.io/tx/${hash}`,
      },
    }

export const FOREIGN_CHAINS: readonly ForeignChain[] = BRIDGE_CHAINS.solana.rpc ? ['ethereum', 'solana'] : ['ethereum']

export function sourceChain(side: BridgeSide, foreign: ForeignChain): BridgeChain {
  return side === 'in' ? BRIDGE_CHAINS[foreign] : BRIDGE_CHAINS.arc
}

export function destChain(side: BridgeSide, foreign: ForeignChain): BridgeChain {
  return side === 'in' ? BRIDGE_CHAINS.arc : BRIDGE_CHAINS[foreign]
}

export function irisMessagesUrl(sourceDomain: number, transactionHash: string): string {
  return `${IRIS_BASE}/v2/messages/${sourceDomain}?transactionHash=${encodeURIComponent(transactionHash)}`
}

export interface IrisMessage {
  attestation: string
  message: string
  status: string
}

export async function fetchIrisMessage(sourceDomain: number, transactionHash: string): Promise<IrisMessage | undefined> {
  const response = await fetch(irisMessagesUrl(sourceDomain, transactionHash))
  if (!response.ok) throw new Error(`Attestation service returned ${response.status}`)
  const body: unknown = await response.json()
  if (!body || typeof body !== 'object') return undefined
  const messages = (body as { messages?: unknown }).messages
  if (!Array.isArray(messages) || messages.length === 0) return undefined
  const first = messages[0] as { attestation?: unknown; message?: unknown; status?: unknown }
  if (typeof first.message !== 'string' || typeof first.attestation !== 'string') return undefined
  return { message: first.message, attestation: first.attestation, status: typeof first.status === 'string' ? first.status : 'pending' }
}

export const messageTransmitterAbi = [
  {
    name: 'receiveMessage',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'message', type: 'bytes' },
      { name: 'attestation', type: 'bytes' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

export function isMessenger(address: string | undefined): boolean {
  if (!address) return false
  const needle = address.toLowerCase()
  return Object.values(BRIDGE_CHAINS).some((chain) => chain.tokenMessenger?.toLowerCase() === needle)
}

export function isTransmitter(address: string | undefined): boolean {
  if (!address) return false
  const needle = address.toLowerCase()
  return Object.values(BRIDGE_CHAINS).some((chain) => chain.messageTransmitter?.toLowerCase() === needle)
}

export function domainLabel(domain: number): string {
  const match = Object.values(BRIDGE_CHAINS).find((chain) => chain.domain === domain)
  return match?.label ?? `domain ${domain}`
}

export function bytes32ToAddress(value: Hex): Address {
  return `0x${value.slice(-40)}`
}

export async function fetchEvmUsdcBalance(chain: BridgeChain, owner: Address): Promise<bigint> {
  const { createPublicClient, http, erc20Abi } = await import('viem')
  const client = createPublicClient({ transport: http(chain.rpc) })
  return client.readContract({
    address: chain.usdc as Address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  })
}

export async function switchEvmChain(provider: EIP1193Provider, chain: BridgeChain): Promise<void> {
  if (!chain.chainId) return
  const hexId = `0x${chain.chainId.toString(16)}`
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] })
  } catch (error) {
    if ((error as { code?: number }).code === 4001) throw error
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: hexId,
        chainName: chain.label,
        nativeCurrency: chain.id === 'arc' ? { name: 'USDC', symbol: 'USDC', decimals: 18 } : { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: chain.rpc ? [chain.rpc] : [],
        blockExplorerUrls: [chain.explorerTx('').replace(/\/tx\/$/, '')],
      }],
    })
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] })
  }
}

export async function fetchSplUsdcBalance(chain: BridgeChain, owner: string): Promise<bigint> {
  if (!chain.rpc) throw new Error('No Solana RPC is configured')
  const response = await fetch(chain.rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTokenAccountsByOwner',
      params: [owner, { mint: chain.usdc }, { encoding: 'jsonParsed' }],
    }),
  })
  if (!response.ok) throw new Error(`Solana RPC returned ${response.status}`)
  const body: unknown = await response.json()
  const values = (body as { result?: { value?: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] } }).result?.value
  if (!values) return 0n
  let total = 0n
  for (const item of values) {
    const raw = item.account.data.parsed.info.tokenAmount.amount
    total += BigInt(raw)
  }
  return total
}
