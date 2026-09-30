import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobStore } from '../store'
import { localAdapter, closedAdapter } from '../localAdapter'
import { quote, runJob, publicJob } from '../runner'
import { createLaunchService } from '../service'
import { hash } from '../request'
import { verifyPayment } from '../payment'
import { fixture, header, sign } from './fixtures'
import { GET, POST } from '../../../api/equilibrium'

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
function setup(path = ':memory:') {
  const store = new JobStore(path); const adapter = localAdapter(store); const request = fixture(now)
  const job = quote(store, adapter, request, now)
  return { store, adapter, request, job }
}

describe('bound payment and recoverable promotional-token job', () => {
  test('same identity returns the original plan; conflicting intent fails, even after expiry', () => {
    const { store, adapter, request, job } = setup()
    expect(quote(store, adapter, { ...request, destinations: [...request.destinations].reverse() }, now + 1000).id).toBe(job.id)
    for (const change of [ { canonical: { ...request.canonical, issuance: '1000000000001' } }, { quote: { ...request.quote, costCap: '99999999' } },
      { quote: { ...request.quote, expires: now + 100 } }, { destinations: [request.destinations[0]] } ]) {
      expect(() => quote(store, adapter, { ...request, ...change }, now)).toThrow('different bound payload')
    }
    expect(() => quote(store, adapter, { ...request, extra: true }, now)).toThrow('Unknown request field')
    store.close()
  })
  test('signature binds the payer, recipients, supply, domains, cost and expiry', async () => {
    const { store, adapter, job, request } = setup()
    const signed = await header(job)
    expect((await verifyPayment(signed, job, now)).authorization.nonce).toBe(job.id)
    const altered = quote(store, adapter, { ...request, requestId: 'different-intent', destinations: [{ ...request.destinations[0], recipient: '0x000000000000000000000000000000000000babe' }, request.destinations[1]] }, now)
    await rejects(verifyPayment(signed, altered, now), 'bound payer')
    await rejects(verifyPayment(signed, job, now + 300), 'expired')
    await rejects(verifyPayment('garbage', job, now), 'bound payer')
    store.close()
  })
  test('closed routes and budget/expiry validation happen before any charge', () => {
    const { store, adapter, request } = setup()
    expect(() => quote(store, closedAdapter('testnet'), { ...request, requestId: 'closed-route-1' }, now)).toThrow('No deployed')
    expect(() => quote(store, adapter, { ...request, requestId: 'cap-small-01', quote: { expires: now + 10, costCap: '1' } }, now)).toThrow('cost cap')
    expect(() => quote(store, adapter, { ...request, requestId: 'expired-001', quote: { ...request.quote, expires: now } }, now)).toThrow('expire')
    expect(store.db.query('SELECT * FROM local_effects').all()).toHaveLength(0)
    store.close()
  })
  for (const step of ['payment:arc', 'canonical:arc', 'manager:arc', 'pool:arc', 'manager:base', 'debit:base', 'credit:base', 'pool:base']) {
    test(`restart after ${step} effect but before receipt causes no duplicate`, async () => {
      const path = database(); const first = setup(path)
      await rejects(runJob(first.store, first.adapter, first.job.id, await sign(first.job), () => now * 1000, (id) => { if (id === step) throw new Error('Process lost result') }), 'Process lost result')
      const before = publicJob(first.store.get(first.job.id)!)
      expect(before.state).toBe('partial'); expect(before.supply.reconciled).toBe(false)
      first.store.close()
      const restarted = new JobStore(path)
      const result = await runJob(restarted, localAdapter(restarted), first.job.id, undefined, () => (now + 1000) * 1000)
      expect(result.state).toBe('complete')
      const finished = publicJob(result)
      expect(finished.supply).toMatchObject({ custody: '500000000000', remote: '500000000000', pending: '0', reconciled: true })
      expect(finished.funds.unallocatedHeld).toBe('0')
      const addresses = finished.steps.map((s) => s.result?.address)
      await runJob(restarted, localAdapter(restarted), first.job.id, undefined, () => (now + 1001) * 1000)
      expect(publicJob(restarted.get(first.job.id)!).steps.map((s) => s.result?.address)).toEqual(addresses)
      expect(restarted.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM local_effects').get()!.count).toBe(8)
      restarted.close()
    })
  }
  test('pending source cannot credit; pending destination retains one claim and no pool', async () => {
    const { store, job } = setup(); const pending = new Set(['debit:base']); const adapter = localAdapter(store, { pending })
    let result = await runJob(store, adapter, job.id, await sign(job), () => now * 1000)
    expect(result.steps.find((s) => s.id === 'credit:base')!.state).toBe('planned')
    expect(publicJob(result).supply.evidence).toBe('incomplete')
    pending.delete('debit:base'); pending.add('credit:base')
    result = await runJob(store, adapter, job.id, undefined, () => now * 1000)
    expect(publicJob(result).supply.pending).toBe('500000000000')
    expect(result.steps.find((s) => s.id === 'pool:base')!.state).toBe('planned')
    pending.clear(); result = await runJob(store, adapter, job.id, undefined, () => now * 1000)
    expect(result.state).toBe('complete'); expect(publicJob(result).supply.pending).toBe('0')
    store.close()
  })
  test('unavailable destination preserves payment and successful canonical/pool addresses', async () => {
    const { store, job } = setup(); const unavailable = new Set(['manager:base']); const adapter = localAdapter(store, { unavailable })
    await rejects(runJob(store, adapter, job.id, await sign(job), () => now * 1000), 'unavailable')
    const partial = publicJob(store.get(job.id)!)
    expect(partial.payment.settled).toBe(true); expect(partial.payment.fulfillment).toBe('incomplete')
    expect(BigInt(partial.funds.unallocatedHeld)).toBeGreaterThan(0n)
    unavailable.clear(); const result = await runJob(store, adapter, job.id, undefined, () => now * 1000)
    expect(result.steps[1].result?.address).toBe(partial.steps[1].result?.address)
    store.close()
  })
  test('lease excludes parallel workers and fences an expired worker', () => {
    const { store, job } = setup()
    const first = store.claim(job.id, 'first', 0)
    expect(() => store.claim(job.id, 'second', 1)).toThrow('worker owns')
    const second = store.claim(job.id, 'second', 30_001)
    expect(() => store.save(first, 'first', 30_002)).toThrow('lost its lease')
    store.save(second, 'second', 30_002); store.close()
  })
  test('unsettled expired authorization never charges, while finalized paid jobs resume after expiry', async () => {
    const { store, adapter, job } = setup()
    await rejects(runJob(store, adapter, job.id, await sign(job), () => (now + 1000) * 1000), 'expired')
    expect(store.db.query('SELECT * FROM local_effects').all()).toHaveLength(0)
    store.close()
  })
  test('actual abrupt process exit leaves one external effect; a fresh process recovers the lease', async () => {
    const path = database()
    const invoke = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, 'run', 'server/equilibrium/rehearse.ts', '--db', path, ...args], { stdout: 'pipe', stderr: 'pipe' })
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      return { exit, stdout, stderr }
    }
    expect((await invoke(['--clock', String(now * 1000), '--crash-step', 'canonical:arc'])).exit).toBe(77)
    const next = await invoke(['--clock', String((now + 31) * 1000)])
    expect(next.stderr).toBe(''); expect(next.exit).toBe(0)
    expect(JSON.parse(next.stdout)).toMatchObject({ effects: 8, job: { state: 'complete', mode: 'local' } })
  })
  test('HTTP x402 quote, signature, partial 202 and free records distinguish settlement from fulfillment', async () => {
    const { store, job, request } = setup(); const pending = new Set(['credit:base'])
    const service = createLaunchService(store, localAdapter(store, { pending }), () => now * 1000)
    const post = (signature?: string) => service(new Request('http://localhost/x402/equilibrium', { method: 'POST', headers: signature ? { 'payment-signature': signature } : {}, body: JSON.stringify(request) }))
    expect((await post()).status).toBe(402)
    expect((await post('bad')).status).toBe(402)
    const response = await post(await header(job))
    expect(response.status).toBe(202); expect(response.headers.get('payment-response')).toBeTruthy()
    const json = await response.json() as ReturnType<typeof publicJob>
    expect(json.payment).toMatchObject({ settled: true, fulfillment: 'incomplete' })
    const free = await service(new Request(`http://localhost/equilibrium/jobs?job=${job.id}`))
    const text = await free.text(); expect(text).not.toContain('signature'); expect(text).not.toContain('bytes')
    const byPath = await service(new Request(`http://localhost/equilibrium/jobs/${job.id}`))
    expect(byPath.status).toBe(200)
    expect(await byPath.json()).toMatchObject({ jobs: [{ id: job.id, state: 'partial' }] })
    pending.clear(); expect((await post()).status).toBe(200)
    expect((await service(new Request('http://localhost/equilibrium/jobs?job=missing'))).status).toBe(404)
    store.close()
  })
  test('an adapter cannot confirm a different operation', async () => {
    const { store, adapter, job } = setup()
    adapter.observe = () => Promise.resolve({ operation: hash('other'), transaction: 'local:bad', finalized: true, cost: '0' })
    await rejects(runJob(store, adapter, job.id, await sign(job), () => now * 1000), 'receipt violates')
    expect(publicJob(store.get(job.id)!).payment.settled).toBe(false)
    store.close()
  })
  for (const [kind, field] of [['canonical', 'amount'], ['credit', 'amount'], ['pool', 'amount'], ['pool', 'quoteAmount']] as const) {
    test(`a finalized ${kind} receipt must prove the bound ${field}`, async () => {
      const { store, adapter, job } = setup()
      const observe = adapter.observe.bind(adapter)
      adapter.observe = async (context, prepared) => {
        const result = await observe(context, prepared)
        return typeof result === 'object' && context.step.kind === kind ? { ...result, [field]: '1' } : result
      }
      await rejects(runJob(store, adapter, job.id, await sign(job), () => now * 1000), 'receipt')
      expect(store.get(job.id)!.steps.find((step) => step.kind === kind)!.state).toBe('prepared')
      expect(publicJob(store.get(job.id)!).supply.reconciled).toBe(false)
      store.close()
    })
  }
  test('adapter configuration changes cannot settle or resume a pinned job', async () => {
    const { store, adapter, job } = setup()
    await rejects(runJob(store, { ...adapter, version: 'changed' }, job.id, await sign(job), () => now * 1000), 'configuration changed')
    expect(store.db.query('SELECT * FROM local_effects').all()).toHaveLength(0)
    store.close()
  })
  test('deployed API keeps payment closed and evidence free without synthetic fulfillment', async () => {
    expect(POST().status).toBe(503)
    const response = GET()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ paidLaunchOpen: false, publicRouteTests: 0, jobs: [], supply: null })
    expect(response.headers.has('payment-required')).toBe(false)
  })
})
