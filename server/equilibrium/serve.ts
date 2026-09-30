import { JobStore, assertDurableStore, durationMs } from './store'
import { localAdapter } from './localAdapter'
import { createLaunchService } from './service'
import { publicJob, reconcile } from './runner'
import { readiness } from '../../src/lib/equilibriumNetwork'

// Refuse to hold authorizations and prepared effects on a host that discards them.
const dbPath = assertDurableStore(process.env.EQUILIBRIUM_DB ?? './output/equilibrium/jobs.sqlite')
const leaseMs = durationMs('EQUILIBRIUM_LEASE_MS', process.env.EQUILIBRIUM_LEASE_MS, 30_000)
const sweepMs = durationMs('EQUILIBRIUM_RECONCILE_MS', process.env.EQUILIBRIUM_RECONCILE_MS, 30_000)
const store = new JobStore(dbPath, { leaseMs })
const adapter = localAdapter(store)
const service = createLaunchService(store, adapter)
const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.EQUILIBRIUM_PORT ?? '4042'), maxRequestBodySize: 16_384,
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/api/equilibrium' && request.method === 'GET') return Response.json({ ...readiness(), mode: 'local', jobs: store.list().map(publicJob), supply: null })
    if (path === '/x402/equilibrium' || path === '/equilibrium/jobs' || path.startsWith('/equilibrium/jobs/')) return service(request)
    return Response.json({ mode: 'local', payment: 'synthetic; no real funds', endpoints: ['/x402/equilibrium', '/equilibrium/jobs'] })
  },
})
console.log(`Local integration rehearsal: ${server.url} (synthetic payments and addresses only)`)
/**
 * A launch interrupted by a crash resumes from durable state without a client request. Booting is
 * not enough on its own: a dead worker still holds its lease, so restarting inside that window
 * finds nothing to do. Sweep on a timer as well, and let the lease fence the duplicate. The sweep
 * runs after the port opens, so one hung adapter call cannot keep the service unreachable; a job
 * whose last attempt submitted nothing stays out of it rather than being retried every tick.
 */
const resumed = (results: Awaited<ReturnType<typeof reconcile>>) => { if (results.length) console.log(`Resumed ${results.length} interrupted job(s): ${JSON.stringify(results)}`) }
const failed = (cause: unknown) => console.error('Reconcile sweep failed:', cause)
let sweeping = false
const runSweep = () => {
  if (sweeping) return
  sweeping = true
  void reconcile(store, adapter).then(resumed).catch(failed).finally(() => { sweeping = false })
}
runSweep()
const sweep = setInterval(runSweep, sweepMs)
sweep.unref?.()
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { clearInterval(sweep); void server.stop(true); store.close(); process.exit(0) })
