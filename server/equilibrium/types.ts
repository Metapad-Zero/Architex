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
export interface Job {
  id: Hex
  identity: Hex
  mode: Mode
  adapterVersion: string
  request: LaunchRequest
  terms: PaymentTerms
  total: Atoms
  payment?: SignedPayment
  steps: Step[]
  state: 'awaiting_payment' | 'running' | 'partial' | 'complete'
  error?: string
  revision: number
  createdAt: number
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
