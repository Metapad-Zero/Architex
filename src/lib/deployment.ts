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
  deployer: Address
  tokens: DeploymentToken[]
  pairs: DeploymentPair[]
  txs: { factory: Hash; router: Hash; lens: Hash }
}

export const deployment = (arcNetwork === 'mainnet' ? mainnetDeployment : testnetDeployment) as ArchitexDeployment
export const isDeployed = deployment.factory !== zeroAddress
