import { describe, expect, test } from 'bun:test'
import { JobStore } from '../store'
import { localAdapter } from '../localAdapter'
import { createLaunchService } from '../service'
import { ClientError, describe as describeJob, launch, quote, status, template, usdc } from '../../../scripts/equilibrium-client'
import { account } from './fixtures'
import { reconcile } from '../runner'
import { shouldRefresh } from '../../../src/lib/equilibriumRecord'

// The same local test key the service fixtures use. It signs only for the synthetic chain 31337 domain.
const KEY = '0x0000000000000000000000000000000000000000000000000000000000000123'
const SERVER = 'http://127.0.0.1:4042'
const now = 1_800_000_000

/** The real service in-process, reached through the client's own HTTP calls. */
function harness(options: { pending?: Set<string> } = {}) {
  const store = new JobStore(':memory:')
  const service = createLaunchService(store, localAdapter(store, options), () => now * 1000)
  const signed: string[] = []
  const fetcher = (url: string, init?: RequestInit) => {
    const signature = new Headers(init?.headers).get('payment-signature')
    if (signature) signed.push(signature)
    return service(new Request(url, init))
  }
  return { store, fetcher, signed }
}
async function failure(promise: Promise<unknown>): Promise<ClientError> {
  try { await promise } catch (cause) { return cause as ClientError }
  throw new Error('Expected the client to refuse')
}

describe('EQUILIBRIUM client against the local service', () => {
  test('a free quote signs nothing and reads the bound terms', async () => {
    const { fetcher, signed, store } = harness()
    const request = template(account.address, { requestId: 'client-quote-1', now })
    const q = await quote(SERVER, request, fetcher)
    expect(q.mode).toBe('local')
    expect(q.total).toBe('27200000')
    expect(usdc(q.total)).toBe('27.2')
    expect(q.accepts[0].extra?.authorizationNonce).toBe(q.jobId)
    expect(signed).toHaveLength(0)
    expect(store.get(q.jobId)?.payment).toBeUndefined()
    const record = await status(SERVER, q.jobId, fetcher)
    const lines = describeJob(record).join('\n')
    expect(lines).toContain('fulfillment: not started')
    expect(lines).toContain('Issuance has not started')
    expect(lines).not.toContain('operations outstanding')
    expect(shouldRefresh([record])).toBe(false)
    store.close()
  })

  test('an authorized local launch settles once; resending the same request resumes without signing again', async () => {
    const { fetcher, signed, store } = harness()
    const request = template(account.address, { requestId: 'client-launch-1', now })
    const first = await launch(SERVER, request, KEY, '30000000', fetcher, now)
    expect(first.status).toBe(200)
    expect(first.job.state).toBe('complete')
    expect(first.settlement?.success).toBe(true)
    expect(signed).toHaveLength(1)
    const again = await launch(SERVER, request, KEY, '30000000', fetcher, now)
    expect(again.job.id).toBe(first.job.id)
    expect(signed).toHaveLength(1)
    const lines = describeJob(await status(SERVER, first.job.id, fetcher)).join('\n')
    expect(lines).toContain('settlement: 27.2 synthetic USDC (27200000 atoms)')
    expect(lines).toContain('fulfillment: complete')
    store.close()
  })

  test('a changed payload under the same requestId is a conflict, not a second launch', async () => {
    const { fetcher, store } = harness()
    const request = template(account.address, { requestId: 'client-conflict-1', now })
    await launch(SERVER, request, KEY, '30000000', fetcher, now)
    const error = await failure(launch(SERVER, { ...request, quote: { ...request.quote, costCap: '99000000' } }, KEY, '30000000', fetcher, now))
    expect(error.code).toBe('identity_conflict')
    expect(error.status).toBe(409)
    expect(error.message).toContain('new requestId')
    store.close()
  })

  test('a pending step returns 202: settled, fulfillment incomplete, and the record says so', async () => {
    const pending = new Set(['credit:base'])
    const { fetcher, store, signed } = harness({ pending })
    const request = template(account.address, { requestId: 'client-partial-1', now })
    const result = await launch(SERVER, request, KEY, '30000000', fetcher, now)
    expect(result.status).toBe(202)
    expect(result.settlement?.success).toBe(true)
    const lines = describeJob(result.job).join('\n')
    expect(lines).toContain('settlement: 27.2 synthetic USDC')
    expect(lines).toContain('fulfillment: incomplete')
    expect(lines).toContain('not final')
    expect(lines).toContain('Supply amounts withheld until finalized receipts are recorded')
    expect(lines).not.toContain('remote 0')
    expect(shouldRefresh([result.job])).toBe(true)
    pending.clear()
    await reconcile(store, localAdapter(store), () => now * 1000)
    const recovered = await status(SERVER, result.job.id, fetcher)
    expect(recovered.state).toBe('complete')
    expect(recovered.supply.remote).toBe('500000000000')
    expect(shouldRefresh([recovered])).toBe(false)
    expect(signed).toHaveLength(1)
    const effects = store.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM local_effects').get()!.count
    expect(effects).toBe(8)
    store.close()
  })

  test('refuses to sign outside the local rehearsal, above the caller cap, or with the wrong key', async () => {
    const { fetcher, signed, store } = harness()
    const request = template(account.address, { requestId: 'client-refuse-1', now })
    expect((await failure(launch('https://architex.fun', request, KEY, '30000000', fetcher, now))).code).toBe('not_local')
    expect((await failure(launch(SERVER, request, KEY, '27199999', fetcher, now))).code).toBe('max_total')
    expect((await failure(launch(SERVER, request, `0x${'4'.repeat(64)}`, '30000000', fetcher, now))).code).toBe('payer_mismatch')
    expect((await failure(launch(SERVER, request, KEY, '30000000', fetcher, request.quote.expires))).code).toBe('quote_expired')
    // A service that is not the local rehearsal is never signed for, whatever it quotes.
    const remote = () => Promise.resolve(Response.json({ jobId: '0x01', mode: 'testnet', total: '1', quoteInventory: '0', steps: [], accepts: [{ scheme: 'exact', network: 'eip155:5042002', asset: '0x3600000000000000000000000000000000000000', amount: '1', payTo: '0x0000000000000000000000000000000000004020', maxTimeoutSeconds: 300, extra: { authorizationNonce: '0x01' } }] }, { status: 402 }))
    expect((await failure(launch(SERVER, request, KEY, '30000000', remote, now))).code).toBe('not_local')
    expect(signed).toHaveLength(0)
    store.close()
  })

  test('an older record without settlement or fund finality is described as older, not as outstanding', () => {
    const lines = describeJob({ id: '0x867d', mode: 'local', state: 'complete', payment: { settled: true, fulfillment: 'complete' },
      funds: { paid: '27200000', platformFee: '1000000', feesSpent: '6200000', quoteInventoryDeployed: '20000000', unallocatedHeld: '0' },
      supply: { issuance: '1', custody: '0', remote: '0', pending: '0', reconciled: true, evidence: 'recorded_steps' }, steps: [] }).join('\n')
    expect(lines).toContain('settled, no separate settlement record (older job)')
    expect(lines).toContain('finality not reported')
    expect(lines).not.toContain('not final')
  })
})
