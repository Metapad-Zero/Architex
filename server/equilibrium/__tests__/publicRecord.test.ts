import { afterEach, describe, expect, test } from 'bun:test'
import { rejects } from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localAdapter } from '../localAdapter'
import { publicJob, quote, reconcile, runJob } from '../runner'
import { createLaunchService } from '../service'
import { JobStore } from '../store'
import { fixture, sign } from './fixtures'

const now = 1_800_000_000
const stores: JobStore[] = []
const dirs: string[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function open(path = ':memory:') {
  const store = new JobStore(path)
  stores.push(store)
  return store
}
function setup() {
  const store = open(); const adapter = localAdapter(store)
  const job = quote(store, adapter, fixture(now), now)
  return { store, adapter, job }
}
function effects(store: JobStore) {
  return store.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM local_effects').get()!.count
}
function supply(store: JobStore, job: string) {
  return store.db.query<{ issuance: string; custody: string; remote: string; pending: string }, [string]>('SELECT issuance,custody,remote,pending FROM local_supply WHERE job=?').get(job)
}
async function read(store: JobStore, id: string, clock = now) {
  const service = createLaunchService(store, localAdapter(store), () => clock * 1000)
  const response = await service(new Request(`http://localhost/equilibrium/jobs/${id}`))
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const text = await response.text()
  expect(text).not.toContain('signature')
  expect(text).not.toContain('bytes')
  return (JSON.parse(text) as { jobs: ReturnType<typeof publicJob>[] }).jobs[0]
}

describe('public recovery and evidence reflect durable work', () => {
  test('unpaid planned and expired quotes have exact zero funds and never refresh automatically', async () => {
    const { store, adapter, job } = setup()
    for (const clock of [now, now + 1000]) {
      const record = await read(store, job.id, clock)
      expect(record.state).toBe('awaiting_payment')
      expect(record.payment).toMatchObject({ settled: false, fulfillment: 'not_started' })
      expect(record.recovery).toEqual({ automatic: false, reason: 'awaiting_payment' })
      expect(record.funds).toMatchObject({ paid: '0', platformFee: '0', feesSpent: '0', quoteInventoryDeployed: '0', unallocatedHeld: '0', determinate: true, refundable: false, refundableAmount: '0', unresolvedEffects: [] })
      expect(record.funds.note).toBe('No payment is settled and no submitted effects are outstanding.')
      expect(record.supply).toMatchObject({ evidence: 'not_started', issuance: '0', custody: '0', remote: '0', pending: '0', canonicalOutsideCustody: '0', reconciled: false })
      expect(store.resumable(clock * 1000)).toEqual([])
      expect(await reconcile(store, adapter, () => clock * 1000)).toEqual([])
    }
    expect(effects(store)).toBe(0)
  })

  test('expiration before payment broadcast blocks held authorization and unattended recovery', async () => {
    const { store, adapter, job } = setup()
    await rejects(runJob(store, adapter, job.id, await sign(job), () => (now + 1000) * 1000), /Unsettled authorization expired/)
    const record = await read(store, job.id, now + 1000)
    expect(store.get(job.id)!.sweep).toBe('blocked')
    expect(record.payment).toMatchObject({ settled: false, fulfillment: 'not_started' })
    expect(record.recovery).toEqual({ automatic: false, reason: 'blocked' })
    expect(record.supply.evidence).toBe('not_started')
    expect(store.resumable((now + 1000) * 1000)).toEqual([])
    expect(await reconcile(store, adapter, () => (now + 1000) * 1000)).toEqual([])
    expect(effects(store)).toBe(0)
  })

  test('paid blocked work does not refresh until an explicit request restores progress', async () => {
    const { store, adapter, job } = setup()
    await rejects(runJob(store, localAdapter(store, { unavailable: new Set(['manager:base']) }), job.id, await sign(job), () => now * 1000), /adapter unavailable/)
    const blocked = await read(store, job.id)
    expect(blocked.payment).toMatchObject({ settled: true, fulfillment: 'incomplete' })
    expect(blocked.recovery).toEqual({ automatic: false, reason: 'blocked' })
    expect(blocked.supply).toMatchObject({ evidence: 'recorded_steps', issuance: '1000000000000', custody: '0', remote: '0', pending: '0' })
    expect(await reconcile(store, adapter, () => (now + 1000) * 1000)).toEqual([])
    const completed = publicJob(await runJob(store, adapter, job.id, undefined, () => (now + 1000) * 1000))
    expect(completed.payment.fulfillment).toBe('complete')
    expect(completed.recovery).toEqual({ automatic: false, reason: 'complete' })
    expect(effects(store)).toBe(8)
  })

  test('a broadcast payment remains recoverable after quote expiry, while issuance has not started', async () => {
    const { store, adapter, job } = setup()
    await rejects(runJob(store, adapter, job.id, await sign(job), () => now * 1000, (step) => {
      if (step === 'payment:arc') throw new Error('Receipt lost after broadcast')
    }), /Receipt lost after broadcast/)
    const pending = await read(store, job.id, now + 1000)
    expect(pending.payment).toMatchObject({ settled: false, fulfillment: 'not_started' })
    expect(pending.recovery).toEqual({ automatic: true, reason: 'pending_evidence' })
    expect(pending.supply.evidence).toBe('not_started')
    expect(pending.funds.determinate).toBe(false)
    expect(store.resumable((now + 1000) * 1000).map((j) => j.id)).toEqual([job.id])
    expect((await reconcile(store, adapter, () => (now + 1000) * 1000))[0].state).toBe('complete')
    expect(effects(store)).toBe(8)
  })

  test('held authorization with planned steps is eligible for automatic progress', async () => {
    const { store, adapter, job } = setup()
    const held = store.claim(job.id, 'interrupted-worker', now * 1000)
    held.payment = await sign(job); held.state = 'running'
    store.save(held, 'interrupted-worker', now * 1000); store.release(job.id, 'interrupted-worker')
    expect((await read(store, job.id)).recovery).toEqual({ automatic: true, reason: 'authorized_work' })
    expect(store.resumable(now * 1000).map((j) => j.id)).toEqual([job.id])
    expect((await reconcile(store, adapter, () => now * 1000))[0].state).toBe('complete')
    expect(effects(store)).toBe(8)
  })
})

describe('supply amounts are withheld through broadcast-before-receipt windows', () => {
  for (const [step, external] of [
    ['canonical:arc', { issuance: '1000000000000', custody: '0', remote: '0', pending: '0' }],
    ['debit:base', { issuance: '1000000000000', custody: '500000000000', remote: '0', pending: '500000000000' }],
    ['credit:base', { issuance: '1000000000000', custody: '500000000000', remote: '500000000000', pending: '0' }],
  ] as const) {
    test(`${step} changes the modeled supply before recording a receipt, then recovery restores exact conservation`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'equilibrium-public-')); dirs.push(dir)
      const path = join(dir, 'jobs.sqlite')
      const first = open(path); const adapter = localAdapter(first)
      const job = quote(first, adapter, fixture(now), now)
      await rejects(runJob(first, adapter, job.id, await sign(job), () => now * 1000, (id) => {
        if (id === step) throw new Error('Receipt lost after broadcast')
      }), /Receipt lost after broadcast/)
      const prepared = first.get(job.id)!.steps.find((s) => s.id === step)!
      expect(prepared.state).toBe('prepared')
      expect(prepared.result).toBeUndefined()
      expect(supply(first, job.id)).toEqual(external)
      const operation = prepared.prepared!.operation
      expect(first.db.query('SELECT operation FROM local_effects WHERE operation=?').get(operation)).toBeTruthy()
      const pending = await read(first, job.id)
      expect(pending.payment).toMatchObject({ settled: true, fulfillment: 'incomplete' })
      expect(pending.recovery).toEqual({ automatic: true, reason: 'pending_evidence' })
      expect(pending.supply).toEqual({ evidence: 'withheld', issuance: null, custody: null, remote: null, pending: null, canonicalOutsideCustody: null, reconciled: false })
      expect(pending.funds).toMatchObject({ determinate: false, refundable: false, unresolvedEffects: [step] })
      const transaction = pending.settlement!.transaction
      first.close(); stores.splice(stores.indexOf(first), 1)

      const restarted = open(path)
      expect((await read(restarted, job.id, now + 1000)).supply.evidence).toBe('withheld')
      expect((await reconcile(restarted, localAdapter(restarted), () => (now + 1000) * 1000))[0].state).toBe('complete')
      const recorded = await read(restarted, job.id, now + 1000)
      expect(recorded.supply).toEqual({ evidence: 'recorded_steps', issuance: '1000000000000', custody: '500000000000', remote: '500000000000', pending: '0', canonicalOutsideCustody: '500000000000', reconciled: true })
      expect(BigInt(recorded.supply.custody!)).toBe(BigInt(recorded.supply.remote!) + BigInt(recorded.supply.pending!))
      expect(BigInt(recorded.supply.issuance!)).toBe(BigInt(recorded.supply.canonicalOutsideCustody!) + BigInt(recorded.supply.remote!) + BigInt(recorded.supply.pending!))
      expect(recorded.settlement!.transaction).toBe(transaction)
      expect(recorded.recovery).toEqual({ automatic: false, reason: 'complete' })
      expect(recorded.funds).toMatchObject({ determinate: true, unallocatedHeld: '0', unresolvedEffects: [] })
      expect(restarted.get(job.id)!.steps.find((s) => s.id === step)!.prepared!.operation).toBe(operation)
      expect(effects(restarted)).toBe(8)
      expect(restarted.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM settled_authorizations').get()!.count).toBe(1)
      expect(await reconcile(restarted, localAdapter(restarted), () => (now + 1001) * 1000)).toEqual([])
      expect(effects(restarted)).toBe(8)
    })
  }
})
