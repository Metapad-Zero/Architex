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
  /** OP Stack chain: bound the L1 data fee with GasPriceOracle.getL1FeeUpperBound before sending. */
  opStackL1Fee?: boolean
}
/**
 * What an approval authorizes, carried inside the approved configuration. The adapter enforces it:
 * at most `launches` paid jobs, only this payer, recipient and exact allocation, a quoted total no
 * higher than `maxTotal`, and cumulative operator gas (native wei, L1 fee included) within
 * `operatorGas` per chain. Nothing is sent that could cross a cap.
 */
export interface PilotScope {
  launches: number
  payer: Address
  recipient: Address
  issuance: Atoms
  destinations: { chain: 'arc' | 'base'; amount: Atoms; poolTokens: Atoms; poolQuote: Atoms }[]
  maxTotal: Atoms
  operatorGas: { arc: string; base: string }
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
  /** Required for testnet; forks may omit it. */
  scope?: PilotScope
}
