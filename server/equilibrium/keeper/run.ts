/**
 * The keeper's own loop. Reconcile first, then one cycle per tick at most, then stop on the first
 * condition the policy says is a stop condition. It never runs a second cycle over an unresolved
 * position, and it never widens a limit to keep going.
 */
import type { KeeperHandle } from './keeper'
import type { KeeperStore } from './store'
import { KeeperError, type CycleRecord, type KeeperDecision } from './types'

export interface TickOutcome {
  at: number
  /** The cycle this tick ran, if any. */
  cycle: CycleRecord | null
  decision: KeeperDecision | null
  /** Cycles a reconcile resolved or halted on this tick. */
  reconciled: string[]
  /** Set when the loop must stop rather than wait for the next tick. */
  stop: string | null
}

/** Reasons the keeper stops the session rather than waiting for the next tick. */
const STOPS = new Set(['halted', 'unresolved_exposure', 'loss_cap', 'not_approved', 'invalid_configuration'])

export async function tick(keeper: KeeperHandle, store: KeeperStore, tokens: bigint): Promise<TickOutcome> {
  const at = Math.floor(Date.now() / 1000)
  const reconciled = (await keeper.reconcile()).map((cycle) => cycle.id)
  if (store.unresolved().length) {
    return { at, cycle: null, decision: null, reconciled, stop: `Unresolved exposure: ${store.unresolved().map((c) => c.id).join(', ')}. Recover it before the keeper runs again.` }
  }
  const { decision } = await keeper.consider(tokens)
  if (!decision.candidate) {
    return { at, cycle: null, decision, reconciled, stop: STOPS.has(decision.reason) ? decision.detail : null }
  }
  try {
    const cycle = await keeper.runCycle(tokens)
    return { at, cycle, decision, reconciled, stop: null }
  } catch (cause) {
    const reason = cause instanceof KeeperError ? cause.reason : 'leg_failed'
    const detail = cause instanceof Error ? cause.message : String(cause)
    return { at, cycle: null, decision, reconciled, stop: STOPS.has(reason) || reason === 'leg_failed' ? detail : null }
  }
}

export interface SessionResult { ticks: TickOutcome[]; stopped: string | null }

/** Run until a stop condition, `maxTicks`, or no opportunity for `idleTicks` consecutive ticks. */
export async function session(
  keeper: KeeperHandle, store: KeeperStore, tokens: bigint,
  options: { maxTicks?: number; idleTicks?: number; intervalMs?: number; onTick?: (outcome: TickOutcome) => void } = {},
): Promise<SessionResult> {
  const maxTicks = options.maxTicks ?? 1
  const idleLimit = options.idleTicks ?? Number.POSITIVE_INFINITY
  const ticks: TickOutcome[] = []
  let idle = 0
  for (let index = 0; index < maxTicks; index++) {
    const outcome = await tick(keeper, store, tokens)
    ticks.push(outcome)
    options.onTick?.(outcome)
    if (outcome.stop) return { ticks, stopped: outcome.stop }
    idle = outcome.cycle ? 0 : idle + 1
    if (idle >= idleLimit) return { ticks, stopped: `No executable cycle for ${idle} consecutive ticks.` }
    if (index + 1 < maxTicks && options.intervalMs) await new Promise((resolve) => setTimeout(resolve, options.intervalMs))
  }
  return { ticks, stopped: null }
}
