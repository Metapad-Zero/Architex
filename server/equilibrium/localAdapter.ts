import { hash } from './request'
import type { JobStore } from './store'
import { LaunchError, type EffectContext, type EffectResult, type PreparedEffect, type PromotionalTokenAdapter } from './types'

/** Durable synthetic external effects. LOCAL ONLY: no RPC, deployed contracts or actual settlement. */
export function localAdapter(store: JobStore, options: { pending?: Set<string>; unavailable?: Set<string> } = {}): PromotionalTokenAdapter {
  const pending = options.pending ?? new Set<string>()
  return {
    mode: 'local',
    version: 'local-shared-supply-v1',
    terms: { chainId: 31337, asset: '0x0000000000000000000000000000000000003009', payTo: '0x0000000000000000000000000000000000004020', name: 'USDC', version: '2' },
    assertReady(request) {
      if (request.destinations.some((d) => d.chain !== 'arc' && d.chain !== 'base')) throw new LaunchError(503, 'route_closed', 'The local integration rehearsal only enables modeled Arc and Base.')
    },
    budgets: () => ({ payment: '1000000', canonical: '2000000', manager: '1000000', debit: '100000', credit: '100000', pool: '1000000' }),
    prepare({ job, step }) {
      const operation = hash([job.id, step.id])
      const bytes = JSON.stringify({ operation, job: job.id, step: step.id, request: job.request, paymentNonce: job.payment?.authorization.nonce })
      return Promise.resolve({ operation, digest: hash(bytes), bytes })
    },
    observe({ step }, prepared) {
      const row = store.db.query<{ digest: string; result: string }, [string]>('SELECT digest,result FROM local_effects WHERE operation=?').get(prepared.operation)
      if (row && row.digest !== prepared.digest) throw new Error('Operation already bound to other bytes')
      if (pending.has(step.id)) return Promise.resolve(row ? 'pending' : 'absent')
      return Promise.resolve(row ? JSON.parse(row.result) as EffectResult : 'absent')
    },
    broadcast(context: EffectContext, prepared: PreparedEffect) {
      const { job, step } = context
      if (options.unavailable?.has(step.id)) throw new Error(`${step.id} adapter unavailable; existing work is preserved`)
      if (hash(prepared.bytes) !== prepared.digest || prepared.operation !== hash([job.id, step.id])) throw new Error('Prepared bytes changed')
      store.db.transaction(() => {
        const prior = store.db.query<{ digest: string }, [string]>('SELECT digest FROM local_effects WHERE operation=?').get(prepared.operation)
        if (prior) {
          if (prior.digest !== prepared.digest) throw new Error('Conflicting operation')
          return
        }
        const destination = job.request.destinations.find((d) => d.chain === step.chain)!
        const result: EffectResult = { operation: prepared.operation, transaction: `local:${prepared.operation}`, finalized: true, cost: step.kind === 'payment' ? '0' : step.budget }
        // Settlement moves the whole authorized total; the platform fee is captured from it.
        if (step.kind === 'payment') result.amount = job.total
        if (['canonical', 'manager', 'pool'].includes(step.kind)) result.address = `local:${hash([job.id, step.id, 'address']).slice(2, 42)}`
        if (step.kind === 'canonical') {
          result.amount = job.request.canonical.issuance
          store.db.query('INSERT INTO local_supply(job,issuance,custody,remote,pending) VALUES(?,?,?,?,?)').run(job.id, job.request.canonical.issuance, '0', '0', '0')
        }
        if (step.kind === 'debit' || step.kind === 'credit') {
          const row = store.db.query<{ issuance: string; custody: string; remote: string; pending: string }, [string]>('SELECT * FROM local_supply WHERE job=?').get(job.id)!
          let custody = BigInt(row.custody); let remote = BigInt(row.remote); let claim = BigInt(row.pending)
          const amount = BigInt(destination.amount)
          if (step.kind === 'debit') { custody += amount; claim += amount }
          else {
            if (job.steps.find((s) => s.id === `debit:${step.chain}`)?.state !== 'complete' || claim < amount) throw new Error('Credit requires a finalized source debit')
            remote += amount; claim -= amount
          }
          if (custody > BigInt(row.issuance) || custody !== remote + claim) throw new Error('Supply mismatch')
          result.amount = destination.amount
          store.db.query('UPDATE local_supply SET custody=?, remote=?, pending=? WHERE job=?').run(custody.toString(), remote.toString(), claim.toString(), job.id)
        }
        if (step.kind === 'pool') {
          result.amount = destination.poolTokens; result.quoteAmount = destination.poolQuote
          store.db.query('INSERT INTO local_pool_inventory(operation,tokens,quote) VALUES(?,?,?)').run(prepared.operation, destination.poolTokens, destination.poolQuote)
        }
        store.db.query('INSERT INTO local_effects(operation,digest,result) VALUES(?,?,?)').run(prepared.operation, prepared.digest, JSON.stringify(result))
      }).immediate()
      return Promise.resolve()
    },
  }
}

/** All remote adapters are fail-closed. No flag alone can establish tested bridge/pool prerequisites. */
export function closedAdapter(mode: 'testnet' | 'live'): PromotionalTokenAdapter {
  const refuse = (): never => { throw new LaunchError(503, 'integration_closed', 'No deployed EQUILIBRIUM token/managers, authenticated route round trip, budget approval or durable production payment backend. Robinhood NTT testnet support is undocumented. See the release preview.') }
  return { mode, version: 'unconfigured-closed-v1', terms: { chainId: mode === 'live' ? 5042 : 5042002, asset: '0x3600000000000000000000000000000000000000', payTo: '0x0000000000000000000000000000000000000000', name: 'USDC', version: '2' },
    assertReady: refuse, budgets: refuse, prepare: refuse, observe: refuse, broadcast: refuse }
}
