import type { Address, Hash } from 'viem'
import { zeroAddress } from 'viem'
import { arcNetwork } from '../chain'
import testnetDeployment from '../deployments/arc-testnet.json'
import mainnetDeployment from '../deployments/arc-mainnet.json'

export interface DeploymentToken {
  symbol: string
  name: string
  address: Address
  decimals: number
  faucet: boolean
}

export interface DeploymentPair {
  pair: Address
  token0: Address
  token1: Address
}

export interface ArchitexDeployment {
  chainId: number
  network: string
  explorerBase: string
  factory: Address
  router: Address
  lens: Address
  /** Launchpad v1.3. Zero until it is deployed on this network; the Launch view exists only when it and its launch router are set. */
  launchpad: Address
  /** The v1.3 launch-pair factory (one pool per launch token, separate from the core factory). */
  launchPairFactory: Address
  /** The v1.3 launch router: the only way to trade a graduated launch token, against USDC. */
  launchRouter: Address
  /** The reference creator-fee plugin singletons (V13-SPEC §2.2), zero until deployed. */
  splitPlugin: Address
  buybackPlugin: Address
  holderPlugin: Address
  comboPlugin: Address
  /** Launchpads the site no longer points at (v1.2 and earlier). Only scripts read them, to find what their tokens name. */
  retiredLaunchpads: Address[]
  deployer: Address
  tokens: DeploymentToken[]
  pairs: DeploymentPair[]
  txs: { factory: Hash; router: Hash; lens: Hash }
}

export const deployment = (arcNetwork === 'mainnet' ? mainnetDeployment : testnetDeployment) as ArchitexDeployment
export const isDeployed = deployment.factory !== zeroAddress
/** The v1.3 suite the site needs to trade launches: the launchpad and its launch router. */
export const isLaunchpadDeployed = isDeployed && deployment.launchpad !== zeroAddress && deployment.launchRouter !== zeroAddress

// `import.meta.env.DEV` is a compile-time constant, so the fixture branch is dead in production.
const fixtureOn = import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1'

export const isLaunchViewAvailable = isLaunchpadDeployed || fixtureOn

export interface LaunchSuite {
  launchpad: Address
  launchPairFactory: Address
  launchRouter: Address
  splitPlugin: Address
  buybackPlugin: Address
  holderPlugin: Address
  comboPlugin: Address
}

/** Stand-ins the dev fixture uses, so listed plugins can be picked and named without deployed contracts. */
export const FIXTURE_SUITE: LaunchSuite = {
  launchpad: '0x00000000000000000000000000000000000fa001',
  launchPairFactory: '0x00000000000000000000000000000000000fa002',
  launchRouter: '0x00000000000000000000000000000000000fa003',
  splitPlugin: '0x00000000000000000000000000000000000fa011',
  buybackPlugin: '0x00000000000000000000000000000000000fa012',
  holderPlugin: '0x00000000000000000000000000000000000fa013',
  comboPlugin: '0x00000000000000000000000000000000000fa014',
}

/** The launchpad suite's addresses on this network (the fixture's stand-ins in fixture mode). */
export const launchSuite: LaunchSuite = fixtureOn
  ? FIXTURE_SUITE
  : {
      launchpad: deployment.launchpad,
      launchPairFactory: deployment.launchPairFactory,
      launchRouter: deployment.launchRouter,
      splitPlugin: deployment.splitPlugin,
      buybackPlugin: deployment.buybackPlugin,
      holderPlugin: deployment.holderPlugin,
      comboPlugin: deployment.comboPlugin,
    }
