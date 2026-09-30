/**
 * FORK-ONLY Robinhood launch service: the same HTTP quote/payment/job surface as serve.ts and
 * evm/serve.ts, backed by the Robinhood fulfillment adapter, on its own port (4046) and its own job
 * journal. The route engine refuses non-loopback RPCs, so this cannot reach a public chain.
 *
 *   EQUILIBRIUM_ROBINHOOD_FULFILLMENT_CONFIG=output/…/fulfillment.json \
 *   EQUILIBRIUM_DB=./output/equilibrium/robinhood-jobs.sqlite bun run server/equilibrium/robinhood/serve.ts
 *
 * Every response carries the mixed-environment and fixture labels. EQUILIBRIUM_ROBINHOOD_KILL_AFTER_SEND
 * names a step whose send SIGKILLs this process: a crash seam for the fork suite, meaningless elsewhere.
 */
import { readFileSync } from 'node:fs'
import { JobStore, assertDurableStore, durationMs } from '../store'
import { createLaunchService } from '../service'
import { publicJob, reconcile } from '../runner'
import { robinhoodFulfillment } from './fulfillment'
import { fulfillmentFromJson } from './fulfillment-fork'
import { robinhoodStatus } from './adapter'

const configPath = process.env.EQUILIBRIUM_ROBINHOOD_FULFILLMENT_CONFIG
if (!configPath) throw new Error('EQUILIBRIUM_ROBINHOOD_FULFILLMENT_CONFIG must name the fork fulfillment configuration.')
const config = fulfillmentFromJson(readFileSync(configPath, 'utf8'))
const dbPath = assertDurableStore(process.env.EQUILIBRIUM_DB ?? './output/equilibrium/robinhood-jobs.sqlite')
const store = new JobStore(dbPath, { leaseMs: durationMs('EQUILIBRIUM_LEASE_MS', process.env.EQUILIBRIUM_LEASE_MS, 60_000) })
const sweepMs = durationMs('EQUILIBRIUM_RECONCILE_MS', process.env.EQUILIBRIUM_RECONCILE_MS, 30_000)
const kill = process.env.EQUILIBRIUM_ROBINHOOD_KILL_AFTER_SEND
const adapter = robinhoodFulfillment(config, store.db, { afterSend: (step) => { if (step === kill) process.kill(process.pid, 'SIGKILL') } })
const service = createLaunchService(store, adapter)
const labels = { ...config.labels, publicRoute: robinhoodStatus().route }
const headers = { 'x-equilibrium-environment': config.labels.environment, 'x-equilibrium-payment': 'fork-fixture' }
const labelled = (response: Response) => {
  const out = new Response(response.body, response)
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v)
  return out
}
/**
 * A released job's money comes from the attribution ledger, not from its never-completed payment
 * step: an authorization used outside the job did move funds, and the view must say so and whether
 * they were refunded. Jobs without a ledger row are returned unchanged.
 */
const attributed = (view: ReturnType<typeof publicJob>) => {
  const l = adapter.ledger(view.id)
  if (!l) return view
  const held = l.refund === 'owed' || l.refund === 'submitted' ? l.residual : '0'
  return { ...view, error: adapter.explain(view.id) ?? view.error,
    funds: { ...view.funds, paid: l.received, feesSpent: l.fees_spent, unallocatedHeld: held, determinate: true, refundable: l.refund === 'owed', refundableAmount: l.refund === 'owed' ? l.residual : '0', unresolvedEffects: [],
      note: l.received === '0' ? `Released (${l.outcome}): nothing reached the executor under this job's authorization.` : `Released (${l.outcome}): ${l.received} reached the executor outside the job; residual ${l.residual}, refund ${l.refund}. No other job may spend it.` },
    attribution: { outcome: l.outcome, authorized: l.authorized, received: l.received, feesSpent: l.fees_spent, residual: l.residual, evidence: { transaction: l.evidence_tx, block: l.evidence_block },
      refund: { state: l.refund, transaction: l.refund_tx, block: l.refund_block } } }
}
/** Chain-read supply. Before the job deploys the spoke there is none to read, and that is reported, not hidden. */
const supply = () => adapter.route.supply().then((s) => JSON.parse(JSON.stringify(s, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))) as unknown,
  (cause: unknown) => ({ unavailable: cause instanceof Error ? cause.message.split('\n')[0] : 'unreadable' }))
const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.EQUILIBRIUM_PORT ?? '4046'), maxRequestBodySize: 16_384,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/api/equilibrium' && request.method === 'GET') {
      return labelled(Response.json({ mode: adapter.mode, adapter: adapter.version, labels, jobs: store.list().map((j) => attributed(publicJob(j))), supply: await supply() },
        { headers: { 'cache-control': 'no-store' } }))
    }
    if (path === '/x402/equilibrium' || path === '/equilibrium/jobs' || path.startsWith('/equilibrium/jobs/')) {
      const response = await service(request)
      if (request.method !== 'GET' || !response.ok) return labelled(response)
      const body = await response.json() as { jobs: ReturnType<typeof publicJob>[] }
      return labelled(Response.json({ ...body, jobs: body.jobs.map(attributed) }, { status: response.status, headers: response.headers }))
    }
    return labelled(Response.json({ mode: adapter.mode, adapter: adapter.version, labels, endpoints: ['/x402/equilibrium', '/equilibrium/jobs', '/api/equilibrium'] }))
  },
})
console.log(`EQUILIBRIUM Robinhood ${config.labels.environment} launch service ${adapter.version}: ${server.url}`)
let sweeping = false
const runSweep = () => {
  if (sweeping) return
  sweeping = true
  void reconcile(store, adapter).then((results) => { if (results.length) console.log(`Swept ${results.length} job(s): ${JSON.stringify(results)}`) })
    .catch((cause) => console.error('Reconcile sweep failed:', cause)).finally(() => { sweeping = false })
}
runSweep()
const sweep = setInterval(runSweep, sweepMs)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(sweep)
    void server.stop(true)
    // An in-flight sweep may still hold a statement; the journal is durable either way, so exit regardless.
    try { store.close() } catch { /* closing a busy handle is not worth staying up for */ }
    process.exit(0)
  })
}
