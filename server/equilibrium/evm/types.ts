import type { Address, Hex } from 'viem'
import type { Atoms, StepKind } from '../types'
import type { VaaSource } from './vaa'

export type Venue = { kind: 'architex'; factory: Address } | { kind: 'uniswap-v3'; factory: Address; fee: number; tickSpacing: number }
export interface ChainConfig {
  chain: 'arc' | 'base'
  rpc: string
  chainId: number
  wormholeChainId: number
  core: Address
  /** EquilibriumExecutor owned by the operator. Every effect on this chain goes through it. */
  executor: Address
  /** Deployed NTT TransceiverStructs library, linked into manager and transceiver code. */
  transceiverStructs: Address
  usdc: Address
  /** 'finalized' reads the chain's finalized tag; a number counts confirmations on top of latest. */
  finality: 'finalized' | number
  /** USDC atoms per 1e18 wei of native gas. Arc gas is native USDC with 18 decimals: 1_000_000. */
  usdcAtomsPerNative: bigint
  venue: Venue
  /** Lowest block searched for executions of this adapter's operations. */
  fromBlock: bigint
  /** Priority fee in wei. Unset lets the RPC suggest one; set it where the suggestion is unrealistic. */
  priorityFeeWei?: bigint
}
export interface EvmAdapterConfig {
  mode: 'fork' | 'testnet'
  operatorKey: Hex
  arc: ChainConfig
  base: ChainConfig
  vaa: VaaSource
  /** NTT rate limits in token atoms per 24 hours. Inbound must cover a whole allocation or the credit queues. */
  limits: { outbound: bigint; inbound: bigint }
  budgets: Record<StepKind, Atoms>
  receiptTimeoutMs?: number
}
