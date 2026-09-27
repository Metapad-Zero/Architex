import type { Address } from 'viem'
import { listedPluginAt, type ListedPlugin } from '../../content/plugins/registry'
import { suiteFor, type LaunchSuite, type LaunchVersion } from '../deployment'
import { shortAddress } from '../format'

/**
 * Where a launch token's creator fees go, stated plainly (V13-SPEC §2 [D7]): the listed plugin's name, the
 * creator's own wallet, or a custom address. The site makes no safety claim about a custom address.
 */
export type FeeDestination =
  | { kind: 'listed'; plugin: ListedPlugin; address: Address }
  | { kind: 'creator'; address: Address }
  | { kind: 'custom'; address: Address }

/**
 * Decided only from the token's registered plugin (`pluginOf`, the curve's `plugin`) and the hooks flag the launchpad
 * stored at launch (`pluginHooks`), never from a plugin's `isConfigured` or its Configured events: a token's
 * registered plugin can mark the token configured on any listed plugin later without changing where its fees go
 * (V13-SPEC §9). A listed plugin's address counts as that plugin only when the launchpad pays it through its hooks.
 * The plugins are the ones deployed for the token's own launchpad (v1.4 has its own Split, Distribute to holders and
 * Combo).
 */
export function feeDestination(
  launch: { plugin: Address; creator: Address; pluginHooks: boolean; version?: LaunchVersion },
  suite: LaunchSuite = suiteFor(launch.version),
): FeeDestination {
  const listed = launch.pluginHooks ? listedPluginAt(launch.plugin, suite) : undefined
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
