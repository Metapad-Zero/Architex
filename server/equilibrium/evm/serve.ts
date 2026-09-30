/**
 * Unattended Arc–Base launch service. Same HTTP surface as the local rehearsal (serve.ts), backed by
 * the real RPC adapter, sweeping interrupted jobs on a timer so a crash never needs a client resend.
 *
 *   EQUILIBRIUM_EVM_CONFIG=deployments/equilibrium-fork.json EQUILIBRIUM_OPERATOR_KEY=0x… \
 *   EQUILIBRIUM_DB=./output/equilibrium/evm.sqlite bun run equilibrium:evm-serve
 *
 * Testnet mode additionally requires EQUILIBRIUM_APPROVAL (see approval.ts). Live mode does not exist.
 */
import { readFileSync } from 'node:fs'
import { JobStore, assertDurableStore, durationMs } from '../store'
import { createLaunchService } from '../service'
import { publicJob, reconcile } from '../runner'
import { evmAdapter } from './adapter'
import { fromFile, type EvmFileConfig } from './config'
import { assertApproved } from './approval'

const configPath = process.env.EQUILIBRIUM_EVM_CONFIG
if (!configPath) throw new Error('EQUILIBRIUM_EVM_CONFIG must name the adapter configuration.')
const configText = readFileSync(configPath, 'utf8')
const file = JSON.parse(configText) as EvmFileConfig
assertApproved(file.mode, readFileSync(process.env.EQUILIBRIUM_PREVIEW ?? './public/equilibrium-release-preview.md', 'utf8'), configText, process.env.EQUILIBRIUM_APPROVAL, [file.arc.rpc, file.base.rpc])
const dbPath = assertDurableStore(process.env.EQUILIBRIUM_DB ?? './output/equilibrium/evm.sqlite')
const store = new JobStore(dbPath, { leaseMs: durationMs('EQUILIBRIUM_LEASE_MS', process.env.EQUILIBRIUM_LEASE_MS, 60_000) })
const sweepMs = durationMs('EQUILIBRIUM_RECONCILE_MS', process.env.EQUILIBRIUM_RECONCILE_MS, 30_000)
const adapter = evmAdapter(fromFile(file), store.db)
// Refuse to quote against executors, cores or venues that are not what the configuration claims.
await adapter.verify()
const service = createLaunchService(store, adapter)
const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.EQUILIBRIUM_PORT ?? '4043'), maxRequestBodySize: 16_384,
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/api/equilibrium' && request.method === 'GET') return Response.json({ mode: adapter.mode, adapter: adapter.version, jobs: store.list().map(publicJob) }, { headers: { 'cache-control': 'no-store' } })
    if (path === '/x402/equilibrium' || path === '/equilibrium/jobs' || path.startsWith('/equilibrium/jobs/')) return service(request)
    return Response.json({ mode: adapter.mode, adapter: adapter.version, endpoints: ['/x402/equilibrium', '/equilibrium/jobs'] })
  },
})
console.log(`EQUILIBRIUM ${adapter.mode} launch service ${adapter.version}: ${server.url}`)
let sweeping = false
const runSweep = () => {
  if (sweeping) return
  sweeping = true
  void reconcile(store, adapter).then((results) => { if (results.length) console.log(`Swept ${results.length} job(s): ${JSON.stringify(results)}`) })
    .catch((cause) => console.error('Reconcile sweep failed:', cause)).finally(() => { sweeping = false })
}
runSweep()
const sweep = setInterval(runSweep, sweepMs)
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { clearInterval(sweep); void server.stop(true); store.close(); process.exit(0) })
