import { describe, expect, test } from 'bun:test'
import { rehearseMaintenance } from '../maintenance-rehearse'

const suite = process.env.EQUILIBRIUM_FORK === '1' ? describe : describe.skip
suite('combined keeper and authenticated inventory maintenance', () => {
  test('depletion, two mined-send crashes, fresh process restarts, bounded trading, caps and exposure refusal', async () => {
    const evidence = await rehearseMaintenance({ writeArtifacts: false })
    expect(Object.values(evidence.checks).every(Boolean)).toBe(true)
    expect(evidence.maintenance.receiptCosts).toHaveLength(5)
    expect(evidence.cycle.state).toBe('closed')
  }, 900_000)
})
