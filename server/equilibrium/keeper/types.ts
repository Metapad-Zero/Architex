import type { Address, Hex } from 'viem'

export const KEEPER_CHAINS = ['arc', 'base'] as const
export type KeeperChain = (typeof KEEPER_CHAINS)[number]
export const LEG_KINDS = ['buy', 'sell', 'recover'] as const
export type LegKind = (typeof LEG_KINDS)[number]
/** Solidity `EquilibriumKeeper.LegKind`. */
export const LEG_KIND_INDEX: Record<LegKind, number> = { buy: 0, sell: 1, recover: 2 }
export const VENUE_INDEX = { 'architex-pair': 0, 'uniswap-v3-pool': 1 } as const
export type KeeperVenue = keyof typeof VENUE_INDEX

/** One chain's keeper vault, its pool and the bounds compiled into the vault. */
export interface KeeperChainConfig {
  chain: KeeperChain
  rpc: string
  chainId: number
  /** Deployed EquilibriumKeeper. Every keeper effect on this chain goes through it. */
  keeper: Address
  token: Address
  quote: Address
  pool: Address
  venue: KeeperVenue
  /** 'finalized' reads the chain's finalized tag; a number counts confirmations on top of latest. */
  finality: 'finalized' | number
  /** Lowest block searched for this keeper's legs. */
  fromBlock: bigint
  /** Quote atoms per 1e18 wei of native gas. Arc gas is native USDC with 18 decimals: 1_000_000. */
  quoteAtomsPerNative: bigint
  /** Priority fee in wei. Unset lets the RPC suggest one; set it where the suggestion is unrealistic. */
  priorityFeeWei?: bigint
  /** OP Stack chain: bound the L1 data fee with GasPriceOracle.getL1FeeUpperBound before sending. */
  opStackL1Fee?: boolean
}

/**
 * Off-chain bounds. Those the vault also enforces on-chain are marked; the rest are cross-chain
 * facts no single-chain contract can see, and are enforced against the durable keeper record.
 */
export interface KeeperPolicy {
  /** Largest token quantity one cycle may trade. On-chain: `maxTokensPerLeg`. */
  maxTokens: string
  /** Smallest net edge, in quote atoms, that justifies opening a cycle. Off-chain only. */
  minEdge: string
  /** Execution buffer subtracted from the edge on top of measured costs. Off-chain only. */
  buffer: string
  /** Cumulative quote a cycle may spend across the session. On-chain per chain: `spendCap`. */
  spendCap: string
  /** Cumulative realized loss that halts the keeper for the session. Off-chain only. */
  lossCap: string
  /** Quote each chain must retain after a buy. On-chain: `recoveryReserve`. */
  recoveryReserve: string
  /** Quote atoms held back for the recovery leg's own gas and fees. Off-chain only. */
  recoveryCost: string
  /** Absolute ceiling on one leg's worst-case gas, whatever the cycle's edge. Off-chain only. */
  maxLegCost: string
  /** A quote older than this many seconds is stale and never traded on. Off-chain + leg deadline. */
  maxQuoteAgeSeconds: number
  /** A quote more than this many blocks behind its chain's head is stale. Off-chain only. */
  maxBlockLag: number
  /** A chain whose head has not advanced between two reads this far apart is unavailable. */
  maxHeadAgeSeconds: number
  /** Seconds a planned leg stays valid on-chain. On-chain: `Leg.deadline`. */
  legTtlSeconds: number
  /** Slippage allowance in basis points applied to each leg's on-chain limit. */
  slippageBps: number
  /** Cycles allowed open at once. On-chain: `maxOpenCycles`. */
  maxOpenCycles: number
}

export interface KeeperConfig {
  mode: 'fork' | 'testnet'
  operatorKey: Hex
  arc: KeeperChainConfig
  base: KeeperChainConfig
  policy: KeeperPolicy
  receiptTimeoutMs?: number
  /** Required for testnet: the digest of the approved keeper preview. */
  approval?: Hex
  /** Separately transfer-approved maintenance; absent closes the maintenance rail. */
  maintenance?: KeeperMaintenancePolicy
}

export interface KeeperMaintenancePolicy {
  launch: Hex
  executors: Record<KeeperChain, Address>
  maxTokenPerTransfer: string
  maxTokenTotal: string
  maxQuotePerTransfer: string
  maxQuoteTotal: string
}

/** One chain's executable quote for one token quantity, plus what the vault can actually do. */
export interface ChainQuote {
  chain: KeeperChain
  pool: Address
  tokens: string
  /** Quote atoms the pool would take for exactly `tokens` out. */
  buyCost: string
  /** Quote atoms the pool would pay for exactly `tokens` in. */
  sellProceeds: string
  blockNumber: string
  /** Block timestamp of the quote, Unix seconds. */
  observedAt: number
  /** Vault inventory at that block. */
  keeperTokens: string
  keeperQuote: string
  /** Vault counters at that block. */
  spentQuote: string
  receivedQuote: string
  openCycles: number
  halted: boolean
  /** Worst-case gas for one leg on this chain, in quote atoms. */
  legCost: string
}

export interface KeeperSnapshot {
  /** Unix seconds the snapshot was taken, from the runner's clock. */
  at: number
  tokens: string
  quotes: Record<KeeperChain, ChainQuote>
  /** How far behind its own chain's head each quote sits. */
  lag: Record<KeeperChain, { blocks: number; seconds: number }>
  /** Chains whose head did not advance across the availability window. */
  stalled: KeeperChain[]
  /** Realized loss so far, from the durable record. */
  loss: string
  /** Net quote result of closed cycles, from the durable record. Keeper profit, not treasury profit. */
  net: string
  /** Cycles with a settled buy and no settled sale. */
  unresolved: string[]
  /** Durable inventory maintenance blocks trades until all transfers/deposits settle. */
  maintenance?: string[]
}

export interface CycleCandidate {
  tokens: string
  buy: KeeperChain
  sell: KeeperChain
  buyCost: string
  sellProceeds: string
  /** Worst-case gas of both legs plus the reserved recovery leg, in quote atoms. */
  cost: string
  /** sellProceeds - buyCost - cost - buffer. */
  edge: string
}

export type KeeperReason =
  | 'ok' | 'halted' | 'unresolved_exposure' | 'loss_cap' | 'stale_quote' | 'chain_unavailable'
  | 'no_edge' | 'inventory' | 'spend_cap' | 'recovery_reserve' | 'size'

export interface KeeperDecision { candidate: CycleCandidate | null; reason: KeeperReason; detail: string }

/** A leg exactly as the vault will see it, persisted before anything is sent. */
export interface LegPlan {
  chain: KeeperChain
  chainId: number
  keeper: Address
  cycle: string
  kind: LegKind
  /** keccak256 over the ABI-encoded leg struct: what `legOf[id]` holds once it has executed. */
  id: Hex
  digest: Hex
  pool: Address
  tokens: string
  limit: string
  deadline: number
  fromBlock: string
}

export interface LegResult {
  transaction: Hex
  amountIn: string
  amountOut: string
  /** Gas of this leg in quote atoms. */
  cost: string
  finalized: boolean
}

export type LegState = 'planned' | 'sent' | 'settled' | 'failed'

export interface LegRecord {
  cycle: string
  kind: LegKind
  chain: KeeperChain
  state: LegState
  plan: LegPlan
  result: LegResult | null
  error: string | null
}

export type CycleState = 'open' | 'closed' | 'halted' | 'recovered' | 'abandoned'

export interface CycleRecord {
  id: string
  state: CycleState
  candidate: CycleCandidate
  createdAt: number
  updatedAt: number
  legs: LegRecord[]
  /** Quote received minus quote paid minus gas, once the cycle is closed or recovered. */
  net: string | null
  note: string | null
}

export class KeeperError extends Error {
  constructor(readonly reason: KeeperReason | 'invalid_configuration' | 'not_approved' | 'leg_failed', message: string) {
    super(message)
    this.name = 'KeeperError'
  }
}
