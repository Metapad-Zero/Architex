import type { Address } from 'viem'
import type { ChainQuote, KeeperChain, KeeperPolicy, KeeperSnapshot } from '../types'

export const POLICY: KeeperPolicy = {
  maxTokens: '2000000000',
  minEdge: '1000000',
  buffer: '500000',
  spendCap: '4000000000',
  lossCap: '200000000',
  recoveryReserve: '1500000000',
  recoveryCost: '2000000',
  maxLegCost: '1000000',
  maxQuoteAgeSeconds: 600,
  maxBlockLag: 20,
  maxHeadAgeSeconds: 3600,
  legTtlSeconds: 600,
  slippageBps: 50,
  maxOpenCycles: 1,
}

const pool = (chain: KeeperChain): Address => (chain === 'arc' ? '0x00000000000000000000000000000000000000a1' : '0x00000000000000000000000000000000000000b1')

export function chainQuote(chain: KeeperChain, over: Partial<ChainQuote> = {}): ChainQuote {
  return {
    chain, pool: pool(chain), tokens: '1000000000',
    buyCost: chain === 'arc' ? '1005000000' : '1205000000',
    sellProceeds: chain === 'arc' ? '995000000' : '1194000000',
    blockNumber: '1000', observedAt: 1_800_000_000,
    keeperTokens: '2000000000', keeperQuote: '5000000000',
    spentQuote: '0', receivedQuote: '0', openCycles: 0, halted: false,
    legCost: '300000',
    ...over,
  }
}

export function snapshot(over: Partial<KeeperSnapshot> = {}, quotes: Partial<Record<KeeperChain, Partial<ChainQuote>>> = {}): KeeperSnapshot {
  return {
    at: 1_800_000_000, tokens: '1000000000',
    quotes: { arc: chainQuote('arc', quotes.arc), base: chainQuote('base', quotes.base) },
    lag: { arc: { blocks: 0, seconds: 0 }, base: { blocks: 0, seconds: 0 } },
    stalled: [], loss: '0', net: '0', unresolved: [],
    ...over,
  }
}
