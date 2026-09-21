/// The creator-fee plugin marketplace: the plugins listed in the token builder (V13-SPEC §2, §7).
///
/// A launch token's creator fee goes to one address, chosen at launch and locked forever. Any address works; a
/// listed plugin is one whose code was reviewed by pull request (see `docs/plugins/CONTRIBUTING.md`) and that the
/// builder knows how to configure. This file is edited by PR, not by the app; there is no on-chain allowlist.
/// Listing makes no safety claim beyond "reviewed and tested": the site says where fees go, and that's all.
import { zeroAddress, type Address } from 'viem'
import { launchSuite, type LaunchSuite } from '../../lib/deployment'

export type ListedPluginKind = 'split' | 'buyback' | 'holders' | 'combo'

export interface ListedPlugin {
  kind: ListedPluginKind
  name: string
  /** One line in the builder's picker. */
  tagline: string
  /** What happens to the fees, in the site's plain voice. */
  description: string
  /** What the builder asks for: payees and shares, Combo allocations, or nothing. */
  config: 'split' | 'combo' | 'none'
  /** Which deployment entry holds the plugin's singleton address. */
  suiteKey: keyof Pick<LaunchSuite, 'splitPlugin' | 'buybackPlugin' | 'holderPlugin' | 'comboPlugin'>
  /** Path from the repo root to the contract's source. */
  contractPath: string
}

export const LISTED_PLUGINS: readonly ListedPlugin[] = [
  {
    kind: 'split',
    name: 'Split',
    tagline: 'Up to 20 wallets, by fixed shares.',
    description:
      'Shares the fees among up to 20 wallets by fixed shares. Each wallet is paid when anyone releases its share; the USDC always goes to that wallet.',
    config: 'split',
    suiteKey: 'splitPlugin',
    contractPath: 'contracts/plugins/launch/SplitPlugin.sol',
  },
  {
    kind: 'buyback',
    name: 'Buyback & burn',
    tagline: 'Buys the token back and burns it.',
    description:
      'Spends the fees buying the token and burns what it buys, so the supply only goes down. Anyone can run a buyback; each run spends at most 0.25% of the USDC side of the curve or pool, once a block.',
    config: 'none',
    suiteKey: 'buybackPlugin',
    contractPath: 'contracts/plugins/launch/BuybackBurnPlugin.sol',
  },
  {
    kind: 'holders',
    name: 'Distribute to holders',
    tagline: 'Paid to holders in USDC, over 24 hours.',
    description:
      'Pays the fees to the token’s holders in USDC, in proportion to what they hold, dripped out over 24 hours so nobody can buy, collect and sell in one go. Holders claim on the token’s page.',
    config: 'none',
    suiteKey: 'holderPlugin',
    contractPath: 'contracts/plugins/launch/HolderDistributionPlugin.sol',
  },
  {
    kind: 'combo',
    name: 'Combo',
    tagline: 'Up to five of these, by percentage.',
    description: 'Splits the fees across up to five destinations by percentage: wallets, a Split, Buyback & burn or Distribute to holders.',
    config: 'combo',
    suiteKey: 'comboPlugin',
    contractPath: 'contracts/plugins/launch/ComboPlugin.sol',
  },
]

export function listedPlugin(kind: ListedPluginKind): ListedPlugin {
  const plugin = LISTED_PLUGINS.find((entry) => entry.kind === kind)
  if (!plugin) throw new Error(`No listed plugin ${kind}`)
  return plugin
}

/** The plugin's singleton on this network; zero until it is deployed. */
export function pluginAddress(plugin: ListedPlugin, suite: LaunchSuite = launchSuite): Address {
  return suite[plugin.suiteKey]
}

export function isPluginDeployed(plugin: ListedPlugin, suite: LaunchSuite = launchSuite): boolean {
  return pluginAddress(plugin, suite) !== zeroAddress
}

/** The listed plugin deployed at `address`, if any. */
export function listedPluginAt(address: string | undefined, suite: LaunchSuite = launchSuite): ListedPlugin | undefined {
  if (!address) return undefined
  const needle = address.toLowerCase()
  return LISTED_PLUGINS.find((plugin) => isPluginDeployed(plugin, suite) && pluginAddress(plugin, suite).toLowerCase() === needle)
}
