/// Fee-distribution plugin registry: contracts anyone can deploy an instance of, then point
/// `feeTo` at, to split protocol or launch fees among multiple recipients instead of one wallet.
/// See `docs/plugins/CONTRIBUTING.md` to submit a new one — this file is edited by PR, not by
/// the app; there is no submission form or on-chain registry, deliberately (see that doc for why).

export type PluginStatus = 'reference' | 'community'

export interface PluginConstructorArg {
  name: string
  type: string
  description: string
}

export interface Plugin {
  slug: string
  name: string
  tagline: string
  description: string
  /** Path from the repo root to the contract's source. */
  contractPath: string
  constructorArgs: PluginConstructorArg[]
  status: PluginStatus
  /** GitHub handle or name of whoever submitted this plugin, for community entries. */
  submittedBy?: string
  /** Anything a deployer should know before using this beyond what the code itself says. */
  notes?: string[]
}

export const PLUGIN_REGISTRY: readonly Plugin[] = [
  {
    slug: 'weighted-split',
    name: 'Weighted Split',
    tagline: 'Split fees among a fixed set of payees, in fixed proportions.',
    description:
      "Splits any ERC-20 balance it holds — LP tokens from ArchitexFactory's feeTo or USDC from ArchitexLaunchpad's feeTo — among a fixed list of addresses in fixed proportions, decided once at deploy and immutable after. Pull-based: anyone can trigger a payee's release, but only that payee ever receives the funds.",
    contractPath: 'contracts/plugins/fee-distribution/WeightedSplitDistributor.sol',
    constructorArgs: [
      { name: 'payees', type: 'address[]', description: 'The fixed set of recipient addresses.' },
      { name: 'shares', type: 'uint256[]', description: "Each payee's weight, same order as payees. Absolute values don't matter, only ratios." },
    ],
    status: 'reference',
    notes: [
      'No admin key on the plugin itself: payees and shares can never change after deploy. Getting the list wrong means redeploying and updating feeTo again.',
      'One instance can be reused as feeTo for both the factory (LP tokens) and the launchpad (USDC) — it tracks each token it ever receives separately.',
    ],
  },
  {
    slug: 'equal-split',
    name: 'Equal Split',
    tagline: 'Weighted Split with every payee given the same share.',
    description:
      'The common case — "N collaborators split fees evenly" — without having to write out a shares array. A thin wrapper around Weighted Split.',
    contractPath: 'contracts/plugins/fee-distribution/EqualSplitDistributor.sol',
    constructorArgs: [{ name: 'payees', type: 'address[]', description: 'The fixed set of recipient addresses; each gets an equal share.' }],
    status: 'reference',
  },
]

export function findPlugin(slug: string): Plugin | undefined {
  return PLUGIN_REGISTRY.find((plugin) => plugin.slug === slug)
}
