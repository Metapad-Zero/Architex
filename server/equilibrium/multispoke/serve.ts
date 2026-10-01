/**
 * FORK-ONLY launch service for the composed Arc–Base–Robinhood job: the same HTTP quote/payment/job
 * surface as serve.ts, evm/serve.ts and robinhood/serve.ts, backed by the multispoke adapter, on its
 * own port (4048) and its own job journal. The adapter refuses non-loopback RPCs, so this cannot
 * reach a public chain.
 *
 *   EQUILIBRIUM_MULTISPOKE_CONFIG=output/…/multispoke.json \
 *   EQUILIBRIUM_DB=./output/equilibrium/multispoke-jobs.sqlite bun run server/equilibrium/multispoke/serve.ts
 *
 * Every response carries the mixed-environment and fixture labels. EQUILIBRIUM_MULTISPOKE_KILL_AFTER_SEND
 * names a step whose send SIGKILLs this process: a crash seam for the fork suite, meaningless elsewhere.
 */
import { readFileSync } from 'node:fs'
import { JobStore, assertDurableStore, durationMs } from '../store'
import { createLaunchService } from '../service'
import { reconcile } from '../runner'
import { robinhoodStatus } from '../robinhood/adapter'
import { multispokeAdapter } from './adapter'
import { configFromJson } from './fork'

const configPath = process.env.EQUILIBRIUM_MULTISPOKE_CONFIG
if (!configPath) throw new Error('EQUILIBRIUM_MULTISPOKE_CONFIG must name the fork composition configuration.')
const config = configFromJson(readFileSync(configPath, 'utf8'))
const dbPath = assertDurableStore(process.env.EQUILIBRIUM_DB ?? './output/equilibrium/multispoke-jobs.sqlite')
const store = new JobStore(dbPath, { leaseMs: durationMs('EQUILIBRIUM_LEASE_MS', process.env.EQUILIBRIUM_LEASE_MS, 60_000) })
const sweepMs = durationMs('EQUILIBRIUM_RECONCILE_MS', process.env.EQUILIBRIUM_RECONCILE_MS, 30_000)
const kill = process.env.EQUILIBRIUM_MULTISPOKE_KILL_AFTER_SEND
const adapter = multispokeAdapter(config, store.db, { afterSend: (label) => { if (label === kill) process.kill(process.pid, 'SIGKILL') } })
await adapter.verify()
const service = createLaunchService(store, adapter)
const labels = { ...config.labels, publicRobinhoodRoute: robinhoodStatus().route }
const headers = { 'x-equilibrium-environment': config.labels.environment, 'x-equilibrium-payment': 'fork-fixture' }
const labelled = (response: Response) => {
  const out = new Response(response.body, response)
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v)
  return out
}
const text = (value: unknown) => JSON.parse(JSON.stringify(value, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))) as unknown
const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.EQUILIBRIUM_PORT ?? '4048'), maxRequestBodySize: 16_384,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/api/equilibrium' && request.method === 'GET') {
      const unavailable = (cause: unknown) => ({ unavailable: String(cause).split('\n')[0] })
      const jobs = await Promise.all(store.list().map(async (job) => ({ ...adapter.view(job), chainSupply: await adapter.supply(job).then(text, unavailable) })))
      const executorUsdc = await adapter.executorUsdc().then(text, unavailable)
      return labelled(Response.json({ mode: adapter.mode, adapter: adapter.version, labels, jobs, executorUsdc }, { headers: { 'cache-control': 'no-store' } }))
    }
    if (path === '/x402/equilibrium' || path === '/equilibrium/jobs' || path.startsWith('/equilibrium/jobs/')) {
      const response = await service(request)
      if (request.method !== 'GET' || !response.ok) return labelled(response)
      // Job reads come from the corrected view: released jobs' attribution and completed jobs' USDC.
      const body = await response.json() as { jobs: { id: string }[] }
      return labelled(Response.json({ ...body, jobs: body.jobs.map((j) => adapter.view(store.get(j.id)!)) }, { status: response.status, headers: response.headers }))
    }
    return labelled(Response.json({ mode: adapter.mode, adapter: adapter.version, labels, endpoints: ['/x402/equilibrium', '/equilibrium/jobs', '/api/equilibrium'] }))
  },
})
console.log(`EQUILIBRIUM ${config.labels.environment} launch service ${adapter.version}: ${server.url}`)
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
    try { store.close() } catch { /* the journal is durable either way */ }
    process.exit(0)
  })
}
