import { JobStore } from './store'
import { localAdapter } from './localAdapter'
import { createLaunchService } from './service'
import { publicJob } from './runner'
import { readiness } from '../../src/lib/equilibriumNetwork'

const store = new JobStore(process.env.EQUILIBRIUM_DB ?? './output/equilibrium/jobs.sqlite')
const service = createLaunchService(store, localAdapter(store))
const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.EQUILIBRIUM_PORT ?? '4042'), maxRequestBodySize: 16_384,
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/api/equilibrium' && request.method === 'GET') return Response.json({ ...readiness(), mode: 'local', jobs: store.list().map(publicJob), supply: null })
    if (path === '/x402/equilibrium' || path === '/equilibrium/jobs' || path.startsWith('/equilibrium/jobs/')) return service(request)
    return Response.json({ mode: 'local', payment: 'synthetic; no real funds', endpoints: ['/x402/equilibrium', '/equilibrium/jobs'] })
  },
})
console.log(`Local integration rehearsal: ${server.url} (synthetic payments and addresses only)`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void server.stop(true); store.close(); process.exit(0) })
