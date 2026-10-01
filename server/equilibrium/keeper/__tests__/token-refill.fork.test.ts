import { describe, expect, test } from 'bun:test'
import { rehearseTokenRefill } from '../token-refill-rehearse'
const suite = process.env.EQUILIBRIUM_FORK === '1' ? describe : describe.skip
suite('Arc→Base keeper token refill', () => {
  test('authenticated finalized refill, refusals, costs, replay and twelve process crash boundaries', async () => {
    const evidence = await rehearseTokenRefill({ writeArtifacts: false })
    expect(Object.values(evidence.checks).every(Boolean)).toBe(true)
    expect(evidence.crashes).toHaveLength(12)
    expect(evidence.receiptCosts).toHaveLength(28)
  }, 900_000)
})
