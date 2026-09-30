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
  result?: EffectResult
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
  get(id: string): Job | undefined
  insert(job: Job): Job
  claim(id: Hex, owner: string, now: number, duration?: number): Job
  /** Extend an owned lease without writing job data. Throws if the lease was lost. */
  renew(id: Hex, owner: string, now: number, duration?: number): void
  save(job: Job, owner: string, now: number): void
  release(id: string, owner: string): void
  list(limit?: number): Job[]
  /** Unleased jobs that are not terminal, so a restart can resume without a client request. */
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
  /** Read finalized chain/provider state. Unknown/pending is never treated as absence. */
  observe(context: EffectContext, prepared: PreparedEffect): Promise<EffectResult | 'absent' | 'pending'>
  /** Resubmit identical persisted bytes only. No new tx nonce or deployment salt on retries. */
  broadcast(context: EffectContext, prepared: PreparedEffect): Promise<void>
}
export class LaunchError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}
