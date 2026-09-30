import type { Plugin } from 'vite'
import { readiness } from '../src/lib/equilibriumNetwork'

/** Free integration records. Only an explicitly configured local rehearsal service may provide jobs. */
export function devEquilibrium(): Plugin {
  const target = process.env.EQUILIBRIUM_JOB_SERVER
  if (target && !/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(target)) throw new Error('EQUILIBRIUM_JOB_SERVER must be a local loopback service.')
  return { name: 'architex-dev-equilibrium', apply: 'serve', configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url?.split('?')[0] !== '/api/equilibrium') return next()
      void (async () => {
        if (req.method !== 'GET') { res.statusCode = 503; res.end('Paid integration closed'); return }
        const snapshot = target ? await fetch(`${target}/api/equilibrium`, { signal: AbortSignal.timeout(3000) }).then((r) => { if (!r.ok) throw new Error('Job service unavailable'); return r.json() })
          : { ...readiness(), mode: 'local', jobs: [], supply: null }
        res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(snapshot))
      })().catch(() => { res.statusCode = 503; res.end('Integration records unavailable') })
    })
  } }
}
