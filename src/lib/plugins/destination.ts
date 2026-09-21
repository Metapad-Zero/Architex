import type { Address } from 'viem'
import { listedPluginAt, type ListedPlugin } from '../../content/plugins/registry'
import { launchSuite, type LaunchSuite } from '../deployment'
import { shortAddress } from '../format'

/**
 * Where a launch token's creator fees go, stated plainly (V13-SPEC §2 [D7]): the listed plugin's name, the
 * creator's own wallet, or a custom address. The site makes no safety claim about a custom address.
 */
export type FeeDestination =
  | { kind: 'listed'; plugin: ListedPlugin; address: Address }
  | { kind: 'creator'; address: Address }
  | { kind: 'custom'; address: Address }

export function feeDestination(launch: { plugin: Address; creator: Address }, suite: LaunchSuite = launchSuite): FeeDestination {
  const listed = listedPluginAt(launch.plugin, suite)
  if (listed) return { kind: 'listed', plugin: listed, address: launch.plugin }
  if (launch.plugin.toLowerCase() === launch.creator.toLowerCase()) return { kind: 'creator', address: launch.plugin }
  return { kind: 'custom', address: launch.plugin }
}

/** The name alone: "Split", "Creator wallet", "Custom address". */
export function destinationName(destination: FeeDestination): string {
  if (destination.kind === 'listed') return destination.plugin.name
  return destination.kind === 'creator' ? 'Creator wallet' : 'Custom address'
}

/** The name, and the address wherever the name alone would not say where the USDC goes. */
export function destinationLabel(destination: FeeDestination): string {
  if (destination.kind === 'listed') return destination.plugin.name
  return `${destinationName(destination)} · ${shortAddress(destination.address)}`
}
