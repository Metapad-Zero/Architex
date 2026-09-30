import { randomUUID } from 'node:crypto'
import { hash, identity, parseRequest, createJob } from './request'
import type { JobStore } from './store'
import { LaunchError, type Job, type PromotionalTokenAdapter, type SignedPayment } from './types'

export function quote(store: JobStore, adapter: PromotionalTokenAdapter, raw: unknown, now: number): Job {
  const request = parseRequest(raw)
  const existing = store.get(identity(request))
  if (existing) {
    if (hash(existing.request) !== hash(request)) throw new LaunchError(409, 'identity_conflict', 'This requestId has a different bound payload. Read the existing job.')
    // Resume the original quote/plan, even after a price update or expiry. Never re-price a paid job.
    if (existing.mode !== adapter.mode) throw new LaunchError(409, 'mode_conflict', 'Cannot resume a job in a different execution mode.')
    return existing
  }
  return store.insert(createJob(request, adapter, now))
}

export async function runJob(store: JobStore, adapter: PromotionalTokenAdapter, id: Job['id'], payment?: SignedPayment, now: () => number = Date.now, afterBroadcast?: (step: string) => void): Promise<Job> {
  const owner = randomUUID()
  const job = store.claim(id, owner, now())
  try {
    if (job.mode !== adapter.mode) throw new LaunchError(409, 'mode_conflict', 'Adapter mode differs from the durable job.')
    if (job.adapterVersion !== adapter.version || hash(job.terms) !== hash(adapter.terms)) throw new LaunchError(409, 'adapter_conflict', 'Adapter version or payment configuration changed; reconcile with the original pinned configuration.')
    adapter.assertReady(job.request)
    if (job.state === 'complete') return job
    if (!job.payment) {
      if (!payment) throw new LaunchError(402, 'payment_required', 'Authorize the bound quote first.')
      // Only service.ts calls this with a verified signature. Persist it before external settlement.
      job.payment = payment
      store.save(job, owner, now())
    }
    job.state = 'running'; delete job.error; store.save(job, owner, now())
    for (const step of job.steps) {
      if (step.state === 'complete') continue
      if (!step.prepared) {
        step.prepared = await adapter.prepare({ job, step })
        if (step.prepared.operation !== hash([job.id, step.id])) throw new Error('Adapter returned an unbound operation')
        step.state = 'prepared'; store.save(job, owner, now())
      }
      let observed = await adapter.observe({ job, step }, step.prepared)
      if (observed === 'absent') {
        // Renew/fence before sending. A lost worker cannot generate or send fresh bytes.
        store.save(job, owner, now())
        if (step.kind === 'payment' && now() / 1000 >= job.request.quote.expires) throw new LaunchError(409, 'quote_expired', 'Unsettled authorization expired; do not charge or begin issuance.')
        await adapter.broadcast({ job, step }, step.prepared)
        afterBroadcast?.(step.id)
        observed = await adapter.observe({ job, step }, step.prepared)
      }
      if (observed === 'pending' || observed === 'absent') {
        job.state = 'partial'; job.error = `${step.id} awaits finalized evidence; no new effect was prepared.`
        store.save(job, owner, now()); return job
      }
      if (observed.operation !== step.prepared.operation || observed.finalized !== true || !/^(0|[1-9]\d*)$/.test(observed.cost)
        || BigInt(observed.cost) > BigInt(step.budget)) throw new Error('Finalized receipt violates its operation or budget')
      const destination = job.request.destinations.find((d) => d.chain === step.chain)!
      if (step.kind === 'canonical' && (observed.amount !== job.request.canonical.issuance || !observed.address)) throw new Error('Issuance receipt does not prove the bound supply/address')
      if (['debit', 'credit'].includes(step.kind) && observed.amount !== destination.amount) throw new Error('Transfer receipt amount differs from the bound allocation')
      if (step.kind === 'manager' && !observed.address) throw new Error('Manager address is missing')
      if (step.kind === 'pool' && (!observed.address || observed.amount !== destination.poolTokens || observed.quoteAmount !== destination.poolQuote)) throw new Error('Pool receipt does not prove the bound token/quote inventory')
      step.result = observed; step.state = 'complete'; store.save(job, owner, now())
    }
    job.state = 'complete'; store.save(job, owner, now()); return job
  } catch (cause) {
    job.state = job.steps.some((s) => s.state !== 'planned') ? 'partial' : 'awaiting_payment'
    job.error = cause instanceof Error ? cause.message : 'Job needs reconciliation'
    store.save(job, owner, now())
    throw cause
  } finally { store.release(id, owner) }
}

/** Free public projection. Payment signatures and prepared transaction bytes never leave the store. */
export function publicJob(job: Job) {
  const settled = job.steps[0].state === 'complete'
  const feesSpent = job.steps.filter((s) => s.kind !== 'payment').reduce((n, s) => n + BigInt(s.result?.cost ?? '0'), 0n)
  const feeCaptured = settled ? BigInt(job.steps[0].budget) : 0n
  const quoteDeployed = job.steps.filter((s) => s.kind === 'pool' && s.state === 'complete').reduce((n, s) => n + BigInt(job.request.destinations.find((d) => d.chain === s.chain)!.poolQuote), 0n)
  const unsettledEffects = job.steps.some((s) => s.state === 'prepared')
  const custody = job.steps.filter((s) => s.kind === 'debit' && s.state === 'complete').reduce((n, s) => n + BigInt(job.request.destinations.find((d) => d.chain === s.chain)!.amount), 0n)
  const remote = job.steps.filter((s) => s.kind === 'credit' && s.state === 'complete').reduce((n, s) => n + BigInt(job.request.destinations.find((d) => d.chain === s.chain)!.amount), 0n)
  const issued = job.steps.find((s) => s.kind === 'canonical')?.state === 'complete'
  return { id: job.id, mode: job.mode, state: job.state, error: job.error, payment: { settled, transaction: job.steps[0].result?.transaction ?? null, fulfillment: job.state === 'complete' ? 'complete' : 'incomplete' },
    funds: { paid: settled ? job.total : '0', platformFee: feeCaptured.toString(), feesSpent: feesSpent.toString(), quoteInventoryDeployed: quoteDeployed.toString(), unallocatedHeld: settled ? (BigInt(job.total) - feeCaptured - feesSpent - quoteDeployed).toString() : '0', refundable: false, note: 'Unallocated funds can include pending costs. Reconcile all submitted effects before a refund.' },
    supply: { evidence: unsettledEffects ? 'incomplete' : 'recorded_steps', issuance: issued ? job.request.canonical.issuance : '0', custody: custody.toString(), remote: remote.toString(), pending: (custody - remote).toString(), canonicalOutsideCustody: issued ? (BigInt(job.request.canonical.issuance) - custody).toString() : '0', reconciled: issued && !unsettledEffects },
    steps: job.steps.map(({ id, kind, chain, state, budget, result }) => ({ id, kind, chain, state, budget, result })) }
}
