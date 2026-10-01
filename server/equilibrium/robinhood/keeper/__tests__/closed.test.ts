import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { boundedSender } from '../sender'
import { assertInputs, valueOf, localLimit, legCost } from '../quotes'
import { decide, decideRecovery } from '../policy'
import { FORK_POLICY } from '../../../keeper/fork'
import { DEV } from '../../../evm/fork'
import type { KeeperChainConfig, KeeperConfig, KeeperSnapshot } from '../types'

const address = '0x1111111111111111111111111111111111111111' as const
const chain = (): KeeperChainConfig => ({ chain: 'robinhood', chainId: 4663, rpc: 'http://127.0.0.1:18946', keeper: address, token: address, quote: address, pool: address, venue: 'uniswap-v3-pool', finality: 2, fromBlock: 0n, quoteAtomsPerNative: 5_000_000_000n, valuation: { numerator: '98', denominator: '100', source: 'explicit fixture', expiresAt: Math.floor(Date.now() / 1000) + 600 }, feeInput: { kind: 'fork-fixture', source: 'synthetic allowance', l1UpperWei: '1000000000000', expiresAt: Math.floor(Date.now() / 1000) + 600 } })
const policy = { ...FORK_POLICY, operatingCap: '30000000' }
const snapshot = (): KeeperSnapshot => {
  const q = { chain: 'arc' as const, pool: address, tokens: '1000000000', rawBuyCost: '1000000000', rawSellProceeds: '999000000', buyCost: '1000000000', sellProceeds: '999000000', blockNumber: '100', observedAt: 100, keeperTokens: '4000000000', keeperQuote: '8000000000', spentQuote: '0', receivedQuote: '0', openCycles: 0, halted: false, legCost: '100000' }
  return { at: 100, tokens: q.tokens, quotes: { arc: q, robinhood: { ...q, chain: 'robinhood', buyCost: '1200000000', sellProceeds: '1170000000' } }, lag: { arc: { blocks: 0, seconds: 0 }, robinhood: { blocks: 0, seconds: 0 } }, stalled: [], loss: '0', net: '0', unresolved: [] }
}
describe('closed Robinhood keeper input and budget gates', () => {
  test('USDG uses explicit non-parity valuation, rounded against the keeper', () => {
    expect(valueOf(chain(), 100n)).toBe(98n)
    expect(valueOf(chain(), 1n, true)).toBe(1n)
    expect(valueOf(chain(), 1n)).toBe(0n)
    expect(localLimit(chain(), 98n, true)).toBe(100n)
    expect(localLimit(chain(), 1n, false)).toBe(2n)
  })
  test.each(['valuation', 'feeInput'] as const)('missing %s refuses before trading', (key) => {
    const c = chain(); delete (c as Partial<KeeperChainConfig>)[key]
    expect(() => assertInputs(c)).toThrow(/unavailable/)
  })
  test.each(['valuation', 'feeInput'] as const)('expired %s refuses before trading', (key) => {
    const c = chain(); c[key].expiresAt = 1
    expect(() => assertInputs(c)).toThrow(/unavailable/)
  })
  test('synthetic L1 component is charged even when L2 fee is zero', () => {
    expect(legCost({} as Parameters<typeof legCost>[0], chain(), 0n, 0n)).toBe(5000n)
  })
  test('public sends are closed at construction', () => {
    const c: KeeperConfig = { mode: 'fork', operatorKey: DEV.operator, arc: { ...chain(), chain: 'arc' }, robinhood: { ...chain(), rpc: 'https://rpc.mainnet.chain.robinhood.com' }, policy }
    const db = new Database(':memory:')
    expect(() => boundedSender(c, db)).toThrow(/loopback/)
    db.close()
  })
  test('maintenance and loss block a price opportunity', () => {
    const s = snapshot(); expect(decide(s, policy).reason).toBe('ok')
    s.maintenance = ['pending-authenticated-refill']; expect(decide(s, policy).reason).toBe('unresolved_exposure')
    s.maintenance = []; s.loss = policy.lossCap; expect(decide(s, policy).reason).toBe('loss_cap')
  })
  test('session spend includes both chains', () => {
    const s = snapshot(); s.quotes.arc.spentQuote = '2000000000'; s.quotes.robinhood.spentQuote = '2500000000'
    expect(decide(s, policy).reason).toBe('spend_cap')
  })
  test('recovery refuses to exceed remaining loss allowance', () => {
    const s = snapshot(); s.loss = '199999999'
    expect(decideRecovery(s, policy, { cycle: 'exposed', buy: 'arc', tokens: s.tokens, spent: '1000000000' })).toHaveProperty('refused')
  })
})
