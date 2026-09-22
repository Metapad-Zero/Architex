import { encodeAbiParameters, encodeEventTopics, type Abi, type AbiEvent, type Address, type Hex } from 'viem'
import type { Market, Snapshot, TokenInfo } from '../listing/chain'
import type { RawLog } from '../listing/logs'
import { NETWORKS } from '../listing/network'

/** A small Arc mainnet as the listing API sees it: USDC/EURC in the core AMM, one launch in its pool, one on its curve. */
export const network = NETWORKS.mainnet
export const USDC: TokenInfo = { address: '0x3600000000000000000000000000000000000000', symbol: 'USDC', name: 'USDC', decimals: 6 }
export const EURC: TokenInfo = { address: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1', symbol: 'EURC', name: 'EURC', decimals: 6 }
export const POOLED: TokenInfo = { address: '0x1111111111111111111111111111111111111111', symbol: 'POOL', name: 'Pooled Token', decimals: 18 }
export const CURVED: TokenInfo = { address: '0x2222222222222222222222222222222222222222', symbol: 'CRV', name: 'Curve Token', decimals: 18 }
export const CORE_PAIR: Address = '0x6B27c00Db2E1fCBE68955C9194B656768B7Cdb06'
export const POOLED_PAIR: Address = '0x3333333333333333333333333333333333333333'
export const CURVED_PAIR: Address = '0x4444444444444444444444444444444444444444'

export const TIME = 1_790_000_000
export const BLOCK = 22_000_000n

const E18 = 10n ** 18n

export function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const core: Market = {
    kind: 'core',
    tickerId: `${EURC.address}_${USDC.address}`,
    key: `${EURC.address}_${USDC.address}`.toLowerCase(),
    poolId: CORE_PAIR,
    base: EURC,
    target: USDC,
    baseReserve: 244_524_893n,
    targetReserve: 281_638_016n,
    feeBps: 30,
    feeOn: 'input',
    baseIsToken0: false,
  }
  const pool: Market = {
    kind: 'pool',
    tickerId: `${POOLED.address}_${USDC.address}`,
    key: `${POOLED.address}_${USDC.address}`.toLowerCase(),
    poolId: POOLED_PAIR,
    base: POOLED,
    target: USDC,
    baseReserve: 200_000_000n * E18,
    targetReserve: 25_000_000_000n,
    feeBps: 150,
    feeOn: 'usdc',
    launchPair: POOLED_PAIR,
    creatorFeeBps: 100,
  }
  const curve: Market = {
    kind: 'curve',
    tickerId: `${CURVED.address}_${USDC.address}`,
    key: `${CURVED.address}_${USDC.address}`.toLowerCase(),
    poolId: CURVED.address,
    base: CURVED,
    target: USDC,
    baseReserve: 1_066_666_667n * E18,
    targetReserve: 8_333_333_333n,
    feeBps: 300,
    feeOn: 'usdc',
    launchPair: CURVED_PAIR,
    creatorFeeBps: 250,
    curve: { tokensLeft: 800_000_000n * E18, tokensSold: 0n, usdcHeld: 0n },
  }
  const tokens = new Map<string, TokenInfo>()
  for (const token of [USDC, EURC, POOLED, CURVED]) tokens.set(token.address.toLowerCase(), token)
  return {
    network,
    block: BLOCK,
    time: TIME,
    markets: [core, pool, curve],
    launches: [
      { token: POOLED.address, pair: POOLED_PAIR, creatorFeeBps: 100, graduated: true, metadataURI: '', createdAt: TIME - 5000 },
      { token: CURVED.address, pair: CURVED_PAIR, creatorFeeBps: 250, graduated: false, metadataURI: '', createdAt: TIME - 1000 },
    ],
    tokens,
    problems: [],
    ...overrides,
  }
}

export interface LogPlace {
  block: bigint
  logIndex: number
  tx: Hex
  time?: number
}

/** A log as eth_getLogs returns it, encoded from an ABI event and its arguments. */
export function makeLog(address: Address, abi: Abi, eventName: string, args: Record<string, unknown>, place: LogPlace): RawLog {
  const event = abi.find((item): item is AbiEvent => item.type === 'event' && item.name === eventName)
  if (!event) throw new Error(`No event ${eventName}`)
  // Every indexed argument is given, so there is no wildcard (null) topic to drop.
  const topics = encodeEventTopics({ abi: [event], eventName, args }).filter((topic): topic is Hex => typeof topic === 'string')
  const unindexed = event.inputs.filter((input) => !input.indexed)
  const data = encodeAbiParameters(unindexed, unindexed.map((input) => args[input.name ?? '']))
  return {
    address,
    topics,
    data,
    blockNumber: `0x${place.block.toString(16)}`,
    logIndex: `0x${place.logIndex.toString(16)}`,
    transactionHash: place.tx,
    ...(place.time === undefined ? {} : { blockTimestamp: `0x${place.time.toString(16)}` as const }),
    removed: false,
  }
}

export const tx = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`
