import type { Database } from 'bun:sqlite'
import {
  BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, createPublicClient, createWalletClient, decodeEventLog, decodeFunctionData, defineChain, encodeAbiParameters, encodeFunctionData, getAddress,
  http, parseAbi, parseSignature, zeroAddress, type Address, type Hex, type PublicClient, type TransactionReceipt, type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { PublicKey } from '@solana/web3.js'
import { hash, identity } from '../request'
import { migrateSchema } from '../store'
import { publicJob } from '../runner'
import { LaunchError, type Atoms, type EffectContext, type EffectResult, type Job, type LaunchRequest, type PreparedEffect, type PromotionalTokenAdapter, type Step, type StepKind } from '../types'
import {
  CODE, NTT_COMMIT, architexFactoryAbi, architexPairAbi, coreAbi, erc20Abi, executorAbi, linked, nttAbi, predict, proxyInit, spokeAbi, transceiverAbi,
  universal, usdcAbi, v3FactoryAbi, v3PoolAbi, withArgs,
} from '../evm/contracts'
import { weiOf } from '../evm/adapter'
import { plan as v3Plan } from '../evm/v3'
import { publishedFrom, type Published, type VaaSource } from '../evm/vaa'
import { hubPeers, solanaSpoke, type SolanaPlan, type SolanaSpokeConfig } from './solana'

/**
 * FORK-ONLY composition of the Arc–Base adapter (PR #12) and the Robinhood fulfillment (PR #18) into
 * ONE paid launch job: one x402 payment and one canonical issuance on Arc, a single Arc locking hub
 * peered to BOTH a Base burning spoke and a Robinhood burning spoke, one outbound transfer and one
 * pool per spoke. Neither source adapter can do this alone: #12 peers its hub to Base only and #18
 * adopts a hub peered to Robinhood only, and their address layouts differ, so dispatching steps to
 * them would issue two assets. This module plans the combined layout itself and reuses their pinned
 * bytecode, ABIs, VAA and v3 helpers unchanged.
 *
 * Idempotency is the executors', as in both sources: each step is one
 * `EquilibriumExecutor.execute(operation, digest, calls)` with `operation = hash([job.id, step.id])`,
 * and a second execution reverts `OperationDone`. A stale worker, a restart or a replayed
 * transaction can only waste its own gas.
 *
 * Launch slots carry #12's one-launch scope and #18's release rule together: with `launches` set, at
 * most that many jobs may hold a payment authorization at once, and a slot moves to another job only
 * once chain state proves the holder's payment can never settle. A released job is refused for good.
 *
 * Money follows #18's correction (22adede). A spent nonce is attributed only from the finalized
 * transaction that spent it; whatever reached the Arc executor is recorded against the ORIGINAL job
 * in multispoke_payment_ledger in the same transaction as the release, and stays reserved for it.
 * Every Arc send that moves executor USDC (a job's Arc pool, a refund, an operator send) first takes a
 * durable claim in the shared journal and checks the executor's final balance against owed residuals
 * and other unfinished claims, so no successor, operator or other process can spend a residual. Only
 * `refund` moves a residual, back to its payer, as one executor operation that executes at most once.
 * `usdcAccount` reconciles a completed job's Arc USDC: what came in, what actually left, and what is
 * held, separating the spoke quote inventory injected on the spokes, the platform fee and the
 * operator's native gas from USDC actually spent.
 *
 * With `solana` configured (49TH-44) the same hub is also peered to the pinned SVM NTT manager on a
 * local validator, and the job has a fourth lane: `debit:solana` is an Arc executor operation like
 * the other debits, and the Solana half of `manager`, `credit` and `pool` is ./solana.ts. The job
 * then fulfils exactly Arc, Base, Solana and Robinhood, and nothing else.
 *
 * Every RPC must be loopback. Public Robinhood routes stay closed (robinhood/adapter.ts), and this
 * module has no testnet or live mode.
 */
export const SPOKES = ['base', 'robinhood'] as const
export type Spoke = typeof SPOKES[number]
export type Side = 'arc' | Spoke
/** Where a step runs: an EVM side, or the Solana validator. */
export type Lane = Side | 'solana'

export interface HubConfig {
  rpc: string
  chainId: number
  wormholeChainId: number
  core: Address
  executor: Address
  transceiverStructs: Address
  /** EIP-3009 payment asset and the Arc pool's quote. */
  usdc: Address
  /** Architex pair factory for the Arc pool. */
  factory: Address
  /** Blocks on top of an execution before it counts as final. */
  confirmations: number
  fromBlock: bigint
  /** USDC atoms per 1e18 wei of native gas. Arc gas is native USDC with 18 decimals: 1_000_000. */
  usdcAtomsPerNative: bigint
  maxFeePerGasWei?: bigint
}
export interface SpokeConfig {
  rpc: string
  chainId: number
  wormholeChainId: number
  core: Address
  executor: Address
  transceiverStructs: Address
  /** The pool's quote token on this spoke. */
  quote: Address
  venue: { factory: Address; fee: number; tickSpacing: number }
  confirmations: number
  fromBlock: bigint
  usdcAtomsPerNative: bigint
  priorityFeeWei?: bigint
  /** OP Stack chain: bound the L1 data fee with GasPriceOracle.getL1FeeUpperBound before sending. */
  opStackL1Fee?: boolean
  /** Signs a debit's message for verification by THIS spoke's core. */
  vaa: VaaSource
}
export interface MultispokeLabels {
  environment: string
  payment: string
  quoteInventory: string
  gas: string
}
export interface MultispokeConfig {
  mode: 'fork'
  labels: MultispokeLabels
  operatorKey: Hex
  arc: HubConfig
  spokes: Record<Spoke, SpokeConfig>
  /** NTT rate limits in token atoms per 24 hours, per peer. */
  limits: { outbound: bigint; inbound: bigint }
  budgets: Record<StepKind, Atoms>
  /** The Solana spoke on a local validator. Set: the job is Arc, Base, Solana and Robinhood. */
  solana?: SolanaSpokeConfig
  /** Jobs that may hold a payment authorization at once. Unset: no launch limit. */
  launches?: number
  receiptTimeoutMs?: number
}
/** Test seam: runs right after a transaction is handed to the RPC, before anything about it is recorded. `label` is a step id, `refund:<job>` or `operator:<name>`. */
export interface MultispokeOptions { afterSend?: (label: string, tx: Hex) => void }
/** Why a job's payment can never settle, with what (if anything) its authorization moved. */
export interface Unsettleable {
  reason: string
  /** The Arc block `confirmations` deep at which this was decided. */
  block: string
  outcome: 'expired_unused' | 'cancelled' | 'used_outside_job' | 'spent_by_other_authorization'
  /** USDC atoms that reached the Arc executor under this job's nonce. */
  received: string
  /** The transaction that spent the nonce, when one did. */
  evidence: string | null
}
/** The original job's money after a release. */
export interface PaymentLedger {
  job: string
  payer: string
  outcome: Unsettleable['outcome']
  authorized: string
  received: string
  fees_spent: string
  residual: string
  evidence_tx: string | null
  evidence_block: string
  /** 'owed' while the residual sits on the executor, 'submitted' once the refund executed but is not final, 'refunded' only when final. */
  refund: 'none' | 'owed' | 'submitted' | 'refunded'
  refund_tx: string | null
  refund_block: string | null
  recorded_at: number
}
/** What is known about a refund now: 'prepared' (journalled, may be sent), 'uncertain' (handed to the RPC, no executed receipt read). */
export interface RefundStatus { state: 'none' | 'owed' | 'prepared' | 'uncertain' | 'submitted' | 'refunded'; transaction: string | null; block: string | null }
const authorizationEvents = parseAbi(['event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)', 'event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)'])

/** The exact label set this composition accepts. A configuration cannot relabel a fixture as funds. */
export const MULTISPOKE_LABELS: MultispokeLabels = {
  environment: 'mixed:arc-testnet-fork+base-sepolia-fork+robinhood-mainnet-fork',
  payment: 'fork-fixture: ForkUsdc (EIP-3009) at the Arc native USDC address on an Arc testnet fork; the payer is an anvil development key; no real funds move',
  quoteInventory: 'fork-fixture: Base Sepolia USDC and Robinhood USDG pool quote are credited to the spoke executors by storage write; the payer\'s Arc USDC for them is not bridged',
  gas: 'Base L1 data fees are bounded by the OP Stack oracle; Robinhood Arbitrum Orbit gas (including its L1 component) is not modelled; both are priced at a fixed ETH/USDC rate',
}

/** The four-chain labels. With a Solana spoke, a configuration cannot relabel the validator either. */
export const FOURCHAIN_LABELS: MultispokeLabels = {
  environment: 'mixed:arc-testnet-fork+base-sepolia-fork+solana-local-validator+robinhood-mainnet-fork',
  payment: MULTISPOKE_LABELS.payment,
  quoteInventory: 'fork-fixture: Base Sepolia USDC and Robinhood USDG pool quote are credited to the spoke executors by storage write, and the Solana quote is a fixture mint held by the operator; the payer\'s Arc USDC for them is not bridged',
  gas: `${MULTISPOKE_LABELS.gas}; Solana fees are paid in SOL by the operator fee payer and recorded in lamports, never converted into the launch's USDC atoms`,
}

const LOCKING = 0
const BURNING = 1
const DAY = 86_400n
const ZERO: Hex = `0x${'0'.repeat(64)}`
/** Selector of EquilibriumExecutor.OperationDone(bytes32,bytes32). */
const OPERATION_DONE = '0x3a140fc2'
const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F' as const
const gasPriceOracleAbi = [{ type: 'function', name: 'getL1FeeUpperBound', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] }] as const
const isLoopback = (url: string) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(url)
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const call = (target: Address, data: Hex, value = 0n) => ({ target, value: value.toString(), data })
const create = (init: Hex) => ({ target: zeroAddress as Address, value: '0', data: init })

interface Plan {
  side: Side
  chainId: number
  executor: Address
  operation: Hex
  calls: { target: Address; value: string; data: Hex }[]
  value: string
  fromBlock: string
  expect: Record<string, Address>
}

/** Every address one job creates on all three chains, derived before any of it exists. */
export function layout(job: Pick<Job, 'id' | 'request'>, config: Pick<MultispokeConfig, 'arc' | 'spokes'>) {
  const op = (step: string) => hash([job.id, step])
  const { name, symbol, issuance } = job.request.canonical
  const canonicalInit = withArgs(linked(CODE.EquilibriumCanonical), [{ type: 'string' }, { type: 'string' }, { type: 'address' }, { type: 'uint64' }], [name, symbol, config.arc.executor, BigInt(issuance)])
  const canonical = predict(config.arc.executor, op('canonical:arc'), 0, canonicalInit)
  const manager = (chain: { executor: Address; transceiverStructs: Address; wormholeChainId: number; core: Address }, token: Address, mode: number, operation: Hex, first: number) => {
    const lib = { TransceiverStructs: chain.transceiverStructs }
    const managerInit = withArgs(linked(CODE.NttManager, lib), [{ type: 'address' }, { type: 'uint8' }, { type: 'uint16' }, { type: 'uint64' }, { type: 'bool' }], [token, mode, chain.wormholeChainId, DAY, false])
    const implementation = predict(chain.executor, operation, first, managerInit)
    const proxy = predict(chain.executor, operation, first + 1, proxyInit(implementation))
    const transceiverInit = withArgs(linked(CODE.WormholeTransceiver, lib), [{ type: 'address' }, { type: 'address' }, { type: 'uint8' }, { type: 'uint8' }, { type: 'uint16' }, { type: 'address' }], [proxy, chain.core, 0, 0, 0, zeroAddress])
    const transceiverImplementation = predict(chain.executor, operation, first + 3, transceiverInit)
    const transceiver = predict(chain.executor, operation, first + 4, proxyInit(transceiverImplementation))
    return { managerInit, implementation, proxy, transceiverInit, transceiverImplementation, transceiver }
  }
  const spoke = (side: Spoke) => {
    const c = config.spokes[side]
    const init = withArgs(linked(CODE.EquilibriumSpoke), [{ type: 'string' }, { type: 'string' }, { type: 'address' }, { type: 'uint64' }], [name, symbol, c.executor, BigInt(issuance)])
    const token = predict(c.executor, op(`manager:${side}`), 0, init)
    return { init, token, manager: manager(c, token, BURNING, op(`manager:${side}`), 1) }
  }
  return { op, canonicalInit, canonical, hub: manager(config.arc, canonical, LOCKING, op('manager:arc'), 0), spokes: { base: spoke('base'), robinhood: spoke('robinhood') } }
}

/** The side a step executes on: debits leave the Arc hub, everything else runs on its own chain. */
export const laneOf = (step: Pick<Step, 'kind' | 'chain'>): Lane => (step.kind === 'debit' || step.chain === 'arc' ? 'arc' : step.chain)
/** The EVM side of a step that is not on the Solana validator. */
export const sideOf = (step: Pick<Step, 'kind' | 'chain'>): Side => {
  const side = laneOf(step)
  if (side === 'solana') throw new Error(`${step.kind}:${step.chain} runs on the Solana validator, not an EVM side`)
  return side
}

export function multispokeAdapter(config: MultispokeConfig, db: Database, options: MultispokeOptions = {}) {
  if (config.mode !== 'fork') throw new LaunchError(503, 'route_closed', 'The Arc–Base–Robinhood composition runs on local forks only.')
  if (JSON.stringify(config.labels) !== JSON.stringify(config.solana ? FOURCHAIN_LABELS : MULTISPOKE_LABELS)) throw new LaunchError(503, 'route_closed', 'Labels differ from the fork fixture labels. Fixtures cannot be relabelled.')
  const solana = config.solana ? solanaSpoke(config.solana) : undefined
  for (const [side, rpc] of [['arc', config.arc.rpc], ...SPOKES.map((s) => [s, config.spokes[s].rpc]), ...(config.solana ? [['solana', config.solana.infrastructure.connection.rpcEndpoint]] : [])]) {
    if (!isLoopback(rpc)) throw new LaunchError(503, 'route_closed', `${side} RPC ${rpc} is not a local fork. Public Robinhood routes are closed.`)
  }
  const account = privateKeyToAccount(config.operatorKey)
  const chain = (side: Side) => (side === 'arc' ? config.arc : config.spokes[side])
  const chainOf = (side: Side) => defineChain({ id: chain(side).chainId, name: side, nativeCurrency: { name: 'native', symbol: 'NATIVE', decimals: 18 }, rpcUrls: { default: { http: [chain(side).rpc] } } })
  const sides = ['arc', ...SPOKES] as const
  const publicClient = (s: Side): PublicClient => createPublicClient({ chain: chainOf(s), transport: http(chain(s).rpc) })
  const walletClient = (s: Side): WalletClient => createWalletClient({ account, chain: chainOf(s), transport: http(chain(s).rpc) })
  const clients: Record<Side, PublicClient> = { arc: publicClient('arc'), base: publicClient('base'), robinhood: publicClient('robinhood') }
  const wallets: Record<Side, WalletClient> = { arc: walletClient('arc'), base: walletClient('base'), robinhood: walletClient('robinhood') }
  // Own tables: this composition never reads or writes the evm_* or robinhood_* journals.
  // Concurrent openers of a shared journal: see migrateSchema.
  migrateSchema(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS multispoke_broadcasts (operation TEXT NOT NULL, side TEXT NOT NULL, tx TEXT NOT NULL, sent_at INTEGER NOT NULL, PRIMARY KEY (operation, tx));
      CREATE TABLE IF NOT EXISTS multispoke_vaas (operation TEXT PRIMARY KEY, vaa TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS multispoke_launches (job TEXT PRIMARY KEY, identity TEXT NOT NULL, payer TEXT NOT NULL, valid_before INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0,
        released_reason TEXT, released_block TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS multispoke_payment_ledger (job TEXT PRIMARY KEY, payer TEXT NOT NULL, outcome TEXT NOT NULL, authorized TEXT NOT NULL, received TEXT NOT NULL,
        fees_spent TEXT NOT NULL, residual TEXT NOT NULL, evidence_tx TEXT, evidence_block TEXT NOT NULL, refund TEXT NOT NULL, refund_tx TEXT, refund_block TEXT, recorded_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS multispoke_ops (operation TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, digest TEXT NOT NULL, bytes TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS multispoke_usdc_claims (operation TEXT PRIMARY KEY, name TEXT NOT NULL, amount TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS multispoke_published (operation TEXT PRIMARY KEY, message TEXT NOT NULL);`)
    // Journals from before attribution lack the bound amount. Such a holder is never attributed a transfer: it cannot be matched.
    if (!db.query("SELECT 1 FROM pragma_table_info('multispoke_launches') WHERE name='value'").get()) db.exec('ALTER TABLE multispoke_launches ADD COLUMN value TEXT')
  })
  const sending: Record<Side, Promise<unknown>> = { arc: Promise.resolve(), base: Promise.resolve(), robinhood: Promise.resolve() }
  const strip = (c: HubConfig | SpokeConfig) => ({ ...c, rpc: undefined, fromBlock: undefined, vaa: 'vaa' in c ? c.vaa.kind : undefined, priorityFeeWei: undefined,
    usdcAtomsPerNative: c.usdcAtomsPerNative.toString(), maxFeePerGasWei: 'maxFeePerGasWei' in c ? c.maxFeePerGasWei?.toString() : undefined })
  const pinned = { labels: config.labels, ntt: NTT_COMMIT, code: Object.fromEntries(Object.entries(CODE).map(([k, v]) => [k, v.sha256])), arc: strip(config.arc),
    spokes: { base: strip(config.spokes.base), robinhood: strip(config.spokes.robinhood) }, limits: { outbound: config.limits.outbound.toString(), inbound: config.limits.inbound.toString() },
    budgets: config.budgets, launches: config.launches ?? null, solana: solana?.version }
  const version = solana ? `multispoke-arc-base-solana-robinhood-v1:${hash(pinned).slice(2, 18)}` : `multispoke-arc-base-robinhood-v1:${hash(pinned).slice(2, 18)}`
  const destination = (request: LaunchRequest, side: Lane) => request.destinations.find((d) => d.chain === side)!
  const route = solana ? 'arc,base,solana,robinhood' : 'arc,base,robinhood'
  /** The message debit:solana published, recorded from its finalized receipt; the credit delivers exactly these bytes. */
  const publishedFor = (job: Job): Published | undefined => {
    const row = db.query<{ message: string }, [string]>('SELECT message FROM multispoke_published WHERE operation=?').get(hash([job.id, 'debit:solana']))
    if (!row) return undefined
    const m = JSON.parse(row.message) as Omit<Published, 'sequence'> & { sequence: string }
    return { ...m, sequence: BigInt(m.sequence) }
  }

  async function executed(side: Side, operation: Hex, at: bigint | 'latest' | 'pending'): Promise<Hex> {
    const block = typeof at === 'bigint' ? { blockNumber: at } : { blockTag: at }
    try { return await clients[side].readContract({ address: chain(side).executor, abi: executorAbi, functionName: 'digestOf', args: [operation], ...block }) } catch (cause) {
      // Before the executor existed nothing could have executed; anything else is a real read failure.
      if (cause instanceof BaseError && cause.walk((e) => e instanceof ContractFunctionZeroDataError)) return ZERO
      throw cause
    }
  }
  async function finalBlock(side: Side): Promise<bigint> {
    return await clients[side].getBlockNumber({ cacheTime: 0 }) - BigInt(chain(side).confirmations)
  }
  /** eth_call as the executor, returning the address a factory call would create. */
  async function dryRun(side: Side, to: Address, data: Hex): Promise<Address> {
    const executor = chain(side).executor
    const { data: out } = await clients[side].call({ account: executor, to, data, stateOverride: [{ address: executor, balance: 10n ** 24n }] })
    if (!out || out.length < 66) throw new Error(`Dry run of ${to} returned no address`)
    return getAddress(`0x${out.slice(26, 66)}`)
  }

  // ---- Launch slots and payment attribution (carried from #18 at 22adede) --------------------
  interface Slot { job: string; identity: string; payer: string; value: string | null; valid_before: number; settled: number; released_reason: string | null; released_block: string | null }
  const slot = (job: string) => db.query<Slot, [string]>('SELECT * FROM multispoke_launches WHERE job=?').get(job) ?? undefined
  const releasedFor = (identityHash: string) => db.query<Slot, [string]>('SELECT * FROM multispoke_launches WHERE identity=? AND released_reason IS NOT NULL').get(identityHash) ?? undefined
  const holders = (except: string) => db.query<Slot, [string]>('SELECT * FROM multispoke_launches WHERE released_reason IS NULL AND job!=?').all(except)
  const ledgerOf = (job: string) => db.query<PaymentLedger, [string]>('SELECT * FROM multispoke_payment_ledger WHERE job=?').get(job) ?? undefined
  /** Residual USDC on the Arc executor that belongs to released jobs and has not provably left it. */
  const owed = (except?: string) => db.query<{ residual: string; job: string }, []>("SELECT residual, job FROM multispoke_payment_ledger WHERE refund IN ('owed','submitted')").all()
    .filter((r) => r.job !== except).reduce((n, r) => n + BigInt(r.residual), 0n)
  const refundOperation = (job: string) => hash([job, 'refund:arc'])

  /** The ledger's refund state, refined by the journal: a refund can be prepared or on the wire before its receipt is read. */
  function refundStatus(l: PaymentLedger): RefundStatus {
    if (l.refund === 'none' || l.refund === 'submitted' || l.refund === 'refunded') return { state: l.refund, transaction: l.refund_tx, block: l.refund_block }
    const op = refundOperation(l.job)
    if (!db.query('SELECT 1 FROM multispoke_ops WHERE operation=?').get(op)) return { state: 'owed', transaction: null, block: null }
    const sent = db.query<{ tx: string }, [string]>('SELECT tx FROM multispoke_broadcasts WHERE operation=? ORDER BY sent_at DESC').get(op)
    return sent ? { state: 'uncertain', transaction: sent.tx, block: null } : { state: 'prepared', transaction: null, block: null }
  }

  /** A released job's error, stating what its authorization actually did with the payer's money. */
  function failed(job: string): LaunchError {
    const s = slot(job)!
    const l = ledgerOf(job)
    const head = `Job ${job}'s payment can never settle (${s.released_reason} at Arc block ${s.released_block}); its launch slot was released for good.`
    if (!l) return new LaunchError(409, 'payment_failed', `${head} No payment attribution was recorded for it; read the executor's USDC history before assuming nothing was charged. Start a new request.`)
    if (l.outcome === 'expired_unused') return new LaunchError(409, 'payment_failed', `${head} Its authorization was never used: nothing was charged. Start a new request.`)
    if (l.outcome === 'cancelled') return new LaunchError(409, 'payment_failed', `${head} The payer cancelled its authorization in ${l.evidence_tx}: nothing was charged. Start a new request.`)
    const r = refundStatus(l)
    const refund = {
      none: '',
      owed: `Residual ${l.residual}: refund owed to ${l.payer}; no refund has been sent. It is held for this job and no other job or operator send may spend it.`,
      prepared: `Residual ${l.residual}: a refund to ${l.payer} is prepared and may already have been sent; its outcome is unknown. It stays held for this job until the refund is final.`,
      uncertain: `Residual ${l.residual}: a refund to ${l.payer} was sent in ${r.transaction} and has no executed receipt yet; its outcome is unknown. It stays held for this job until the refund is final.`,
      submitted: `Residual ${l.residual}: refunded to ${l.payer} in ${r.transaction} at Arc block ${r.block}, not yet final. It stays held for this job until then.`,
      refunded: `Residual ${l.residual}: refunded to ${l.payer} in ${r.transaction}, final at Arc block ${r.block}. Nothing of it remains on the executor.`,
    }[r.state]
    if (l.outcome === 'spent_by_other_authorization') {
      if (l.received === '0') return new LaunchError(409, 'payment_failed', `${head} Its nonce was spent in ${l.evidence_tx} by an authorization with other terms, and none of that transfer reached the executor. Nothing is attributed to this job. Start a new request.`)
      return new LaunchError(409, 'payment_failed', `${head} Its nonce was spent in ${l.evidence_tx} by an authorization with other terms, which moved ${l.received} USDC atoms to the Arc executor. That is not this job's payment and fulfilled nothing. ${refund} Start a new request.`)
    }
    return new LaunchError(409, 'payment_failed', `${head} Its authorization was used outside the job in ${l.evidence_tx}: ${l.received} USDC atoms reached the Arc executor and nothing was fulfilled. Fees spent: ${l.fees_spent}. ${refund} Start a new request.`)
  }

  /**
   * Why a job's payment can never settle, or null while it still could (or while that cannot yet be
   * proven). Read at one block `confirmations` deep: the payment operation is unexecuted there, and
   * either the nonce is spent by a finalized, identified transaction whose transfer is matched
   * against the bound terms, or the authorization's validBefore has passed unused.
   */
  async function unsettleable(job: string, r: Pick<Slot, 'payer' | 'value' | 'valid_before'>): Promise<Unsettleable | null> {
    const at = await finalBlock('arc')
    if (await executed('arc', hash([job, 'payment:arc']), at) !== ZERO) {
      db.query('UPDATE multispoke_launches SET settled=1 WHERE job=?').run(job)
      return null
    }
    const spentAt = (blockNumber: bigint) => clients.arc.readContract({ address: config.arc.usdc, abi: usdcAbi, functionName: 'authorizationState', args: [r.payer as Address, job as Hex], blockNumber })
    // Spent first: an authorization used before it expired moved money even if it has expired since.
    if (await spentAt(at)) return spentBy(job, r, at, spentAt)
    const block = await clients.arc.getBlock({ blockNumber: at })
    if (block.timestamp >= BigInt(r.valid_before)) return { reason: 'authorization expired', block: at.toString(), outcome: 'expired_unused', received: '0', evidence: null }
    return null
  }
  /**
   * The finalized transaction that spent the nonce, and what it moved. The nonce flipped in exactly
   * one block at or below `at`: step back until it is unspent, then bisect. That block must hold one
   * AuthorizationUsed or AuthorizationCanceled log for (payer, nonce); a used authorization is
   * attributed only from the transfer that follows that log in the same transaction. An unrelated
   * USDC transfer to the executor is never attributed. Anything less certain returns null, which
   * keeps the slot held.
   */
  async function spentBy(job: string, r: Pick<Slot, 'payer' | 'value'>, at: bigint, spentAt: (b: bigint) => Promise<boolean>): Promise<Unsettleable | null> {
    let hi = at; let lo = at; let stride = 1n
    while (true) {
      if (lo === 0n) return null
      lo = lo > stride ? lo - stride : 0n
      if (!await spentAt(lo)) break
      hi = lo; stride *= 2n
    }
    while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if (await spentAt(mid)) hi = mid; else lo = mid }
    const logs = (await Promise.all(authorizationEvents.map((event) => clients.arc.getLogs({ address: config.arc.usdc, event, args: { authorizer: r.payer as Address, nonce: job as Hex }, fromBlock: hi, toBlock: hi })))).flat()
    if (logs.length !== 1) return null
    const [log] = logs
    const base = { block: at.toString(), evidence: log.transactionHash }
    if (log.eventName === 'AuthorizationCanceled') return { ...base, reason: 'authorization cancelled', outcome: 'cancelled', received: '0' }
    const receipt = await clients.arc.getTransactionReceipt({ hash: log.transactionHash })
    if (receipt.status !== 'success') return null
    const moved = receipt.logs.filter((l) => same(l.address, config.arc.usdc) && l.logIndex > log.logIndex).flatMap((l) => {
      try {
        const e = decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics })
        return e.eventName === 'Transfer' && same(e.args.from, r.payer) ? [e.args] : []
      } catch { return [] }
    })[0]
    if (!moved) return null
    if (r.value !== null && same(moved.to, config.arc.executor) && moved.value === BigInt(r.value)) return { ...base, reason: 'authorization used outside the job', outcome: 'used_outside_job', received: moved.value.toString() }
    // Other terms are not this job's payment, but money they moved onto the executor is still the payer's and is held for return.
    return { ...base, reason: 'authorization nonce spent by other terms', outcome: 'spent_by_other_authorization', received: same(moved.to, config.arc.executor) ? moved.value.toString() : '0' }
  }
  /**
   * Release a slot for good and record the original job's money, in one transaction. Idempotent:
   * the first decision stands. A released job ran no executor operation (release requires its
   * payment unexecuted, and every later step requires a completed payment), so its whole receipt
   * is residual.
   */
  function release(job: string, r: Pick<Slot, 'identity' | 'payer' | 'value' | 'valid_before'>, why: Unsettleable) {
    db.transaction(() => {
      db.query(`INSERT INTO multispoke_launches(job, identity, payer, value, valid_before, created_at, released_reason, released_block) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(job) DO UPDATE SET released_reason=COALESCE(released_reason, excluded.released_reason), released_block=COALESCE(released_block, excluded.released_block)`)
        .run(job, r.identity, r.payer.toLowerCase(), r.value, r.valid_before, Date.now(), why.reason, why.block)
      db.query(`INSERT OR IGNORE INTO multispoke_payment_ledger(job, payer, outcome, authorized, received, fees_spent, residual, evidence_tx, evidence_block, refund, recorded_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(job, r.payer.toLowerCase(), why.outcome, r.value ?? 'unknown', why.received, '0', why.received, why.evidence, why.block, BigInt(why.received) > 0n ? 'owed' : 'none', Date.now())
    }).immediate()
  }
  /** A holder that is settled, or whose authorization has not expired yet, still counts. */
  const live = (s: Slot) => s.settled === 1 || Date.now() / 1000 < s.valid_before
  const slotOf = (job: Job): Pick<Slot, 'identity' | 'payer' | 'value' | 'valid_before'> => {
    const a = job.payment!.authorization
    return { identity: job.identity, payer: a.from.toLowerCase(), value: a.value, valid_before: Number(a.validBefore) }
  }

  /**
   * Take this job's slot before its payment can be sent. Holders whose payments provably can never
   * settle are released first, with their attribution; the count and insert then happen in one
   * IMMEDIATE transaction, so two processes racing for the last slot cannot both take it.
   */
  async function takeSlot(job: Job) {
    const own = slot(job.id)
    if (own?.released_reason) throw failed(job.id)
    if (own) return
    const limit = config.launches
    if (limit !== undefined && holders(job.id).length >= limit) {
      for (const h of holders(job.id).filter((x) => !x.settled)) {
        const why = await unsettleable(h.job, h)
        if (why) release(h.job, h, why)
      }
    }
    const s = slotOf(job)
    db.transaction(() => {
      if (slot(job.id)) return
      const taken = holders(job.id)
      if (limit !== undefined && taken.length >= limit) throw new LaunchError(409, 'launch_limit', `${taken.length} launch(es) already hold the approved slot(s): ${taken.map((t) => t.job).join(', ')}. Nothing was charged.`)
      db.query('INSERT INTO multispoke_launches(job, identity, payer, value, valid_before, created_at) VALUES(?,?,?,?,?,?)').run(job.id, s.identity, s.payer, s.value, s.valid_before, Date.now())
    }).immediate()
  }

  // ---- Executor USDC claims (job, refund and operator sends) ---------------------------------
  /**
   * Arc USDC a plan sends out of the executor. Plans make only plain transfers (outflows) and the
   * payment's transferWithAuthorization (an inflow from the payer); any other USDC call is refused.
   */
  function usdcOut(calls: Plan['calls']) {
    return calls.filter((c) => same(c.target, config.arc.usdc)).reduce((n, c) => {
      const d = decodeFunctionData({ abi: [...erc20Abi, ...usdcAbi], data: c.data })
      if (d.functionName === 'transferWithAuthorization') return n
      if (d.functionName !== 'transfer') throw new Error(`Unplanned USDC call ${d.functionName}`)
      return n + d.args[1]
    }, 0n)
  }
  /**
   * Coordinate an Arc send that moves executor USDC across every process sharing this journal. The
   * claim is committed BEFORE the check, so of two racing sends the later-committed one always sees
   * the other's claim. Funds are read at a block `confirmations` deep; claims not executed at that
   * depth are subtracted, as are residuals owed to released jobs, except the one this send refunds.
   * Any failure to establish this refuses the send. Returns an undo for when nothing was then sent.
   * Journals that share an executor do not see each other's claims: one journal per executor.
   */
  async function claim(name: string, operation: Hex, calls: Plan['calls'], refunding?: string): Promise<() => void> {
    const out = usdcOut(calls)
    if (out === 0n) return () => undefined
    const fresh = db.query("INSERT OR IGNORE INTO multispoke_usdc_claims(operation, name, amount, state, created_at) VALUES(?,?,?,'pending',?)").run(operation, name, out.toString(), Date.now()).changes > 0
    const drop = () => { if (fresh) db.query("DELETE FROM multispoke_usdc_claims WHERE operation=? AND state='pending'").run(operation) }
    try {
      const at = await finalBlock('arc')
      let others = 0n
      for (const c of db.query<{ operation: Hex; amount: string }, [string]>("SELECT operation, amount FROM multispoke_usdc_claims WHERE state='pending' AND operation<>?").all(operation)) {
        // Executed at the depth read below: already in that balance, and final from now on.
        if (await executed('arc', c.operation, at) !== ZERO) db.query("UPDATE multispoke_usdc_claims SET state='final' WHERE operation=?").run(c.operation)
        else others += BigInt(c.amount)
      }
      const held = await clients.arc.readContract({ address: config.arc.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [config.arc.executor], blockNumber: at })
      const reserved = owed(refunding)
      if (held - reserved - others < out) throw new LaunchError(409, 'residual_reserved', `At Arc block ${at} the executor holds ${held} USDC atoms; ${reserved} are owed to released jobs and ${others} are claimed by sends not yet final. ${name} needs ${out}. Nothing was sent.`)
    } catch (cause) {
      drop()
      if (cause instanceof LaunchError) throw cause
      throw new LaunchError(503, 'residual_reserved', `Executor USDC for ${name} could not be established (${cause instanceof Error ? cause.message.split('\n')[0] : 'unreadable'}). Nothing was sent.`)
    }
    return drop
  }

  // ---- Plans --------------------------------------------------------------------------------
  async function plan({ job, step }: EffectContext): Promise<Plan> {
    const L = layout(job, config)
    const side = sideOf(step)
    const c = chain(side)
    const operation = L.op(step.id)
    const request = job.request
    const calls: Plan['calls'] = []
    const expect: Record<string, Address> = {}
    const fee = await clients[side].readContract({ address: c.core, abi: coreAbi, functionName: 'messageFee' })
    if (step.kind === 'payment') {
      const a = job.payment?.authorization
      if (!a || !job.payment) throw new Error('Payment step without a verified authorization')
      if (!same(a.to, config.arc.executor)) throw new Error('Authorization does not pay the Arc executor')
      const { r, s, v } = parseSignature(job.payment.signature)
      calls.push(call(config.arc.usdc, encodeFunctionData({ abi: usdcAbi, functionName: 'transferWithAuthorization', args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, Number(v ?? 27n), r, s] })))
      expect.payer = a.from
    } else if (step.kind === 'canonical') {
      calls.push(create(L.canonicalInit)); expect.token = L.canonical
    } else if (step.kind === 'manager' && side === 'arc') {
      // ONE hub for both spokes: a peer and a Wormhole peer per spoke, each with its own inbound limit.
      const h = L.hub
      calls.push(create(h.managerInit), create(proxyInit(h.implementation)), call(h.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'initialize' })),
        create(h.transceiverInit), create(proxyInit(h.transceiverImplementation)), call(h.transceiver, encodeFunctionData({ abi: transceiverAbi, functionName: 'initialize' }), fee),
        call(h.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setTransceiver', args: [h.transceiver] })),
        call(h.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setThreshold', args: [1] })),
        call(h.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setOutboundLimit', args: [config.limits.outbound] })))
      for (const s of SPOKES) {
        const peer = L.spokes[s].manager
        calls.push(call(h.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setPeer', args: [config.spokes[s].wormholeChainId, universal(peer.proxy), 6, config.limits.inbound] })),
          call(h.transceiver, encodeFunctionData({ abi: transceiverAbi, functionName: 'setWormholePeer', args: [config.spokes[s].wormholeChainId, universal(peer.transceiver)] }), fee))
      }
      if (solana) {
        // The pinned SVM manager program and its transceiver's emitter PDA: properties of the programs,
        // not of this launch, so the hub peers them before the job's Solana mint exists.
        const peer = hubPeers()
        calls.push(call(h.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setPeer', args: [peer.chain, peer.manager, 6, config.limits.inbound] })),
          call(h.transceiver, encodeFunctionData({ abi: transceiverAbi, functionName: 'setWormholePeer', args: [peer.chain, peer.emitter] }), fee))
      }
      expect.manager = h.proxy; expect.transceiver = h.transceiver
    } else if (step.kind === 'manager') {
      const h = L.hub; const sp = L.spokes[side as Spoke]; const m = sp.manager
      calls.push(create(sp.init), create(m.managerInit), create(proxyInit(m.implementation)), call(m.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'initialize' })),
        create(m.transceiverInit), create(proxyInit(m.transceiverImplementation)), call(m.transceiver, encodeFunctionData({ abi: transceiverAbi, functionName: 'initialize' }), fee),
        call(m.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setTransceiver', args: [m.transceiver] })),
        call(m.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setThreshold', args: [1] })),
        call(m.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setOutboundLimit', args: [config.limits.outbound] })),
        call(m.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setPeer', args: [config.arc.wormholeChainId, universal(h.proxy), 6, config.limits.inbound] })),
        call(m.transceiver, encodeFunctionData({ abi: transceiverAbi, functionName: 'setWormholePeer', args: [config.arc.wormholeChainId, universal(h.transceiver)] }), fee),
        call(sp.token, encodeFunctionData({ abi: spokeAbi, functionName: 'setMinter', args: [m.proxy] })))
      expect.manager = m.proxy; expect.transceiver = m.transceiver; expect.token = sp.token
    } else if (step.kind === 'debit') {
      const to = step.chain
      if (to === 'arc') throw new Error('Arc is not a debit destination')
      const amount = BigInt(destination(request, to).amount)
      // Solana's recipient is the launch's custody owner on the validator; an EVM spoke's is its executor.
      const chainId = to === 'solana' ? hubPeers().chain : config.spokes[to].wormholeChainId
      const recipient: Hex = to === 'solana' ? `0x${new PublicKey(solana!.custodian()).toBuffer().toString('hex')}` : universal(config.spokes[to].executor)
      calls.push(call(L.canonical, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [L.hub.proxy, amount] })),
        call(L.hub.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'transfer', args: [amount, chainId, recipient] }), fee))
      expect.token = L.canonical; expect.manager = L.hub.proxy
    } else if (step.kind === 'credit') {
      const vaa = db.query<{ vaa: string }, [string]>('SELECT vaa FROM multispoke_vaas WHERE operation=?').get(L.op(`debit:${side}`))?.vaa
      if (!vaa) throw new Error(`No signed VAA is recorded for the finalized debit:${side}`)
      calls.push(call(L.spokes[side as Spoke].manager.transceiver, encodeFunctionData({ abi: transceiverAbi, functionName: 'receiveMessage', args: [vaa as Hex] })))
      expect.token = L.spokes[side as Spoke].token
    } else if (step.kind === 'pool' && side === 'arc') {
      const d = destination(request, 'arc')
      let pair = await clients.arc.readContract({ address: config.arc.factory, abi: architexFactoryAbi, functionName: 'getPair', args: [L.canonical, config.arc.usdc] })
      if (pair === zeroAddress) {
        const createPair = encodeFunctionData({ abi: architexFactoryAbi, functionName: 'createPair', args: [L.canonical, config.arc.usdc] })
        pair = await dryRun('arc', config.arc.factory, createPair)
        calls.push(call(config.arc.factory, createPair))
      }
      calls.push(call(L.canonical, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [pair, BigInt(d.poolTokens)] })),
        call(config.arc.usdc, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [pair, BigInt(d.poolQuote)] })),
        call(pair, encodeFunctionData({ abi: architexPairAbi, functionName: 'mint', args: [config.arc.executor] })))
      // Custody leaves the executor here, except exactly what the two spoke debits will lock.
      const remainder = BigInt(d.amount) - BigInt(d.poolTokens)
      if (remainder > 0n) calls.push(call(L.canonical, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [d.recipient as Address, remainder] })))
      const unallocated = BigInt(request.canonical.issuance) - request.destinations.reduce((n, x) => n + BigInt(x.amount), 0n)
      if (unallocated > 0n) calls.push(call(L.canonical, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [request.canonical.recipient, unallocated] })))
      expect.pool = pair; expect.token = L.canonical; expect.quote = config.arc.usdc
    } else if (step.kind === 'pool') {
      const s = config.spokes[side as Spoke]
      const token = L.spokes[side as Spoke].token
      const d = destination(request, side)
      const existing = await clients[side].readContract({ address: s.venue.factory, abi: v3FactoryAbi, functionName: 'getPool', args: [token, s.quote, s.venue.fee] })
      if (existing !== zeroAddress) throw new LaunchError(409, 'pool_exists', `A ${s.venue.fee} pool for the ${side} spoke already exists at ${existing}; refusing to seed a pool this job did not create.`)
      const createPool = encodeFunctionData({ abi: v3FactoryAbi, functionName: 'createPool', args: [token, s.quote, s.venue.fee] })
      const pool = await dryRun(side, s.venue.factory, createPool)
      const tokenFirst = token.toLowerCase() < s.quote.toLowerCase()
      const total0 = BigInt(tokenFirst ? d.poolTokens : d.poolQuote); const total1 = BigInt(tokenFirst ? d.poolQuote : d.poolTokens)
      const p = v3Plan(total0, total1, s.venue.tickSpacing)
      calls.push(call(s.venue.factory, createPool), call(pool, encodeFunctionData({ abi: v3PoolAbi, functionName: 'initialize', args: [p.sqrtPriceX96] })),
        call(pool, encodeFunctionData({ abi: v3PoolAbi, functionName: 'mint', args: [s.executor, p.lower, p.upper, p.liquidity, encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [total0, total1])] })))
      const remainder = BigInt(d.amount) - BigInt(d.poolTokens)
      if (remainder > 0n) calls.push(call(token, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [d.recipient as Address, remainder] })))
      expect.pool = pool; expect.token = token; expect.quote = s.quote
    } else throw new Error(`No plan for ${step.id}`)
    const value = calls.reduce((n, x) => n + BigInt(x.value), 0n)
    const fromBlock = await clients[side].getBlockNumber({ cacheTime: 0 })
    return { side, chainId: c.chainId, executor: c.executor, operation, calls, value: value.toString(), fromBlock: (fromBlock > c.fromBlock ? fromBlock : c.fromBlock).toString(), expect }
  }

  const parse = (prepared: PreparedEffect, step: Step, job: Job): Plan => {
    if (hash(prepared.bytes) !== prepared.digest || prepared.operation !== hash([job.id, step.id])) throw new Error('Prepared bytes changed')
    const p = JSON.parse(prepared.bytes) as Plan
    if (p.operation !== prepared.operation || p.side !== sideOf(step) || !same(p.executor, chain(p.side).executor)) throw new Error(`Prepared plan for ${step.id} is inconsistent`)
    return p
  }
  /** A Solana step's persisted plan. The mint secret lives here, and is never projected by publicJob. */
  const parseSolana = (prepared: PreparedEffect, step: Step, job: Job): SolanaPlan => {
    if (hash(prepared.bytes) !== prepared.digest || prepared.operation !== hash([job.id, step.id])) throw new Error('Prepared bytes changed')
    const p = JSON.parse(prepared.bytes) as { side: string; operation: Hex; plan: SolanaPlan }
    if (p.side !== 'solana' || p.operation !== prepared.operation) throw new Error(`Prepared plan for ${step.id} is inconsistent`)
    return p.plan
  }
  const executeArgs = (p: Plan, digest: Hex) => [p.operation, digest, p.calls.map((x) => ({ target: x.target, value: BigInt(x.value), data: x.data }))] as const

  function transfers(receipt: TransactionReceipt, token: Address) {
    return receipt.logs.filter((l) => same(l.address, token)).flatMap((l) => {
      try {
        const e = decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics })
        return e.eventName === 'Transfer' ? [e.args] : []
      } catch { return [] }
    })
  }
  const sum = (items: { value: bigint }[]) => items.reduce((n, x) => n + x.value, 0n).toString()

  async function result(p: Plan, job: Job, step: Step, receipt: TransactionReceipt): Promise<EffectResult | 'pending'> {
    const c = chain(p.side)
    const cost = ((weiOf(receipt) * c.usdcAtomsPerNative + 10n ** 18n - 1n) / 10n ** 18n).toString()
    const base: EffectResult = { operation: p.operation, transaction: receipt.transactionHash, finalized: true, cost }
    const X = p.executor
    if (step.kind === 'payment') return { ...base, amount: sum(transfers(receipt, config.arc.usdc).filter((t) => same(t.from, p.expect.payer) && same(t.to, X))) }
    if (step.kind === 'canonical') return { ...base, address: p.expect.token, amount: sum(transfers(receipt, p.expect.token).filter((t) => t.from === zeroAddress && same(t.to, X))) }
    if (step.kind === 'manager') {
      const owner = await clients[p.side].readContract({ address: p.expect.manager, abi: nttAbi, functionName: 'owner', blockNumber: receipt.blockNumber })
      if (!same(owner, X)) throw new Error(`${step.id} manager owner is not the executor`)
      return { ...base, address: p.expect.manager }
    }
    if (step.kind === 'debit') {
      const locked = transfers(receipt, p.expect.token).filter((t) => same(t.from, X) && same(t.to, p.expect.manager))
      const block = await clients.arc.getBlock({ blockNumber: receipt.blockNumber })
      const messages = publishedFrom(receipt.logs, config.arc.core, config.arc.wormholeChainId, Number(block.timestamp))
      if (messages.length !== 1) throw new Error(`${step.id} published ${messages.length} Wormhole messages; expected exactly one`)
      if (step.chain === 'solana') {
        // The validator's core is given these exact bytes by credit:solana, signed by its own fixture guardian.
        solana!.checkDebit(job, messages[0])
        db.query('INSERT OR IGNORE INTO multispoke_published(operation, message) VALUES(?, ?)').run(p.operation, JSON.stringify({ ...messages[0], sequence: messages[0].sequence.toString() }))
        return { ...base, amount: sum(locked) }
      }
      // Signed for the destination's core. Unsigned is pending, never absent.
      const vaa = await config.spokes[step.chain as Spoke].vaa.signed(messages[0])
      if (!vaa) return 'pending'
      db.query('INSERT OR IGNORE INTO multispoke_vaas(operation, vaa) VALUES(?, ?)').run(p.operation, vaa)
      return { ...base, amount: sum(locked) }
    }
    if (step.kind === 'credit') {
      const minted = transfers(receipt, p.expect.token).filter((t) => t.from === zeroAddress && same(t.to, X))
      if (!minted.length) throw new Error(`${step.id} executed without a mint: the inbound transfer is queued or was not redeemed`)
      return { ...base, amount: sum(minted) }
    }
    const token = sum(transfers(receipt, p.expect.token).filter((t) => same(t.from, X) && same(t.to, p.expect.pool)))
    const quote = sum(transfers(receipt, p.expect.quote).filter((t) => same(t.from, X) && same(t.to, p.expect.pool)))
    return { ...base, address: p.expect.pool, amount: token, quoteAmount: quote }
  }

  async function fees(side: Side) {
    const c = chain(side)
    if ('maxFeePerGasWei' in c && c.maxFeePerGasWei !== undefined) return { maxFeePerGas: c.maxFeePerGasWei, maxPriorityFeePerGas: 0n }
    const tip = 'priorityFeeWei' in c ? c.priorityFeeWei : undefined
    if (tip === undefined) {
      const { maxFeePerGas, maxPriorityFeePerGas } = await clients[side].estimateFeesPerGas()
      return { maxFeePerGas, maxPriorityFeePerGas }
    }
    return { maxPriorityFeePerGas: tip, maxFeePerGas: ((await clients[side].getBlock()).baseFeePerGas ?? 0n) * 2n + tip }
  }
  /** Refuse to send anything whose worst-case cost could exceed the step's budget. */
  async function worstCase(side: Side, label: string, budget: bigint, gas: bigint, maxFeePerGas: bigint, data: Hex) {
    const c = chain(side)
    let worst = gas * maxFeePerGas
    if ('opStackL1Fee' in c && c.opStackL1Fee) worst += await clients[side].readContract({ address: GAS_PRICE_ORACLE, abi: gasPriceOracleAbi, functionName: 'getL1FeeUpperBound', args: [BigInt((data.length - 2) / 2 + 68)] })
    const atoms = (worst * c.usdcAtomsPerNative + 10n ** 18n - 1n) / 10n ** 18n
    if (atoms > budget) throw new LaunchError(409, 'budget', `${label} could cost up to ${atoms} USDC atoms, above its ${budget} budget. Nothing was sent.`)
  }
  /**
   * Send one executor operation from its persisted plan, exactly as a job step is sent. Any Arc send
   * that moves executor USDC takes a claim first; the claim is dropped only if the send provably never
   * left (refused in simulation or estimation before anything was signed).
   */
  async function send(p: Plan, digest: Hex, label: string, budget: bigint, refunding?: string) {
    const client = clients[p.side]
    const run = async () => {
      const current = await executed(p.side, p.operation, 'latest')
      if (current === digest) return
      if (current !== ZERO) throw new LaunchError(409, 'operation_conflict', `${label} already executed with other bytes (${current}).`)
      // A crashed or stale worker's identical copy may still be in the mempool: observe it instead of paying for a second send.
      if (await executed(p.side, p.operation, 'pending') === digest) return
      const abandon = p.side === 'arc' ? await claim(label, p.operation, p.calls, refunding) : () => undefined
      let gas: bigint
      try {
        await client.simulateContract({ account, address: p.executor, abi: executorAbi, functionName: 'execute', args: executeArgs(p, digest), value: BigInt(p.value) })
        gas = await client.estimateContractGas({ account, address: p.executor, abi: executorAbi, functionName: 'execute', args: executeArgs(p, digest), value: BigInt(p.value) })
      } catch (cause) {
        // Another worker executed it between the read and the simulation: nothing to send, and its claim stands.
        const revert = cause instanceof BaseError ? cause.walk((e) => e instanceof ContractFunctionRevertedError) : null
        if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName === 'OperationDone') return
        abandon()
        throw cause
      }
      const limit = (gas * 12n) / 10n
      const fee = await fees(p.side)
      try { await worstCase(p.side, label, budget, limit, fee.maxFeePerGas, encodeFunctionData({ abi: executorAbi, functionName: 'execute', args: executeArgs(p, digest) })) } catch (cause) { abandon(); throw cause }
      let tx: Hex | undefined
      for (let attempt = 0; attempt < 3 && !tx; attempt++) {
        try {
          tx = await wallets[p.side].writeContract({ account, chain: chainOf(p.side), address: p.executor, abi: executorAbi, functionName: 'execute', args: executeArgs(p, digest), value: BigInt(p.value), gas: limit, ...fee })
        } catch (cause) {
          // Another worker's execution landed between our simulation and our send: nothing to send.
          if (String(cause).includes(OPERATION_DONE) || await executed(p.side, p.operation, 'pending') === digest) return
          // Possibly delivered: the claim stays until the operation is final or provably absent.
          if (attempt === 2 || !/nonce|underpriced|already known/i.test(String(cause))) throw cause
        }
      }
      options.afterSend?.(label, tx!)
      db.query('INSERT OR IGNORE INTO multispoke_broadcasts(operation, side, tx, sent_at) VALUES(?,?,?,?)').run(p.operation, p.side, tx!, Date.now())
      const receipt = await client.waitForTransactionReceipt({ hash: tx!, timeout: config.receiptTimeoutMs ?? 120_000 })
      if (receipt.status !== 'success' && await executed(p.side, p.operation, receipt.blockNumber) !== digest) throw new Error(`${label} execution reverted in ${tx}`)
    }
    const next = sending[p.side].then(run, run)
    sending[p.side] = next.catch(() => undefined)
    await next
  }

  /** The executing receipt of an operation, if it executed at `at` or earlier. */
  async function executedReceipt(side: Side, operation: Hex, fromBlock: bigint, at: bigint): Promise<TransactionReceipt | null> {
    const [log] = await clients[side].getLogs({ address: chain(side).executor, event: executorAbi.find((x) => x.type === 'event' && x.name === 'Executed')!, args: { operation }, fromBlock, toBlock: at }) as { transactionHash: Hex }[]
    return log ? clients[side].getTransactionReceipt({ hash: log.transactionHash }) : null
  }

  /** Persist an Arc operation outside the job steps once; the first bytes win, and a different plan under the same name is a conflict. */
  async function persistOp(kind: 'refund' | 'operator', name: string, operation: Hex, build: () => Plan['calls']): Promise<{ plan: Plan; digest: Hex }> {
    let row = db.query<{ digest: Hex; bytes: string }, [string]>('SELECT digest, bytes FROM multispoke_ops WHERE operation=?').get(operation)
    if (!row) {
      const calls = build()
      const fromBlock = await clients.arc.getBlockNumber({ cacheTime: 0 })
      const p: Plan = { side: 'arc', chainId: config.arc.chainId, executor: config.arc.executor, operation, calls, value: '0', fromBlock: (fromBlock > config.arc.fromBlock ? fromBlock : config.arc.fromBlock).toString(), expect: {} }
      const bytes = JSON.stringify(p)
      db.query('INSERT OR IGNORE INTO multispoke_ops(operation, name, kind, digest, bytes, created_at) VALUES(?,?,?,?,?,?)').run(operation, name, kind, hash(bytes), bytes, Date.now())
      row = db.query<{ digest: Hex; bytes: string }, [string]>('SELECT digest, bytes FROM multispoke_ops WHERE operation=?').get(operation)!
    }
    if (hash(row.bytes) !== row.digest) throw new Error(`Persisted ${name} is inconsistent`)
    return { plan: JSON.parse(row.bytes) as Plan, digest: row.digest }
  }
  const usdcTransfer = (to: Address, amount: bigint) => call(config.arc.usdc, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }))

  /**
   * Operator action: return a released job's residual to its payer. One executor operation named for
   * the job, persisted before sending, so repeated calls, restarts and racing operators execute it at
   * most once. The ledger says 'refunded' only once that execution is `confirmations` deep and its
   * receipt shows exactly the residual going to the payer.
   */
  async function refund(job: string): Promise<PaymentLedger> {
    const l = ledgerOf(job)
    if (!l) throw new LaunchError(404, 'not_released', `Job ${job} has no payment ledger; only a released job's residual can be refunded.`)
    if (l.refund === 'none') throw new LaunchError(409, 'nothing_to_refund', `Job ${job}'s authorization moved nothing to the executor.`)
    if (l.refund === 'refunded') return l
    const operation = refundOperation(job)
    const { plan: p, digest } = await persistOp('refund', `refund:${job}`, operation, () => [usdcTransfer(l.payer as Address, BigInt(l.residual))])
    await send(p, digest, `refund:${job}`, BigInt(config.budgets.payment), job)
    const latest = await clients.arc.getBlockNumber({ cacheTime: 0 })
    const receipt = await executedReceipt('arc', operation, BigInt(p.fromBlock), latest)
    // Executed in state the node serves but in no committed block yet, or not executed: the ledger stays owed and the refund prepared/uncertain.
    if (!receipt) return ledgerOf(job)!
    const back = transfers(receipt, config.arc.usdc).filter((t) => same(t.from, config.arc.executor) && same(t.to, l.payer)).reduce((n, t) => n + t.value, 0n)
    if (back.toString() !== l.residual) throw new Error(`Refund receipt ${receipt.transactionHash} moved ${back}, not the residual ${l.residual}`)
    const final = latest >= receipt.blockNumber + BigInt(config.arc.confirmations)
    db.query("UPDATE multispoke_payment_ledger SET refund=?, refund_tx=?, refund_block=? WHERE job=? AND refund <> 'refunded'").run(final ? 'refunded' : 'submitted', receipt.transactionHash, receipt.blockNumber.toString(), job)
    return ledgerOf(job)!
  }

  /**
   * Operator action: move executor USDC that no job or residual claims, e.g. retained fees. The same
   * name with other parameters is a conflict, never a second transfer; it executes at most once and
   * passes the same claim check as every job and refund send.
   */
  async function operatorSend(name: string, to: Address, amount: bigint) {
    if (!/^[a-z0-9-]{1,64}$/.test(name) || amount <= 0n) throw new LaunchError(400, 'invalid_request', 'An operator send needs a short lowercase name and a positive amount.')
    const operation = hash(['operator', name])
    const { plan: p, digest } = await persistOp('operator', `operator:${name}`, operation, () => [usdcTransfer(to, amount)])
    if (JSON.stringify(p.calls) !== JSON.stringify([usdcTransfer(to, amount)])) throw new LaunchError(409, 'operation_conflict', `operator:${name} is journalled with other parameters.`)
    await send(p, digest, `operator:${name}`, BigInt(config.budgets.payment))
    const receipt = await executedReceipt('arc', operation, BigInt(p.fromBlock), await clients.arc.getBlockNumber({ cacheTime: 0 }))
    return { operation, transaction: receipt?.transactionHash ?? null }
  }

  /**
   * A completed job's Arc USDC, from its own receipts. In: the payment. Out: only the Arc pool's quote.
   * Held on the executor: everything else, which is the platform fee, the reserve for the spoke pools'
   * quote (injected on Base and Robinhood from pre-positioned inventory; no Arc USDC moved for it) and
   * the step budgets. The operator paid the steps' gas in native currency from its own account, so
   * those costs are reported as reimbursable from the held budgets, not as USDC the executor spent.
   */
  function usdcAccount(job: Job) {
    if (job.state !== 'complete') return null
    const step = (id: string) => job.steps.find((s) => s.id === id)!
    const inflow = BigInt(step('payment:arc').result!.amount!)
    const arcPoolQuote = BigInt(step('pool:arc').result!.quoteAmount!)
    const injected: Record<string, bigint> = { base: BigInt(step('pool:base').result!.quoteAmount!), robinhood: BigInt(step('pool:robinhood').result!.quoteAmount!) }
    if (solana) injected.solana = BigInt(step('pool:solana').result!.quoteAmount!)
    const platformFee = BigInt(step('payment:arc').budget)
    const stepBudgets = job.steps.filter((s) => s.kind !== 'payment').reduce((n, s) => n + BigInt(s.budget), 0n)
    const nativeOperatorCosts = Object.fromEntries((['arc', ...SPOKES] as const).map((side) => [side, job.steps.filter((s) => s.kind !== 'payment' && laneOf(s) === side).reduce((n, s) => n + BigInt(s.result!.cost), 0n)])) as Record<Side, bigint>
    const native = nativeOperatorCosts.arc + nativeOperatorCosts.base + nativeOperatorCosts.robinhood
    const held = inflow - arcPoolQuote
    const spokeReserve = Object.values(injected).reduce((n, x) => n + x, 0n)
    // Solana fees are SOL from the operator's fee payer: reported in lamports, never as USDC atoms.
    const solanaLamports = solana ? job.steps.filter((s) => laneOf(s) === 'solana').reduce((n, s) => n + (solana.lamports.get(hash([job.id, s.id])) ?? 0n), 0n) : undefined
    return {
      inflow, usdcSpent: { arcPool: arcPoolQuote }, held,
      spokeQuoteInjected: { ...injected, source: 'pre-positioned spoke inventory (fork fixture); not bridged from Arc USDC' },
      disposition: { platformFee, spokeQuoteReserve: spokeReserve, stepBudgets, operatorReimbursable: native, unspentBudget: stepBudgets - native },
      nativeOperatorCosts: { ...nativeOperatorCosts, note: 'operator gas paid in native currency from the operator account, valued in USDC atoms at the configured rates; not paid from executor USDC' },
      ...(solanaLamports === undefined ? {} : { solanaOperatorLamports: { measured: solanaLamports, note: 'lamports this process measured across its own Solana submissions; not converted to USDC and not reimbursed from the held budgets' } }),
      reconciled: inflow === BigInt(job.total) && held === platformFee + spokeReserve + stepBudgets && native <= stepBudgets,
    }
  }

  /**
   * The Arc executor's USDC against this journal. Expected: completed and partial jobs' payments less
   * their Arc pool quote, plus residuals of released jobs not yet refunded, less executed operator
   * sends. Anything else on the executor is unattributed (an unsolicited deposit, or another journal
   * sharing the executor) and is reported separately, never assigned to a job.
   */
  async function executorUsdc() {
    const at = await finalBlock('arc')
    const balance = await clients.arc.readContract({ address: config.arc.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [config.arc.executor], blockNumber: at })
    let jobs = 0n
    for (const { data } of db.query<{ data: string }, []>('SELECT data FROM jobs').all()) {
      const job = JSON.parse(data) as Job
      const paid = job.steps.find((s) => s.id === 'payment:arc')
      if (paid?.state !== 'complete') continue
      const pool = job.steps.find((s) => s.id === 'pool:arc')!
      jobs += BigInt(paid.result!.amount!) - (pool.state === 'complete' ? BigInt(pool.result!.quoteAmount!) : 0n)
    }
    const residuals = owed()
    let operator = 0n
    for (const o of db.query<{ operation: Hex; bytes: string }, []>("SELECT operation, bytes FROM multispoke_ops WHERE kind='operator'").all()) {
      if (await executed('arc', o.operation, at) !== ZERO) operator += usdcOut((JSON.parse(o.bytes) as Plan).calls)
    }
    const expected = jobs + residuals - operator
    return { block: at, balance, jobs, residualsOwed: residuals, operatorSends: operator, expected, unattributed: balance - expected }
  }

  /** The public record: the runner's projection, corrected for released jobs and completed jobs' USDC. */
  function view(job: Job) {
    const v = publicJob(job)
    const l = ledgerOf(job.id)
    if (l) {
      const refund = refundStatus(l)
      const held = l.refund === 'owed' || l.refund === 'submitted' ? l.residual : '0'
      const refundable = refund.state === 'owed'
      return { ...v, error: slot(job.id)?.released_reason ? failed(job.id).message : v.error,
        // Only the job's own authorization counts as its payment; other terms' funds are held for the payer, never paid.
        funds: { ...v.funds, paid: l.outcome === 'used_outside_job' ? l.received : '0', heldForPayer: held, feesSpent: l.fees_spent, unallocatedHeld: held, determinate: true, refundable,
          refundableAmount: refundable ? l.residual : '0', unresolvedEffects: [],
          note: l.received === '0' ? `Released (${l.outcome}): nothing reached the executor under this job's authorization.` : `Released (${l.outcome}): ${l.received} reached the executor outside the job; residual ${l.residual}, refund ${refund.state}.${held === '0' ? '' : ' No other job or operator send may spend it.'}` },
        attribution: { outcome: l.outcome, authorized: l.authorized, received: l.received, feesSpent: l.fees_spent, residual: l.residual, evidence: { transaction: l.evidence_tx, block: l.evidence_block }, refund } }
    }
    const account = usdcAccount(job)
    if (!account) return v
    const s = (x: bigint) => x.toString()
    return { ...v, funds: { ...v.funds, quoteInventoryDeployed: s(account.usdcSpent.arcPool),
      spokeQuoteInjected: Object.fromEntries(Object.entries(account.spokeQuoteInjected).filter(([k]) => k !== 'source').map(([k, x]) => [k, String(x)])),
      ...(account.solanaOperatorLamports ? { solanaOperatorLamports: s(account.solanaOperatorLamports.measured) } : {}),
      feesSpent: '0', nativeOperatorCosts: s(account.disposition.operatorReimbursable), unallocatedHeld: s(account.held), heldOnExecutor: s(account.held),
      disposition: Object.fromEntries(Object.entries(account.disposition).map(([k, x]) => [k, s(x)])), reconciled: account.reconciled,
      note: 'Arc USDC: paid in, Arc pool quote out, the rest held on the executor. Spoke pool quote was injected from spoke inventory; operator gas was paid natively and is reimbursable from the held step budgets.' } }
  }

  /**
   * One job's supply across all three chains, read from chain state only. In flight is a spoke
   * whose debit executed on Arc while its credit has not executed on the spoke. Canonical tokens
   * outside custody, both representations and in-flight claims must sum to the fixed issuance, and
   * custody must back exactly the representations plus in-flight claims.
   */
  async function supply(job: Job) {
    const L = layout(job, config)
    const orZero = (read: Promise<bigint>) => read.catch((cause: unknown) => {
      // Not deployed yet: nothing issued there.
      if (cause instanceof BaseError && cause.walk((e) => e instanceof ContractFunctionZeroDataError)) return 0n
      throw cause
    })
    const totalSupply = (side: Side, address: Address) => orZero(clients[side].readContract({ address, abi: erc20Abi, functionName: 'totalSupply' }))
    const issued = await totalSupply('arc', L.canonical)
    const custody = await orZero(clients.arc.readContract({ address: L.canonical, abi: erc20Abi, functionName: 'balanceOf', args: [L.hub.proxy] }))
    const spokes: Record<string, bigint> = { base: await totalSupply('base', L.spokes.base.token), robinhood: await totalSupply('robinhood', L.spokes.robinhood.token) }
    const inFlight: Record<string, bigint> = { base: 0n, robinhood: 0n }
    for (const s of SPOKES) {
      const debited = await executed('arc', L.op(`debit:${s}`), 'latest') !== ZERO
      const credited = await executed(s, L.op(`credit:${s}`), 'latest') !== ZERO
      if (debited && !credited) inFlight[s] = BigInt(destination(job.request, s).amount)
    }
    let solanaLedger: { mint: string | null; supply: bigint; custody: bigint } | undefined
    let queued = 0n
    if (solana) {
      // The SPL mint's own supply; in flight is a debit executed on Arc whose inbox item is not released.
      // A held claim is part of in flight: locked on Arc, not minted. It is reported beside it, never added again.
      solanaLedger = await solana.ledger(job)
      spokes.solana = solanaLedger.supply
      const debited = await executed('arc', L.op('debit:solana'), 'latest') !== ZERO
      const credit = job.steps.find((s) => s.id === 'credit:solana')!
      const plan = credit.prepared ? parseSolana(credit.prepared, credit, job) : undefined
      const released = plan?.kind === 'credit' ? await solana.released(job, plan.digest) : false
      inFlight.solana = debited && !released ? BigInt(destination(job.request, 'solana').amount) : 0n
      if (credit.claim && credit.state !== 'complete' && !released) queued = BigInt(credit.claim.amount)
    }
    const remote = Object.values(spokes).reduce((n, x) => n + x, 0n)
    const pending = Object.values(inFlight).reduce((n, x) => n + x, 0n)
    const outside = issued - custody
    // A burning spoke holds nothing in custody; anything there is unexplained and fails reconciliation.
    const spokeCustodyClean = (solanaLedger?.custody ?? 0n) === 0n
    return { issued, custody, spokes, inFlight, outside, accounted: outside + remote + pending, ...(solanaLedger ? { queued, solanaMint: solanaLedger.mint, solanaSpokeCustody: solanaLedger.custody } : {}),
      reconciled: issued === BigInt(job.request.canonical.issuance) && outside + remote + pending === issued && custody === remote + pending && spokeCustodyClean }
  }

  const adapter: PromotionalTokenAdapter & {
    clients: Record<Side, PublicClient>; verify(): Promise<void>; supply: typeof supply; slot: typeof slot; ledger: typeof ledgerOf; refundStatus(job: string): RefundStatus | undefined
    explain(job: string): string | undefined; refund: typeof refund; operatorSend: typeof operatorSend; usdcAccount: typeof usdcAccount; executorUsdc: typeof executorUsdc; view: typeof view
  } = {
    mode: 'fork',
    version,
    clients,
    supply,
    slot,
    ledger: ledgerOf,
    refundStatus: (job) => { const l = ledgerOf(job); return l ? refundStatus(l) : undefined },
    /** A released job's error as of now. The job's stored error is a snapshot and goes stale once a refund moves. */
    explain: (job) => (slot(job)?.released_reason ? failed(job).message : undefined),
    refund,
    operatorSend,
    usdcAccount,
    executorUsdc,
    view,
    terms: { chainId: config.arc.chainId, asset: config.arc.usdc, payTo: config.arc.executor, name: 'USDC', version: '2' },
    assertReady(request) {
      if (request.destinations.map((d) => d.chain).join(',') !== route) {
        throw new LaunchError(503, 'route_closed', solana
          ? 'This fork composition fulfils exactly Arc, Base, Solana and Robinhood in one job; single-spoke launches run in their own harnesses.'
          : 'This fork composition fulfils exactly Arc, Base and Robinhood in one job. Solana is closed here; single-spoke launches run in their own harnesses.')
      }
      // The hub's outbound limit is shared by every peer. Solana's own inbound limit may hold a claim; that is a delay, not a refusal.
      if (solana && BigInt(destination(request, 'solana').amount) > config.limits.outbound) throw new LaunchError(409, 'rate_limit', 'The solana allocation exceeds the hub outbound rate limit and would queue on Arc.')
      for (const s of SPOKES) {
        const amount = BigInt(destination(request, s).amount)
        if (amount > config.limits.inbound || amount > config.limits.outbound) throw new LaunchError(409, 'rate_limit', `The ${s} allocation exceeds the configured NTT rate limit and would queue.`)
      }
      const gone = releasedFor(identity(request))
      if (gone) throw failed(gone.job)
      // Fast refusal before a quote or charge. The payment step re-checks atomically.
      if (config.launches !== undefined) {
        const taken = holders('').filter((h) => h.identity !== identity(request) && live(h))
        if (taken.length >= config.launches) throw new LaunchError(409, 'launch_limit', `${taken.length} launch(es) already hold the approved slot(s). Nothing was charged.`)
      }
    },
    budgets: () => config.budgets,
    async verify() {
      for (const side of sides) {
        const c = chain(side)
        if (await clients[side].getChainId() !== c.chainId) throw new Error(`${side} RPC reports a different chain id`)
        if (await clients[side].readContract({ address: c.core, abi: coreAbi, functionName: 'chainId' }) !== c.wormholeChainId) throw new Error(`${side} Wormhole core reports a different chain`)
        const owner = await clients[side].readContract({ address: c.executor, abi: executorAbi, functionName: 'owner' })
        if (!same(owner, account.address)) throw new Error(`${side} executor is owned by ${owner}, not the operator ${account.address}`)
        const factory = await clients[side].readContract({ address: c.executor, abi: executorAbi, functionName: 'v3Factory' })
        if (!same(factory, side === 'arc' ? zeroAddress : config.spokes[side].venue.factory)) throw new Error(`${side} executor v3 factory differs from the venue`)
      }
      await solana?.verify()
    },
    async prepare(context) {
      if (laneOf(context.step) === 'solana') {
        const L = layout(context.job, config)
        const operation = L.op(context.step.id)
        const bytes = JSON.stringify({ side: 'solana', operation, plan: solana!.plan(context.job, context.step, operation, { manager: L.hub.proxy, transceiver: L.hub.transceiver }, publishedFor(context.job)) })
        return { operation, digest: hash(bytes), bytes }
      }
      const p = await plan(context)
      const bytes = JSON.stringify(p)
      return { operation: p.operation, digest: hash(bytes), bytes }
    },
    async observe({ job, step }, prepared) {
      if (laneOf(step) === 'solana') return solana!.observe(job, prepared.operation, parseSolana(prepared, step, job))
      const p = parse(prepared, step, job)
      const client = clients[p.side]
      const final = await finalBlock(p.side)
      const atFinal = await executed(p.side, p.operation, final)
      if (atFinal !== ZERO) {
        if (atFinal !== prepared.digest) throw new LaunchError(409, 'operation_conflict', `${step.id} already executed with other bytes (${atFinal}).`)
        const [log] = await client.getLogs({ address: p.executor, event: executorAbi.find((x) => x.type === 'event' && x.name === 'Executed')!, args: { operation: p.operation }, fromBlock: BigInt(p.fromBlock), toBlock: final }) as { transactionHash: Hex }[]
        if (!log) throw new Error(`${step.id} executed but has no log in the searched range`)
        if (step.kind === 'payment') db.query('UPDATE multispoke_launches SET settled=1 WHERE job=?').run(job.id)
        return result(p, job, step, await client.getTransactionReceipt({ hash: log.transactionHash }))
      }
      // Executed but not yet final, or a submission still in the mempool: pending, never absent.
      const current = await executed(p.side, p.operation, 'latest')
      if (current === prepared.digest) return 'pending'
      if (current !== ZERO) throw new LaunchError(409, 'operation_conflict', `${step.id} already executed with other bytes (${current}).`)
      for (const { tx } of db.query<{ tx: string }, [string]>('SELECT tx FROM multispoke_broadcasts WHERE operation=?').all(p.operation)) {
        if (await client.getTransaction({ hash: tx as Hex }).then((t) => t.blockNumber === null, () => false)) return 'pending'
      }
      if (step.kind === 'payment') {
        // Absent and provably never payable: release the slot and refuse this job for good.
        if (slot(job.id)?.released_reason) throw failed(job.id)
        const s = slot(job.id) ?? slotOf(job)
        const why = await unsettleable(job.id, s)
        if (why) { release(job.id, s, why); throw failed(job.id) }
      }
      return 'absent'
    },
    async broadcast({ job, step }, prepared) {
      if (laneOf(step) === 'solana') return solana!.submit(job, prepared.operation, parseSolana(prepared, step, job))
      const p = parse(prepared, step, job)
      if (step.kind === 'payment') await takeSlot(job)
      await send(p, prepared.digest, step.id, BigInt(step.budget))
    },
  }
  return adapter
}
export type MultispokeAdapter = ReturnType<typeof multispokeAdapter>
