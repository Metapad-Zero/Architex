import { randomUUID } from 'node:crypto'
import type { Hex } from 'viem'
import { hash, identity, parseRequest, createJob } from './request'
import {
  LaunchError, claimConflict, isQueued,
  type Job, type JobStorage, type PromotionalTokenAdapter, type QueuedClaim, type Settlement,
  type SignedPayment, type Step,
} from './types'

export function quote(store: JobStorage, adapter: PromotionalTokenAdapter, raw: unknown, now: number): Job {
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

/**
 * Keep an owned lease alive while an adapter call is still outstanding. Without it a chain or
 * provider call slower than the lease silently loses ownership and the effect it submitted
 * can no longer be recorded by the worker that produced it.
 */
function heartbeat(store: JobStorage, id: Hex, owner: string, now: () => number, intervalMs: number) {
  let lost: Error | undefined
  const timer = setInterval(() => {
    try { store.renew(id, owner, now()) } catch (cause) {
      lost = cause instanceof Error ? cause : new LaunchError(409, 'stale_worker', 'Lease renewal failed.')
      clearInterval(timer)
    }
  }, intervalMs)
  timer.unref?.()
  return {
    stop() { clearInterval(timer) },
    /** Refuse to submit or record anything once the lease is provably gone. */
    check() { if (lost) throw lost },
  }
}

/**
 * Bind a claim the destination holds but will not release yet onto the step that produced it.
 *
 * The claim is the only durable record that the effect landed, so it is written before the job is
 * reported back and it is compared against whatever the next observation finds. A claim whose
 * reference, amount or recipient moved is not this launch's delivery, and the step fails closed
 * rather than keeping a different claim's company until it releases; the boundary and the observed
 * clock are expected to move and are recorded rather than compared. `queuedAt` is kept from the
 * first sighting, because the point of the figure is how long this launch has been waiting.
 */
function bindClaim(step: Step, observed: QueuedClaim): QueuedClaim {
  const recorded = step.claim
  if (!recorded) return observed
  const conflict = claimConflict(recorded, observed)
  if (conflict) throw new Error(`The claim now held for ${step.id} ${conflict}; reconcile this job before releasing anything`)
  return { ...observed, queuedAt: recorded.queuedAt }
}

/** A lane that cannot progress on this attempt for a reason the next attempt can observe past. */
class Deferral extends Error {}

const firstLine = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).split('\n')[0]

/**
 * Whether a failure is the chain being unreachable rather than anything about the job: a refused
 * connection, a dropped socket or a request that timed out. Integrity failures — a conflicting
 * operation, a receipt that does not prove its allocation, ledgers that do not reconcile — are
 * never this, and still stop the whole job.
 */
export function unavailable(cause: unknown): boolean {
  if (cause instanceof LaunchError) return false
  const seen = new Set<unknown>()
  for (let at: unknown = cause; at && !seen.has(at); at = (at as { cause?: unknown }).cause) {
    seen.add(at)
    const name = (at as { name?: string }).name ?? ''
    const text = `${name} ${(at as { message?: string }).message ?? ''} ${(at as { code?: string }).code ?? ''}`
    if (/HttpRequestError|TimeoutError|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|fetch failed|Unable to connect|ConnectionRefused|took too long to respond/i.test(text)) return true
  }
  return false
}

/** Settlement evidence is derived from the finalized payment receipt, never from the request. */
function settlementOf(job: Job, step: Step, finalizedAt: number): Settlement {
  const authorization = job.payment!.authorization
  return { chainId: job.terms.chainId, asset: job.terms.asset, payer: job.request.payer, payTo: job.terms.payTo,
    nonce: authorization.nonce, amount: step.result!.amount!, transaction: step.result!.transaction, finalizedAt }
}

export async function runJob(store: JobStorage, adapter: PromotionalTokenAdapter, id: Job['id'], payment?: SignedPayment, now: () => number = Date.now, afterBroadcast?: (step: string) => void, options: { leaseMs?: number; heartbeatMs?: number } = {}): Promise<Job> {
  const owner = randomUUID()
  const leaseMs = options.leaseMs ?? store.leaseMs
  const job = store.claim(id, owner, now(), leaseMs)
  // The heartbeat must fire at least twice within a lease. A requested interval longer than the
  // lease would let a slow call outlive its ownership, so it is clamped rather than honoured.
  const beat = heartbeat(store, id, owner, now, Math.max(1, Math.min(options.heartbeatMs ?? 10_000, Math.floor(leaseMs / 2))))
  /**
   * Whether the step being worked on put anything on the wire. Decides if the sweep may try
   * again: a step that failed before submitting will fail the same way unattended, while one
   * that failed after submitting leaves an effect a retry can observe and move past.
   */
  let stepSubmitted = false
  /** Re-fence immediately before an irreversible external call. A lapsed lease must not reach it. */
  const fence = () => { beat.check(); store.renew(id, owner, now(), leaseMs); beat.check() }
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
    // Claim the authorization nonce durably before the payment step can submit anything. One
    // authorization settles at most once, even across a restored or duplicated job row.
    store.reserveAuthorization(job)
    job.state = 'running'; delete job.error; store.save(job, owner, now())
    /**
     * Spoke lanes this attempt has set aside, with the reason. Every spoke's steps depend on the Arc
     * steps before them and on nothing in another spoke, so a spoke whose destination holds a claim,
     * has not finalized, or cannot be reached defers only its own remaining steps: the other spokes
     * are still worked, and the job stays partial and sweep-eligible until every lane completes.
     * An Arc step never defers, because every lane depends on it.
     */
    const deferred = new Map<string, string>()
    for (const step of job.steps) {
      if (step.state === 'complete') continue
      const lane = step.chain === 'arc' ? undefined : step.chain
      if (lane && deferred.has(lane)) continue
      stepSubmitted = false
      try {
        if (!step.prepared) {
          step.prepared = await adapter.prepare({ job, step })
          beat.check()
          if (step.prepared.operation !== hash([job.id, step.id])) throw new Error('Adapter returned an unbound operation')
          step.state = 'prepared'; store.save(job, owner, now())
        }
        /**
         * A claim the destination holds and will not release yet. Recorded, and then its lane stops:
         * nothing is submitted — the effect already landed — and nothing is completed, because the
         * recipient holds nothing. The sweep keeps the job because there is something new to observe
         * when the boundary passes, which is the one case where retrying unattended is progress.
         */
        const held = (claim: QueuedClaim): string => {
          step.claim = bindClaim(step, claim)
          job.sweep = 'eligible'
          store.save(job, owner, now())
          return `${step.id} holds a claim of ${step.claim.amount} atoms for ${step.claim.recipient}, releasable no earlier than ${step.claim.releaseAfter} on the destination chain's own clock (last read ${step.claim.observedClock}); no new effect was prepared.`
        }
        let observed = await adapter.observe({ job, step }, step.prepared)
        beat.check()
        if (isQueued(observed)) throw new Deferral(held(observed.queued))
        if (observed === 'absent') {
          // Renew/fence before sending. A lost worker cannot generate or send fresh bytes.
          store.save(job, owner, now())
          if (step.kind === 'payment' && now() / 1000 >= job.request.quote.expires) throw new LaunchError(409, 'quote_expired', 'Unsettled authorization expired; do not charge or begin issuance.')
          fence()
          await adapter.broadcast({ job, step }, step.prepared)
          stepSubmitted = true; job.sweep = 'eligible'
          afterBroadcast?.(step.id)
          observed = await adapter.observe({ job, step }, step.prepared)
          beat.check()
          if (isQueued(observed)) throw new Deferral(held(observed.queued))
        }
        if (observed === 'pending' || observed === 'absent') throw new Deferral(`${step.id} awaits finalized evidence; no new effect was prepared.`)
        if (observed.operation !== step.prepared.operation || observed.finalized !== true || !/^(0|[1-9]\d*)$/.test(observed.cost)
          || BigInt(observed.cost) > BigInt(step.budget)) throw new Error('Finalized receipt violates its operation or budget')
        const destination = job.request.destinations.find((d) => d.chain === step.chain)!
        // A settlement receipt must prove the authorized amount moved, not merely that a transaction exists.
        if (step.kind === 'payment' && (observed.amount !== job.total || !observed.transaction)) throw new Error('Settlement receipt does not prove the authorized amount was transferred')
        if (step.kind === 'canonical' && (observed.amount !== job.request.canonical.issuance || !observed.address)) throw new Error('Issuance receipt does not prove the bound supply/address')
        if (['debit', 'credit'].includes(step.kind) && observed.amount !== destination.amount) throw new Error('Transfer receipt amount differs from the bound allocation')
        if (step.kind === 'manager' && !observed.address) throw new Error('Manager address is missing')
        if (step.kind === 'pool' && (!observed.address || observed.amount !== destination.poolTokens || observed.quoteAmount !== destination.poolQuote)) throw new Error('Pool receipt does not prove the bound token/quote inventory')
        // A delivery that was queued keeps its claim, stamped with the release. The delay is part of
        // what the customer was told happened, and it is gone from the chain once the claim releases.
        if (step.claim) step.claim = { ...step.claim, releasedAt: Math.floor(now() / 1000) }
        step.result = observed; step.state = 'complete'; job.sweep = 'eligible'
        // Settlement is recorded against the reservation and readable on its own, before fulfillment.
        if (step.kind === 'payment') { fence(); job.settlement = store.recordSettlement(settlementOf(job, step, Math.floor(now() / 1000)), job.id) }
        store.save(job, owner, now())
      } catch (cause) {
        // A held claim or unfinalized effect on the Arc lane stops the job: every lane depends on it.
        if (cause instanceof Deferral && !lane) {
          job.state = 'partial'; job.error = cause.message; store.save(job, owner, now()); return job
        }
        if (lane && (cause instanceof Deferral || unavailable(cause))) {
          deferred.set(lane, cause instanceof Deferral ? cause.message : `${step.id} could not reach its chain (${firstLine(cause)}); the ${lane} lane is deferred and nothing else was skipped.`)
          // An unreachable chain is retried unattended: the next attempt observes before submitting anything.
          job.sweep = 'eligible'
          continue
        }
        throw cause
      }
    }
    if (deferred.size) {
      job.state = 'partial'; job.error = [...deferred.values()].join(' ')
      store.save(job, owner, now()); return job
    }
    job.state = 'complete'; delete job.error; store.save(job, owner, now()); return job
  } catch (cause) {
    try {
      // A held authorization is never reported back as awaiting payment.
      job.state = job.payment || job.steps.some((s) => s.state !== 'planned') ? 'partial' : 'awaiting_payment'
      job.error = cause instanceof Error ? cause.message : 'Job needs reconciliation'
      // Nothing went out on this attempt, so repeating it unattended would only repeat the
      // failure. An expired authorization or a route that closed first stays out of the sweep
      // until progress or an explicit request revisits the job.
      if (!stepSubmitted) job.sweep = 'blocked'
      store.save(job, owner, now())
    } catch { /* The lease or revision is gone; the durable job keeps its last persisted state. */ }
    throw cause
  } finally { beat.stop(); store.release(id, owner) }
}

/**
 * Finish jobs whose worker died: an authorization is already held and no live lease owns them.
 * Recovery must not depend on a client re-sending the request that started the launch.
 */
export async function reconcile(store: JobStorage, adapter: PromotionalTokenAdapter, now: () => number = Date.now, limit = 20): Promise<{ id: Hex; state: Job['state']; error?: string }[]> {
  const results: { id: Hex; state: Job['state']; error?: string }[] = []
  for (const stale of store.resumable(now(), limit)) {
    try {
      const result = await runJob(store, adapter, stale.id, undefined, now)
      results.push({ id: result.id, state: result.state, error: result.error })
    } catch (cause) {
      const current = store.get(stale.id)
      results.push({ id: stale.id, state: current?.state ?? stale.state, error: cause instanceof Error ? cause.message : 'Reconciliation failed' })
    }
  }
  return results
}

/** Free public projection. Payment signatures and prepared transaction bytes never leave the store. */
export function publicJob(job: Job) {
  const settled = job.steps[0].state === 'complete'
  const feesSpent = job.steps.filter((s) => s.kind !== 'payment').reduce((n, s) => n + BigInt(s.result?.cost ?? '0'), 0n)
  const feeCaptured = settled ? BigInt(job.steps[0].budget) : 0n
  const quoteDeployed = job.steps.filter((s) => s.kind === 'pool' && s.state === 'complete').reduce((n, s) => n + BigInt(job.request.destinations.find((d) => d.chain === s.chain)!.poolQuote), 0n)
  const unsettledEffects = job.steps.filter((s) => s.state === 'prepared').map((s) => s.id)
  const custody = job.steps.filter((s) => s.kind === 'debit' && s.state === 'complete').reduce((n, s) => n + BigInt(job.request.destinations.find((d) => d.chain === s.chain)!.amount), 0n)
  const remote = job.steps.filter((s) => s.kind === 'credit' && s.state === 'complete').reduce((n, s) => n + BigInt(job.request.destinations.find((d) => d.chain === s.chain)!.amount), 0n)
  const issued = job.steps.find((s) => s.kind === 'canonical')?.state === 'complete'
  /**
   * Claims the destination holds but has not released. Projected so the free record can say why a
   * paid launch is not finished yet and when it can be: the alternative is an unexplained partial
   * job, which looks the same as a lost one to the customer reading it.
   */
  const claims = job.steps.filter((s) => s.claim).map((s) => ({ step: s.id, chain: s.chain, ...s.claim!, released: s.state === 'complete' }))
  const queued = claims.filter((claim) => !claim.released).reduce((n, claim) => n + BigInt(claim.amount), 0n)
  const unallocated = settled ? BigInt(job.total) - feeCaptured - feesSpent - quoteDeployed : 0n
  // Unspent funds are a determinate figure only once every submitted effect resolved. While an
  // operation is outstanding its cost may already be spent, so no refund may be decided from it.
  const determinate = settled && unsettledEffects.length === 0
  const refundable = determinate && job.state !== 'complete' && unallocated > 0n
  return { id: job.id, mode: job.mode, state: job.state, error: job.error,
    payment: { settled, transaction: job.steps[0].result?.transaction ?? null, fulfillment: job.state === 'complete' ? 'complete' : 'incomplete' },
    // Settlement is inspectable on its own: it proves the charge, not the launch.
    settlement: job.settlement ? { ...job.settlement, fulfillment: job.state === 'complete' ? 'complete' : 'incomplete' } : null,
    funds: { paid: settled ? job.total : '0', platformFee: feeCaptured.toString(), feesSpent: feesSpent.toString(), quoteInventoryDeployed: quoteDeployed.toString(), unallocatedHeld: unallocated.toString(),
      determinate, refundable, refundableAmount: refundable ? unallocated.toString() : '0', unresolvedEffects: unsettledEffects,
      note: determinate ? 'Every submitted effect resolved, so the unspent remainder is final.' : 'Unallocated funds can include pending costs. Reconcile all submitted effects before a refund.' },
    // An authenticated claim the destination will not release yet. Part of `pending`, with a reason
    // and a release boundary attached, so a waiting launch is distinguishable from a stuck one.
    claims,
    supply: { evidence: unsettledEffects.length ? 'incomplete' : 'recorded_steps', issuance: issued ? job.request.canonical.issuance : '0', custody: custody.toString(), remote: remote.toString(), pending: (custody - remote).toString(), queued: queued.toString(), canonicalOutsideCustody: issued ? (BigInt(job.request.canonical.issuance) - custody).toString() : '0', reconciled: issued && !unsettledEffects.length },
    steps: job.steps.map(({ id, kind, chain, state, budget, claim, result }) => ({ id, kind, chain, state, budget, claim, result })) }
}
