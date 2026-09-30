/**
 * 49TH-27 local-only evidence fixture. No RPC and no public payment domain.
 * Seed a NEW durable SQLite file, serve the pending receipt, then restart with
 * --recover to exercise unattended recovery while the browser observes it.
 * See docs/EQUILIBRIUM-REPAIR.md for the complete browser verification sequence.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { account, sign } from './__tests__/fixtures'
import { localAdapter } from './localAdapter'
import { publicJob, quote as makeQuote, reconcile, runJob } from './runner'
import { createLaunchService } from './service'
import { assertDurableStore, JobStore } from './store'
import { readiness } from '../../src/lib/equilibriumNetwork'
import { describe, launch, quote, status, template } from '../../scripts/equilibrium-client'

const flags = process.argv.slice(2)
const value = (flag: string, fallback: string) => flags.includes(flag) ? flags[flags.indexOf(flag) + 1] : fallback
const dbPath = assertDurableStore(value('--db', './output/equilibrium/repair.sqlite'))
const store = new JobStore(dbPath)
const now = Math.floor(Date.now() / 1000)
const pending = flags.includes('--recover') ? new Set<string>() : new Set(['credit:base'])
const adapter = localAdapter(store, { pending })
const service = createLaunchService(store, adapter)
const seed = flags.includes('--seed')
if (!seed && !flags.includes('--serve')) { store.close(); throw new Error('Pass --seed for a new DB, or --serve [--recover] to inspect/recover it.') }
if (seed && store.list().length) { store.close(); throw new Error('Seed requires an empty database; choose a new --db path. Existing evidence is preserved.') }

const server = Bun.serve({ hostname: '127.0.0.1', port: seed ? 0 : Number(value('--port', '41428')),
  fetch(request) {
    if (new URL(request.url).pathname === '/api/equilibrium' && request.method === 'GET') return Response.json({ ...readiness(), mode: 'local', jobs: store.list().map(publicJob), supply: null }, { headers: { 'cache-control': 'no-store' } })
    return service(request)
  },
})
const origin = server.url.origin
if (seed) {
  try {
    const unpaidRequest = template(account.address, { requestId: 'repair-unpaid', now })
    const unpaid = await quote(origin, unpaidRequest)
    assert.deepEqual(await quote(origin, unpaidRequest), unpaid)
    const unpaidRecord = await status(origin, unpaid.jobId)
    assert.equal(unpaidRecord.payment.fulfillment, 'not_started')
    assert.equal(unpaidRecord.funds?.determinate, true)
    assert.equal(unpaidRecord.recovery?.automatic, false)

    // Persist an authorization whose quote expired before any payment was broadcast.
    const expiredJob = makeQuote(store, adapter, template(account.address, { requestId: 'repair-expired', now: now - 1000 }), now - 1000)
    await assert.rejects(runJob(store, adapter, expiredJob.id, await sign(expiredJob)), /Unsettled authorization expired/)
    const expired = await status(origin, expiredJob.id)
    assert.equal(expired.recovery?.automatic, false)
    assert.equal(expired.payment.settled, false)

    const blockedJob = makeQuote(store, adapter, template(account.address, { requestId: 'repair-blocked', now }), now)
    await assert.rejects(runJob(store, localAdapter(store, { unavailable: new Set(['manager:base']) }), blockedJob.id, await sign(blockedJob)), /adapter unavailable/)
    const blocked = await status(origin, blockedJob.id)
    assert.equal(blocked.recovery?.automatic, false)
    assert.equal(blocked.payment.settled, true)

    const request = template(account.address, { requestId: 'repair-recover', now })
    // Public, well-known synthetic fixture key. This client signs only for loopback chain 31337.
    const key = '0x0000000000000000000000000000000000000000000000000000000000000123'
    const result = await launch(origin, request, key, '30000000')
    assert.equal(result.status, 202)
    assert.equal(result.settlement?.success, true)
    assert.equal(result.job.supply.remote, null)
    assert.equal(result.job.recovery?.automatic, true)
    const retry = await fetch(`${origin}/x402/equilibrium`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })
    assert.equal(retry.status, 202)
    const retried = await retry.json() as typeof result.job
    assert.equal(retried.settlement?.transaction, result.job.settlement?.transaction)
    const conflict = await fetch(`${origin}/x402/equilibrium`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...request, quote: { ...request.quote, costCap: '99000000' } }) })
    assert.equal(conflict.status, 409)
    const conflictBody = await conflict.json() as { error: string }
    assert.equal(conflictBody.error, 'identity_conflict')
    const ledger = store.db.query('SELECT issuance,custody,remote,pending FROM local_supply WHERE job=?').get(result.job.id)
    const report = { mode: 'local', label: 'Synthetic Arc/Base HTTP rehearsal; no RPC, public funds or transactions', quoteHttp: 402, launchHttp: result.status, unsignedRetryHttp: retry.status, conflictHttp: conflict.status,
      unpaid: unpaidRecord, expired, blocked, pending: result.job, settlementHeader: result.settlement, externalSyntheticLedger: ledger,
      client: [unpaidRecord, expired, blocked, result.job].map(describe),
      counts: store.db.query('SELECT (SELECT COUNT(*) FROM local_effects) AS effects,(SELECT COUNT(*) FROM settled_authorizations) AS settlements').get() }
    const reportPath = value('--report', './output/equilibrium/repair-http.json')
    mkdirSync(dirname(reportPath), { recursive: true }); writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({ report: reportPath, pendingJob: result.job.id, mode: 'local', counts: report.counts }))
  } finally { await server.stop(true); store.close() }
} else {
  console.log(`49TH-27 local synthetic evidence server pid=${process.pid} ${origin}; receipt ${pending.size ? 'pending' : 'recoverable'}; database ${dbPath}`)
  let sweeping = false
  const sweep = async () => {
    if (sweeping) return
    sweeping = true
    try { const results = await reconcile(store, adapter); if (results.length && !pending.size) console.log(JSON.stringify({ mode: 'local', resumed: results })) }
    catch (cause) { console.error(cause) }
    finally { sweeping = false }
  }
  await sweep()
  const timer = setInterval(() => { void sweep() }, 1000)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { clearInterval(timer); void server.stop(true); store.close(); process.exit(0) })
}
