import type { Address } from 'viem'

/**
 * Which chain the listing endpoints read, and the addresses they read there.
 *
 * The addresses mirror src/deployments/arc-mainnet.json and arc-testnet.json. They are copied rather than imported
 * because a Vercel function runs as a native Node module, which cannot import JSON without import attributes that
 * the build tooling may not carry through. server/__tests__/listingNetwork.test.ts fails when the two drift apart, so
 * a redeployed contract cannot be picked up by the site and missed here.
 *
 * The network follows the same switch as the app: VITE_ARC_NETWORK=mainnet (ARC_NETWORK overrides it for the server
 * alone), anything else is testnet. Production runs with VITE_ARC_NETWORK=mainnet, so these endpoints read mainnet
 * there and testnet on previews that build the testnet app.
 */
export type ListingNetworkName = 'mainnet' | 'testnet'

export interface ListingToken {
  symbol: string
  name: string
  address: Address
  decimals: number
}

export interface ListingNetwork {
  name: ListingNetworkName
  chainId: number
  explorerBase: string
  /** Public RPC endpoints, tried in order; ARC_RPC_URL replaces them. */
  rpcUrls: readonly string[]
  factory: Address
  router: Address
  lens: Address
  /** Launchpad v1.3 and its launch-pool suite; zero where it is not deployed. */
  launchpad: Address
  launchPairFactory: Address
  launchRouter: Address
  usdc: Address
  /** The deployment's own tokens, which the token list always carries. */
  tokens: readonly ListingToken[]
  /** Quote assets, most preferred first: a core pair with one of them is quoted in it. */
  quotes: readonly Address[]
}

const USDC: Address = '0x3600000000000000000000000000000000000000'

export const NETWORKS: Readonly<Record<ListingNetworkName, ListingNetwork>> = {
  mainnet: {
    name: 'mainnet',
    chainId: 5042,
    explorerBase: 'https://explorer.arc.io',
    rpcUrls: ['https://rpc.mainnet.arc.io', 'https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.quicknode.mainnet.arc.io'],
    factory: '0x3648cc1323b4729e472cffdC570C6096565b0923',
    router: '0xC373dCf04547515801b4502500924459b8c877a8',
    lens: '0x9302f61cbb1f1572F50EB76C794ca623DacD1aDd',
    launchpad: '0xC4Edce6e3751a91dc9094f140D217aCE23221327',
    launchPairFactory: '0xAE59776B7B3B23AcD6784cA0f9E5256C82d2f41a',
    launchRouter: '0x4B179cD28c4e6014a7b311df3db1B6284dF2b808',
    usdc: USDC,
    tokens: [
      { symbol: 'USDC', name: 'USD Coin', address: USDC, decimals: 6 },
      { symbol: 'EURC', name: 'EURC', address: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1', decimals: 6 },
    ],
    quotes: [USDC, '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1'],
  },
  testnet: {
    name: 'testnet',
    chainId: 5042002,
    explorerBase: 'https://explorer.testnet.arc.io',
    rpcUrls: ['https://rpc.testnet.arc.io', 'https://rpc.testnet.arc.network', 'https://rpc.blockdaemon.testnet.arc.network'],
    factory: '0x6362f5A0fc007AB7D1e61f99D3F4eB04360D060a',
    router: '0xCB417BbB2C3cE02296229ca89B639bb3Af2538E2',
    lens: '0x8ee79a8a702e7f8dd433b940d11b327e5153094b',
    launchpad: '0x02Bf15bc8caB1b5BCf210C1C55bA2c91AC20164E',
    launchPairFactory: '0xe538e1C2d08D5014CF89715F53F3135Aa8E34905',
    launchRouter: '0x63E473AD3d1A7CE84E9Ea5C7435BEFf89cb4e833',
    usdc: USDC,
    tokens: [
      { symbol: 'USDC', name: 'USD Coin', address: USDC, decimals: 6 },
      { symbol: 'WETH', name: 'Wrapped Ether (test)', address: '0xf2bb050Eb30A9Cd4Bd5Df986C626765ae57d21e4', decimals: 18 },
      { symbol: 'WBTC', name: 'Wrapped Bitcoin (test)', address: '0x34136a662681Df7AaCbF2aAD5C35258Db8f1a113', decimals: 8 },
      { symbol: 'ARC', name: 'Arc Token (test)', address: '0x004925d26559DE8823106E3Cbf47ED870788d0D5', decimals: 18 },
      { symbol: 'EURC', name: 'Euro Coin (test)', address: '0x07748023f41001efD73D7907D74F8222a76B2DC2', decimals: 6 },
    ],
    quotes: [USDC, '0x07748023f41001efD73D7907D74F8222a76B2DC2'],
  },
}

type Env = Readonly<Record<string, string | undefined>>

/** mainnet only when asked for by name, as in src/chain.ts; ARC_NETWORK wins over VITE_ARC_NETWORK. */
export function networkFromEnv(env: Env): ListingNetworkName {
  const requested = (env.ARC_NETWORK ?? env.VITE_ARC_NETWORK ?? '').trim().toLowerCase()
  return requested === 'mainnet' ? 'mainnet' : 'testnet'
}

/**
 * ARC_RPC_URL (server only; one URL or several separated by commas, https only) replaces the public endpoints, for
 * a keyed provider without the public endpoint's burst limits. The app's VITE_ARC_RPC_URL is deliberately not read:
 * it ships in the browser bundle and may be locked to the site's origin.
 */
export function rpcUrlsFromEnv(env: Env, network: ListingNetwork): string[] {
  const configured = (env.ARC_RPC_URL ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter((url) => url.startsWith('https://'))
  return configured.length > 0 ? configured : [...network.rpcUrls]
}
