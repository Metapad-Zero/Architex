import type { Address, Hex } from 'viem'
import type { Atoms, PreparedEffect } from '../../types'

/**
 * Operator transfers that move value after a launch: the Base→Arc return of EQUILIBRIUM (NTT burn
 * on Base, unlock from Arc custody) and the USDC quote-inventory refill (CCTP burn, attested mint).
 * They are separate from launch jobs: their own store rows, operation ids, gas caps and approval.
 */
export type TransferKind = 'return' | 'refill'
export type EvmChain = 'arc' | 'base'

export interface TransferStep {
  id: string
  chain: EvmChain
  state: 'planned' | 'prepared' | 'complete'
  prepared?: PreparedEffect
  result?: TransferResult
}
export interface TransferResult {
  operation: Hex
  transaction: Hex
  finalized: true
  /** Operator gas in USDC atoms; zero when someone else paid for the transaction. */
  cost: Atoms
  amount: Atoms
  /** Who submitted the transaction that produced the effect. */
  by: 'executor' | 'holder' | 'third-party'
  details?: Record<string, string>
}
export interface Transfer<R = unknown> {
  id: Hex
  identity: Hex
  kind: TransferKind
  version: string
  request: R
  steps: TransferStep[]
  state: 'running' | 'partial' | 'complete'
  error?: string
  revision: number
  createdAt: number
}

/** Return EQUILIBRIUM from Base to Arc. `launch` is the completed launch job whose contracts carry it. */
export type ReturnRequest =
  | { kind: 'return'; source: 'executor'; requestId: string; launch: Hex; amount: Atoms; recipient: Address }
  | { kind: 'return'; source: 'holder'; launch: Hex; transaction: Hex }

/** Move USDC quote inventory between the executors with CCTP V2 standard (hard-finality) transfers. */
export interface RefillRequest { kind: 'refill'; requestId: string; from: EvmChain; to: EvmChain; amount: Atoms; maxFee: Atoms }

/** One route implementation. Every effect is one executor operation, or an observation of someone else's. */
export interface TransferRoute<R> {
  readonly kind: TransferKind
  readonly version: string
  parse(raw: unknown): R
  identity(request: R): Hex
  steps(request: R): { id: string; chain: EvmChain }[]
  /** Caps, closed rails and prerequisites, checked before a transfer is created and before each run. */
  assertAllowed(request: R, existing?: Transfer<R>): Promise<void>
  prepare(transfer: Transfer<R>, step: TransferStep): Promise<PreparedEffect>
  observe(transfer: Transfer<R>, step: TransferStep, prepared: PreparedEffect): Promise<TransferResult | 'absent' | 'pending'>
  broadcast(transfer: Transfer<R>, step: TransferStep, prepared: PreparedEffect): Promise<void>
  /** Throws unless the finalized result proves exactly the bound effect. */
  validate(transfer: Transfer<R>, step: TransferStep, result: TransferResult): void
}
