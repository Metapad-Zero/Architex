import { describe, expect, test } from 'bun:test'
import { encodePacked, getContractAddress, keccak256, toEventSelector, type AbiEvent, type Address } from 'viem'
import mainnet from '../../deployments/arc-mainnet.json'
import testnet from '../../deployments/arc-testnet.json'
import { factoryAbi, launchPairAbi, launchPairFactoryAbi, launchRouterAbi, launchpadAbi, pairAbi } from '../abi'
import { LAUNCH_TOPICS, MAINNET_USDC_EURC_PAIR, PAIR_INIT_CODE_HASH, UNISWAP_V2_TOPICS } from '../integration'

/** What a Uniswap V2 SDK computes: CREATE2 over the sorted pair and the init code hash. */
function pairFor(factory: string, tokenA: string, tokenB: string, initCodeHash: `0x${string}`): Address {
  const [token0, token1] = tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA]
  const salt = keccak256(encodePacked(['address', 'address'], [token0 as Address, token1 as Address]))
  return getContractAddress({ opcode: 'CREATE2', from: factory as Address, salt, bytecodeHash: initCodeHash })
}

function topic(abi: readonly unknown[], name: string): string {
  const event = (abi as AbiEvent[]).find((item) => item.type === 'event' && item.name === name)
  if (!event) throw new Error(`no ${name}`)
  return toEventSelector(event)
}

describe('the init code hash reproduces the live pairs', () => {
  test('mainnet: USDC/EURC is factory.allPairs(0)', () => {
    const [usdc, eurc] = [mainnet.tokens[0].address, mainnet.tokens[1].address]
    expect(pairFor(mainnet.factory, usdc, eurc, PAIR_INIT_CODE_HASH.mainnet)).toBe(MAINNET_USDC_EURC_PAIR)
  })

  test('testnet: every pair in the deployment file', () => {
    for (const pair of testnet.pairs) expect(pairFor(testnet.factory, pair.token0, pair.token1, PAIR_INIT_CODE_HASH.testnet)).toBe(pair.pair as Address)
  })
})

describe('events', () => {
  test('the core factory and pair emit exactly Uniswap V2 topics', () => {
    expect(topic(factoryAbi, 'PairCreated')).toBe(UNISWAP_V2_TOPICS.PairCreated)
    for (const name of ['Swap', 'Sync', 'Mint', 'Burn'] as const) expect(topic(pairAbi, name)).toBe(UNISWAP_V2_TOPICS[name])
  })

  test('a launch pair reuses the V2 topics, but its factory does not', () => {
    for (const name of ['Swap', 'Sync', 'Mint', 'Burn'] as const) expect(topic(launchPairAbi, name)).toBe(UNISWAP_V2_TOPICS[name])
    expect(topic(launchPairFactoryAbi, 'PairCreated')).toBe(LAUNCH_TOPICS.LaunchPairCreated)
    expect(new Set<string>([LAUNCH_TOPICS.LaunchPairCreated, UNISWAP_V2_TOPICS.PairCreated]).size).toBe(2)
  })

  test('the launch topics match the ABIs', () => {
    expect(topic(launchpadAbi, 'TokenCreated')).toBe(LAUNCH_TOPICS.TokenCreated)
    expect(topic(launchpadAbi, 'Trade')).toBe(LAUNCH_TOPICS.Trade)
    expect(topic(launchpadAbi, 'Graduated')).toBe(LAUNCH_TOPICS.Graduated)
    expect(topic(launchRouterAbi, 'PoolTrade')).toBe(LAUNCH_TOPICS.PoolTrade)
  })
})
