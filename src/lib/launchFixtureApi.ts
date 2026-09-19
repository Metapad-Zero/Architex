import type { Address, Hash } from 'viem'
import type { LaunchRecord, LaunchTrade } from './launch'

export interface LaunchFixtureApi {
  subscribe: (onStoreChange: () => void) => () => void
  version: () => number
  launchFee: () => bigint
  list: () => LaunchRecord[]
  get: (token: Address) => LaunchRecord | undefined
  balance: (owner: Address | undefined, token: Address) => bigint
  allowance: (owner: Address | undefined, token: Address) => bigint
  trades: (token: Address) => LaunchTrade[]
  approve: (owner: Address, token: Address, value: bigint) => Hash
  buy: (owner: Address, token: Address, usdcIn: bigint) => { hash: Hash; tokensOut: bigint; usdcSpent: bigint; graduates: boolean }
  sell: (owner: Address, token: Address, tokensIn: bigint) => { hash: Hash; usdcOut: bigint }
  create: (owner: Address, name: string, symbol: string, metadataURI: string, initialBuyUsdc: bigint) => { hash: Hash; token: Address }
}

let api: LaunchFixtureApi | undefined

export function setLaunchFixtureApi(next: LaunchFixtureApi): void {
  api = next
}

export function launchFixtureApi(): LaunchFixtureApi | undefined {
  return api
}
