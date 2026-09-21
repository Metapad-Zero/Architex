import { parseAbi, type Address } from 'viem'
import { launchFeePluginEntries } from '../abi'

/**
 * Distribute to holders ([D15], [D21]): a token's creator fees are dripped to its holders through the token's own
 * USDC dividend tracker. Everything the site reads from or sends to this plugin lives in this file, so the drip
 * API can be re-pointed in one place (contracts/interfaces/plugins/IHolderDistributionPlugin.sol):
 *
 * - `drip(token)`: anyone releases what the stream owes holders by now.
 * - `dripAndClaim(token)`: drips, then pays the caller its claimable USDC (never anyone else).
 * - `unreleased(token)`: USDC still waiting to be released to holders.
 * - `releasable(token)`: what a drip would release right now (0 without eligible supply).
 * - `streamEnd(token)`: from then on everything unreleased is due. A delivery moves it to an amount-weighted
 *   point between the old end and a full DRIP_PERIOD (24 hours) from now, so the site reads it, never computes it.
 * - drip and dripAndClaim revert NotConfigured(token) for a token that does not use this plugin. There is no flush.
 *
 * A holder's own claimable balance is read from the token (`claimable(holder)`), not from here.
 */
export const holderPluginAbi = parseAbi([
  ...launchFeePluginEntries,
  'event FeesStreamed(address indexed token, uint256 amount, uint256 unreleased, uint256 streamEnd)',
  'event Distributed(address indexed token, uint256 amount)',
  'function DRIP_PERIOD() view returns (uint256)',
  'function drip(address token) returns (uint256 released)',
  'function dripAndClaim(address token) returns (uint256 released, uint256 claimed)',
  'function unreleased(address token) view returns (uint256)',
  'function releasable(address token) view returns (uint256)',
  'function lastDrip(address token) view returns (uint256)',
  'function streamEnd(address token) view returns (uint256)',
  'function totalDistributed(address token) view returns (uint256)',
])

/** The plugin's per-token stream, as the token page shows it. */
export interface HolderStream {
  unreleased: bigint
  releasable: bigint
  /** Unix seconds from which all of `unreleased` is due; 0 if the stream was never fed. */
  streamEnd: bigint
  totalDistributed: bigint
}

/** The reads behind `HolderStream`, in order, for one multicall. */
export function holderStreamReads(plugin: Address, token: Address) {
  return [
    { address: plugin, abi: holderPluginAbi, functionName: 'unreleased', args: [token] },
    { address: plugin, abi: holderPluginAbi, functionName: 'releasable', args: [token] },
    { address: plugin, abi: holderPluginAbi, functionName: 'streamEnd', args: [token] },
    { address: plugin, abi: holderPluginAbi, functionName: 'totalDistributed', args: [token] },
  ] as const
}

export function holderStreamFrom(results: readonly [bigint, bigint, bigint, bigint]): HolderStream {
  const [unreleased, releasable, streamEnd, totalDistributed] = results
  return { unreleased, releasable, streamEnd, totalDistributed }
}

/** The holder's claim: drip what is due, then pay the caller. */
export function dripAndClaimCall(plugin: Address, token: Address) {
  return { address: plugin, abi: holderPluginAbi, functionName: 'dripAndClaim', args: [token] } as const
}

/** Releases what is due to every holder, without claiming. */
export function dripCall(plugin: Address, token: Address) {
  return { address: plugin, abi: holderPluginAbi, functionName: 'drip', args: [token] } as const
}

/**
 * What `dripAndClaim` would pay `holder` now: what the token already owes them, plus their pro-rata share of
 * what the drip releases. The share is floored the way the token floors it, so this can differ from the payment by
 * at most one unit, and the drip keeps growing until the transaction lands.
 */
export function claimableAfterDrip(input: { claimable: bigint; releasable: bigint; balance: bigint; eligibleSupply: bigint }): bigint {
  const share = input.eligibleSupply > 0n && input.balance > 0n ? (input.releasable * input.balance) / input.eligibleSupply : 0n
  return input.claimable + share
}
