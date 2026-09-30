import type { Database } from 'bun:sqlite'
import { decodeEventLog, encodeAbiParameters, encodeFunctionData, getAddress, parseSignature, zeroAddress, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
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
interface Reservation { identity: string; job: string; payer: string; valid_before: number; settled: number }
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

export function robinhoodFulfillment(config: RobinhoodFulfillmentConfig, db: Database, options: FulfillmentOptions = {}): PromotionalTokenAdapter & { route: RobinhoodRoute } {
  if (JSON.stringify(config.labels) !== JSON.stringify(FULFILLMENT_LABELS)) throw new LaunchError(503, 'route_closed', 'Fulfillment labels differ from the fork fixture labels. Fixtures cannot be relabelled.')
  const names = new Map<string, string>()
  const route = robinhoodRoute(config.route, db, { afterSend: (name) => { const step = names.get(name); if (step) options.afterSend?.(step) } })
  const L = route.layout
  const { arc, robinhood } = config.route
  const clients: Record<Side, PublicClient> = route.clients
  db.exec(`CREATE TABLE IF NOT EXISTS robinhood_launches (asset TEXT PRIMARY KEY, identity TEXT NOT NULL, job TEXT NOT NULL, payer TEXT NOT NULL, valid_before INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS robinhood_released (job TEXT PRIMARY KEY, asset TEXT NOT NULL, identity TEXT NOT NULL, reason TEXT NOT NULL, block TEXT NOT NULL, released_at INTEGER NOT NULL);`)
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
  const boundJob = () => db.query<Reservation, [string]>('SELECT identity, job, payer, valid_before, settled FROM robinhood_launches WHERE asset=?').get(config.route.asset.id)
  const released = (job: string) => db.query<{ reason: string; block: string }, [string]>('SELECT reason, block FROM robinhood_released WHERE job=?').get(job)
  const failed = (job: string, why: { reason: string; block: string }) =>
    new LaunchError(409, 'payment_failed', `Job ${job}'s payment can never settle (${why.reason} at Arc block ${why.block}); its asset reservation was released. Nothing was charged. Start a new request.`)

  /** Refuse any work for a job that does not hold the asset. A released job never reacquires it. */
  function assertOwner(job: Job) {
    const gone = released(job.id)
    if (gone) throw failed(job.id, gone)
    const bound = boundJob()
    if (!bound || bound.job !== job.id) throw new LaunchError(409, 'asset_launched', `Job ${job.id} does not hold asset ${config.route.asset.id}${bound ? `; job ${bound.job} does` : ''}. Nothing was sent.`)
  }

  /**
   * Why a reserved payment can never settle, or null while it still could. Read at one block
   * `confirmations` deep: the operation is unexecuted there, and either the authorization's
   * validBefore has passed (block time only grows) or its nonce is spent by something else. Either
   * way no later block can execute it, and the persisted bytes of it revert if anyone resends them.
   */
  async function unsettleable(job: string, r: Pick<Reservation, 'payer' | 'valid_before'>): Promise<{ reason: string; block: string } | null> {
    const latest = await clients.arc.getBlockNumber({ cacheTime: 0 })
    const at = latest - BigInt(arc.confirmations)
    if (await route.digestOf('arc', L.op(`job:${job}:payment:arc`), at) !== ZERO) {
      db.query('UPDATE robinhood_launches SET settled=1 WHERE job=?').run(job)
      return null
    }
    const block = await clients.arc.getBlock({ blockNumber: at })
    if (block.timestamp >= BigInt(r.valid_before)) return { reason: 'authorization expired', block: at.toString() }
    const spent = await clients.arc.readContract({ address: config.arc.usdc, abi: usdcAbi, functionName: 'authorizationState', args: [r.payer as Address, job as Hex], blockNumber: at })
    return spent ? { reason: 'authorization nonce spent elsewhere', block: at.toString() } : null
  }
  /** Move the job out of the reservation. Idempotent; only ever removes the named job's row. */
  function release(job: string, why: { reason: string; block: string }) {
    db.transaction(() => {
      const bound = boundJob()
      if (bound?.job === job) db.query('DELETE FROM robinhood_launches WHERE asset=? AND job=?').run(config.route.asset.id, job)
      db.query('INSERT OR IGNORE INTO robinhood_released(job, asset, identity, reason, block, released_at) VALUES(?,?,?,?,?,?)').run(job, config.route.asset.id, bound?.job === job ? bound.identity : '', why.reason, why.block, Date.now())
    }).immediate()
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
        release(holder.job, why)
      }
      // Bind the asset to this job before anything can settle. The loser of a race is refused uncharged.
      db.transaction(() => {
        const bound = boundJob()
        if (bound && bound.job !== job.id) throw new LaunchError(409, 'asset_launched', `Asset ${config.route.asset.id} is already launched by job ${bound.job}. Nothing was charged.`)
        if (!bound) db.query('INSERT INTO robinhood_launches(asset, identity, job, payer, valid_before, created_at) VALUES(?,?,?,?,?,?)').run(config.route.asset.id, job.identity, job.id, a.from, Number(a.validBefore), Date.now())
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

  return {
    mode: 'fork',
    version,
    route,
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
        const why = await unsettleable(job.id, boundJob()!)
        if (why) { release(job.id, why); throw failed(job.id, why) }
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
