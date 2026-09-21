import type { Address } from 'viem'
import type { HolderStream } from './holders'

/** One Split payee, for one token. */
export interface SplitPayeeState {
  address: Address
  share: bigint
  /** What `release(token, payee)` would pay now. */
  releasable: bigint
  released: bigint
}

export interface SplitState {
  payees: SplitPayeeState[]
  totalShares: bigint
  totalReceived: bigint
}

export interface BuybackState {
  /** USDC waiting to buy with. */
  held: bigint
  totalSpent: bigint
  totalBurned: bigint
  /**
   * Exactly what a run now would offer (`previewRun`): min(held, budget), where the budget is 0.25% of the USDC-side
   * reserve prorated by the time since the last run (full after an hour). 0 when the token already ran this block
   * or the offer would be under MIN_RUN_USDC.
   */
  offer: bigint
  /** Unix seconds of the token's latest run; 0 if it never ran. */
  lastRunAt: bigint
}

/** Buyback & burn pacing (IBuybackBurnPlugin): the budget refills over this long after each run. */
export const BUYBACK_RUN_INTERVAL = 3_600n
/** Buyback & burn's smallest offer, in USDC units: below it a run is refused and previewRun reports 0. */
export const BUYBACK_MIN_RUN_USDC = 3n

export interface HolderState extends HolderStream {
  /** The token's eligible supply (0 below one whole token, when nothing can be distributed). */
  eligibleSupply: bigint
  /** The connected wallet's position; absent when no wallet is connected. */
  you?: {
    balance: bigint
    /** What the token owes the wallet now. */
    claimable: bigint
  }
}

export interface ComboEntryState {
  target: Address
  bps: number
  /** Decided at launch: a plugin is configured and paid through its hooks, anything else by transfer. */
  isPlugin: boolean
}

/** Everything the token page shows about where a token's creator fees are and what can be done with them. */
export interface CreatorFeeState {
  /** Accrued in the launchpad, waiting for anyone to collect them to the plugin. */
  pending: bigint
  split?: SplitState
  buyback?: BuybackState
  holders?: HolderState
  combo?: ComboEntryState[]
}
