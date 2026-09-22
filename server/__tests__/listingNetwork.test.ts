import { describe, expect, test } from 'bun:test'
import mainnet from '../../src/deployments/arc-mainnet.json'
import testnet from '../../src/deployments/arc-testnet.json'
import { NETWORKS, networkFromEnv, rpcUrlsFromEnv } from '../listing/network'

const lower = (value: string) => value.toLowerCase()

describe('the listing API reads the same contracts as the site', () => {
  for (const [name, file] of [
    ['mainnet', mainnet],
    ['testnet', testnet],
  ] as const) {
    test(`${name}: every address matches src/deployments`, () => {
      const network = NETWORKS[name]
      expect(network.chainId).toBe(file.chainId)
      expect(network.explorerBase).toBe(file.explorerBase)
      for (const key of ['factory', 'router', 'lens', 'launchpad', 'launchPairFactory', 'launchRouter'] as const) {
        expect(`${key} ${lower(network[key])}`).toBe(`${key} ${lower(file[key])}`)
      }
      expect(network.tokens.map((token) => [token.symbol, lower(token.address), token.decimals])).toEqual(
        file.tokens.map((token) => [token.symbol, lower(token.address), token.decimals]),
      )
      expect(lower(network.usdc)).toBe(lower(file.tokens.find((token) => token.symbol === 'USDC')?.address ?? ''))
    })
  }
})

describe('network and RPC from the environment', () => {
  test('mainnet only when asked for by name, as the app does; ARC_NETWORK wins', () => {
    expect(networkFromEnv({})).toBe('testnet')
    expect(networkFromEnv({ VITE_ARC_NETWORK: 'mainnet' })).toBe('mainnet')
    expect(networkFromEnv({ VITE_ARC_NETWORK: ' Mainnet ' })).toBe('mainnet')
    expect(networkFromEnv({ VITE_ARC_NETWORK: 'main' })).toBe('testnet')
    expect(networkFromEnv({ VITE_ARC_NETWORK: 'mainnet', ARC_NETWORK: 'testnet' })).toBe('testnet')
  })

  test('ARC_RPC_URL replaces the public endpoints; only https is taken; the app variable is ignored', () => {
    expect(rpcUrlsFromEnv({}, NETWORKS.mainnet)).toEqual([...NETWORKS.mainnet.rpcUrls])
    expect(rpcUrlsFromEnv({ ARC_RPC_URL: 'https://a.example, https://b.example' }, NETWORKS.mainnet)).toEqual(['https://a.example', 'https://b.example'])
    expect(rpcUrlsFromEnv({ ARC_RPC_URL: 'http://plain.example' }, NETWORKS.mainnet)).toEqual([...NETWORKS.mainnet.rpcUrls])
    expect(rpcUrlsFromEnv({ VITE_ARC_RPC_URL: 'https://browser.example' }, NETWORKS.mainnet)).toEqual([...NETWORKS.mainnet.rpcUrls])
    expect(NETWORKS.mainnet.rpcUrls[0]).toBe('https://rpc.mainnet.arc.io')
  })
})
