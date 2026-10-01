/**
 * The seam between the durable launch job and the Arc–Solana bridge route.
 *
 * `scripts/solana/integrate.ts` established the route itself: an Anvil fork of Arc testnet carrying
 * the real deployed Wormhole core bridge with the pinned locking NTT manager on it, exchanging its
 * own published bytes with the pinned NTT programs on a local Solana validator, with both halves of
 * the ledger read from their own chain. It proved the route in one straight line of script calls.
 *
 * What it did not do is make a launch out of it. A launch is paid for once, resumes after a crash,
 * and must not debit or credit twice when a worker dies between submitting an effect and recording
 * it. That is what `server/equilibrium/runner.ts` provides for the local rehearsal adapter, and
 * what this module lets the real route provide.
 *
 * Everything here is pure: derivations, the immutable per-step plan, and the two-sided conservation
 * gate. Nothing opens a socket. `scripts/solana/fulfillRoute.ts` implements {@link SolanaRoute}
 * against the actual chains and `scripts/solana/fulfill.ts` drives the HTTP path over it.
 *
 * The one rule every plan here obeys: a step's plan is a function of the job alone, plus at most a
 * chain read that is recorded inside it. It is persisted before anything is submitted, so a restart
 * re-derives the same plan, looks for the same effect, and finds either that effect or nothing.
 */
import { PublicKey } from '@solana/web3.js'
import type { Address, Hex } from 'viem'
import { reconcileRoute, type ObservedRoute, type RouteReconciliation } from '../../src/lib/equilibriumArcSolana'
import { SOLANA_NTT } from '../../src/lib/equilibriumSolana'
import { hash } from './request'
import { LaunchError, type Atoms, type EffectContext, type Job, type LaunchRequest, type Observation, type PaymentTerms, type QueuedClaim, type Step, type StepKind } from './types'

/** The only two legs this route fulfils. Base and Robinhood are refused before a quote is priced. */
export const ROUTE_CHAINS = ['arc', 'solana'] as const

/* ------------------------------------------------------------------ deterministic addresses */

/**
 * Where a step places its inventory on Arc.
 *
 * Derived from the step's operation hash and nothing else, so the observation that decides whether
 * the placement already happened — the balance this address holds — is available to a worker that
 * has just restarted and holds no memory of the attempt. A contract would do the same job; an
 * address with no code does it without a deployment that could itself be half-finished.
 */
export function inventoryHolder(operation: Hex): Address {
  return `0x${operation.slice(-40)}`
}

/**
 * Where a step places its inventory on Solana: an address off the ed25519 curve.
 *
 * It has to be recoverable from the operation, because the balance it holds is how the observation
 * decides whether the placement already happened. It must equally be an address nobody can sign
 * for — including us. An earlier version derived an ed25519 keypair from the operation, which made
 * the holder's signing key a public function of the job id: the 402 response returns that job id,
 * so anyone who had merely asked for a quote could move the pool allocation afterwards.
 *
 * A program-derived address has no private key at all. Only the program it is derived from can act
 * for it, through `invoke_signed`, and only for seeds that program declares — the pinned NTT manager
 * declares `config`, `token_authority`, `peer`, `outbox_rate_limit` and friends, and nothing with
 * this prefix. So there is no signature for this account, and the balance is still a public read.
 */
export function solanaInventoryOwner(operation: Hex): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(INVENTORY_SEED_PREFIX, 'utf8'), Buffer.from(operation.slice(2), 'hex')],
    new PublicKey(SOLANA_NTT.manager),
  )[0]
}
/** Not a seed the pinned manager program declares, which is what makes the address unsignable. */
export const INVENTORY_SEED_PREFIX = 'equilibrium-inventory'

/* ------------------------------------------------------------------ per-step plans */

export interface PaymentPlan {
  kind: 'payment'
  asset: Address
  from: Address
  to: Address
  value: Atoms
  validAfter: Atoms
  validBefore: Atoms
  nonce: Hex
  signature: Hex
}
export interface CanonicalPlan {
  kind: 'canonical'
  /** The factory binds issuance parameters to this key on chain and refuses a conflicting reuse. */
  identity: Hex
  name: string
  symbol: string
  /**
   * The launch's own Arc account, not the customer's.
   *
   * A launch has to hold its supply to bridge it, place inventory out of it and deliver the rest;
   * it cannot move tokens that were minted straight to the customer. Each destination's recipient
   * receives its allocation from the inventory step, which is where the split is recorded.
   */
  custody: Address
  issuance: Atoms
}
export interface LegPlan {
  kind: 'leg'
  chain: 'arc' | 'solana'
  /** Registered on Arc / read from the manager config PDA on Solana once the leg is complete. */
  operation: Hex
  /**
   * The spoke mint's 32-byte secret, generated once when this step was prepared. Solana legs only.
   *
   * The mint address must be recoverable, or a restarted worker cannot tell a mint it has already
   * created from one it has not — and that is the condition under which a launch issues twice. It
   * must not be *predictable*, or anyone who saw the quote could create the mint first and choose
   * its authority. A random secret persisted in the step's plan is both: the plan is written to the
   * journal before anything is submitted, and `publicJob` never projects a step's prepared bytes.
   */
  mintSecret?: Hex
}
export interface DebitPlan {
  kind: 'debit'
  amount: Atoms
  /**
   * The Solana account the bridged allocation is credited to: the launch's own custody owner, in
   * base58. The NTT message carries this address, and the spoke will only release the mint to the
   * account the message named, so the split between pool inventory and the customer's share has to
   * happen after the credit rather than inside it.
   */
  custodian: string
  /** The customer's Solana address from the signed request, delivered by the inventory step. */
  beneficiary: string
  /**
   * The core bridge sequence this debit's message is expected to occupy, read from the emitter
   * before anything was submitted. The hub's `transfer` is not idempotent, so this is what makes
   * the effect findable afterwards: a restart looks for a published message at exactly this
   * sequence and checks its payload. An unpublished sequence means the debit never happened; a
   * sequence carrying a different payload means something else took it, and the step fails closed
   * rather than locking a second allocation.
   */
  expectedSequence: string
}
export interface CreditPlan {
  kind: 'credit'
  amount: Atoms
  custodian: string
  /** The NTT manager-message digest, which the spoke's inbox item and its replay guard are keyed by. */
  digest: Hex
  /** The Arc core-bridge sequence whose published bytes this credit delivers. */
  sequence: string
}
export interface InventoryPlan {
  kind: 'inventory'
  chain: 'arc' | 'solana'
  tokens: Atoms
  quote: Atoms
  /** EVM address or base58 owner of the two inventory accounts, derived from the operation. */
  holder: string
  /** The recipient from the signed request, and the part of the allocation it is owed. */
  recipient: string
  delivered: Atoms
}
export type StepPlan = PaymentPlan | CanonicalPlan | LegPlan | DebitPlan | CreditPlan | InventoryPlan

/**
 * The bytes persisted for a step before any effect is submitted, and the only thing a retry is
 * allowed to resubmit. `operation` is repeated inside them so a decoded plan can be checked against
 * the step it claims to belong to rather than trusted.
 */
export interface PreparedPlan {
  operation: Hex
  plan: StepPlan
}

export function encodePlan(operation: Hex, plan: StepPlan): string {
  return JSON.stringify({ operation, plan } satisfies PreparedPlan)
}
export function decodePlan(operation: Hex, bytes: string): StepPlan {
  let decoded: PreparedPlan
  try {
    decoded = JSON.parse(bytes) as PreparedPlan
  } catch {
    throw new Error('Persisted step plan is not readable; reconcile this job by hand before retrying.')
  }
  if (decoded?.operation !== operation) throw new Error('Persisted step plan belongs to a different operation')
  return decoded.plan
}

/**
 * Fields a plan RECORDS once rather than deriving: a chain read taken before submitting, or a secret
 * generated when the step was prepared. Re-deriving a plan produces a different value for each of
 * them, and the persisted one is always the authoritative one.
 */
const RECORDED_PLAN_FIELDS: Record<StepPlan['kind'], readonly string[]> = {
  payment: [], canonical: [], credit: [], inventory: [],
  leg: ['mintSecret'],
  debit: ['expectedSequence'],
}

/**
 * Whether a freshly derived plan is the same plan that was persisted, ignoring the recorded fields.
 *
 * This is what catches a route whose configuration moved between preparing a step and submitting it:
 * the persisted bytes are what gets submitted, so if the route would now plan something else, the
 * two disagree and the step must stop rather than send a different effect under a recorded operation.
 */
export function planMatches(derived: StepPlan, persisted: StepPlan): boolean {
  if (derived.kind !== persisted.kind) return false
  const strip = (plan: StepPlan) => {
    const copy: Record<string, unknown> = { ...plan }
    for (const field of RECORDED_PLAN_FIELDS[plan.kind]) delete copy[field]
    return hash(copy)
  }
  return strip(derived) === strip(persisted)
}

/* ------------------------------------------------------------------ the route */

/**
 * What durable fulfilment needs from the Arc–Solana route.
 *
 * `plan` and `observe` are the whole contract. `plan` must be derivable from the job; `observe`
 * must read finalized chain state and must never answer `absent` for an effect that is merely
 * unconfirmed — that answer is what authorizes a resubmission, so a pending transfer reported as
 * absent is a double debit. `pending` is the honest answer whenever the chain has not settled.
 */
export interface SolanaRoute {
  /** Pins implementation, program commits and the deployed addresses the plans resolve against. */
  readonly version: string
  readonly terms: PaymentTerms
  /** Refuse every unopened leg, missing authority or unpinned program before a quote is priced. */
  assertReady(request: LaunchRequest): void
  budgets(request: LaunchRequest): Record<StepKind, Atoms>
  plan(context: EffectContext): Promise<StepPlan>
  observe(context: EffectContext, plan: StepPlan): Promise<Observation>
  submit(context: EffectContext, plan: StepPlan): Promise<void>
  /**
   * Both halves of the ledger, each read from its own chain: Arc token supply and locking-manager
   * custody, SPL mint supply and the spoke's custody account. The two pending counters are supplied
   * by the caller from durable job state, because a message in flight is not a chain fact.
   */
  observeLedger(job: Job, pending: RoutePending): Promise<ObservedRoute>
}

export interface RoutePending { toSpoke: bigint; toHub: bigint }

/* ------------------------------------------------------------------ the spoke's inbound queue */

/** The pinned SVM manager's inbox item, as much of it as a credit observation depends on. */
export interface SpokeInboxItem {
  amount: bigint
  /** The owner the manager will release to, base58. */
  recipient: string
  status: 'not_approved' | 'release_after' | 'released'
  /** The boundary the manager wrote against the Clock sysvar, present only while delayed. */
  releaseAfter: bigint | null
}

/**
 * What a redeemed-but-undelivered spoke claim means for the durable job.
 *
 * The pinned manager keeps the queue inside the inbox item: a delivery over the peer's inbound rate
 * limit is approved with `ReleaseAfter(now + RATE_LIMIT_DURATION)` and `release_inbound_mint`
 * refuses until the Clock sysvar passes it. From outside, a claim held by that boundary and a claim
 * simply not released yet are the same account in two different states, and the difference decides
 * whether submitting is progress or a pointless refusal — so it is read from the boundary against
 * the chain's own clock, never the host's.
 *
 *  - no account                    the delivery never happened; the caller answers `absent`.
 *  - approved, boundary in future  queued: the claim is authenticated and this is what to record.
 *  - approved, boundary passed     releasable now; the caller answers `absent` so the runner submits.
 *  - released                      delivered; the caller reports the result.
 *
 * The amount and the recipient are checked against the bound allocation here rather than only on
 * release, because a claim addressed elsewhere is not something this launch should wait out.
 */
export function spokeClaim(plan: CreditPlan, item: SpokeInboxItem, chainClock: bigint, at: number): QueuedClaim | undefined {
  if (item.amount !== BigInt(plan.amount)) {
    throw new Error(`The spoke claim ${plan.digest} carries ${item.amount} atoms, not the bound allocation ${plan.amount}`)
  }
  if (item.recipient !== plan.custodian) {
    throw new Error(`The spoke claim ${plan.digest} is addressed to ${item.recipient}, not this launch's custody account ${plan.custodian}`)
  }
  if (item.status !== 'release_after' || item.releaseAfter === null) return undefined
  if (chainClock >= item.releaseAfter) return undefined
  return {
    reference: plan.digest, amount: plan.amount, recipient: plan.custodian,
    releaseAfter: Number(item.releaseAfter), observedClock: Number(chainClock), queuedAt: at,
  }
}

/* ------------------------------------------------------------------ the conservation gate */

/**
 * What the durable job asserts is in flight, derived from its own recorded steps.
 *
 * `completing` is the step about to be marked complete. Its effect is already on chain and already
 * visible to `observeLedger`, but the job has not recorded it yet, so the reconciliation would
 * otherwise be compared against a ledger one step in the future and fail for the wrong reason.
 */
export function routePending(job: Job, completing?: string): RoutePending {
  const done = (id: string) => job.steps.find((step) => step.id === id)?.state === 'complete' || id === completing
  let toSpoke = 0n
  for (const destination of job.request.destinations) {
    if (destination.chain === 'arc') continue
    // Locked on Arc and not yet minted on the spoke. The reverse direction is not something a
    // launch produces: nothing in a launch burns a representation to return it to the hub.
    if (done(`debit:${destination.chain}`) && !done(`credit:${destination.chain}`)) toSpoke += BigInt(destination.amount)
  }
  return { toSpoke, toHub: 0n }
}

/**
 * Claims this job holds and has not delivered, which is the subset of `toSpoke` with a reason.
 *
 * The conservation figure does not change when a credit is queued rather than merely unsubmitted —
 * either way the atoms are locked on Arc and not minted on the spoke — and that is the point: a
 * queue is not an accounting event. What it is is an explanation, so it is read off the job's own
 * recorded claims and reported next to the figure rather than folded into it.
 */
export function outstandingClaims(job: Job): (QueuedClaim & { step: string })[] {
  return job.steps.filter((step) => step.claim && step.state !== 'complete').map((step) => ({ step: step.id, ...step.claim! }))
}

/**
 * Whether the two independently observed ledgers can be compared yet.
 *
 * Before the canonical token exists there is no issuance to read, and before the spoke leg exists
 * there is no mint. Reconciling either against zero would pass trivially and prove nothing, so the
 * gate declares itself inapplicable instead of declaring success.
 */
export function ledgerComparable(job: Job, completing?: string): boolean {
  const done = (id: string) => job.steps.find((step) => step.id === id)?.state === 'complete' || id === completing
  return done('canonical:arc') && done('manager:solana')
}

export interface LedgerGate {
  compared: boolean
  observed?: ObservedRoute
  reconciliation?: RouteReconciliation
}

/**
 * Refuse to record a step whose effect leaves the two chains disagreeing.
 *
 * This is the point of connecting the launch to the observed route rather than to a model of it. A
 * debit that locked the wrong amount, a credit that minted more than the hub holds, or a mint whose
 * authority let someone else issue alongside the launch all show up here as a failed comparison
 * between two ledgers neither of which was calculated from the other — and the step is not recorded
 * complete, so nothing downstream treats the allocation as delivered.
 */
export async function gateLedger(route: SolanaRoute, job: Job, completing?: string): Promise<LedgerGate> {
  if (!ledgerComparable(job, completing)) return { compared: false }
  const observed = await route.observeLedger(job, routePending(job, completing))
  const reconciliation = reconcileRoute(observed)
  if (!reconciliation.ok) {
    throw new Error(
      `Observed Arc and Solana ledgers do not reconcile after ${completing ?? 'this step'}: `
      + `issuance ${observed.issuance}, hub circulating ${observed.hubCirculating}, hub custody ${observed.hubCustody}, `
      + `spoke supply ${observed.spokeSupply}, spoke custody ${observed.spokeCustody}, in flight ${observed.pendingToSpoke}`
      + ` (conserved ${reconciliation.conserved}, backed ${reconciliation.backed}, custody clean ${reconciliation.custodyClean})`,
    )
  }
  return { compared: true, observed, reconciliation }
}

/* ------------------------------------------------------------------ request admission */

/**
 * Refuse a request this route cannot fulfil, before a quote exists to be paid.
 *
 * Quoting a leg that is not open would take a payment for work the service knows it cannot do, and
 * `assertReady` runs again on every resumption, so a leg that closes after payment stops the job
 * rather than half-delivering it.
 */
export function assertRouteRequest(request: LaunchRequest): void {
  const unopened = request.destinations.filter((d) => !ROUTE_CHAINS.includes(d.chain as typeof ROUTE_CHAINS[number]))
  if (unopened.length) {
    throw new LaunchError(503, 'route_closed', `The Arc–Solana fulfilment route opens Arc and Solana only; ${unopened.map((d) => d.chain).join(', ')} ${unopened.length > 1 ? 'are' : 'is'} not part of it.`)
  }
  const solana = request.destinations.find((d) => d.chain === 'solana')
  if (!solana) throw new LaunchError(503, 'route_closed', 'This adapter fulfils the Arc–Solana route; select Solana as a destination.')
  // The pinned SVM manager keeps one config PDA per deployed program, so one program instance backs
  // exactly one mint. A second concurrent launch would have to share it, and sharing it is how two
  // issuances end up behind one set of custody figures.
  if (BigInt(solana.amount) > BigInt(request.canonical.issuance)) {
    throw new LaunchError(400, 'invalid_request', 'The Solana allocation exceeds the canonical issuance.')
  }
}

/** The step's operation hash, bound to the job and the step exactly as the runner requires. */
export function operationOf(job: Job, step: Step): Hex {
  return hash([job.id, step.id])
}
