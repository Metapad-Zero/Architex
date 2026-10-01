import type { Database } from 'bun:sqlite'
import { decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, parseAbi, parseSignature, zeroAddress, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { hash, identity } from '../request'
import { LaunchError, type Atoms, type EffectContext, type EffectResult, type Job, type LaunchRequest, type PreparedEffect, type PromotionalTokenAdapter, type Step, type StepKind } from '../types'
import { architexFactoryAbi, architexPairAbi, erc20Abi, nttAbi, usdcAbi, v3FactoryAbi, v3PoolAbi } from '../evm/contracts'
import { plan as v3Plan } from '../evm/v3'
import { robinhoodRoute, type RobinhoodRoute, type RobinhoodRouteConfig, type Side } from './route'

/**
 * FORK-ONLY launch-job adapter for the Robinhood spoke. It runs the shared-supply launch job
 * (payment -> canonical -> Arc manager -> Arc pool -> Robinhood manager -> debit -> credit ->
 * Robinhood pool) through the route engine in route.ts, against the EXISTING canonical asset the
 * route configuration names. Nothing here opens a public route: the route engine refuses any
 * non-loopback RPC and the public adapter in adapter.ts stays closed.
 *
 * Two journals meet here and neither is trusted on its own. The job store fences workers with a
 * lease; the route journal persists each executor operation's bytes before sending. What makes a
 * second charge, issuance, debit, credit or pool deposit impossible is the destination: every
 * effect is one `EquilibriumExecutor.execute(operation, digest, calls)` and the executor refuses a
 * second execution of an operation on-chain, so a stale worker, a restarted process or a replayed
 * transaction finds the operation done instead of doing it again.
 *
 * The asset is reserved for one job from its payment step onward. The reservation moves to another
 * job only once chain state proves the holder's payment can never settle: at a block `confirmations`
 * deep its operation is unexecuted and the authorization has expired or its nonce is spent. A
 * released job is refused at every later step, so it cannot charge or fulfil after ownership moves.
 * A send whose outcome is unknown keeps the reservation and stays observable for the sweep.
 *
 * A spent nonce is not by itself proof of anything about money. Before a spent-nonce release, the
 * finalized log that spent it is found and the transfer in that transaction is matched against the
 * job's bound payer, executor, amount and nonce. Whatever reached the executor is recorded against
 * the ORIGINAL job in robinhood_payment_ledger (received, fees spent, residual, refund obligation) in
 * the same transaction as the release; so is USDC an authorization with other terms moved to the
 * executor under the same nonce, which is never accepted as the launch payment. Owed residuals are
 * excluded from the executor's spendable USDC, so a successor cannot fund its own steps with them;
 * only `refund` moves them, back to the payer, as one executor operation per job that can execute
 * at most once.
 *
 * Spendable USDC is coordinated through the shared journal, not a process: every Arc send that moves
 * executor USDC first records a durable claim (robinhood_usdc_claims), then checks the executor's
 * balance at a block `confirmations` deep against owed residuals and every other claim not yet
 * executed at that depth — pending, uncertain or sent by another process. A claim is dropped only if
 * its send provably never left; otherwise it counts until its execution is final.
 */
export interface RobinhoodFulfillmentConfig {
  route: RobinhoodRouteConfig
  /** Arc payment asset (EIP-3009) and the Architex pair factory for the Arc pool. */
  arc: { usdc: Address; factory: Address }
  /** USDC atoms per 1e18 wei of native gas. Arc gas is native USDC with 18 decimals: 1_000_000. */
  pricing: { arc: bigint; robinhood: bigint }
  budgets: Record<StepKind, Atoms>
  /** Carried into the adapter version and every public response, so fixtures are never mistaken for funds. */
  labels: FulfillmentLabels
}
export interface FulfillmentLabels {
  environment: RobinhoodRouteConfig['environment']
  payment: string
  quoteInventory: string
  gas: string
}
export interface FulfillmentOptions { afterSend?: (stepId: string) => void }

/** The exact label set this adapter accepts. A configuration cannot relabel a fixture as funds. */
export const FULFILLMENT_LABELS: FulfillmentLabels = {
  environment: 'mixed:arc-testnet-fork+robinhood-mainnet-fork',
  payment: 'fork-fixture: ForkUsdc (EIP-3009) at the Arc native USDC address on an Arc testnet fork; the payer is an anvil development key; no real funds move',
  quoteInventory: 'fork-fixture: Robinhood pool quote is USDG credited to the executor by storage write; the payer\'s Arc USDC for it is not bridged (no CCTP domain on Robinhood)',
  gas: 'Arbitrum Orbit gas (including its L1 component) is not modelled; Robinhood costs are fork-local L2 execution priced at a fixed ETH/USDC rate',
}

const ZERO: Hex = `0x${'0'.repeat(64)}`
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const call = (target: Address, data: Hex, value = 0n) => ({ target, value: value.toString(), data })
const destination = (request: LaunchRequest, chain: 'arc' | 'robinhood') => request.destinations.find((d) => d.chain === chain)

/** The job holding the asset, with what decides whether its payment can still settle. */
interface Reservation { identity: string; job: string; payer: string; value: string | null; valid_before: number; settled: number }
/** Why a job's payment can never settle, with what (if anything) its authorization moved. */
interface Unsettleable {
  reason: string
  /** The Arc block `confirmations` deep at which this was decided. */
  block: string
  outcome: 'expired_unused' | 'cancelled' | 'used_outside_job' | 'spent_by_other_authorization'
  /**
   * USDC atoms that reached the Arc executor under this job's nonce: the bound payment for
   * `used_outside_job`, or whatever other terms sent there for `spent_by_other_authorization`.
   */
  received: string
  /** The transaction that spent the nonce, when one did. */
  evidence: string | null
}
/**
 * The original job's money after a release. `refund` is 'none' when nothing arrived, 'owed' while
 * the residual sits on the executor, 'submitted' once the refund operation executed but is not yet
 * `confirmations` deep, and 'refunded' only with that finalized receipt. Between 'owed' and
 * 'submitted' a refund may already be prepared or on the wire; `refundStatus` reports that.
 */
export interface PaymentLedger {
  job: string
  asset: string
  payer: string
  outcome: Unsettleable['outcome']
  authorized: string
  received: string
  fees_spent: string
  residual: string
  evidence_tx: string | null
  evidence_block: string
  refund: 'none' | 'owed' | 'submitted' | 'refunded'
  refund_tx: string | null
  refund_block: string | null
  recorded_at: number
}
/**
 * What is known about a released job's refund now. 'prepared': the refund operation is journalled
 * and may have been sent; 'uncertain': it was handed to the RPC in `transaction` with no executed
 * receipt yet; 'submitted': executed in `transaction` at `block`, not yet final; 'refunded': final.
 */
export interface RefundStatus { state: 'none' | 'owed' | 'prepared' | 'uncertain' | 'submitted' | 'refunded'; transaction: string | null; block: string | null }
const authorizationEvents = parseAbi(['event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)', 'event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)'])
/** Route errors that leave a send's outcome unknown. The step is observed again, never re-planned. */
const UNCERTAIN = new Set(['broadcast_uncertain', 'pending', 'pending_dropped'])

/** What the job persists for a step: the route operation it runs and that operation's exact bytes. */
interface Binding {
  environment: string
  job: Hex
  step: string
  name: string
  side: Side
  operation: Hex
  digest: Hex
  plan: string
  transfer?: string
}

/** The Robinhood transfer a job's debit and credit steps drive. One per job, bound to its allocation. */
export const transferId = (job: Pick<Job, 'id'>) => `launch-${job.id.slice(2)}`

export function robinhoodFulfillment(config: RobinhoodFulfillmentConfig, db: Database, options: FulfillmentOptions = {}): PromotionalTokenAdapter & { route: RobinhoodRoute; ledger(job: string): PaymentLedger | undefined; refundStatus(job: string): RefundStatus | undefined; explain(job: string): string | undefined; refund(job: string): Promise<PaymentLedger> } {
  if (JSON.stringify(config.labels) !== JSON.stringify(FULFILLMENT_LABELS)) throw new LaunchError(503, 'route_closed', 'Fulfillment labels differ from the fork fixture labels. Fixtures cannot be relabelled.')
  const names = new Map<string, string>()
  // Every Arc send passes `claim`, whoever calls the route: a job step, a refund or an operator.
  const route = robinhoodRoute(config.route, db, { afterSend: (name) => { const step = names.get(name); if (step) options.afterSend?.(step) },
    guard: (side, name, operation, calls) => side === 'arc' ? claim(name, operation, calls) : Promise.resolve() })
  const L = route.layout
  const { arc, robinhood } = config.route
  const clients: Record<Side, PublicClient> = route.clients
  db.exec(`CREATE TABLE IF NOT EXISTS robinhood_launches (asset TEXT PRIMARY KEY, identity TEXT NOT NULL, job TEXT NOT NULL, payer TEXT NOT NULL, valid_before INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS robinhood_released (job TEXT PRIMARY KEY, asset TEXT NOT NULL, identity TEXT NOT NULL, reason TEXT NOT NULL, block TEXT NOT NULL, released_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS robinhood_payment_ledger (job TEXT PRIMARY KEY, asset TEXT NOT NULL, payer TEXT NOT NULL, outcome TEXT NOT NULL, authorized TEXT NOT NULL, received TEXT NOT NULL,
      fees_spent TEXT NOT NULL, residual TEXT NOT NULL, evidence_tx TEXT, evidence_block TEXT NOT NULL, refund TEXT NOT NULL, refund_tx TEXT, refund_block TEXT, recorded_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS robinhood_usdc_claims (operation TEXT PRIMARY KEY, name TEXT NOT NULL, amount TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL);`)
  // Journals from before attribution lack the bound amount. Such a holder is never attributed a transfer: it cannot be matched.
  if (!db.query("SELECT 1 FROM pragma_table_info('robinhood_launches') WHERE name='value'").get()) db.exec('ALTER TABLE robinhood_launches ADD COLUMN value TEXT')
  const pinned = { labels: config.labels, asset: { ...config.route.asset, issuance: config.route.asset.issuance.toString() }, arc: { chainId: arc.chainId, executor: arc.executor, usdc: config.arc.usdc, factory: config.arc.factory },
    robinhood: { chainId: robinhood.chainId, executor: robinhood.executor, venue: robinhood.venue, quote: robinhood.quote }, limits: { outbound: config.route.limits.outbound.toString(), inbound: config.route.limits.inbound.toString() },
    pricing: { arc: config.pricing.arc.toString(), robinhood: config.pricing.robinhood.toString() }, budgets: config.budgets }
  const version = `robinhood-fork-fulfillment-v1:${hash(pinned).slice(2, 18)}`

  /** Each job step runs one route operation. Canonical and hub are the asset's; the rest are the job's. */
  function nameOf(job: Job, step: Step): { name: string; side: Side } {
    if (step.id === 'canonical:arc' || step.id === 'manager:arc' || step.id === 'manager:robinhood') return { name: step.id, side: step.chain as Side }
    if (step.id === 'debit:robinhood') return { name: `transfer:${transferId(job)}:debit`, side: 'arc' }
    if (step.id === 'credit:robinhood') return { name: `transfer:${transferId(job)}:credit`, side: 'robinhood' }
    if (step.id === 'payment:arc' || step.id === 'pool:arc' || step.id === 'pool:robinhood') return { name: `job:${job.id}:${step.id}`, side: step.chain as Side }
    throw new Error(`No Robinhood fulfillment plan for ${step.id}`)
  }
  const persisted = (name: string) => db.query<{ digest: Hex }, [string]>('SELECT digest FROM robinhood_ops WHERE operation=?').get(L.op(name))
  const boundJob = () => db.query<Reservation, [string]>('SELECT identity, job, payer, value, valid_before, settled FROM robinhood_launches WHERE asset=?').get(config.route.asset.id)
  const released = (job: string) => db.query<{ reason: string; block: string }, [string]>('SELECT reason, block FROM robinhood_released WHERE job=?').get(job)
  const ledgerOf = (job: string) => db.query<PaymentLedger, [string]>('SELECT * FROM robinhood_payment_ledger WHERE job=?').get(job) ?? undefined
  /** Residual USDC on the Arc executor that belongs to released jobs and has not provably left it. */
  const owed = (except?: string) => db.query<{ residual: string; job: string }, []>("SELECT residual, job FROM robinhood_payment_ledger WHERE refund IN ('owed','submitted')").all()
    .filter((r) => r.job !== except).reduce((n, r) => n + BigInt(r.residual), 0n)
  /** The released job's error, stating what its authorization actually did with the payer's money. */
  function failed(job: string, why: { reason: string; block: string }) {
    const l = ledgerOf(job)
    const head = `Job ${job}'s payment can never settle (${why.reason} at Arc block ${why.block}); its asset reservation was released.`
    if (!l) return new LaunchError(409, 'payment_failed', `${head} No payment attribution was recorded for it; read the executor's USDC history before assuming nothing was charged. Start a new request.`)
    if (l.outcome === 'expired_unused') return new LaunchError(409, 'payment_failed', `${head} Its authorization was never used: nothing was charged. Start a new request.`)
    if (l.outcome === 'cancelled') return new LaunchError(409, 'payment_failed', `${head} The payer cancelled its authorization in ${l.evidence_tx}: nothing was charged. Start a new request.`)
    const r = refundStatus(l)
    const refund = {
      none: '',
      owed: `Residual ${l.residual}: refund owed to ${l.payer}; no refund has been sent. It is held for this job and no other job may spend it.`,
      prepared: `Residual ${l.residual}: a refund to ${l.payer} is prepared and may already have been sent; its outcome is unknown. It stays held for this job until the refund is final.`,
      uncertain: `Residual ${l.residual}: a refund to ${l.payer} was sent in ${r.transaction} and has not executed yet; its outcome is unknown. It stays held for this job until the refund is final.`,
      submitted: `Residual ${l.residual}: refunded to ${l.payer} in ${r.transaction} at Arc block ${r.block}, not yet final. It stays held for this job until then.`,
      refunded: `Residual ${l.residual}: refunded to ${l.payer} in ${r.transaction}, final at Arc block ${r.block}. Nothing of it remains on the executor.`,
    }[r.state]
    if (l.outcome === 'spent_by_other_authorization') {
      if (l.received === '0') return new LaunchError(409, 'payment_failed', `${head} Its nonce was spent in ${l.evidence_tx} by an authorization with other terms, and none of that transfer reached the executor. Nothing is attributed to this job. Start a new request.`)
      return new LaunchError(409, 'payment_failed', `${head} Its nonce was spent in ${l.evidence_tx} by an authorization with other terms, which moved ${l.received} USDC atoms to the Arc executor. That is not this job's payment and fulfilled nothing. ${refund} Start a new request.`)
    }
    return new LaunchError(409, 'payment_failed', `${head} Its authorization was used outside the job in ${l.evidence_tx}: ${l.received} USDC atoms reached the Arc executor and nothing was fulfilled. Fees spent: ${l.fees_spent}. ${refund} Start a new request.`)
  }
  const refundName = (job: string) => `job:${job}:refund:arc`
  /** The ledger's state, refined by the journal: a refund can be on the wire before its receipt is read. */
  function refundStatus(l: PaymentLedger): RefundStatus {
    if (l.refund === 'none' || l.refund === 'submitted' || l.refund === 'refunded') return { state: l.refund, transaction: l.refund_tx, block: l.refund_block }
    const op = db.query<{ tx: string | null }, [string]>('SELECT tx FROM robinhood_ops WHERE operation=?').get(L.op(refundName(l.job)))
    if (!op) return { state: 'owed', transaction: null, block: null }
    return op.tx ? { state: 'uncertain', transaction: op.tx, block: null } : { state: 'prepared', transaction: null, block: null }
  }

  /** Refuse any work for a job that does not hold the asset. A released job never reacquires it. */
  function assertOwner(job: Job) {
    const gone = released(job.id)
    if (gone) throw failed(job.id, gone)
    const bound = boundJob()
    if (!bound || bound.job !== job.id) throw new LaunchError(409, 'asset_launched', `Job ${job.id} does not hold asset ${config.route.asset.id}${bound ? `; job ${bound.job} does` : ''}. Nothing was sent.`)
  }

  /**
   * Why a reserved payment can never settle, or null while it still could (or while that cannot yet
   * be proven). Read at one block `confirmations` deep: the operation is unexecuted there, and either
   * the nonce is spent — by a finalized, identified transaction whose transfer is matched against the
   * bound terms — or the authorization's validBefore has passed unused (block time only grows).
   * Either way no later block can execute it, and its persisted bytes revert if anyone resends them.
   */
  async function unsettleable(job: string, r: Pick<Reservation, 'payer' | 'value' | 'valid_before'>): Promise<Unsettleable | null> {
    const latest = await clients.arc.getBlockNumber({ cacheTime: 0 })
    const at = latest - BigInt(arc.confirmations)
    if (await route.digestOf('arc', L.op(`job:${job}:payment:arc`), at) !== ZERO) {
      db.query('UPDATE robinhood_launches SET settled=1 WHERE job=?').run(job)
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
   * attributed only if the same transaction transferred exactly the bound amount from the payer to
   * the Arc executor. Anything less certain returns null, which keeps the reservation.
   */
  async function spentBy(job: string, r: Pick<Reservation, 'payer' | 'value'>, at: bigint, spentAt: (b: bigint) => Promise<boolean>): Promise<Unsettleable | null> {
    let hi = at; let lo = at; let step = 1n
    while (true) {
      if (lo === 0n) return null
      lo = lo > step ? lo - step : 0n
      if (!await spentAt(lo)) break
      hi = lo; step *= 2n
    }
    while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if (await spentAt(mid)) hi = mid; else lo = mid }
    const logs = (await Promise.all(authorizationEvents.map((event) => clients.arc.getLogs({ address: config.arc.usdc, event, args: { authorizer: r.payer as Address, nonce: job as Hex }, fromBlock: hi, toBlock: hi })))).flat()
    if (logs.length !== 1) return null
    const [log] = logs
    const base = { block: at.toString(), evidence: log.transactionHash }
    if (log.eventName === 'AuthorizationCanceled') return { ...base, reason: 'authorization cancelled', outcome: 'cancelled', received: '0' }
    const receipt = await clients.arc.getTransactionReceipt({ hash: log.transactionHash })
    if (receipt.status !== 'success') return null
    // The transfer the authorization made follows its AuthorizationUsed log in the same transaction.
    const moved = receipt.logs.filter((l) => same(l.address, config.arc.usdc) && l.logIndex > log.logIndex).flatMap((l) => {
      try {
        const e = decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics })
        return e.eventName === 'Transfer' && same(e.args.from, r.payer) ? [e.args] : []
      } catch { return [] }
    })[0]
    if (!moved) return null
    if (r.value !== null && same(moved.to, arc.executor) && moved.value === BigInt(r.value)) return { ...base, reason: 'authorization used outside the job', outcome: 'used_outside_job', received: moved.value.toString() }
    // Other terms are not this job's payment, but money they moved onto the executor is still the payer's and is held for return.
    return { ...base, reason: 'authorization nonce spent by other terms', outcome: 'spent_by_other_authorization', received: same(moved.to, arc.executor) ? moved.value.toString() : '0' }
  }
  /**
   * Move the job out of the reservation and record its money, in one transaction. Idempotent: the
   * first decision stands, and only the named job's row is ever removed. The released job ran no
   * executor operation — release requires its payment unexecuted, and every later step requires a
   * completed payment — so it spent no fees and its whole receipt is residual.
   */
  function release(job: string, r: Pick<Reservation, 'payer' | 'value'>, why: Unsettleable) {
    db.transaction(() => {
      const bound = boundJob()
      if (bound?.job === job) db.query('DELETE FROM robinhood_launches WHERE asset=? AND job=?').run(config.route.asset.id, job)
      db.query('INSERT OR IGNORE INTO robinhood_released(job, asset, identity, reason, block, released_at) VALUES(?,?,?,?,?,?)').run(job, config.route.asset.id, bound?.job === job ? bound.identity : '', why.reason, why.block, Date.now())
      db.query(`INSERT OR IGNORE INTO robinhood_payment_ledger(job, asset, payer, outcome, authorized, received, fees_spent, residual, evidence_tx, evidence_block, refund, recorded_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(job, config.route.asset.id, r.payer, why.outcome, r.value ?? 'unknown', why.received, '0', why.received, why.evidence, why.block, BigInt(why.received) > 0n ? 'owed' : 'none', Date.now())
    }).immediate()
  }
  /**
   * Arc USDC a plan sends out of the executor. Plans make only plain transfers (outflows) and the
   * payment's transferWithAuthorization (an inflow from the payer); any other USDC call is refused.
   */
  function usdcOut(calls: { target: Address; data: Hex }[]) {
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
   * the other's claim. Funds are read at a block `confirmations` deep; any claim not executed at that
   * depth (in the mempool, uncertain, or sent by another process) is subtracted, as are residuals
   * owed to released jobs except the one this send refunds. Any failure to establish this — an RPC
   * error included — refuses the send. Returns an undo for the case where nothing was then sent.
   */
  async function claim(name: string, operation: Hex, calls: { target: Address; data: Hex }[]): Promise<(() => void) | void> {
    const out = usdcOut(calls)
    if (out === 0n) return
    const fresh = db.query("INSERT OR IGNORE INTO robinhood_usdc_claims(operation, name, amount, state, created_at) VALUES(?,?,?,'pending',?)").run(operation, name, out.toString(), Date.now()).changes > 0
    const drop = () => { if (fresh) db.query("DELETE FROM robinhood_usdc_claims WHERE operation=? AND state='pending'").run(operation) }
    try {
      const at = await clients.arc.getBlockNumber({ cacheTime: 0 }) - BigInt(arc.confirmations)
      const pending = db.query<{ operation: Hex; amount: string }, [string]>("SELECT operation, amount FROM robinhood_usdc_claims WHERE state='pending' AND operation<>?").all(operation)
      let others = 0n
      for (const c of pending) {
        // Executed at the depth read below: already in that balance, and final from now on.
        if (await route.digestOf('arc', c.operation, at) !== ZERO) db.query("UPDATE robinhood_usdc_claims SET state='final' WHERE operation=?").run(c.operation)
        else others += BigInt(c.amount)
      }
      const held = await clients.arc.readContract({ address: config.arc.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [arc.executor], blockNumber: at })
      const refunding = /^job:(0x[0-9a-f]{64}):refund:arc$/.exec(name)?.[1]
      const reserved = owed(refunding)
      if (held - reserved - others < out) {
        throw new LaunchError(409, 'residual_reserved', `At Arc block ${at} the executor holds ${held} USDC atoms; ${reserved} are owed to released jobs and ${others} are claimed by sends not yet final. ${name} needs ${out}. Nothing was sent.`)
      }
    } catch (cause) {
      drop()
      if (cause instanceof LaunchError) throw cause
      throw new LaunchError(503, 'residual_reserved', `Executor USDC for ${name} could not be established (${cause instanceof Error ? cause.message.split('\n')[0] : 'unreadable'}). Nothing was sent.`)
    }
    return drop
  }

  /** eth_call as the executor, returning the address a factory call would create. */
  async function dryRun(side: Side, to: Address, data: Hex): Promise<Address> {
    const executor = config.route[side].executor
    const { data: out } = await clients[side].call({ account: executor, to, data, stateOverride: [{ address: executor, balance: 10n ** 24n }] })
    if (!out || out.length < 66) throw new Error(`Dry run of ${to} returned no address`)
    return getAddress(`0x${out.slice(26, 66)}`)
  }

  async function build(job: Job, step: Step): Promise<{ operation: Hex; digest: Hex; bytes: string; transfer?: string }> {
    const { name, side } = nameOf(job, step)
    if (step.id !== 'payment:arc') assertOwner(job)
    const refuse = (): never => { throw new LaunchError(409, 'asset_missing', `${name} is not persisted: the existing canonical asset ${config.route.asset.id} must be deployed before a launch job adopts it.`) }
    if (step.id === 'canonical:arc' || step.id === 'manager:arc') return route.persist(name, side, refuse)
    if (step.id === 'manager:robinhood') return route.persist(name, side, route.spokeCalls)
    if (step.id === 'payment:arc') {
      const payment = job.payment
      if (!payment) throw new Error('Payment step without a verified authorization')
      const a = payment.authorization
      if (!same(a.to, arc.executor)) throw new Error('Authorization does not pay the Arc executor')
      const gone = released(job.id)
      if (gone) throw failed(job.id, gone)
      // A holder whose payment can provably never settle gives way; any other holder keeps the asset.
      const holder = boundJob()
      if (holder && holder.job !== job.id) {
        const why = holder.settled ? null : await unsettleable(holder.job, holder)
        if (!why) throw new LaunchError(409, 'asset_launched', `Asset ${config.route.asset.id} is already launched by job ${holder.job}. Nothing was charged.`)
        release(holder.job, holder, why)
      }
      // Bind the asset to this job before anything can settle. The loser of a race is refused uncharged.
      db.transaction(() => {
        const bound = boundJob()
        if (bound && bound.job !== job.id) throw new LaunchError(409, 'asset_launched', `Asset ${config.route.asset.id} is already launched by job ${bound.job}. Nothing was charged.`)
        if (!bound) db.query('INSERT INTO robinhood_launches(asset, identity, job, payer, value, valid_before, created_at) VALUES(?,?,?,?,?,?,?)').run(config.route.asset.id, job.identity, job.id, a.from, a.value, Number(a.validBefore), Date.now())
      }).immediate()
      const { r, s, v } = parseSignature(payment.signature)
      return route.persist(name, side, () => [call(config.arc.usdc, encodeFunctionData({ abi: usdcAbi, functionName: 'transferWithAuthorization',
        args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, Number(v ?? 27n), r, s] }))])
    }
    if (step.id === 'pool:arc') {
      const d = destination(job.request, 'arc')!
      return route.persist(name, side, async () => {
        const calls = []
        let pair = await clients.arc.readContract({ address: config.arc.factory, abi: architexFactoryAbi, functionName: 'getPair', args: [L.canonical, config.arc.usdc] })
        if (pair === zeroAddress) {
          const create = encodeFunctionData({ abi: architexFactoryAbi, functionName: 'createPair', args: [L.canonical, config.arc.usdc] })
          pair = await dryRun('arc', config.arc.factory, create)
          calls.push(call(config.arc.factory, create))
        }
        calls.push(call(L.canonical, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [pair, BigInt(d.poolTokens)] })),
          call(config.arc.usdc, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [pair, BigInt(d.poolQuote)] })),
          call(pair, encodeFunctionData({ abi: architexPairAbi, functionName: 'mint', args: [arc.executor] })))
        // Custody leaves the executor here: the Arc recipient's remainder, then whatever no destination claimed.
        const remainder = BigInt(d.amount) - BigInt(d.poolTokens)
        if (remainder > 0n) calls.push(call(L.canonical, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [d.recipient as Address, remainder] })))
        const unallocated = BigInt(job.request.canonical.issuance) - job.request.destinations.reduce((n, x) => n + BigInt(x.amount), 0n)
        if (unallocated > 0n) calls.push(call(L.canonical, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [job.request.canonical.recipient, unallocated] })))
        return calls
      })
    }
    if (step.id === 'debit:robinhood') {
      const id = transferId(job)
      // The credit mints to the Robinhood executor, which seeds the pool and forwards the remainder.
      const t = route.transfer(id, 'outbound', BigInt(destination(job.request, 'robinhood')!.amount), robinhood.executor)
      const leg = route.leg(t, 'debit')
      return { ...await route.persist(leg.name, leg.side, leg.build), transfer: id }
    }
    if (step.id === 'credit:robinhood') {
      const id = transferId(job)
      const t = route.get(id)
      if (!t?.vaa) throw new Error(`Transfer ${id} is not attested; the credit cannot be planned`)
      const leg = route.leg(t, 'credit')
      return { ...await route.persist(leg.name, leg.side, leg.build), transfer: id }
    }
    // pool:robinhood — a new v3 pool against the provisional quote fixture, then the recipient's remainder.
    const d = destination(job.request, 'robinhood')!
    return route.persist(name, side, async () => {
      const venue = robinhood.venue
      const existing = await clients.robinhood.readContract({ address: venue.factory, abi: v3FactoryAbi, functionName: 'getPool', args: [L.spoke, robinhood.quote, venue.fee] })
      if (existing !== zeroAddress) throw new LaunchError(409, 'pool_exists', `A ${venue.fee} pool for the spoke already exists at ${existing}; refusing to seed a pool this job did not create.`)
      const create = encodeFunctionData({ abi: v3FactoryAbi, functionName: 'createPool', args: [L.spoke, robinhood.quote, venue.fee] })
      const pool = await dryRun('robinhood', venue.factory, create)
      const tokenFirst = L.spoke.toLowerCase() < robinhood.quote.toLowerCase()
      const total0 = BigInt(tokenFirst ? d.poolTokens : d.poolQuote); const total1 = BigInt(tokenFirst ? d.poolQuote : d.poolTokens)
      const p = v3Plan(total0, total1, venue.tickSpacing)
      const calls = [call(venue.factory, create), call(pool, encodeFunctionData({ abi: v3PoolAbi, functionName: 'initialize', args: [p.sqrtPriceX96] })),
        call(pool, encodeFunctionData({ abi: v3PoolAbi, functionName: 'mint', args: [robinhood.executor, p.lower, p.upper, p.liquidity, encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [total0, total1])] }))]
      const remainder = BigInt(d.amount) - BigInt(d.poolTokens)
      if (remainder > 0n) calls.push(call(L.spoke, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [d.recipient as Address, remainder] })))
      return calls
    })
  }

  function parse({ job, step }: EffectContext, prepared: PreparedEffect): Binding & { plan: string } {
    if (hash(prepared.bytes) !== prepared.digest || prepared.operation !== hash([job.id, step.id])) throw new Error('Prepared bytes changed')
    const b = JSON.parse(prepared.bytes) as Binding
    const expected = nameOf(job, step)
    if (b.job !== job.id || b.step !== step.id || b.name !== expected.name || b.side !== expected.side || b.operation !== L.op(b.name) || hash(b.plan) !== b.digest) throw new Error(`Prepared binding for ${step.id} is inconsistent`)
    // The route journal must hold the same bytes the job holds. A differing row is another plan for the same operation.
    const row = persisted(b.name)
    if (row && row.digest !== b.digest) throw new LaunchError(409, 'operation_conflict', `${b.name} is journalled with other bytes.`)
    names.set(b.name, step.id)
    return b
  }

  function transfersIn(receipt: TransactionReceipt, token: Address) {
    return receipt.logs.filter((l) => same(l.address, token)).flatMap((l) => {
      try {
        const e = decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics })
        return e.eventName === 'Transfer' ? [e.args] : []
      } catch { return [] }
    })
  }
  const sum = (items: { value: bigint }[]) => items.reduce((n, x) => n + x.value, 0n).toString()

  /** The executing receipt once it is `confirmations` deep; pending while in the mempool or shallower. */
  async function settled(b: Binding): Promise<TransactionReceipt | 'pending' | 'absent'> {
    const current = await route.digestOf(b.side, b.operation)
    if (current === ZERO) return await route.digestOf(b.side, b.operation, 'pending') === b.digest ? 'pending' : 'absent'
    if (current !== b.digest) throw new LaunchError(409, 'operation_conflict', `${b.name} already executed with other bytes (${current}).`)
    const receipt = await route.executedReceipt(b.side, b.operation)
    const latest = await clients[b.side].getBlockNumber({ cacheTime: 0 })
    return latest < receipt.blockNumber + BigInt(config.route[b.side].confirmations) ? 'pending' : receipt
  }

  function result(b: Binding, step: Step, job: Job, receipt: TransactionReceipt): EffectResult {
    const X = config.route[b.side].executor
    const wei = receipt.gasUsed * receipt.effectiveGasPrice
    const rate = config.pricing[b.side]
    const base: EffectResult = { operation: hash([job.id, step.id]), transaction: receipt.transactionHash, finalized: true, cost: ((wei * rate + 10n ** 18n - 1n) / 10n ** 18n).toString() }
    if (step.kind === 'payment') return { ...base, amount: sum(transfersIn(receipt, config.arc.usdc).filter((t) => same(t.from, job.request.payer) && same(t.to, X))) }
    if (step.kind === 'canonical') return { ...base, address: L.canonical, amount: sum(transfersIn(receipt, L.canonical).filter((t) => t.from === zeroAddress && same(t.to, X))) }
    if (step.kind === 'manager') return { ...base, address: b.side === 'arc' ? L.hub.proxy : L.spokeManager.proxy }
    if (step.kind === 'debit') return { ...base, amount: sum(transfersIn(receipt, L.canonical).filter((t) => same(t.from, X) && same(t.to, L.hub.proxy))) }
    if (step.kind === 'credit') return { ...base, amount: sum(transfersIn(receipt, L.spoke).filter((t) => t.from === zeroAddress && same(t.to, X))) }
    const [token, quote] = b.side === 'arc' ? [L.canonical, config.arc.usdc] : [L.spoke, robinhood.quote]
    const deposits = transfersIn(receipt, token).filter((t) => same(t.from, X) && !same(t.to, X))
    const pool = deposits.find((t) => transfersIn(receipt, quote).some((q) => same(q.from, X) && same(q.to, t.to)))?.to
    if (!pool) throw new Error(`${step.id} receipt shows no deposit of both assets into one pool`)
    return { ...base, address: pool, amount: sum(deposits.filter((t) => same(t.to, pool))), quoteAmount: sum(transfersIn(receipt, quote).filter((t) => same(t.from, X) && same(t.to, pool))) }
  }

  async function ownedBy(side: Side, manager: Address, blockNumber: bigint) {
    const owner = await clients[side].readContract({ address: manager, abi: nttAbi, functionName: 'owner', blockNumber })
    if (!same(owner, config.route[side].executor)) throw new Error(`${side} manager owner is ${owner}, not the executor`)
  }

  /**
   * Operator action: return a released job's residual to its payer. The transfer is one executor
   * operation named for the job, persisted before sending, so repeated calls, restarts and racing
   * operators can execute it at most once; the ledger says 'refunded' only once that execution's
   * receipt is `confirmations` deep and shows exactly the residual going to the payer.
   */
  async function refund(job: string): Promise<PaymentLedger> {
    const l = ledgerOf(job)
    if (!l) throw new LaunchError(404, 'not_released', `Job ${job} has no payment ledger; only a released job's residual can be refunded.`)
    if (l.refund === 'none') throw new LaunchError(409, 'nothing_to_refund', `Job ${job}'s authorization moved nothing to the executor.`)
    if (l.refund === 'refunded') return l
    const receipt = await route.execute(refundName(job), 'arc', () => [call(config.arc.usdc, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [l.payer as Address, BigInt(l.residual)] }))])
    const back = sum(transfersIn(receipt, config.arc.usdc).filter((t) => same(t.from, arc.executor) && same(t.to, l.payer)))
    if (back !== l.residual) throw new Error(`Refund receipt ${receipt.transactionHash} moved ${back}, not the residual ${l.residual}`)
    const latest = await clients.arc.getBlockNumber({ cacheTime: 0 })
    const final = latest >= receipt.blockNumber + BigInt(arc.confirmations)
    db.query("UPDATE robinhood_payment_ledger SET refund=?, refund_tx=?, refund_block=? WHERE job=? AND refund <> 'refunded'").run(final ? 'refunded' : 'submitted', receipt.transactionHash, receipt.blockNumber.toString(), job)
    return ledgerOf(job)!
  }

  return {
    mode: 'fork',
    version,
    route,
    ledger: ledgerOf,
    refundStatus: (job: string) => { const l = ledgerOf(job); return l ? refundStatus(l) : undefined },
    /** A released job's error as of now. The job's stored error is a snapshot and goes stale once a refund moves. */
    explain(job: string) { const gone = released(job); return gone ? failed(job, gone).message : undefined },
    refund,
    terms: { chainId: arc.chainId, asset: config.arc.usdc, payTo: arc.executor, name: 'USDC', version: '2' },
    assertReady(request) {
      const chains = request.destinations.map((d) => d.chain).join(',')
      if (chains !== 'arc,robinhood') throw new LaunchError(503, 'route_closed', 'This fork harness fulfils exactly Arc and Robinhood. Base and Solana run in their own harnesses; public Robinhood routes are closed.')
      const asset = config.route.asset
      const c = request.canonical
      if (c.name !== asset.name || c.symbol !== asset.symbol || BigInt(c.issuance) !== asset.issuance) throw new LaunchError(409, 'asset_mismatch', `The request must launch the existing canonical asset ${asset.id} (${asset.name}/${asset.symbol}, issuance ${asset.issuance}).`)
      if (!persisted('canonical:arc') || !persisted('manager:arc')) throw new LaunchError(409, 'asset_missing', `The existing canonical asset ${asset.id} and its Arc hub are not deployed in this journal.`)
      const rh = destination(request, 'robinhood')!
      if (BigInt(rh.amount) > config.route.limits.outbound || BigInt(rh.amount) > config.route.limits.inbound) throw new LaunchError(409, 'rate_limit', 'The Robinhood allocation exceeds the configured NTT rate limit and would queue.')
      // A released request is told why, whoever holds the asset now.
      const gone = db.query<{ job: string; reason: string; block: string }, [string]>('SELECT job, reason, block FROM robinhood_released WHERE identity=?').get(identity(request))
      if (gone) throw failed(gone.job, gone)
      // A settled holder, or one whose authorization could still settle, refuses others outright. Past
      // its validBefore the request may proceed: the payment step decides from chain state, uncharged.
      const bound = boundJob()
      if (bound && bound.identity !== identity(request) && (bound.settled || Date.now() / 1000 < bound.valid_before)) throw new LaunchError(409, 'asset_launched', `Asset ${asset.id} is already launched by job ${bound.job}. Nothing was charged.`)
    },
    budgets: () => config.budgets,
    async prepare(context) {
      const { job, step } = context
      const { name, side } = nameOf(job, step)
      const p = await build(job, step)
      const binding: Binding = { environment: config.labels.environment, job: job.id, step: step.id, name, side, operation: p.operation, digest: p.digest, plan: p.bytes, transfer: p.transfer }
      names.set(name, step.id)
      const bytes = JSON.stringify(binding)
      return { operation: hash([job.id, step.id]), digest: hash(bytes), bytes }
    },
    async observe(context, prepared) {
      const { job, step } = context
      assertOwner(job)
      const b = parse(context, prepared)
      const state = await settled(b)
      if (state === 'absent' && step.kind === 'payment') {
        const bound = boundJob()!
        const why = await unsettleable(job.id, bound)
        if (why) { release(job.id, bound, why); throw failed(job.id, why) }
      }
      if (state === 'absent' || state === 'pending') return state
      if (step.kind === 'payment') db.query('UPDATE robinhood_launches SET settled=1 WHERE job=?').run(job.id)
      if (step.kind === 'manager') await ownedBy(b.side, b.side === 'arc' ? L.hub.proxy : L.spokeManager.proxy, state.blockNumber)
      if (step.kind === 'debit') {
        // Usable only once attested. The debit is already on-chain, so advancing cannot send it again.
        const progress = await route.advance(b.transfer!, 'attested')
        if (progress !== 'attested' && progress !== 'credited') return 'pending'
      }
      if (step.kind === 'credit' && route.get(b.transfer!)?.state === 'attested') await route.advance(b.transfer!)
      return result(b, step, job, state)
    },
    async broadcast(context, prepared) {
      assertOwner(context.job)
      const b = parse(context, prepared)
      try {
        if (context.step.kind === 'debit') await route.advance(b.transfer!, 'attested')
        else if (context.step.kind === 'credit') await route.advance(b.transfer!)
        else await route.execute(b.name, b.side, () => { throw new Error(`${b.name} bytes are not journalled; refusing to re-plan during broadcast`) })
      } catch (cause) {
        // Possibly on the wire: return so the job records a submission and observes it, keeping the
        // reservation and the sweep's claim on it. A definite refusal still fails the attempt.
        if (cause instanceof LaunchError && UNCERTAIN.has(cause.code)) return
        throw cause
      }
    },
  }
}
