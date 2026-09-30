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
/** Chain-read supply. Before the job deploys the spoke there is none to read, and that is reported, not hidden. */
const supply = () => adapter.route.supply().then((s) => JSON.parse(JSON.stringify(s, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))) as unknown,
  (cause: unknown) => ({ unavailable: cause instanceof Error ? cause.message.split('\n')[0] : 'unreadable' }))
const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.EQUILIBRIUM_PORT ?? '4046'), maxRequestBodySize: 16_384,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/api/equilibrium' && request.method === 'GET') {
      return labelled(Response.json({ mode: adapter.mode, adapter: adapter.version, labels, jobs: store.list().map(publicJob), supply: await supply() },
        { headers: { 'cache-control': 'no-store' } }))
    }
    if (path === '/x402/equilibrium' || path === '/equilibrium/jobs' || path.startsWith('/equilibrium/jobs/')) return labelled(await service(request))
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
