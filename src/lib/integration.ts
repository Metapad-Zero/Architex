import type { Hex } from 'viem'

/**
 * Facts an integrator needs that are not addresses: the core pair's init code hash and the event topics.
 * src/lib/__tests__/integration.test.ts checks every value here against CREATE2, the ABIs and the deployments.
 */

/**
 * keccak256 of ArchitexPair's creation code, as each network's factory deploys it (no constructor arguments). With
 * it, a pair's address is CREATE2(factory, keccak256(abi.encodePacked(token0, token1)), INIT_CODE_HASH), token0 the
 * lower address. The testnet factory was deployed from an earlier build of the pair, so its hash differs.
 */
export const PAIR_INIT_CODE_HASH = {
  mainnet: '0x581ed87174caa94de5958734f4640087ca90ae3aa3bc6b6dce536615037a664b',
  testnet: '0xceba1cc4b1a5d13336793d0ec3ed890f510688417b40b9699e0bb2182ef2a7a5',
} as const satisfies Record<string, Hex>

/** A mainnet pair that proves the hash: USDC/EURC, factory.allPairs(0). */
export const MAINNET_USDC_EURC_PAIR = '0x6B27c00Db2E1fCBE68955C9194B656768B7Cdb06' as const

/** Uniswap V2's event topics. The core factory and pairs emit exactly these. */
export const UNISWAP_V2_TOPICS = {
  PairCreated: '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9',
  Swap: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
  Sync: '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1',
  Mint: '0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f',
  Burn: '0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496',
} as const satisfies Record<string, Hex>

/** The launchpad's and launch router's own events. */
export const LAUNCH_TOPICS = {
  TokenCreated: '0xff19378899e044d72c2e4a735bc7f647534b61366f8dbdd001b60785bb32e6eb',
  Trade: '0x952ff8d90add9fdeaeb478102d54441cf0cc0cbe53b1d99e51f747cdc8379e54',
  Graduated: '0x487dc7f66c623fb0ff13f9024a3ff9675453d069e075eceb12d9f8d7870e2374',
  PoolTrade: '0x6bc65ab609361247b21bdca12478db9bc5435fba69d50ecab2495d3109d1ca78',
  LaunchPairCreated: '0xc1db9ba7c4b7ce660fe8d17bbcf07167549381df2abd694a970bd1402d86d313',
} as const satisfies Record<string, Hex>

/** Launchpad v1.4's own events: the launchpad's, and the hook's (every v1.4 pool's trades and locks). */
export const LAUNCH_V14_TOPICS = {
  TokenCreated: '0xe8417223fa785d687f775abe65b3a9062151fabf4c6d5b2c02e7406d33c8a43f',
  Trade: '0xd5bfddbe72aa2c9b73b3fe3ad6d90e4dc2bb1b80d51272e831927c33f587a441',
  Graduated: '0x819fcdd992a6bd4039b37fd3f53611638e48a1ec83bfad5050f26b0f5f5d7dae',
  PoolOpened: '0xbcd8140ba57b584223c260db25386ddf8f5805d690e00e25a36a9b8fe574c9ad',
  PoolTrade: '0x9a96e557d7ca9d7ffdc15090e918b600cf14e24d23aca695e344f0f896d7ca1c',
  BidLocked: '0x4ff958855c24f443feb330e3d64c24afe5379fe97e10eac93d6687076e679739',
  FeesReleased: '0xaf3cb1d4e3118cf86dcc5a60d719c346f961a5ed8bdf30e5df48750b162d81dd',
  PoolFeesAccrued: '0x224ebb718a43a951a3eefba40c38ae681d4a27940b58fe8d89750d3ef81f5398',
} as const satisfies Record<string, Hex>
