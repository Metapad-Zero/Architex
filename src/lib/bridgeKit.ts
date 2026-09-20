/**
 * Circle App Kit is a large CCTP client. It loads only when the Bridge view runs a quote or a
 * transfer, the same way WalletConnect stays off the first paint.
 */
import type { EIP1193Provider } from 'viem'
import type { BridgeChain } from './cctp'

export type KitEvent = { method?: string; values?: { name?: string; state?: string; txHash?: string; explorerUrl?: string } }

type AppKit = {
  bridge: (params: Record<string, unknown>) => Promise<BridgeKitResult>
  retryBridge: (result: BridgeKitResult, retry: { from: unknown; to?: unknown }) => Promise<BridgeKitResult>
  estimateBridge: (params: Record<string, unknown>) => Promise<EstimateKitResult>
  on: (event: string, handler: (payload: KitEvent) => void) => void
}

export interface BridgeKitResult {
  state: 'pending' | 'success' | 'error'
  amount: string
  steps: { name?: string; state?: string; txHash?: string; explorerUrl?: string; error?: unknown }[]
}

export interface EstimateKitResult {
  amount: string
  fees: { type: string; token: string; amount: string | null }[]
  gasFees: { name: string; token: string; fees: { estimated?: string; amount?: string } | string | null }[]
}

let kitPromise: Promise<AppKit> | undefined

export async function getAppKit(): Promise<AppKit> {
  if (!kitPromise) {
    kitPromise = import('@circle-fin/app-kit').then((mod) => new mod.AppKit() as unknown as AppKit)
  }
  return kitPromise
}

export async function evmAdapter(provider: EIP1193Provider) {
  const { createViemAdapterFromProvider } = await import('@circle-fin/adapter-viem-v2')
  return createViemAdapterFromProvider({ provider })
}

export async function solanaAdapter(provider: unknown) {
  const { createSolanaAdapterFromProvider } = await import('@circle-fin/adapter-solana')
  return createSolanaAdapterFromProvider({ provider: provider as never })
}

export function destinationContext(adapter: unknown, chain: BridgeChain, recipient?: string) {
  const base: Record<string, unknown> = { chain: chain.kit, useForwarder: true }
  if (adapter) base.adapter = adapter
  if (recipient) base.recipientAddress = recipient
  return base
}

export function sourceContext(adapter: unknown, chain: BridgeChain, address?: string) {
  const base: Record<string, unknown> = { adapter, chain: chain.kit }
  if (address) base.address = address
  return base
}

export function totalUsdcFees(estimate: EstimateKitResult | undefined): bigint {
  if (!estimate) return 0n
  let total = 0n
  for (const fee of estimate.fees) {
    if (fee.token !== 'USDC' || !fee.amount) continue
    const [whole = '0', fraction = ''] = fee.amount.split('.')
    total += BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6))
  }
  return total
}
