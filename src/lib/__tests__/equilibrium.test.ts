import { describe, expect, test } from 'bun:test'
import { CHAINS, ISSUANCE, LIMITS, UNIT, applyDemo, assertDemo, createDemo, gap, quoteCycle, restoreDemo, serializeDemo, supply, treasury, type DemoState } from '../equilibrium'

const shocked = () => applyDemo(createDemo(), { type: 'demand', chain: 'solana', quote: 200n * UNIT })
function row(state: DemoState, chain: string) { return state.markets.find((item) => item.chain === chain)! }

describe('EQUILIBRIUM supply model', () => {
  test('counts spendable supply once, excluding canonical custody', () => {
    const state = createDemo()
    expect(supply(state)).toEqual({ arc: ISSUANCE / 4n, remote: ISSUANCE * 3n / 4n, pending: 0n, economic: ISSUANCE, backing: ISSUANCE * 3n / 4n, reconciled: true })
  })
  for (const chain of CHAINS.filter((chain) => chain !== 'arc')) {
    test(`delayed Arc → ${chain} → Arc round trip reconciles exactly`, () => {
      let state = createDemo()
      const initial = serializeDemo(state)
      const amount = 80n * UNIT + 123456n
      state = applyDemo(state, { type: 'bridge', from: 'arc', to: chain, amount })
      expect(supply(state).pending).toBe(amount)
      expect(supply(state).reconciled).toBe(true)
      expect(row(state, chain).keeperTokens).toBe(250n * UNIT)
      // Restart while a source debit has happened but its credit has not.
      state = restoreDemo(serializeDemo(state))
      state = applyDemo(state, { type: 'complete', id: state.transfers[0].id })
      const complete = serializeDemo(state)
      expect(serializeDemo(applyDemo(state, { type: 'complete', id: state.transfers[0].id }))).toBe(complete)
      state = applyDemo(state, { type: 'bridge', from: chain, to: 'arc', amount })
      expect(supply(state).pending).toBe(amount)
      expect(supply(state).reconciled).toBe(true)
      state = applyDemo(state, { type: 'complete', id: state.transfers[1].id })
      expect(state.markets).toEqual(restoreDemo(initial).markets)
      expect(state.locked).toBe(restoreDemo(initial).locked)
      expect(supply(state).economic).toBe(ISSUANCE)
    })
  }
  test('unknown and unhealthy destination messages cannot credit tokens', () => {
    let state = applyDemo(createDemo(), { type: 'bridge', from: 'arc', to: 'base', amount: 80n * UNIT })
    state = applyDemo(state, { type: 'health', chain: 'base', health: 'offline' })
    const original = serializeDemo(state)
    expect(() => applyDemo(state, { type: 'complete', id: 'forged-message' })).toThrow('Unknown transfer')
    expect(() => applyDemo(state, { type: 'complete', id: state.transfers[0].id })).toThrow('Destination chain')
    expect(serializeDemo(state)).toBe(original)
    expect(supply(state).pending).toBe(80n * UNIT)
  })
  test('inventory cannot be transferred twice while the first debit is pending', () => {
    const state = applyDemo(createDemo(), { type: 'bridge', from: 'arc', to: 'base', amount: 250n * UNIT })
    expect(() => applyDemo(state, { type: 'bridge', from: 'arc', to: 'solana', amount: UNIT })).toThrow('available keeper')
    expect(() => applyDemo(state, { type: 'bridge', from: 'base', to: 'solana', amount: UNIT })).toThrow('Arc-to-spoke')
    expect(supply(state).reconciled).toBe(true)
  })
})

describe('bounded balancing', () => {
  test('reproduces the worked example with atom rounding and fee-inclusive quotes', () => {
    const state = shocked()
    const quote = quoteCycle(state).candidate!
    expect(quote).toEqual({ buy: 'arc', sell: 'solana', amount: 80n * UNIT, buyCost: 82893309n, sellProceeds: 89913973n, cost: 3n * UNIT, edge: 3020664n })
    expect(Math.abs(gap(state) - 16.61408)).toBeLessThan(0.000005)
    const after = applyDemo(state, { type: 'balance' })
    expect(Math.abs(gap(after) - 8.96564)).toBeLessThan(0.000005)
    expect(after.net).toBe(4020664n)
    expect(supply(after).economic).toBe(ISSUANCE)
    // Whole treasury cash loses costs, even though the keeper books a profit.
    expect(treasury(after).quote).toBe(treasury(state).quote - quote.cost)
    expect(treasury(after).tokens).toBe(treasury(state).tokens)
  })
  test('costs, empty inventory and exhausted session budget stop trades', () => {
    const costly = applyDemo(shocked(), { type: 'cost', amount: 100n * UNIT })
    expect(quoteCycle(costly).candidate).toBeNull()
    const noTokens = shocked()
    row(noTokens, 'solana').publicTokens += row(noTokens, 'solana').keeperTokens
    row(noTokens, 'solana').keeperTokens = 0n
    expect(quoteCycle(noTokens).reason).toContain('inventory')
    const noCash = shocked()
    noCash.markets.filter((item) => item.chain !== 'solana').forEach((item) => { item.keeperQuote = 0n })
    expect(quoteCycle(noCash).candidate).toBeNull()
    const budget = shocked(); budget.spent = LIMITS.dailySpend
    expect(quoteCycle(budget).reason).toContain('spending limit')
    for (const state of [costly, noTokens, noCash, budget]) {
      const after = applyDemo(state, { type: 'balance' })
      expect(after.markets).toEqual(state.markets)
      expect(after.net).toBe(0n)
      expect(after.receipts[after.receipts.length - 1].kind).toBe('skip')
    }
  })
  test('stale and offline markets are excluded from route selection', () => {
    for (const health of ['stale', 'offline'] as const) {
      const state = applyDemo(shocked(), { type: 'health', chain: 'solana', health })
      expect(quoteCycle(state).candidate).toBeNull()
      expect(quoteCycle(applyDemo(state, { type: 'health', chain: 'solana', health: 'healthy' })).candidate).not.toBeNull()
    }
  })
  test('a trade reserves recovery cash and session spending before it starts', () => {
    const state = shocked()
    const original = quoteCycle(state).candidate!
    state.spent = LIMITS.dailySpend - original.buyCost - original.cost
    const bounded = quoteCycle(state).candidate!
    expect(bounded.amount).toBeLessThan(original.amount)
    expect(state.spent + bounded.buyCost + bounded.cost + LIMITS.recoveryCost <= LIMITS.dailySpend).toBe(true)
    const noReserve = shocked()
    noReserve.markets.filter((item) => item.chain !== 'solana').forEach((item) => { item.keeperQuote = LIMITS.recoveryCost + noReserve.cost })
    expect(quoteCycle(noReserve).candidate).toBeNull()
  })
  test('a failed sale persists its exposure and recovery realizes all fees', () => {
    const before = shocked()
    let state = applyDemo(before, { type: 'balance', failSell: true })
    expect(state.halted).toBe(true)
    expect(state.net).toBe(0n)
    expect(state.recovery).not.toBeNull()
    expect(row(state, 'solana')).toEqual(row(before, 'solana'))
    expect(quoteCycle(state).candidate).toBeNull()
    expect(() => applyDemo(state, { type: 'bridge', from: 'arc', to: 'base', amount: UNIT })).toThrow('Recover')
    state = restoreDemo(serializeDemo(state))
    const after = applyDemo(state, { type: 'recover' })
    expect(after.halted).toBe(false)
    expect(after.recovery).toBeNull()
    expect(after.net).toBe(-after.loss)
    expect(after.loss).toBeGreaterThan(4n * UNIT)
    expect(after.loss).toBeLessThan(LIMITS.dailyLoss)
    expect(treasury(after).quote).toBe(treasury(before).quote - 4n * UNIT)
    expect(treasury(after).tokens).toBe(treasury(before).tokens)
    expect(supply(after).reconciled).toBe(true)
    expect(() => applyDemo(after, { type: 'recover' })).toThrow('no failed trade')
  })
  test('recovery refuses an unavailable purchase market or excessive remaining loss', () => {
    const failed = applyDemo(shocked(), { type: 'balance', failSell: true })
    const offline = applyDemo(failed, { type: 'health', chain: failed.recovery!.buy, health: 'offline' })
    expect(() => applyDemo(offline, { type: 'recover' })).toThrow('fresh and available')
    failed.loss = 9n * UNIT
    expect(() => applyDemo(failed, { type: 'recover' })).toThrow('remaining loss')
    expect(failed.halted).toBe(true)
  })
  test('repeated shocks, routes, restarts and actions never change issuance', () => {
    let state = createDemo()
    for (let i = 0; i < 120; i++) {
      const chain = CHAINS[i % 4]
      state = applyDemo(state, { type: 'demand', chain, quote: BigInt(50 + i % 200) * UNIT })
      state = applyDemo(state, { type: 'balance' })
      if (i % 3 === 0) {
        const target = CHAINS[1 + i % 3]
        state = applyDemo(state, { type: 'bridge', from: 'arc', to: target, amount: UNIT })
        const id = state.transfers[state.transfers.length - 1].id
        state = restoreDemo(serializeDemo(state))
        state = applyDemo(state, { type: 'complete', id })
        state = applyDemo(state, { type: 'complete', id })
      }
      expect(supply(state).economic).toBe(ISSUANCE)
      expect(supply(state).reconciled).toBe(true)
      expect(state.spent <= LIMITS.dailySpend).toBe(true)
      assertDemo(state)
    }
  })
})

describe('snapshot validation and atomic failures', () => {
  test('rejects malformed snapshots and tampered supply', () => {
    expect(() => restoreDemo('{}')).toThrow('invalid')
    expect(() => restoreDemo('not-json')).toThrow()
    const bad = createDemo(); bad.markets[0].publicTokens++
    expect(() => assertDemo(bad)).toThrow('invalid')
    const health = JSON.parse(serializeDemo(createDemo())) as { markets: { health: string }[] }
    health.markets[0].health = 'unknown'
    expect(() => restoreDemo(JSON.stringify(health))).toThrow('invalid')
    const version = serializeDemo(createDemo()).replace('"version":1', '"version":2')
    expect(() => restoreDemo(version)).toThrow('invalid')
  })
  test('invalid commands leave the caller snapshot untouched', () => {
    const state = createDemo(); const snapshot = serializeDemo(state)
    expect(() => applyDemo(state, { type: 'demand', chain: 'solana', quote: -UNIT })).toThrow()
    expect(() => applyDemo(state, { type: 'cost', amount: -UNIT })).toThrow()
    expect(() => applyDemo(state, { type: 'bridge', from: 'arc', to: 'arc', amount: UNIT })).toThrow()
    expect(serializeDemo(state)).toBe(snapshot)
  })
})
