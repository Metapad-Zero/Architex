/** Capability candidates, pinned on 2026-09-30. Documentation/bytecode reads cannot open a route. */
export const BRIDGE = {
  name: 'Wormhole NTT',
  evmVersion: 'v2.0.0+evm', evmCommit: 'c636cc15b07969e4b44de7e466c999c07e7387a9',
  solanaVersion: 'v3.0.0+solana', solanaCommit: '1a2a92ef7f289972b2d00dd1d58077d139fe68d7',
  decimals: 6, wireMaxDecimals: 8, consistencyLevel: 0,
} as const
export interface NetworkCandidate {
  chain: 'arc' | 'base' | 'solana' | 'robinhood'
  name: string
  authority: 'locking' | 'burning'
  mainnet: { id: number | string; wormholeId: number; rpc: string; core: string; market: string | null }
  testnet: { id: number | string; wormholeId: number | null; rpc: string; core: string | null; market: string | null }
  venue: string
  prerequisite: string
}
export const NETWORKS: NetworkCandidate[] = [
  { chain: 'arc', name: 'Arc', authority: 'locking', venue: 'Architex constant-product AMM',
    mainnet: { id: 5042, wormholeId: 71, rpc: 'https://rpc.mainnet.arc.io', core: '0xC8aD24fC6063c41cB5C12a8e3851AafC3b3CF027', market: '0x3648cc1323b4729e472cffdC570C6096565b0923' },
    testnet: { id: 5042002, wormholeId: 71, rpc: 'https://rpc.testnet.arc.io', core: '0xBB73cB66C26740F31d1FabDC6b7A46a038A300dd', market: '0x6362f5a0fc007ab7d1e61f99d3f4eb04360d060a' },
    prerequisite: 'Canonical token, locking manager/transceiver, approved admin and funding; prove Arc↔Base round trip and seed its existing-token pool.' },
  { chain: 'base', name: 'Base', authority: 'burning', venue: 'Uniswap v3',
    mainnet: { id: 8453, wormholeId: 30, rpc: 'https://mainnet.base.org', core: '0xbebdb6C8ddC678FfA9f8748f85C815C556Dd8ac6', market: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD' },
    testnet: { id: 84532, wormholeId: 10004, rpc: 'https://sepolia.base.org', core: '0x79A1027a6A159502049F10906D333EC57E95F083', market: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24' },
    prerequisite: 'Zero-supply spoke, manager mint authority, peers, finalized credits and public Uniswap pool rehearsal. The Uniswap v3 fork test proves pool compatibility only.' },
  { chain: 'solana', name: 'Solana', authority: 'burning', venue: 'PumpSwap existing-mint pool',
    mainnet: { id: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', wormholeId: 1, rpc: 'https://api.mainnet-beta.solana.com', core: 'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth', market: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA' },
    testnet: { id: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1', wormholeId: 1, rpc: 'https://api.devnet.solana.com', core: '3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5', market: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA' },
    prerequisite: 'SVM manager program deployment, six-decimal SPL mint with manager PDA mint authority, actual devnet Arc↔Solana transfer and create_pool test. Wormhole Testnet maps to Solana devnet.' },
  { chain: 'robinhood', name: 'Robinhood Chain', authority: 'burning', venue: 'Uniswap v3',
    mainnet: { id: 4663, wormholeId: 72, rpc: 'https://rpc.mainnet.chain.robinhood.com', core: '0x141fBa8AD5D61bdaB45A047cF60b5Ad9784987FB', market: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa' },
    testnet: { id: 46630, wormholeId: null, rpc: 'https://rpc.testnet.chain.robinhood.com', core: null, market: null },
    prerequisite: 'Robinhood testnet exists; NTT support/Guardian route and official testnet venue addresses are not documented. A mainnet fork cannot prove that public testnet route.' },
]
export function readiness() {
  return { paidLaunchOpen: false, tokenAddresses: [] as string[], publicRouteTests: 0, bridge: BRIDGE,
    routes: NETWORKS.map((n) => ({ chain: n.chain, name: n.name, mode: 'testnet' as const, open: false, tested: false, venue: n.venue, prerequisite: n.prerequisite })) }
}
