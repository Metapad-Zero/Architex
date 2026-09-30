import { describe, expect, test } from 'bun:test'
import { cycleCost, decide, decideRecovery, drained, legLimits, requiredBuyCash, requiredReserve } from '../policy'
import { POLICY, chainQuote, snapshot } from './fixtures'

describe('keeper policy', () => {
  test('opens the profitable direction at the same quantity on both pools', () => {
    const decision = decide(snapshot(), POLICY)
    expect(decision.reason).toBe('ok')
    expect(decision.candidate).toMatchObject({ buy: 'arc', sell: 'base', tokens: '1000000000' })
    // 1,194.0 received - 1,005.0 paid - 0.6 gas - 2.0 recovery - 0.5 buffer.
    expect(decision.candidate!.cost).toBe('2600000')
    expect(decision.candidate!.edge).toBe('185900000')
  })

  test('prices both sides for the identical quantity', () => {
    const taken = snapshot()
    expect(taken.quotes.arc.tokens).toBe(taken.tokens)
    expect(taken.quotes.base.tokens).toBe(taken.tokens)
  })

  test('refuses when the gap does not cover fees, gas, recovery and the buffer', () => {
    const decision = decide(snapshot({}, { base: { sellProceeds: '1006000000' } }), POLICY)
    expect(decision.reason).toBe('no_edge')
    expect(decision.candidate).toBeNull()
    expect(decision.detail).toContain('below the 1000000 minimum edge')
  })

  test('counts the pool fee once, from the pool quotes, and never twice', () => {
    const taken = snapshot()
    const candidate = decide(taken, POLICY).candidate!
    const gross = BigInt(taken.quotes.base.sellProceeds) - BigInt(taken.quotes.arc.buyCost)
    expect(BigInt(candidate.edge)).toBe(gross - BigInt(candidate.cost) - BigInt(POLICY.buffer))
  })

  test('refuses a sale the selling chain has no inventory for, and names the refill as separate', () => {
    const decision = decide(snapshot({}, { base: { keeperTokens: '999999999' } }), POLICY)
    expect(decision.reason).toBe('inventory')
    expect(decision.detail).toContain('Refill is a separate authorized route')
  })

  test('refuses a purchase the buying chain cannot even pay for', () => {
    const need = requiredBuyCash(1_005_000_000n, chainQuote('arc'))
    expect(need).toBe(1_005_000_000n + 300_000n)
    const decision = decide(snapshot({}, { arc: { keeperQuote: (need - 1n).toString() } }), POLICY)
    expect(decision.reason).toBe('inventory')
  })

  test('refuses when the purchase would leave less than the reserved recovery capacity', () => {
    // Affordable, but the unwind of the position it opens would no longer be funded.
    const need = requiredBuyCash(1_005_000_000n, chainQuote('arc'))
    const short = need + requiredReserve(POLICY) - 1n
    expect(decide(snapshot({}, { arc: { keeperQuote: short.toString() } }), POLICY).reason).toBe('recovery_reserve')
    expect(decide(snapshot({}, { arc: { keeperQuote: (short + 1n).toString() } }), POLICY).reason).toBe('ok')
  })

  test('refuses once the session spending cap would be passed', () => {
    const decision = decide(snapshot({}, { arc: { spentQuote: '3000000000' } }), POLICY)
    expect(decision.reason).toBe('spend_cap')
  })

  test('stops on the realized-loss cap before looking at any price', () => {
    const decision = decide(snapshot({ loss: POLICY.lossCap }), POLICY)
    expect(decision.reason).toBe('loss_cap')
  })

  test('stops while a vault is halted', () => {
    expect(decide(snapshot({}, { arc: { halted: true } }), POLICY).reason).toBe('halted')
  })

  test('stops while an earlier cycle still holds a position, from the record or from the chain', () => {
    expect(decide(snapshot({ unresolved: ['cycle-1'] }), POLICY).reason).toBe('unresolved_exposure')
    expect(decide(snapshot({}, { arc: { openCycles: 1 } }), POLICY).reason).toBe('unresolved_exposure')
  })

  test('refuses a stale quote by block lag or by age', () => {
    expect(decide(snapshot({ lag: { arc: { blocks: 21, seconds: 0 }, base: { blocks: 0, seconds: 0 } } }), POLICY).reason).toBe('stale_quote')
    expect(decide(snapshot({ lag: { arc: { blocks: 0, seconds: 0 }, base: { blocks: 0, seconds: 601 } } }), POLICY).reason).toBe('stale_quote')
  })

  test('refuses an unavailable chain', () => {
    expect(decide(snapshot({ stalled: ['base'] }), POLICY).reason).toBe('chain_unavailable')
  })

  test('refuses a cycle above the per-cycle size limit', () => {
    const taken = snapshot({ tokens: '2000000001' }, { arc: { tokens: '2000000001' }, base: { tokens: '2000000001' } })
    expect(decide(taken, POLICY).reason).toBe('size')
  })

  test('reports a blocked-but-profitable route rather than the other direction having no edge', () => {
    const decision = decide(snapshot({}, { base: { keeperTokens: '0' } }), POLICY)
    expect(decision.reason).toBe('inventory')
  })

  test('binds each leg to a limit derived from its own quote and the slippage allowance', () => {
    const candidate = decide(snapshot(), POLICY).candidate!
    const { buyLimit, sellFloor } = legLimits(candidate, POLICY)
    expect(buyLimit).toBe((1_005_000_000n * 10_050n) / 10_000n)
    expect(sellFloor).toBe((1_194_000_000n * 9_950n) / 10_000n)
    expect(buyLimit).toBeGreaterThan(BigInt(candidate.buyCost))
    expect(sellFloor).toBeLessThan(BigInt(candidate.sellProceeds))
  })

  test('cycle cost is both legs plus the reserved recovery leg', () => {
    expect(cycleCost(chainQuote('arc'), chainQuote('base'), POLICY)).toBe(300_000n + 300_000n + 2_000_000n)
  })

  test('net drain never reads below zero', () => {
    expect(drained(chainQuote('arc', { spentQuote: '1', receivedQuote: '5' }))).toBe(0n)
    expect(drained(chainQuote('arc', { spentQuote: '9', receivedQuote: '5' }))).toBe(4n)
  })
})

describe('keeper recovery policy', () => {
  const position = { cycle: 'cycle-1', buy: 'arc' as const, tokens: '1000000000', spent: '1005000000' }

  test('unwinds on the purchase market at a floor derived from that market', () => {
    const outcome = decideRecovery(snapshot(), POLICY, position)
    expect('floor' in outcome).toBe(true)
    if (!('floor' in outcome)) return
    expect(outcome.floor).toBe(((995_000_000n * 9_950n) / 10_000n).toString())
    // Paid 1,005.0, floor 990.025, plus 0.3 gas.
    expect(outcome.loss).toBe((1_005_000_000n + 300_000n - (995_000_000n * 9_950n) / 10_000n).toString())
  })

  test('refuses and leaves the position open when the unwind would pass the loss cap', () => {
    const outcome = decideRecovery(snapshot({ loss: '199000000' }), POLICY, position)
    expect(outcome).toHaveProperty('refused')
    expect((outcome as { refused: string }).refused).toContain('stays open and the keeper stays halted')
  })

  test('refuses to unwind against a stale or unavailable purchase market', () => {
    expect(decideRecovery(snapshot({ lag: { arc: { blocks: 99, seconds: 0 }, base: { blocks: 0, seconds: 0 } } }), POLICY, position)).toHaveProperty('refused')
    expect(decideRecovery(snapshot({ stalled: ['arc'] }), POLICY, position)).toHaveProperty('refused')
  })

  test('refuses when the purchase market no longer holds the tokens to unwind', () => {
    expect(decideRecovery(snapshot({}, { arc: { keeperTokens: '1' } }), POLICY, position)).toHaveProperty('refused')
  })

  test('refuses when the purchase chain cannot pay the recovery gas', () => {
    expect(decideRecovery(snapshot({}, { arc: { keeperQuote: '0' } }), POLICY, position)).toHaveProperty('refused')
  })
})
