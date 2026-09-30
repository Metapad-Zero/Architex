import { readiness } from '../src/lib/equilibriumNetwork.js'

/** Production stays closed. The SQLite/local signer rehearsal is deliberately not deployed here. */
export function GET(): Response {
  return Response.json({ ...readiness(), mode: 'testnet', jobs: [], supply: null, note: 'No public EQUILIBRIUM issuance or fulfilled paid launch. Read local rehearsal and infrastructure evidence separately.' }, { headers: { 'cache-control': 'no-store' } })
}
export function POST(): Response {
  return Response.json({ error: 'integration_closed', mode: 'testnet', paidLaunchOpen: false, message: 'Shared-supply launches await deployed managers, route/pool proofs and approval of the release preview.' }, { status: 503 })
}
