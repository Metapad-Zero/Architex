import type { Address } from 'viem'
import type { HolderDividends } from './holders'

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

export interface DeepenState {
  /** The share of each pool run that buys the token and burns it, in basis points, fixed at launch (`burnBpsOf`). */
  burnBps: number
  /** USDC waiting to run with. */
  held: bigint
  /**
   * Exactly what a run now would offer (`previewRun`), paced like Buyback & burn's but, in the pool, from the locked
   * part of the USDC reserve (what liquidity at 0x…dEaD owns). 0 when the token already ran this block or the offer
   * would be under MIN_RUN_USDC.
   */
  offer: bigint
  /** How that offer divides: `toBurn` buys the token and burns it, `toDeepen` buys it and adds it to the pool (0 on the curve). */
  toBurn: bigint
  toDeepen: bigint
  /** Unix seconds of the token's latest run; 0 if it never ran. */
  lastRunAt: bigint
  /** Both buys and the liquidity added, all runs together. */
  totalSpent: bigint
  totalBurned: bigint
  /** What the runs have added to the launch pool, and the LP minted for it, locked at 0x…dEaD. */
  totalUsdcAdded: bigint
  totalTokensAdded: bigint
  totalLiquidity: bigint
}

/** Deepen pool's burn share when its creator gives it no settings (IDeepenPoolPlugin DEFAULT_BURN_BPS): half and half. */
export const DEEPEN_DEFAULT_BURN_BPS = 5_000
/** Deepen pool paces its runs with Buyback & burn's constants (IDeepenPoolPlugin RUN_INTERVAL, MIN_RUN_USDC). */
export const DEEPEN_RUN_INTERVAL = BUYBACK_RUN_INTERVAL
export const DEEPEN_MIN_RUN_USDC = BUYBACK_MIN_RUN_USDC

/** A token's holder dividends, streamed inside the token (lib/plugins/holders.ts). */
export interface HolderState extends HolderDividends {
  /** Its creator fees go to Distribute to holders (directly or in a Combo), so collecting them adds to the stream. */
  fromFees: boolean
}

export interface ComboEntryState {
  target: Address
  bps: number
  /** Decided at launch: a plugin is configured and paid through its hooks, anything else by transfer. */
  isPlugin: boolean
}

/** Everything the token page shows about where a token's creator fees are and what can be done with them. */
export interface CreatorFeeState {
  /**
   * Waiting for anyone to collect them to the plugin: accrued in the launchpad, and for a graduated v1.4 token also
   * held by its hook until the collection syncs them.
   */
  pending: bigint
  split?: SplitState
  buyback?: BuybackState
  deepen?: DeepenState
  /**
   * Present when the token pays holder dividends: its fees go to Distribute to holders (directly or in a Combo), or
   * someone has distributed to it directly. Dividends are built into every launch token.
   */
  holders?: HolderState
  combo?: ComboEntryState[]
}
