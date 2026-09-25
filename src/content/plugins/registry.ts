/// The creator-fee plugin marketplace: the plugins listed in the token builder (V13-SPEC §2, §7).
///
/// A launch token's creator fee goes to one address, chosen at launch and locked forever. Any address works; a
/// listed plugin is one whose code was reviewed by pull request (see `docs/plugins/CONTRIBUTING.md`) and that the
/// builder knows how to configure. This file is edited by PR, not by the app; there is no on-chain allowlist.
/// Listing makes no safety claim beyond "reviewed and tested": the site says where fees go, and that's all.
import { zeroAddress, type Address } from 'viem'
import { launchSuite, type LaunchSuite } from '../../lib/deployment'

export type ListedPluginKind = 'split' | 'buyback' | 'deepen' | 'holders' | 'combo'

export interface ListedPlugin {
  kind: ListedPluginKind
  name: string
  /** One line in the builder's picker. */
  tagline: string
  /** What happens to the fees, in the site's plain voice. */
  description: string
  /** What the builder asks for: payees and shares, Combo allocations, a burn share, or nothing. */
  config: 'split' | 'combo' | 'burnShare' | 'none'
  /** Which deployment entry holds the plugin's singleton address. */
  suiteKey: keyof Pick<LaunchSuite, 'splitPlugin' | 'buybackPlugin' | 'deepenPlugin' | 'holderPlugin' | 'comboPlugin'>
  /** Path from the repo root to the contract's source. */
  contractPath: string
  /**
   * Set while the plugin is closed to new launches: one short line, shown where the builder would offer it. The
   * builder stops offering it, on its own and as a Combo entry; tokens that already chose it still show it and can
   * still run it.
   */
  paused?: string
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
      'Spends the fees buying the token and burns what it buys, so the supply only goes down. Anyone can run a buyback; it spends at most 0.25% of the curve’s or pool’s USDC side per hour.',
    config: 'none',
    suiteKey: 'buybackPlugin',
    contractPath: 'contracts/plugins/launch/BuybackBurnPlugin.sol',
    paused: 'Paused for new launches. Deepen pool at a 100% burn share does the same job.',
  },
  {
    kind: 'deepen',
    name: 'Deepen pool',
    tagline: 'Burns the token and grows its pool, in one.',
    description:
      'Spends the fees buying the token and burning it while it is on the curve. Once it graduates, every run splits: your burn share buys the token and burns it, and the rest buys the token and adds it to the launch pool, locking the new liquidity at the burn address. Anyone can run it; it spends at most 0.25% of the curve’s USDC side, or of the pool’s locked USDC, per hour, whatever the mix.',
    config: 'burnShare',
    suiteKey: 'deepenPlugin',
    contractPath: 'contracts/plugins/launch/DeepenPoolPlugin.sol',
  },
  {
    kind: 'holders',
    name: 'Distribute to holders',
    tagline: 'Paid to holders in USDC, over 24 hours.',
    description:
      'Streams the fees to the token’s holders in USDC over about 24 hours: holders earn for every second they hold, in proportion to what they hold, so buying just before a payout earns nothing extra. Holders claim on the token’s page.',
    config: 'none',
    suiteKey: 'holderPlugin',
    contractPath: 'contracts/plugins/launch/HolderDistributionPlugin.sol',
  },
  {
    kind: 'combo',
    name: 'Combo',
    tagline: 'Up to five of these, by percentage.',
    description: 'Splits the fees across up to five destinations by percentage: wallets, a Split, Buyback & burn, Deepen pool or Distribute to holders.',
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

/** Whether the builder offers the plugin for a new launch: deployed on this network and not paused. */
export function isPluginOffered(plugin: ListedPlugin, suite: LaunchSuite = launchSuite): boolean {
  return isPluginDeployed(plugin, suite) && !plugin.paused
}

/** The listed plugin deployed at `address`, if any. */
export function listedPluginAt(address: string | undefined, suite: LaunchSuite = launchSuite): ListedPlugin | undefined {
  if (!address) return undefined
  const needle = address.toLowerCase()
  return LISTED_PLUGINS.find((plugin) => isPluginDeployed(plugin, suite) && pluginAddress(plugin, suite).toLowerCase() === needle)
}
