/**
 * The durable launch adapter for the Arc–Solana route.
 *
 * `localAdapter` satisfies the same interface with synthetic effects in the job database: it is what
 * proved the runner's payment, restart and idempotency behaviour without a chain. This adapter
 * satisfies it against a {@link SolanaRoute} whose effects are real transactions on an Arc fork and
 * a Solana validator, and whose observations are reads of those two chains.
 *
 * Its job is narrow and worth stating exactly, because the interesting failures all live here:
 *
 *  - Never answer `absent` for an effect that might have landed. `absent` is the runner's licence to
 *    submit, so a debit reported absent while its transfer is unconfirmed is a second lock of the
 *    same allocation. Anything the route cannot resolve is `pending`, which stops the job instead.
 *  - Never submit anything but the bytes that were persisted. Each plan is re-derived at submit time
 *    and checked against the persisted one, so a route whose configuration moved between the two
 *    fails rather than sending a different effect under a recorded operation.
 *  - Never record a step whose effect left the two chains disagreeing. Every observation that would
 *    complete a step past the point where both ledgers exist is gated on the two of them
 *    reconciling, each read from its own chain.
 */
import { assertRouteRequest, decodePlan, encodePlan, gateLedger, operationOf, type SolanaRoute, type StepPlan } from './solanaRoute'
import { hash } from './request'
import { LaunchError, type EffectContext, type EffectResult, type PreparedEffect, type PromotionalTokenAdapter, type Mode } from './types'

/** Steps whose completion is only accepted when both observed ledgers reconcile. */
const LEDGER_GATED = ['canonical', 'manager', 'debit', 'credit', 'pool']

export interface SolanaAdapterOptions {
  /**
   * Steps the route must report as unresolved rather than settled, whatever the chain says. The
   * harness uses it to hold a step in flight and leave the job recoverable, which is the state a
   * crashed worker actually leaves behind.
   */
  pending?: Set<string>
  /** Steps whose submission must fail. The harness uses it to exercise recovery, not to skip work. */
  unavailable?: Set<string>
  mode?: Mode
}

export function solanaAdapter(route: SolanaRoute, options: SolanaAdapterOptions = {}): PromotionalTokenAdapter {
  const pending = options.pending ?? new Set<string>()
  const unavailable = options.unavailable ?? new Set<string>()

  /**
   * The plan for a step, re-derived and checked against what was persisted.
   *
   * The runner persists `prepared.bytes` before the first submission and hands the same bytes to
   * every retry. Re-deriving lets a changed route be caught: the persisted plan is what gets
   * submitted, and if the route would now plan something else then the two disagree and the step
   * stops. The one field allowed to differ is a recorded chain read, which is why the comparison is
   * on the fields the job determines rather than on the whole object.
   */
  const reconcilePlan = async (context: EffectContext, persisted: StepPlan): Promise<StepPlan> => {
    const derived = await route.plan(context)
    if (derived.kind !== persisted.kind) {
      throw new Error(`Persisted ${persisted.kind} plan for ${context.step.id} no longer matches the route, which now plans ${derived.kind}`)
    }
    // A chain read recorded inside the plan is expected to be stale; everything the job determines
    // is not. `expectedSequence` is the only such field, and the persisted one is authoritative.
    if (persisted.kind === 'debit' && derived.kind === 'debit') {
      if (persisted.amount !== derived.amount || persisted.custodian !== derived.custodian || persisted.beneficiary !== derived.beneficiary) {
        throw new Error('Persisted debit plan does not match the bound allocation')
      }
      return persisted
    }
    if (hash(derived) !== hash(persisted)) {
      throw new Error(`Persisted plan for ${context.step.id} differs from the plan this route derives now; reconcile against the original pinned configuration`)
    }
    return persisted
  }

  return {
    mode: options.mode ?? 'local',
    version: route.version,
    terms: route.terms,

    assertReady(request) {
      assertRouteRequest(request)
      route.assertReady(request)
    },

    budgets: (request) => route.budgets(request),

    async prepare(context: EffectContext): Promise<PreparedEffect> {
      const operation = operationOf(context.job, context.step)
      const plan = await route.plan(context)
      const bytes = encodePlan(operation, plan)
      return { operation, digest: hash(bytes), bytes }
    },

    async observe(context: EffectContext, prepared: PreparedEffect): Promise<EffectResult | 'absent' | 'pending'> {
      const plan = decodePlan(prepared.operation, prepared.bytes)
      const observed = await route.observe(context, plan)
      // Held deliberately. Reported before the chain is consulted for a verdict, so a harness case
      // cannot accidentally depend on the effect having settled first.
      if (pending.has(context.step.id) && observed !== 'absent') return 'pending'
      if (observed === 'absent' || observed === 'pending') return observed
      if (observed.operation !== prepared.operation) {
        throw new Error(`${context.step.id} observed an effect bound to a different operation`)
      }
      if (LEDGER_GATED.includes(context.step.kind)) await gateLedger(route, context.job, context.step.id)
      return observed
    },

    async broadcast(context: EffectContext, prepared: PreparedEffect): Promise<void> {
      if (unavailable.has(context.step.id)) {
        throw new Error(`${context.step.id} is unavailable on this route; existing work is preserved for reconciliation`)
      }
      if (hash(prepared.bytes) !== prepared.digest) throw new Error('Prepared bytes do not match their persisted digest')
      if (prepared.operation !== operationOf(context.job, context.step)) throw new Error('Prepared operation is not bound to this job step')
      const persisted = decodePlan(prepared.operation, prepared.bytes)
      await route.submit(context, await reconcilePlan(context, persisted))
    },
  }
}

/**
 * The Arc–Solana route with nothing configured: every call refuses.
 *
 * A launch service that has not been handed a live route must not quote one. Returning this rather
 * than `undefined` keeps the refusal a single explicit code path with a reason attached, instead of
 * a missing-adapter crash somewhere inside the runner.
 */
export function closedSolanaRoute(mode: Mode = 'testnet'): PromotionalTokenAdapter {
  const refuse = (): never => {
    throw new LaunchError(503, 'route_closed', 'No Arc–Solana route is configured for this service: no deployed canonical token, locking manager, transceiver peer or spoke mint, and no approved budget. Bring one up with scripts/solana/fulfill.ts.')
  }
  return {
    mode,
    version: 'arc-solana-unconfigured-closed-v1',
    // Arc testnet's USDC address and the zero payee: a closed route must not name a payable destination.
    terms: { chainId: 5042002, asset: '0x3600000000000000000000000000000000000000', payTo: '0x0000000000000000000000000000000000000000', name: 'USDC', version: '2' },
    assertReady: refuse, budgets: refuse, prepare: refuse, observe: refuse, broadcast: refuse,
  }
}
