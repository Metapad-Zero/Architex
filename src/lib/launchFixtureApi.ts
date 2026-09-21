import type { Address, Hash, Hex } from 'viem'
import type { LaunchRecord, LaunchTrade } from './launch'
import type { CreatorFeeState } from './plugins/state'

export interface FixtureCreateArgs {
  name: string
  symbol: string
  metadataURI: string
  creatorFeeBps: number
  plugin: Address
  pluginData: Hex
  initialBuyUsdc: bigint
  maxLaunchFee: bigint
}

/** The dev fixture's stand-in for the v1.3 suite (launchpad, launch router, reference plugins). */
export interface LaunchFixtureApi {
  subscribe: (onStoreChange: () => void) => () => void
  version: () => number
  launchFee: () => bigint
  list: () => LaunchRecord[]
  get: (token: Address) => LaunchRecord | undefined
  balance: (owner: Address | undefined, token: Address) => bigint
  allowance: (owner: Address | undefined, token: Address, spender: Address) => bigint
  trades: (token: Address) => LaunchTrade[]
  approve: (owner: Address, token: Address, spender: Address, value: bigint) => Hash
  /** A curve buy before graduation, a launch-pool buy after. */
  buy: (owner: Address, token: Address, usdcIn: bigint) => { hash: Hash }
  sell: (owner: Address, token: Address, tokensIn: bigint) => { hash: Hash }
  create: (owner: Address, args: FixtureCreateArgs) => { hash: Hash; token: Address }
  creatorFees: (token: Address, owner: Address | undefined) => CreatorFeeState | undefined
  collect: (token: Address) => Hash
  release: (token: Address, payee: Address) => Hash
  runBuyback: (token: Address) => Hash
  /** The owner claims its dividends on the token. */
  claim: (token: Address, owner: Address) => Hash
}

let api: LaunchFixtureApi | undefined

export function setLaunchFixtureApi(next: LaunchFixtureApi): void {
  api = next
}

export function launchFixtureApi(): LaunchFixtureApi | undefined {
  return api
}
