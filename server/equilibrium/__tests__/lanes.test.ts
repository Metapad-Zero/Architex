import { describe, expect, test } from 'bun:test'
import { localAdapter } from '../localAdapter'
import { quote, runJob, reconcile } from '../runner'
import { JobStore } from '../store'
import type { EffectContext, Observation, PreparedEffect, PromotionalTokenAdapter, QueuedClaim } from '../types'
import { account, fixture, sign } from './fixtures'

/**
 * One job across all four chains, where one spoke is held, unreachable or broken. Each spoke's steps
 * depend on the Arc steps and on nothing in another spoke, so a held or unreachable spoke must defer
 * only its own lane, while an integrity failure still stops the whole job.
 */
const SOLANA = 'So1anaRecipient1111111111111111111111111111'
function fourChain(now: number) {
  const request = fixture(now)
  request.requestId = `lanes-${Math.random().toString(36).slice(2, 10)}`
  request.destinations = [
    { chain: 'arc', recipient: account.address, amount: '400000000000', poolTokens: '1000000000', poolQuote: '10000000' },
    { chain: 'base', recipient: account.address, amount: '100000000000', poolTokens: '1000000000', poolQuote: '10000000' },
    { chain: 'solana', recipient: SOLANA, amount: '100000000000', poolTokens: '1000000000', poolQuote: '10000000' },
    { chain: 'robinhood', recipient: account.address, amount: '100000000000', poolTokens: '1000000000', poolQuote: '10000000' },
  ]
  return request
}

interface Faults {
  /** Step id -> claim the destination holds after the effect landed. Removed to release it. */
  queued: Map<string, QueuedClaim>
  /** Step ids whose chain is unreachable: observe and broadcast fail as a refused connection would. */
  down: Set<string>
  /** Step ids whose observation proves something other than this job's effect. */
  conflict: Set<string>
}
function harness() {
  const store = new JobStore(':memory:')
  const base = localAdapter(store)
  const faults: Faults = { queued: new Map(), down: new Set(), conflict: new Set() }
  const broadcasts = new Map<string, number>()
  const refused = () => Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:18899'), { code: 'ECONNREFUSED' }) })
  const adapter: PromotionalTokenAdapter = {
    ...base,
    assertReady() { /* every lane is open in this double */ },
    async observe(context: EffectContext, prepared: PreparedEffect): Promise<Observation> {
      const id = context.step.id
      if (faults.down.has(id)) throw refused()
      if (faults.conflict.has(id)) throw new Error(`${id} already executed with other bytes`)
      const observed = await base.observe(context, prepared)
      const claim = faults.queued.get(id)
      if (claim && observed !== 'absent') return { queued: claim }
      return observed
    },
    async broadcast(context: EffectContext, prepared: PreparedEffect) {
      const id = context.step.id
      if (faults.down.has(id)) throw refused()
      broadcasts.set(id, (broadcasts.get(id) ?? 0) + 1)
      await base.broadcast(context, prepared)
    },
  }
  return { store, adapter, faults, broadcasts }
}
const state = (job: { steps: { id: string; state: string }[] }, id: string) => job.steps.find((s) => s.id === id)!.state

describe('spoke lanes of one four-chain job', () => {
  test('a queued Solana credit defers only the Solana lane; release completes it once', async () => {
    const now = Math.floor(Date.now() / 1000)
    const { store, adapter, faults, broadcasts } = harness()
    const claim: QueuedClaim = { reference: '0xclaim', amount: '100000000000', recipient: 'custody', releaseAfter: now + 86_400, observedClock: now, queuedAt: now }
    faults.queued.set('credit:solana', claim)
    const job = quote(store, adapter, fourChain(now), now)
    const first = await runJob(store, adapter, job.id, await sign(job))
    expect(first.state).toBe('partial')
    for (const lane of ['base', 'robinhood']) for (const kind of ['manager', 'debit', 'credit', 'pool']) expect(state(first, `${kind}:${lane}`)).toBe('complete')
    expect(state(first, 'debit:solana')).toBe('complete')
    expect(state(first, 'credit:solana')).toBe('prepared')
    expect(state(first, 'pool:solana')).toBe('planned')
    expect(first.steps.find((s) => s.id === 'credit:solana')!.claim).toEqual(claim)
    expect(first.error).toContain('credit:solana holds a claim')
    expect(first.sweep).toBe('eligible')

    // Still held: the sweep finds it, submits nothing new and keeps the first sighting.
    const swept = await reconcile(store, adapter)
    expect(swept.map((r) => r.state)).toEqual(['partial'])

    faults.queued.delete('credit:solana')
    const done = await runJob(store, adapter, job.id)
    expect(done.state).toBe('complete')
    expect(done.error).toBeUndefined()
    expect(done.steps.find((s) => s.id === 'credit:solana')!.claim?.queuedAt).toBe(now)
    expect(done.steps.find((s) => s.id === 'credit:solana')!.claim?.releasedAt).toBeNumber()
    // Every irreversible effect went out exactly once.
    for (const step of done.steps) expect(broadcasts.get(step.id)).toBe(1)
  })

  test('an unreachable Robinhood spoke defers its lane, stays sweep-eligible and completes on recovery', async () => {
    const now = Math.floor(Date.now() / 1000)
    const { store, adapter, faults, broadcasts } = harness()
    faults.down.add('manager:robinhood')
    const job = quote(store, adapter, fourChain(now), now)
    const first = await runJob(store, adapter, job.id, await sign(job))
    expect(first.state).toBe('partial')
    expect(first.sweep).toBe('eligible')
    expect(first.error).toContain('manager:robinhood could not reach its chain')
    for (const lane of ['base', 'solana']) expect(state(first, `pool:${lane}`)).toBe('complete')
    expect(state(first, 'debit:robinhood')).toBe('planned')
    expect(broadcasts.get('manager:robinhood')).toBeUndefined()

    faults.down.clear()
    const [recovered] = await reconcile(store, adapter)
    expect(recovered.state).toBe('complete')
    for (const step of store.get(job.id)!.steps) expect(broadcasts.get(step.id)).toBe(1)
  })

  test('an integrity failure in one spoke still stops the whole job', async () => {
    const now = Math.floor(Date.now() / 1000)
    const { store, adapter, faults } = harness()
    faults.conflict.add('debit:base')
    const job = quote(store, adapter, fourChain(now), now)
    const failure = await runJob(store, adapter, job.id, await sign(job)).then(() => undefined, (cause: unknown) => cause)
    expect(String(failure)).toContain('already executed with other bytes')
    const stored = store.get(job.id)!
    expect(stored.state).toBe('partial')
    // Nothing after the conflicting step ran: an integrity failure is not a lane deferral.
    expect(state(stored, 'manager:solana')).toBe('planned')
    expect(state(stored, 'manager:robinhood')).toBe('planned')
  })

  test('an unreachable Arc lane is not deferred around', async () => {
    const now = Math.floor(Date.now() / 1000)
    const { store, adapter, faults } = harness()
    faults.down.add('manager:arc')
    const job = quote(store, adapter, fourChain(now), now)
    const failure = await runJob(store, adapter, job.id, await sign(job)).then(() => undefined, (cause: unknown) => cause)
    expect(String(failure)).toContain('fetch failed')
    const stored = store.get(job.id)!
    for (const lane of ['base', 'solana', 'robinhood']) expect(state(stored, `manager:${lane}`)).toBe('planned')
  })
})
