import type { Address, Hex } from 'viem'

export const CHAINS = ['arc', 'base', 'solana', 'robinhood'] as const
export type Chain = typeof CHAINS[number]
export type Mode = 'local' | 'fork' | 'testnet' | 'live'
export type Atoms = string
export interface LaunchRequest {
  requestId: string
  payer: Address
  canonical: { chain: 'arc'; name: string; symbol: string; decimals: 6; issuance: Atoms; recipient: Address }
  destinations: { chain: Chain; recipient: string; amount: Atoms; poolTokens: Atoms; poolQuote: Atoms }[]
  quote: { expires: number; costCap: Atoms }
}
export type StepKind = 'payment' | 'canonical' | 'manager' | 'debit' | 'credit' | 'pool'
export interface Step {
  id: string
  kind: StepKind
  chain: Chain
  budget: Atoms
  state: 'planned' | 'prepared' | 'complete'
  prepared?: PreparedEffect
  /** A destination-side claim this step's effect produced but cannot deliver yet. */
  claim?: QueuedClaim
  result?: EffectResult
}
/**
 * A claim that exists on the destination chain, is addressed to this job's recipient, and that the
 * destination program will not release yet: a bridge's inbound rate limit, a queue, a timelock.
 *
 * It is neither a result nor an absence, and that is the whole reason it is recorded. An absence is
 * the runner's licence to submit, so a queued credit reported absent is a second allocation locked
 * or minted; a result would mark the allocation delivered while the recipient holds nothing. What is
 * true is that the launch holds an authenticated claim for a known amount, addressed to a known
 * account, releasable no earlier than a boundary the destination program itself wrote — so the
 * durable job records exactly that, survives a restart with it, and keeps the launch unfulfilled
 * until the claim is released.
 */
export interface QueuedClaim {
  /** The destination chain's own handle for the claim. Its replay guard is keyed by this. */
  reference: string
  /** The claim's amount, in the same six-decimal atoms as the bound allocation. */
  amount: Atoms
  /** The account the destination program will release to, as the claim itself records it. */
  recipient: string
  /** The earliest Unix second at which the destination program will release the claim. */
  releaseAfter: number
  /** The destination chain's own clock when the claim was last observed, never the host's. */
  observedClock: number
  /** When this job first recorded the claim, in Unix seconds. */
  queuedAt: number
  /** Set when the step carrying the claim completed, so the delay stays visible afterwards. */
  releasedAt?: number
}
/**
 * `observe`'s answer when the effect is on chain and held: the claim, not a result and not an
 * absence. The runner persists it, leaves the step prepared and leaves the job recoverable.
 */
export interface QueuedEffect { queued: QueuedClaim }
export type Observation = EffectResult | QueuedEffect | 'absent' | 'pending'
export function isQueued(observation: Observation): observation is QueuedEffect {
  return typeof observation === 'object' && 'queued' in observation
}
/**
 * Whether a freshly observed claim is the claim the job already recorded.
 *
 * The reference, the amount and the recipient are the claim's identity and must never move: a
 * second claim under the same step is either the same authenticated delivery or something this
 * launch did not ask for, and only the first is safe to go on waiting for. The boundary and the
 * observed clock do move — the clock with every read, and the boundary if the program requeues —
 * so they are reported rather than compared.
 */
export function claimConflict(recorded: QueuedClaim, observed: QueuedClaim): string | undefined {
  if (recorded.reference !== observed.reference) return `references ${observed.reference}, not the recorded ${recorded.reference}`
  if (recorded.amount !== observed.amount) return `carries ${observed.amount} atoms, not the recorded ${recorded.amount}`
  if (recorded.recipient !== observed.recipient) return `is addressed to ${observed.recipient}, not the recorded ${recorded.recipient}`
  return undefined
}
export interface PreparedEffect {
  operation: Hex
  digest: Hex
  /** Immutable signed bytes / provider idempotency key. Persist BEFORE any broadcast. */
  bytes: string
}
export interface EffectResult {
  operation: Hex
  transaction: string
  finalized: true
  cost: Atoms
  address?: string
  amount?: Atoms
  quoteAmount?: Atoms
}
export interface PaymentAuthorization {
  from: Address
  to: Address
  value: Atoms
  validAfter: Atoms
  validBefore: Atoms
  nonce: Hex
}
export interface SignedPayment { authorization: PaymentAuthorization; signature: Hex }
export interface PaymentTerms { chainId: number; asset: Address; payTo: Address; name: string; version: string }
/** Settlement evidence, recorded and readable independently of launch fulfillment. */
export interface Settlement {
  chainId: number
  asset: Address
  payer: Address
  payTo: Address
  /** The EIP-3009 authorization nonce. At most one settlement may ever exist for it. */
  nonce: Hex
  amount: Atoms
  transaction: string
  finalizedAt: number
}
export interface Job {
  id: Hex
  identity: Hex
  mode: Mode
  adapterVersion: string
  request: LaunchRequest
  terms: PaymentTerms
  total: Atoms
  payment?: SignedPayment
  /** Present only once the authorization settled with finalized evidence. */
  settlement?: Settlement
  steps: Step[]
  /**
   * Whether the unattended sweep may claim this job. A failure that submitted nothing — an
   * expired authorization, a route that closed before any effect went out — blocks it, so the
   * sweep cannot reclaim the same doomed job every tick. Progress makes it eligible again, and
   * an explicit client request always reaches the job directly regardless of this marker.
   */
  sweep: 'eligible' | 'blocked'
  state: 'awaiting_payment' | 'running' | 'partial' | 'complete'
  error?: string
  revision: number
  createdAt: number
}
/**
 * The durable contract the runner and service depend on. SQLite satisfies it for a single
 * host; a production deployment substitutes a transactional shared database implementing
 * the same revision fencing, renewable leases and settled-authorization uniqueness.
 */
export interface JobStorage {
  /** The lease this store grants. Workers derive their heartbeat interval from it. */
  readonly leaseMs: number
  get(id: string): Job | undefined
  insert(job: Job): Job
  claim(id: Hex, owner: string, now: number, duration?: number): Job
  /** Extend an owned lease without writing job data. Throws if the lease was lost. */
  renew(id: Hex, owner: string, now: number, duration?: number): void
  save(job: Job, owner: string, now: number): void
  release(id: string, owner: string): void
  list(limit?: number): Job[]
  /** Unleased, sweep-eligible jobs that are not terminal, so a restart resumes without a request. */
  resumable(now: number, limit?: number): Job[]
  /** Bind (chainId, asset, nonce) to this job before any settlement may be submitted. */
  reserveAuthorization(job: Job): void
  /** Record finalized settlement against the reserved authorization. Idempotent per job. */
  recordSettlement(settlement: Settlement, jobId: Hex): Settlement
  settlementOf(jobId: Hex): Settlement | undefined
}
export interface EffectContext { job: Job; step: Step }
export interface PromotionalTokenAdapter {
  readonly mode: Mode
  /** Pin both implementation and contract/peer configuration in real adapters. */
  readonly version: string
  readonly terms: PaymentTerms
  /** Check ALL selected routes, venue compatibility and authority before quoting/charging. */
  assertReady(request: LaunchRequest): void
  budgets(request: LaunchRequest): Record<StepKind, Atoms>
  prepare(context: EffectContext): Promise<PreparedEffect>
  /**
   * Read finalized chain/provider state. Unknown/pending is never treated as absence, and neither
   * is a claim the destination holds but will not release yet: that answer carries the claim.
   */
  observe(context: EffectContext, prepared: PreparedEffect): Promise<Observation>
  /** Resubmit identical persisted bytes only. No new tx nonce or deployment salt on retries. */
  broadcast(context: EffectContext, prepared: PreparedEffect): Promise<void>
}
export class LaunchError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}
