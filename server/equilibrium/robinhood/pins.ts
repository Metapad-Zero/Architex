import type { Address, Hex } from 'viem'

/**
 * Robinhood Chain infrastructure the EQUILIBRIUM spoke would depend on, read from the public
 * mainnet RPC on 2026-09-30. Runtime code hashes pin the exact bytecode a fork must run: the
 * public RPC keeps only minutes of historical state, so a fork cannot be pinned by block number
 * alone (see access.ts). Nothing here is an EQUILIBRIUM deployment; every EQUILIBRIUM token,
 * manager, transceiver and pool address on Robinhood is still absent.
 */
export const ROBINHOOD_MAINNET = {
  network: 'mainnet',
  rpc: 'https://rpc.mainnet.chain.robinhood.com',
  chainId: 4663,
  /** Wormhole chain id, read from core.chainId(). */
  wormholeChainId: 72,
  /** Guardian set index current at the observation; fork harnesses overwrite this set locally. */
  guardianSetIndex: 7,
  /** Robinhood Chain is an Arbitrum Orbit chain: ETH gas, no OP Stack L1 fee oracle. */
  gas: 'ETH',
  core: '0x141fBa8AD5D61bdaB45A047cF60b5Ad9784987FB' as Address,
  coreImplementation: '0x1aafb0d5aab9ffbe09d4d30c9fd90d695c4f0881' as Address,
  venue: {
    kind: 'uniswap-v3' as const,
    factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa' as Address,
    quoterV2: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7' as Address,
    swapRouter02: '0xcaf681a66d020601342297493863e78c959e5cb2' as Address,
    fee: 3000,
    tickSpacing: 60,
  },
  /**
   * PROVISIONAL FORK FIXTURE. Paxos Global Dollar (USDG), six decimals. It is not USDC, Circle
   * documents no CCTP domain for Robinhood Chain, and no owner has approved it as the quote
   * asset. It is used only so fork pools quote against a real deployed stablecoin's bytecode.
   */
  usdgFixture: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address,
  usdgImplementation: '0x68184c449e1a8f34fa18d289737129fd27b66f8f' as Address,
  observedBlock: 76826272n,
  codeHashes: {
    '0x141fBa8AD5D61bdaB45A047cF60b5Ad9784987FB': '0xbc8fa8e742d94fefadf07dc4c91b0681bb69a67d6a92213041bae6fdbc0402af',
    '0x1aafb0d5aab9ffbe09d4d30c9fd90d695c4f0881': '0x49ef719d3d246ab781470db9dba6aa4326112e79bb9bb402fd92952e74ded443',
    '0x1f7d7550b1b028f7571e69a784071f0205fd2efa': '0xec72b1abd1f2faee020cfea9c646bd8994f9fb389054f6e574f103a895091739',
    '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7': '0x3db0868d945e9304c9bc6a8b2181948109ea617647142f3c4083e14393496a28',
    '0xcaf681a66d020601342297493863e78c959e5cb2': '0x6f36c378e272c6324c48f045182bcb54bd8ad654cf9ebd42e8893d52c4cb25dc',
    '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168': '0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6',
    '0x68184c449e1a8f34fa18d289737129fd27b66f8f': '0x3a551ac5c744af57e68a1d1431ac403c0f516ffd7d224a75746aee11fc4f3baf',
  } as Record<Address, Hex>,
  /** EIP-1967 implementation slot values that must hold for the proxies above. */
  implementations: {
    '0x141fBa8AD5D61bdaB45A047cF60b5Ad9784987FB': '0x1aafb0d5aab9ffbe09d4d30c9fd90d695c4f0881',
    '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168': '0x68184c449e1a8f34fa18d289737129fd27b66f8f',
  } as Record<Address, Address>,
} as const

/** The real Robinhood testnet: chain id observed, but no documented Wormhole core, NTT route or venue. */
export const ROBINHOOD_TESTNET = {
  network: 'testnet',
  rpc: 'https://rpc.testnet.chain.robinhood.com',
  chainId: 46630,
  wormholeChainId: null,
  core: null,
  venue: null,
} as const

export const EIP1967_IMPLEMENTATION_SLOT: Hex = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'

/**
 * What must be decided or exist before any public Robinhood route may open. Each entry is a gate
 * the closed adapter reports verbatim; none can be satisfied by configuration alone.
 */
export const ROBINHOOD_DECISIONS = [
  { key: 'environment', text: 'No Robinhood testnet has a documented Wormhole core, NTT route or Uniswap venue, and the EQUILIBRIUM hub exists only on Arc testnet forks. The only rehearsal is an Arc-testnet/Robinhood-mainnet fork pairing: mixed-environment compatibility, not a route. Choose the rehearsal network pair for a public test (Arc mainnet + Robinhood mainnet, or wait for a Robinhood testnet core).' },
  { key: 'quote_asset', text: 'Approve the Robinhood quote asset. USDG is a provisional fork fixture only: it is not USDC and Robinhood has no documented CCTP domain, so quote inventory cannot be refilled from Arc USDC by CCTP.' },
  { key: 'refill', text: 'Approve an inventory/refill policy for the quote asset (pre-positioned amount, source, who may move it, cap per refill) and for ETH gas.' },
  { key: 'custody', text: 'Approve custody for the Robinhood spoke manager/transceiver owner (upgrade, peer, threshold, rate-limit and pause powers) and the EquilibriumExecutor operator key.' },
  { key: 'funding', text: 'Approve the funding budget: deployment gas in ETH, pool seed tokens and quote, and the Wormhole message fee (currently 0 on the Robinhood core).' },
  { key: 'finality', text: 'Approve a finality policy. The Robinhood RPC finalized tag lags latest by roughly ten thousand blocks and the public RPC does not serve state that old; credits must wait for Guardian attestation of consistency level 0 (finalized), whose latency is unmeasured on this route.' },
  { key: 'state_access', text: 'Provide an archive-capable Robinhood RPC if a rehearsal must be reproducible at a fixed block; the public RPC serves roughly 6,000–8,000 blocks (about ten minutes) of history.' },
] as const
export type RobinhoodDecision = typeof ROBINHOOD_DECISIONS[number]['key']
