import { randomUUID } from 'node:crypto'
import type { Hex } from 'viem'
import { hash } from '../../request'
import { LaunchError } from '../../types'
import type { TransferStore } from './store'
import type { Transfer, TransferRoute } from './types'

/** Bind a transfer request durably. The same identity resumes; different content under it is refused. */
export async function createTransfer<R>(store: TransferStore, route: TransferRoute<R>, raw: unknown, now: number): Promise<Transfer<R>> {
  const request = route.parse(raw)
  const identity = route.identity(request)
  const existing = store.byIdentity(identity) as Transfer<R> | undefined
  if (existing) {
    if (hash(existing.request) !== hash(request)) throw new LaunchError(409, 'identity_conflict', 'This transfer identity is bound to a different request. Read the existing transfer.')
    if (existing.version !== route.version) throw new LaunchError(409, 'adapter_conflict', 'The transfer was bound under a different route configuration.')
    return existing
  }
  await route.assertAllowed(request)
  const steps = route.steps(request).map((s) => ({ ...s, state: 'planned' as const }))
  const id = hash({ version: 1, kind: route.kind, route: route.version, request, steps })
  return store.insert({ id, identity, kind: route.kind, version: route.version, request, steps, state: 'running', revision: 0, createdAt: now }) as Transfer<R>
}

/**
 * Drive a transfer to its finalized result, or to the first step that is still pending. Prepared
 * bytes are persisted before anything is sent, a pending effect is never treated as absent, and a
 * worker that lost its lease stops before it can send or record anything.
 */
export async function runTransfer<R>(store: TransferStore, route: TransferRoute<R>, id: Hex, now: () => number = Date.now, afterBroadcast?: (step: string) => void): Promise<Transfer<R>> {
  const owner = randomUUID()
  const t = store.claim(id, owner, now()) as Transfer<R>
  const save = () => store.save(t, owner, now())
  try {
    if (t.kind !== route.kind || t.version !== route.version) throw new LaunchError(409, 'adapter_conflict', 'Route configuration changed; resume with the configuration the transfer was bound under.')
    if (t.state === 'complete') return t
    await route.assertAllowed(t.request, t)
    t.state = 'running'; delete t.error; save()
    for (const step of t.steps) {
      if (step.state === 'complete') continue
      if (!step.prepared) {
        step.prepared = await route.prepare(t, step)
        if (step.prepared.operation !== hash([t.id, step.id])) throw new Error('Route returned an unbound operation')
        step.state = 'prepared'; save()
      }
      let observed = await route.observe(t, step, step.prepared)
      if (observed === 'absent') {
        save() // fence: a worker that lost the lease stops here, before sending
        await route.broadcast(t, step, step.prepared)
        afterBroadcast?.(step.id)
        observed = await route.observe(t, step, step.prepared)
      }
      if (observed === 'pending' || observed === 'absent') {
        t.state = 'partial'; t.error = `${step.id} awaits finalized evidence; nothing new was prepared.`
        save(); return t
      }
      if (observed.operation !== step.prepared.operation || observed.finalized !== true) throw new Error('Finalized result does not match its operation')
      route.validate(t, step, observed)
      step.result = observed; step.state = 'complete'; save()
    }
    t.state = 'complete'; save(); return t
  } catch (cause) {
    try { t.state = 'partial'; t.error = cause instanceof Error ? cause.message : 'Transfer needs reconciliation'; save() } catch { /* lease or revision gone */ }
    throw cause
  } finally { store.release(id, owner) }
}

/** Resume unfinished transfers of one route after a restart, without any client request. */
export async function reconcileTransfers<R>(store: TransferStore, route: TransferRoute<R>, now: () => number = Date.now) {
  const results: { id: Hex; state: Transfer['state']; error?: string }[] = []
  for (const t of store.resumable(now()).filter((x) => x.kind === route.kind)) {
    try {
      const done = await runTransfer(store, route, t.id, now)
      results.push({ id: done.id, state: done.state, error: done.error })
    } catch (cause) {
      results.push({ id: t.id, state: store.get(t.id)?.state ?? t.state, error: cause instanceof Error ? cause.message : 'Reconciliation failed' })
    }
  }
  return results
}

/** Free public projection: requests, results and costs; never prepared bytes or signed messages. */
export function publicTransfer(t: Transfer) {
  return { id: t.id, kind: t.kind, version: t.version, state: t.state, error: t.error, request: t.request,
    steps: t.steps.map(({ id, chain, state, result }) => ({ id, chain, state, result })) }
}
