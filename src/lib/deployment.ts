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
  /** Deepen pool (V13-SPEC §2.3), listed after the others; zero until deployed. */
  deepenPlugin: Address
  /** Launchpad v1.4 and everything its tokens trade through; every address is zero until v1.4 is deployed here. */
  v14: LaunchSuiteV14
  /**
   * Launchpads the site no longer points at: v1.2, and v1.3 deployments replaced since (testnet rehearsals). Only
   * scripts read them, to find what their tokens name; scripts/metadata-cleanup.ts tells the two versions apart.
   */
  retiredLaunchpads: Address[]
  deployer: Address
  tokens: DeploymentToken[]
  pairs: DeploymentPair[]
  txs: { factory: Hash; router: Hash; lens: Hash }
}

/**
 * Launchpad v1.4 (docs/launchpad/V14-SPEC.md): curves like v1.3's that graduate into a Uniswap v4 pool behind the
 * Architex hook. The plugins bind to one launchpad when they are deployed, so v1.4 has its own Split, Distribute to
 * holders and Combo; Buyback & burn and Deepen pool have no v1.4 deployment. `poolManager` and `stateView` are
 * Uniswap's own contracts on this network (UNISWAP_V4_ARC on mainnet), set here with the rest when v1.4 is deployed.
 */
export interface LaunchSuiteV14 {
  launchpad: Address
  /** ArchitexLaunchHook: opens every v1.4 pool, takes the fees of every pool trade and locks the anti-sniping fees. */
  hook: Address
  /** ArchitexV4Router: exact-in buys and sells of a graduated token in its pool, the way the site trades them. */
  router: Address
  splitPlugin: Address
  holderPlugin: Address
  comboPlugin: Address
  poolManager: Address
  /** Uniswap's StateView: a pool's price (getSlot0) and liquidity by pool id. */
  stateView: Address
}

/**
 * Uniswap v4 on Arc (developers.uniswap.org; the code confirmed on chain 2026-09-25, V14-SPEC §2): the same addresses
 * on Arc mainnet and Arc Testnet.
 */
export const UNISWAP_V4_ARC = {
  poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  stateView: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
} as const satisfies Record<string, Address>

/** Which launchpad a token was launched on: v1.3 (its own launch pool) or v1.4 (a Uniswap v4 pool). */
export type LaunchVersion = 'v13' | 'v14'

export const deployment = (arcNetwork === 'mainnet' ? mainnetDeployment : testnetDeployment) as ArchitexDeployment
export const isDeployed = deployment.factory !== zeroAddress
/** The v1.3 suite the site needs to trade launches: the launchpad and its launch router. */
export const isLaunchpadDeployed = isDeployed && deployment.launchpad !== zeroAddress && deployment.launchRouter !== zeroAddress
/** The v1.4 suite the site needs: the launchpad, the hook, the router and Uniswap's PoolManager and StateView. */
export const isLaunchpadV14Deployed =
  isDeployed
  && ([deployment.v14.launchpad, deployment.v14.hook, deployment.v14.router, deployment.v14.poolManager, deployment.v14.stateView] as const).every(
    (address) => address !== zeroAddress,
  )

// `import.meta.env.DEV` is a compile-time constant, so the fixture branch is dead in production.
const fixtureOn = import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1'
// The fixture previews v1.4 as live unless VITE_LAUNCHPAD_FIXTURE_V14=0, which previews the site as it is before then.
const fixtureV14On = fixtureOn && import.meta.env.VITE_LAUNCHPAD_FIXTURE_V14 !== '0'

export const isLaunchViewAvailable = isLaunchpadDeployed || isLaunchpadV14Deployed || fixtureOn
/** Whether v1.4 runs here (or in the fixture): its tokens are listed, and new launches go to it. */
export const isV14Available = isLaunchpadV14Deployed || fixtureV14On
/** The launchpad the builder creates tokens on: v1.4 once it is deployed on this network, v1.3 until then. */
export const builderVersion: LaunchVersion = isV14Available ? 'v14' : 'v13'

export interface LaunchSuite {
  launchpad: Address
  launchPairFactory: Address
  launchRouter: Address
  splitPlugin: Address
  buybackPlugin: Address
  holderPlugin: Address
  comboPlugin: Address
  deepenPlugin: Address
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
  deepenPlugin: '0x00000000000000000000000000000000000fa015',
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
      deepenPlugin: deployment.deepenPlugin,
    }

/** The fixture's v1.4 stand-ins. */
export const FIXTURE_SUITE_V14: LaunchSuiteV14 = {
  launchpad: '0x00000000000000000000000000000000000fb001',
  hook: '0x00000000000000000000000000000000000fb002',
  router: '0x00000000000000000000000000000000000fb003',
  splitPlugin: '0x00000000000000000000000000000000000fb011',
  holderPlugin: '0x00000000000000000000000000000000000fb013',
  comboPlugin: '0x00000000000000000000000000000000000fb014',
  poolManager: '0x00000000000000000000000000000000000fb0a0',
  stateView: '0x00000000000000000000000000000000000fb0a1',
}

/** The v1.4 suite's addresses on this network: all zero until it is deployed (the fixture's stand-ins in fixture mode). */
export const launchSuiteV14: LaunchSuiteV14 = fixtureV14On ? FIXTURE_SUITE_V14 : deployment.v14

/**
 * The v1.4 suite in the shape the plugin registry and the builder's checks read (lib/plugins/plan.ts). As the v1.4
 * launchpad itself reports them, the hook stands where v1.3's pair factory stood (`pairFactory()`) and the v4 router
 * where its launch router stood (`router()`). Buyback & burn and Deepen pool have no v1.4 deployment: zero.
 */
export function pluginSuiteOf(suite: LaunchSuiteV14): LaunchSuite {
  return {
    launchpad: suite.launchpad,
    launchPairFactory: suite.hook,
    launchRouter: suite.router,
    splitPlugin: suite.splitPlugin,
    buybackPlugin: zeroAddress,
    holderPlugin: suite.holderPlugin,
    comboPlugin: suite.comboPlugin,
    deepenPlugin: zeroAddress,
  }
}

const launchSuiteV14Plugins = pluginSuiteOf(launchSuiteV14)

/** The suite a token of `version` was launched on, in the registry's shape: its launchpad, router and plugins. */
export function suiteFor(version: LaunchVersion | undefined): LaunchSuite {
  return version === 'v14' ? launchSuiteV14Plugins : launchSuite
}
