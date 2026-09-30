import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobStore, assertDurableStore } from '../store'
import { localAdapter } from '../localAdapter'
import { publicJob, quote, reconcile, runJob } from '../runner'
import { createLaunchService } from '../service'
import { fixture, header, sign } from './fixtures'
import type { EffectContext, Job, PromotionalTokenAdapter, Settlement } from '../types'

async function rejects(promise: Promise<unknown>, message: string) {
  let failure: unknown
  try { await promise } catch (cause) { failure = cause }
  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toContain(message)
}
const now = 1_800_000_000
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function database() { const dir = mkdtempSync(join(tmpdir(), 'equilibrium-')); dirs.push(dir); return join(dir, 'jobs.sqlite') }
/** The synthetic two-chain fixture: 7.2 in step budgets plus 20 of quote inventory. */
const TOTAL = '27200000'
function setup(path = ':memory:', options: { leaseMs?: number } = {}) {
  const store = new JobStore(path, options); const adapter = localAdapter(store); const request = fixture(now)
  const job = quote(store, adapter, request, now)
  return { store, adapter, request, job }
}
/** Delay one step's prepare so the adapter call outlives a short lease. */
function delayed(adapter: PromotionalTokenAdapter, stepId: string, ms: number, before?: () => void): PromotionalTokenAdapter {
  const prepare = adapter.prepare.bind(adapter)
  return { ...adapter, async prepare(context: EffectContext) {
    if (context.step.id !== stepId) return prepare(context)
    before?.(); await Bun.sleep(ms); return prepare(context)
  } }
}
const effects = (store: JobStore) => store.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM local_effects').get()!.count

describe('durable host required for held authorizations', () => {
  test('a serverless marker, an in-memory store and a temporary path are all refused', () => {
    for (const marker of ['AWS_LAMBDA_FUNCTION_NAME', 'LAMBDA_TASK_ROOT', 'VERCEL', 'FUNCTIONS_WORKER_RUNTIME', 'K_SERVICE']) {
      expect(() => assertDurableStore('./output/equilibrium/jobs.sqlite', { [marker]: '1' })).toThrow('serverless host')
    }
    expect(() => assertDurableStore(':memory:', {})).toThrow('in-memory store loses prepared effects')
    for (const path of ['/tmp/jobs.sqlite', '/var/tmp/x/jobs.sqlite', '/var/task/jobs.sqlite', '/dev/shm/jobs.sqlite', join(tmpdir(), 'jobs.sqlite')]) {
      expect(() => assertDurableStore(path, {})).toThrow('temporary path')
    }
  })
  test('a durable relative path resolves and is accepted', () => {
    expect(assertDurableStore('./output/equilibrium/jobs.sqlite', {})).toBe(join(process.cwd(), 'output/equilibrium/jobs.sqlite'))
  })
})

describe('lease survives a slow external call', () => {
  test('a chain call slower than the lease keeps ownership and records its effect', async () => {
    const { store, adapter, job } = setup(database(), { leaseMs: 80 })
    // Real time, so the lease genuinely expires unless the heartbeat renews it.
    const result = await runJob(store, delayed(adapter, 'canonical:arc', 260), job.id, await sign(job), Date.now, undefined, { leaseMs: 80, heartbeatMs: 20 })
    expect(result.state).toBe('complete')
    expect(effects(store)).toBe(8)
    store.close()
  })
  test('without renewal the same slow call cannot record its result', async () => {
    const { store, adapter, job } = setup(database(), { leaseMs: 80 })
    await rejects(runJob(store, delayed(adapter, 'canonical:arc', 260), job.id, await sign(job), Date.now, undefined, { leaseMs: 80, heartbeatMs: 10_000 }), 'lost its lease')
    store.close()
  })
  test('a worker whose lease was taken submits nothing further', async () => {
    const { store, adapter, job } = setup(database(), { leaseMs: 60 })
    const steal = () => { setTimeout(() => store.claim(job.id, 'other-worker', Date.now() + 60_000), 40) }
    await rejects(runJob(store, delayed(adapter, 'canonical:arc', 300, steal), job.id, await sign(job), Date.now, undefined, { leaseMs: 60, heartbeatMs: 15 }), 'lost its lease')
    // Only the settled payment reached the journal; no issuance was prepared or sent.
    expect(effects(store)).toBe(1)
    expect(store.get(job.id)!.steps.find((s) => s.id === 'canonical:arc')!.state).toBe('planned')
    store.close()
  })
  test('an adapter failure is reported even when the lease was lost at the same moment', async () => {
    const { store, adapter, job } = setup()
    const failing: PromotionalTokenAdapter = { ...adapter, prepare(context: EffectContext) {
      if (context.step.id !== 'canonical:arc') return adapter.prepare(context)
      store.claim(job.id, 'other-worker', now * 1000 + 60_000)
      return Promise.reject(new Error('Provider rejected the deployment'))
    } }
    // The original cause must survive: a masked stale_worker hides why the launch stopped.
    await rejects(runJob(store, failing, job.id, await sign(job), () => now * 1000), 'Provider rejected the deployment')
    store.close()
  })
})

describe('an x402 authorization settles at most once', () => {
  test('a second job cannot reserve the same asset, chain and nonce', async () => {
    const { store, adapter, job, request } = setup()
    job.payment = await sign(job)
    store.reserveAuthorization(job)
    store.reserveAuthorization(job)
    const other = quote(store, adapter, { ...request, requestId: 'second-intent-01' }, now)
    other.payment = { ...await sign(other), authorization: { ...(await sign(other)).authorization, nonce: job.id } }
    expect(() => store.reserveAuthorization(other)).toThrow('already reserved by a different job')
    job.payment = { ...job.payment, authorization: { ...job.payment.authorization, nonce: other.id } }
    expect(() => store.reserveAuthorization(job)).toThrow('already reserved a different authorization nonce')
    store.close()
  })
  test('settlement without a reservation, for another job, or conflicting is refused', async () => {
    const { store, adapter, job, request } = setup()
    job.payment = await sign(job)
    const settlement: Settlement = { chainId: job.terms.chainId, asset: job.terms.asset, payer: job.request.payer, payTo: job.terms.payTo, nonce: job.id, amount: job.total, transaction: 'local:settled', finalizedAt: now }
    expect(() => store.recordSettlement(settlement, job.id)).toThrow('without a reservation')
    store.reserveAuthorization(job)
    const other = quote(store, adapter, { ...request, requestId: 'third-intent-001' }, now)
    expect(() => store.recordSettlement(settlement, other.id)).toThrow('belongs to a different job')
    expect(store.recordSettlement(settlement, job.id).transaction).toBe('local:settled')
    expect(store.recordSettlement(settlement, job.id).transaction).toBe('local:settled')
    expect(() => store.recordSettlement({ ...settlement, transaction: 'local:other' }, job.id)).toThrow('different settlement is already recorded')
    expect(() => store.recordSettlement({ ...settlement, amount: '1' }, job.id)).toThrow('different settlement is already recorded')
    expect(store.settlementOf(job.id)!.amount).toBe(TOTAL)
    store.close()
  })
  test('a settled job records the charge separately from its fulfillment', async () => {
    const { store, job } = setup()
    const pending = new Set(['pool:base'])
    const result = await runJob(store, localAdapter(store, { pending }), job.id, await sign(job), () => now * 1000)
    const view = publicJob(result)
    expect(view.state).toBe('partial')
    // The charge is proven and readable even though the launch is not fulfilled.
    expect(view.settlement).toMatchObject({ chainId: job.terms.chainId, asset: job.terms.asset, payer: job.request.payer, payTo: job.terms.payTo, nonce: job.id, amount: TOTAL, fulfillment: 'incomplete' })
    expect(store.settlementOf(job.id)!.transaction).toBe(view.settlement!.transaction)
    pending.clear()
    const done = publicJob(await runJob(store, localAdapter(store), job.id, undefined, () => now * 1000))
    expect(done.settlement).toMatchObject({ amount: TOTAL, fulfillment: 'complete' })
    // Fulfilling the launch must not produce a second settlement for the same authorization.
    expect(store.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM settled_authorizations').get()!.count).toBe(1)
    expect(JSON.stringify(done)).not.toContain('signature')
    store.close()
  })
  test('a settlement receipt that does not move the authorized total issues nothing', async () => {
    const { store, adapter, job } = setup()
    const observe = adapter.observe.bind(adapter)
    for (const amount of ['1', undefined]) {
      adapter.observe = async (context, prepared) => {
        const result = await observe(context, prepared)
        return typeof result === 'object' && context.step.kind === 'payment' ? { ...result, amount } : result
      }
      await rejects(runJob(store, adapter, job.id, await sign(job), () => now * 1000), 'does not prove the authorized amount')
    }
    const stored = store.get(job.id)!
    expect(stored.steps[0].state).toBe('prepared')
    expect(stored.steps.find((s) => s.kind === 'canonical')!.state).toBe('planned')
    expect(stored.settlement).toBeUndefined()
    const view = publicJob(stored)
    expect(view.payment.settled).toBe(false); expect(view.settlement).toBeNull()
    expect(view.supply.issuance).toBe('0')
    store.close()
  })
})

describe('recovery does not depend on a client request', () => {
  test('a crashed launch is finished by the reconciler with no request and no signature', async () => {
    const path = database(); const { store, adapter, job } = setup(path)
    await rejects(runJob(store, adapter, job.id, await sign(job), () => now * 1000, (step) => { if (step === 'manager:base') throw new Error('Process lost result') }), 'Process lost result')
    expect(store.get(job.id)!.state).toBe('partial')
    const resumed = await reconcile(store, adapter, () => (now + 1000) * 1000)
    expect(resumed).toEqual([{ id: job.id, state: 'complete', error: undefined }])
    expect(effects(store)).toBe(8)
    // A finished job is never picked up again.
    expect(await reconcile(store, adapter, () => (now + 2000) * 1000)).toEqual([])
    store.close()
  })
  test('an unpaid quote and a job a live worker owns are both left alone', () => {
    const { store, job } = setup()
    expect(store.resumable(now * 1000)).toEqual([])
    store.claim(job.id, 'live-worker', now * 1000)
    expect(store.resumable(now * 1000)).toEqual([])
    store.close()
  })
  test('the reconciler reports a route that is still closed instead of throwing', async () => {
    const { store, adapter, job } = setup()
    await rejects(runJob(store, adapter, job.id, await sign(job), () => now * 1000, (step) => { if (step === 'manager:base') throw new Error('Process lost result') }), 'Process lost result')
    // manager:base was already journalled before the crash; the next step is the closed one.
    const blocked = await reconcile(store, localAdapter(store, { unavailable: new Set(['debit:base']) }), () => (now + 1000) * 1000)
    expect(blocked).toHaveLength(1)
    expect(blocked[0]).toMatchObject({ id: job.id, state: 'partial' })
    expect(blocked[0].error).toContain('unavailable')
    store.close()
  })
  test('an abrupt process exit is recovered by a later unattended reconcile run', async () => {
    const path = database()
    const invoke = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, 'run', 'server/equilibrium/rehearse.ts', '--db', path, ...args], { stdout: 'pipe', stderr: 'pipe' })
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      return { exit, stdout, stderr }
    }
    expect((await invoke(['--clock', String(now * 1000), '--crash-step', 'credit:base'])).exit).toBe(77)
    const recovered = await invoke(['--clock', String((now + 31) * 1000), '--reconcile'])
    expect(recovered.stderr).toBe(''); expect(recovered.exit).toBe(0)
    const report = JSON.parse(recovered.stdout) as { resumed: { state: string }[]; effects: number; job: ReturnType<typeof publicJob> }
    expect(report.resumed).toHaveLength(1)
    expect(report.resumed[0].state).toBe('complete')
    expect(report.effects).toBe(8)
    expect(report.job.settlement).toMatchObject({ amount: TOTAL, fulfillment: 'complete' })
  })
  test('a store written by the previous schema keeps its jobs and stays resumable', async () => {
    const source = setup()
    const paid: Job = { ...source.job, payment: await sign(source.job), state: 'running' }
    source.store.close()
    const path = database()
    const legacy = new Database(path, { create: true, strict: true })
    legacy.exec('CREATE TABLE jobs (identity TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, data TEXT NOT NULL, revision INTEGER NOT NULL, lease TEXT, until_ms INTEGER NOT NULL DEFAULT 0);')
    legacy.query('INSERT INTO jobs(identity,id,data,revision) VALUES(?,?,?,?)').run(paid.identity, paid.id, JSON.stringify(paid), 0)
    legacy.close()
    const migrated = new JobStore(path)
    expect(migrated.get(paid.id)!.id).toBe(paid.id)
    expect(migrated.resumable(now * 1000).map((j) => j.id)).toEqual([paid.id])
    const finished = await runJob(migrated, localAdapter(migrated), paid.id, undefined, () => now * 1000)
    expect(finished.state).toBe('complete')
    expect(migrated.resumable(now * 1000)).toEqual([])
    migrated.close()
  })
})

describe('unspent funds are only determinate once every effect resolved', () => {
  test('an outstanding operation blocks any refund decision', async () => {
    const { store, job } = setup()
    const result = await runJob(store, localAdapter(store, { pending: new Set(['pool:base']) }), job.id, await sign(job), () => now * 1000)
    const funds = publicJob(result).funds
    expect(funds).toMatchObject({ determinate: false, refundable: false, refundableAmount: '0', unresolvedEffects: ['pool:base'] })
    expect(BigInt(funds.unallocatedHeld)).toBeGreaterThan(0n)
    expect(funds.note).toContain('Reconcile all submitted effects')
    store.close()
  })
  test('a step that never reached an effect leaves an exact refundable remainder', async () => {
    const { store, adapter, job } = setup()
    const closed: PromotionalTokenAdapter = { ...adapter, prepare(context: EffectContext) {
      if (context.step.id === 'pool:base') return Promise.reject(new Error('Venue adapter unavailable'))
      return adapter.prepare(context)
    } }
    await rejects(runJob(store, closed, job.id, await sign(job), () => now * 1000), 'Venue adapter unavailable')
    const funds = publicJob(store.get(job.id)!).funds
    // The unspent remainder is the unopened pool's budget plus its undeployed quote inventory.
    expect(funds).toMatchObject({ determinate: true, refundable: true, refundableAmount: '11000000', unallocatedHeld: '11000000', unresolvedEffects: [] })
    expect(funds.note).toContain('final')
    store.close()
  })
  test('a fulfilled launch has nothing unspent and nothing refundable', async () => {
    const { store, adapter, job } = setup()
    const result = await runJob(store, adapter, job.id, await sign(job), () => now * 1000)
    expect(publicJob(result).funds).toMatchObject({ paid: TOTAL, determinate: true, refundable: false, refundableAmount: '0', unallocatedHeld: '0' })
    store.close()
  })
})

describe('the paid HTTP surface is idempotent and conflict-safe', () => {
  test('a repeated paid request charges once and reports the same settlement', async () => {
    const { store, adapter, request, job } = setup()
    const service = createLaunchService(store, adapter, () => now * 1000)
    const post = (body: unknown, signature?: string) => service(new Request('http://localhost/x402/equilibrium',
      { method: 'POST', headers: signature ? { 'payment-signature': signature } : {}, body: JSON.stringify(body) }))
    expect((await post(request)).status).toBe(402)
    const signature = await header(job)
    const first = await post(request, signature)
    expect(first.status).toBe(200)
    const settlement = (await first.json() as ReturnType<typeof publicJob>).settlement
    expect(settlement).toMatchObject({ amount: TOTAL, nonce: job.id, fulfillment: 'complete' })
    // Replaying the identical paid request must not settle, deploy or credit a second time.
    for (const retry of [await post(request, signature), await post(request)]) {
      expect(retry.status).toBe(200)
      expect((await retry.json() as ReturnType<typeof publicJob>).settlement).toEqual(settlement)
    }
    expect(effects(store)).toBe(8)
    expect(store.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM settled_authorizations').get()!.count).toBe(1)
    // A different payload under the same requestId is refused rather than re-quoted.
    const conflict = await post({ ...request, canonical: { ...request.canonical, issuance: '2000000000000' } }, signature)
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: 'identity_conflict' })
    // Free records carry the settlement but never the authorization signature or prepared bytes.
    const free = await (await service(new Request(`http://localhost/equilibrium/jobs/${job.id}`))).text()
    expect(free).toContain('"settlement"')
    expect(free).not.toContain('signature'); expect(free).not.toContain('bytes')
    store.close()
  })
})
