import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import type { Address } from 'viem'
import { createJob } from '../../request'
import { JobStore } from '../../store'
import { createLaunchService } from '../../service'
import { LaunchError, type LaunchRequest } from '../../types'
import { FULFILLMENT_LABELS, robinhoodFulfillment, type RobinhoodFulfillmentConfig } from '../fulfillment'
import type { RobinhoodRouteConfig } from '../route'

const a = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`
const loopback: RobinhoodRouteConfig = {
  mode: 'fork', environment: 'mixed:arc-testnet-fork+robinhood-mainnet-fork', operatorKey: `0x${'11'.repeat(32)}`,
  arc: { side: 'arc', rpc: 'http://127.0.0.1:1', chainId: 5042002, wormholeChainId: 71, core: a(1), executor: a(2), transceiverStructs: a(3), confirmations: 0, fromBlock: 1n },
  robinhood: { side: 'robinhood', rpc: 'http://127.0.0.1:2', chainId: 4663, wormholeChainId: 72, core: a(4), executor: a(5), transceiverStructs: a(6), confirmations: 0, fromBlock: 1n,
    venue: { factory: a(7), quoterV2: a(8), fee: 3000, tickSpacing: 60 }, quote: a(9) },
  vaa: { arc: { kind: 'local-guardian', signed: () => Promise.resolve(null) }, robinhood: { kind: 'local-guardian', signed: () => Promise.resolve(null) } },
  limits: { outbound: 50_000_000_000n, inbound: 50_000_000_000n },
  asset: { id: 'unit-asset', name: 'Equilibrium', symbol: 'EQL', issuance: 1_000_000_000_000n },
}
const config = (overrides: Partial<RobinhoodFulfillmentConfig> = {}): RobinhoodFulfillmentConfig => ({
  route: loopback, arc: { usdc: a(10), factory: a(11) }, pricing: { arc: 1_000_000n, robinhood: 5_000_000_000n },
  budgets: { payment: '1000000', canonical: '5000000', manager: '10000000', debit: '2000000', credit: '2000000', pool: '5000000' }, labels: FULFILLMENT_LABELS, ...overrides,
})
const payer = a(0xabc)
function request(requestId: string, now: number, patch: Partial<LaunchRequest['canonical']> = {}, chains: ('arc' | 'robinhood' | 'base')[] = ['arc', 'robinhood']): LaunchRequest {
  return { requestId, payer, canonical: { chain: 'arc', name: 'Equilibrium', symbol: 'EQL', decimals: 6, issuance: '1000000000000', recipient: a(0xa1), ...patch },
    destinations: chains.map((chain) => ({ chain, recipient: a(0xa1), amount: '10000000000', poolTokens: '5000000000', poolQuote: '10000000' })),
    quote: { expires: now + 240, costCap: '100000000' } }
}
const code = (fn: () => unknown) => { try { fn(); return null } catch (cause) { return cause instanceof LaunchError ? cause.code : String(cause) } }
/** Journal the existing asset's hub operations without a chain: what `deployHub` leaves behind. */
async function journalAsset(adapter: ReturnType<typeof robinhoodFulfillment>) {
  await adapter.route.persist('canonical:arc', 'arc', () => [])
  await adapter.route.persist('manager:arc', 'arc', () => [])
}

describe('EQUILIBRIUM Robinhood fulfillment adapter (no forks)', () => {
  test('fixture labels are fixed and the route engine still refuses public RPCs', () => {
    expect(() => robinhoodFulfillment(config({ labels: { ...FULFILLMENT_LABELS, payment: 'live USDC' } }), new Database(':memory:'))).toThrow('cannot be relabelled')
    expect(() => robinhoodFulfillment(config({ route: { ...loopback, robinhood: { ...loopback.robinhood, rpc: 'https://rpc.mainnet.chain.robinhood.com' } } }), new Database(':memory:'))).toThrow('not a local fork')
  })

  test('only an Arc+Robinhood launch of the existing canonical asset is accepted', async () => {
    const adapter = robinhoodFulfillment(config(), new Database(':memory:'))
    const now = 1_900_000_000
    expect(adapter.mode).toBe('fork')
    expect(adapter.terms.payTo).toBe(loopback.arc.executor)
    expect(code(() => adapter.assertReady(request('req-unit-0001', now)))).toBe('asset_missing')
    await journalAsset(adapter)
    expect(code(() => adapter.assertReady(request('req-unit-0001', now)))).toBeNull()
    expect(code(() => adapter.assertReady(request('req-unit-0001', now, {}, ['arc', 'robinhood', 'base'])))).toBe('route_closed')
    expect(code(() => adapter.assertReady(request('req-unit-0001', now, {}, ['arc'])))).toBe('route_closed')
    expect(code(() => adapter.assertReady(request('req-unit-0001', now, { symbol: 'OTHER' })))).toBe('asset_mismatch')
    expect(code(() => adapter.assertReady(request('req-unit-0001', now, { issuance: '999' })))).toBe('asset_mismatch')
    const big = request('req-unit-0001', now)
    big.destinations[1].amount = '60000000000'
    expect(code(() => adapter.assertReady(big))).toBe('rate_limit')
  })

  test('the version pins budgets and pricing, so a changed configuration cannot resume an old job', () => {
    const one = robinhoodFulfillment(config(), new Database(':memory:')).version
    expect(robinhoodFulfillment(config(), new Database(':memory:')).version).toBe(one)
    expect(robinhoodFulfillment(config({ budgets: { ...config().budgets, pool: '6000000' } }), new Database(':memory:')).version).not.toBe(one)
    expect(robinhoodFulfillment(config({ pricing: { arc: 1_000_000n, robinhood: 1n } }), new Database(':memory:')).version).not.toBe(one)
    expect(one).toStartWith('robinhood-fork-fulfillment-v1:')
  })

  test('HTTP quotes bind the payer and plan; a conflicting payload and a second launch of the asset are refused', async () => {
    const store = new JobStore(':memory:')
    const adapter = robinhoodFulfillment(config(), store.db)
    await journalAsset(adapter)
    const now = Date.now()
    const service = createLaunchService(store, adapter, () => now)
    const post = (body: unknown) => service(new Request('http://127.0.0.1:4046/x402/equilibrium', { method: 'POST', body: JSON.stringify(body) }))
    const first = request('req-unit-http-1', Math.floor(now / 1000))
    const quoted = await post(first)
    expect(quoted.status).toBe(402)
    const body = await quoted.json() as { jobId: string; accepts: { payTo: string; amount: string; extra: { mode: string } }[]; steps: { id: string }[] }
    expect(body.accepts[0].payTo).toBe(loopback.arc.executor)
    expect(body.accepts[0].extra.mode).toBe('fork')
    expect(body.steps.map((s) => s.id)).toEqual(['payment:arc', 'canonical:arc', 'manager:arc', 'pool:arc', 'manager:robinhood', 'debit:robinhood', 'credit:robinhood', 'pool:robinhood'])
    expect((await post(first)).status).toBe(402)
    const changed = { ...first, destinations: first.destinations.map((d) => ({ ...d, amount: d.chain === 'robinhood' ? '20000000000' : d.amount })) }
    const conflict = await post(changed)
    expect(conflict.status).toBe(409)
    expect((await conflict.json() as { error: string }).error).toBe('identity_conflict')
    // Once a job binds the asset (its payment step prepared), no other request may launch it.
    store.db.query('INSERT INTO robinhood_launches(asset, identity, job, payer, valid_before, created_at) VALUES(?,?,?,?,?,?)').run('unit-asset', '0xother', '0xotherjob', payer, Math.floor(now / 1000) + 60, 0)
    const second = await post(request('req-unit-http-2', Math.floor(now / 1000)))
    expect(second.status).toBe(409)
    expect((await second.json() as { error: string }).error).toBe('asset_launched')
  })

  test('a holder refuses others until its authorization lapses; settled holders refuse forever', async () => {
    const store = new JobStore(':memory:')
    const adapter = robinhoodFulfillment(config(), store.db)
    await journalAsset(adapter)
    const now = Math.floor(Date.now() / 1000)
    const hold = (validBefore: number, settled: number) => {
      store.db.query('DELETE FROM robinhood_launches').run()
      store.db.query('INSERT INTO robinhood_launches(asset, identity, job, payer, valid_before, settled, created_at) VALUES(?,?,?,?,?,?,?)').run('unit-asset', '0xholder', '0xholderjob', payer, validBefore, settled, 0)
    }
    hold(now + 60, 0)
    expect(code(() => adapter.assertReady(request('req-unit-other', now)))).toBe('asset_launched')
    // Past validBefore the quote may proceed; the payment step decides from chain state before charging.
    hold(now - 1, 0)
    expect(code(() => adapter.assertReady(request('req-unit-other', now)))).toBeNull()
    hold(now - 1, 1)
    expect(code(() => adapter.assertReady(request('req-unit-other', now)))).toBe('asset_launched')
  })

  test('a released or non-holding job is refused at every step before any chain access', async () => {
    const store = new JobStore(':memory:')
    // The RPCs point at closed loopback ports: reaching a chain would fail with another error.
    const adapter = robinhoodFulfillment(config(), store.db)
    await journalAsset(adapter)
    const now = Math.floor(Date.now() / 1000)
    const job = createJob(request('req-unit-released', now), adapter, now)
    job.payment = { authorization: { from: payer, to: loopback.arc.executor, value: job.total, validAfter: '0', validBefore: String(job.request.quote.expires), nonce: job.id }, signature: `0x${'11'.repeat(65)}` }
    const prepared = { operation: job.id, digest: job.id, bytes: '{}' }
    const refusals = async () => Promise.all(job.steps.map(async (step) => {
      const at = async (fn: () => Promise<unknown>) => { try { await fn(); return null } catch (cause) { return cause instanceof LaunchError ? cause.code : String(cause) } }
      return [step.id, await at(() => adapter.prepare({ job, step })), await at(() => adapter.observe({ job, step }, prepared)), await at(() => adapter.broadcast({ job, step }, prepared))]
    }))
    // Another job holds the asset: every step but payment is refused as not holding it.
    store.db.query('INSERT INTO robinhood_launches(asset, identity, job, payer, valid_before, settled, created_at) VALUES(?,?,?,?,?,?,?)').run('unit-asset', '0xholder', '0xholderjob', payer, now + 60, 1, 0)
    for (const [step, ...codes] of await refusals()) expect([step, ...codes]).toEqual([step, 'asset_launched', 'asset_launched', 'asset_launched'])
    // Released: the job can never reacquire the asset, even once nobody holds it.
    store.db.query('DELETE FROM robinhood_launches').run()
    store.db.query('INSERT INTO robinhood_released(job, asset, identity, reason, block, released_at) VALUES(?,?,?,?,?,?)').run(job.id, 'unit-asset', job.identity, 'authorization expired', '1', 0)
    for (const [step, ...codes] of await refusals()) expect([step, ...codes]).toEqual([step, 'payment_failed', 'payment_failed', 'payment_failed'])
    expect(store.db.query('SELECT COUNT(*) AS n FROM robinhood_launches').get()).toEqual({ n: 0 })
  })

  test('a released job reports what its authorization moved, and only an owed residual can be refunded', async () => {
    const store = new JobStore(':memory:')
    const adapter = robinhoodFulfillment(config(), store.db)
    await journalAsset(adapter)
    const now = Math.floor(Date.now() / 1000)
    const message = (id: string) => { try { adapter.assertReady(request(id, now)); return null } catch (cause) { return cause instanceof LaunchError ? [cause.code, cause.message] : String(cause) } }
    const released = (id: string, reason: string) => {
      const job = createJob(request(id, now), adapter, now)
      store.db.query('INSERT INTO robinhood_released(job, asset, identity, reason, block, released_at) VALUES(?,?,?,?,?,?)').run(job.id, 'unit-asset', job.identity, reason, '9', 0)
      return job
    }
    const ledger = (job: string, outcome: string, received: string, refund: string) => store.db.query(`INSERT INTO robinhood_payment_ledger(job, asset, payer, outcome, authorized, received, fees_spent, residual, evidence_tx, evidence_block, refund, recorded_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(job, 'unit-asset', payer, outcome, '60000000', received, '0', received, outcome === 'expired_unused' ? null : '0xevidence', '9', refund, 0)
    // A journal from before attribution: the error must not claim nothing was charged.
    released('req-unit-legacy', 'authorization nonce spent elsewhere')
    const legacy = message('req-unit-legacy') as string[]
    expect(legacy[0]).toBe('payment_failed')
    expect(legacy[1]).not.toContain('Nothing was charged')
    expect(legacy[1]).toContain('No payment attribution was recorded')
    const expired = released('req-unit-expired', 'authorization expired')
    ledger(expired.id, 'expired_unused', '0', 'none')
    expect((message('req-unit-expired') as string[])[1]).toContain('never used: nothing was charged')
    const moved = released('req-unit-moved', 'authorization used outside the job')
    ledger(moved.id, 'used_outside_job', '60000000', 'owed')
    const text = (message('req-unit-moved') as string[])[1]
    expect(text).toContain('used outside the job in 0xevidence: 60000000 USDC atoms reached the Arc executor')
    expect(text).toContain(`refund owed to ${payer}; no refund has been sent`)
    expect(text).not.toContain('Nothing was charged')
    const other = released('req-unit-other-terms', 'authorization nonce spent by other terms')
    ledger(other.id, 'spent_by_other_authorization', '0', 'none')
    expect((message('req-unit-other-terms') as string[])[1]).toContain('none of that transfer reached the executor. Nothing is attributed to this job')
    // Other terms that did reach the executor: held for the payer, never this job's payment.
    const stray = released('req-unit-stray', 'authorization nonce spent by other terms')
    ledger(stray.id, 'spent_by_other_authorization', '30000000', 'owed')
    const strayText = (message('req-unit-stray') as string[])[1]
    expect(strayText).toContain('which moved 30000000 USDC atoms to the Arc executor. That is not this job\'s payment')
    expect(strayText).toContain('no refund has been sent. It is held for this job')
    // Each refund state has its own sentence, and only an unfinished one says the residual is held.
    const op = adapter.route.layout.op(`job:${moved.id}:refund:arc`)
    const refundText = () => (message('req-unit-moved') as string[])[1]
    store.db.query('INSERT INTO robinhood_ops(operation, name, side, digest, bytes, created_at) VALUES(?,?,?,?,?,?)').run(op, `job:${moved.id}:refund:arc`, 'arc', '0x00', '{}', 0)
    expect(adapter.refundStatus(moved.id)).toEqual({ state: 'prepared', transaction: null, block: null })
    expect(refundText()).toContain('is prepared and may already have been sent; its outcome is unknown')
    store.db.query('UPDATE robinhood_ops SET tx=? WHERE operation=?').run('0xrefund', op)
    expect(adapter.refundStatus(moved.id)).toEqual({ state: 'uncertain', transaction: '0xrefund', block: null })
    expect(refundText()).toContain('was sent in 0xrefund and has not executed yet; its outcome is unknown. It stays held')
    store.db.query("UPDATE robinhood_payment_ledger SET refund='submitted', refund_tx='0xrefund', refund_block='12' WHERE job=?").run(moved.id)
    expect(refundText()).toContain('refunded to 0x0000000000000000000000000000000000000abc in 0xrefund at Arc block 12, not yet final. It stays held')
    store.db.query("UPDATE robinhood_payment_ledger SET refund='refunded' WHERE job=?").run(moved.id)
    expect(refundText()).toContain('final at Arc block 12. Nothing of it remains on the executor.')
    expect(refundText()).not.toContain('held')
    expect(adapter.ledger(moved.id)).toMatchObject({ outcome: 'used_outside_job', received: '60000000', fees_spent: '0', residual: '60000000', refund: 'refunded' })
    // Refunds need an owed residual; neither case reaches a chain.
    const refused = async (job: string) => { try { await adapter.refund(job); return null } catch (cause) { return cause instanceof LaunchError ? cause.code : String(cause) } }
    expect(await refused(expired.id)).toBe('nothing_to_refund')
    expect(await refused('0xunknown')).toBe('not_released')
  })
})
