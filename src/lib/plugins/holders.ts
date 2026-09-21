import { parseAbi, type Address } from 'viem'
import { launchFeePluginEntries, launchTokenAbi } from '../abi'

/**
 * Holder dividends ([D15], [D21]). They live inside every launch token: `distribute(amount)` streams USDC to the
 * eligible holders over DRIP_PERIOD (24 hours), and each holder earns second by second in proportion to what it
 * holds, so buying just before a payout earns nothing extra. While under one whole token is eligible the stream
 * pauses (its end moves out). Tokens in the launch pool, the curve's unsold inventory and burned tokens earn none.
 *
 * The Distribute to holders plugin only forwards a token's creator fees to that token's `distribute`; it holds
 * nothing. Everything the site reads or sends for holder dividends lives in this file:
 * - token: `claimable(holder)` (grows live), `claim()`, `streamRate()` (USDC units per second to all holders),
 *   `streamEnd()`, `undistributed()` (what the running stream still owes), `eligibleSupply()`,
 *   `totalDistributed()`, `balanceOf(holder)`;
 * - plugin: `totalDistributed(token)` only.
 */
export const holderPluginAbi = parseAbi([
  ...launchFeePluginEntries,
  'event Distributed(address indexed token, uint256 amount)',
  'function totalDistributed(address token) view returns (uint256)',
])

/** A token's dividend stream and, with a wallet connected, that wallet's part in it. */
export interface HolderDividends {
  /** What the running stream still owes all holders from now on; 0 when none runs. */
  undistributed: bigint
  /** The stream's current payout to all eligible holders together, in USDC units per second (rounded down). */
  streamRate: bigint
  /** When the running stream ends, unless it pauses or more is distributed; 0 if nothing was ever distributed. */
  streamEnd: bigint
  /** All USDC ever distributed to holders, streamed out or not. */
  totalDistributed: bigint
  /** 0 below one whole eligible token, where the stream pauses. */
  eligibleSupply: bigint
  you?: {
    balance: bigint
    /** Everything the wallet has earned up to the second it was read, less what it claimed. */
    claimable: bigint
  }
}

/** The token reads behind `HolderDividends`, in this order: undistributed, streamRate, streamEnd, totalDistributed, eligibleSupply. */
export function dividendReads(token: Address) {
  return [
    { address: token, abi: launchTokenAbi, functionName: 'undistributed' },
    { address: token, abi: launchTokenAbi, functionName: 'streamRate' },
    { address: token, abi: launchTokenAbi, functionName: 'streamEnd' },
    { address: token, abi: launchTokenAbi, functionName: 'totalDistributed' },
    { address: token, abi: launchTokenAbi, functionName: 'eligibleSupply' },
  ] as const
}

/** A holder's part: balanceOf, then claimable. */
export function holderReads(token: Address, holder: Address) {
  return [
    { address: token, abi: launchTokenAbi, functionName: 'balanceOf', args: [holder] },
    { address: token, abi: launchTokenAbi, functionName: 'claimable', args: [holder] },
  ] as const
}

/** The connected wallet claims its own dividends, on the token. */
export function claimCall(token: Address) {
  return { address: token, abi: launchTokenAbi, functionName: 'claim' } as const
}

export type DividendStatus =
  | { kind: 'none' }
  /** Owed, but under one whole token is eligible: nothing accrues until someone holds. */
  | { kind: 'paused'; left: bigint }
  | { kind: 'streaming'; left: bigint; endsAt: bigint; perHour: bigint }

/**
 * What the stream is doing, for the token page. `streamRate` keeps its last value after a stream ends, so a stream
 * counts as running only while it still owes something (the token's `undistributed()` is 0 once it has ended).
 */
export function dividendStatus(dividends: Pick<HolderDividends, 'undistributed' | 'streamRate' | 'streamEnd' | 'eligibleSupply'>): DividendStatus {
  if (dividends.undistributed === 0n) return { kind: 'none' }
  if (dividends.eligibleSupply === 0n) return { kind: 'paused', left: dividends.undistributed }
  return { kind: 'streaming', left: dividends.undistributed, endsAt: dividends.streamEnd, perHour: dividends.streamRate * 3_600n }
}

/** Whether the token page should show holder dividends: the token pays them, or someone paid it some. */
export function hasDividends(dividends: Pick<HolderDividends, 'totalDistributed' | 'you'>): boolean {
  return dividends.totalDistributed > 0n || (dividends.you?.claimable ?? 0n) > 0n
}
