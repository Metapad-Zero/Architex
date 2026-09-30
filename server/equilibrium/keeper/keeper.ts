/**
 * The bounded Arc–Base keeper.
 *
 * One cycle is two legs on two chains, and they are not atomic. Everything here is arranged around
 * that: the plan for a leg is written to the durable record before anything is sent; the leg id is
 * bound in the vault on the chain where it takes effect, so a repeat costs only gas; and a cycle
 * whose purchase settled but whose sale did not is exposure the keeper halts on rather than trades
 * over. Recovery unwinds on the purchase market, inside the loss budget, or the position stays open
 * and the keeper stays halted — the limit is never quietly relaxed to make the position go away.
 *
 * Keeper profit is reported separately from the pool/treasury outcome. The keeper's own volume is
 * not customer demand and its internal payments are not revenue.
 */
import {
  BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, createWalletClient, decodeEventLog, encodeFunctionData, http, keccak256, toBytes,
  type Address, type Hex, type PublicClient, type TransactionReceipt, type WalletClient,
} from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { cycleId, keeperAbi, legDigest, legId, legStruct, KEEPER_CODE } from './contracts'
import { weiOf } from './fees'
import { decide, decideRecovery, legBudget, legLimits } from './policy'
import { keeperChain, keeperClients, legCost, legFees, LEG_GAS, quoteLag, readChainQuote, toQuoteAtoms } from './quotes'
import type { KeeperStore } from './store'
import {
  KEEPER_CHAINS, KeeperError,
  type ChainQuote, type CycleCandidate, type CycleRecord, type KeeperChain, type KeeperConfig, type KeeperDecision,
  type KeeperSnapshot, type LegKind, type LegPlan, type LegResult,
} from './types'

const ZERO: Hex = `0x${'0'.repeat(64)}`
const LEG_RUN = keeperAbi.find((item) => item.type === 'event' && item.name === 'LegRun')!

/** The chain each leg of a cycle runs on: the purchase where it is cheap, the sale where it is dear. */
export const legChain = (candidate: CycleCandidate, kind: LegKind): KeeperChain =>
  (kind === 'sell' ? candidate.sell : candidate.buy)

export interface KeeperHandle {
  readonly version: string
  readonly manifest: Record<string, unknown>
  readonly clients: Record<KeeperChain, PublicClient>
  verify(): Promise<void>
  snapshot(tokens: bigint): Promise<KeeperSnapshot>
  consider(tokens: bigint): Promise<{ snapshot: KeeperSnapshot; decision: KeeperDecision }>
  /**
   * `failSell` deliberately abandons a settled purchase to rehearse recovery, and `failAttest`
   * deliberately drops the close attestation to rehearse finishing it. Fork mode only.
   */
  runCycle(tokens: bigint, options?: { id?: string; failSell?: boolean; failAttest?: boolean }): Promise<CycleRecord>
  recover(id: string): Promise<CycleRecord>
  reconcile(): Promise<CycleRecord[]>
  halt(reason: string): Promise<void>
  resume(): Promise<void>
}

export function createKeeper(config: KeeperConfig, store: KeeperStore): KeeperHandle {
  const account: PrivateKeyAccount = privateKeyToAccount(config.operatorKey)
  const chains = { arc: config.arc, base: config.base }
  const clients = keeperClients(config)
  const wallets: Record<KeeperChain, WalletClient> = {
    arc: createWalletClient({ account, chain: keeperChain(config.arc), transport: http(config.arc.rpc) }),
    base: createWalletClient({ account, chain: keeperChain(config.base), transport: http(config.base.rpc) }),
  }
  /** One sender per chain in this process, so two cycles never race for the operator's nonce. */
  const sending: Record<KeeperChain, Promise<unknown>> = { arc: Promise.resolve(), base: Promise.resolve() }

  const manifest = {
    mode: config.mode,
    keeperCode: KEEPER_CODE.sha256,
    compiler: KEEPER_CODE.compiler,
    chains: KEEPER_CHAINS.map((chain) => {
      const c = chains[chain]
      return { chain, chainId: c.chainId, keeper: c.keeper, token: c.token, quote: c.quote, pool: c.pool, venue: c.venue, finality: c.finality, quoteAtomsPerNative: c.quoteAtomsPerNative.toString() }
    }),
    policy: config.policy,
  }
  const version = `equilibrium-keeper-v1:${keccak256(toBytes(JSON.stringify(manifest))).slice(2, 18)}`

  const now = () => Math.floor(Date.now() / 1000)

  async function finalizedBlock(chain: KeeperChain): Promise<bigint> {
    const finality = chains[chain].finality
    if (finality === 'finalized') return (await clients[chain].getBlock({ blockTag: 'finalized' })).number ?? 0n
    const latest = await clients[chain].getBlockNumber({ cacheTime: 0 })
    const confirmations = BigInt(finality)
    return latest > confirmations ? latest - confirmations : 0n
  }

  async function legOf(chain: KeeperChain, id: Hex, blockNumber: bigint): Promise<Hex> {
    try {
      return await clients[chain].readContract({ address: chains[chain].keeper, abi: keeperAbi, functionName: 'legOf', args: [id], blockNumber })
    } catch (cause) {
      // Before the vault existed nothing could have run; anything else is a real read failure.
      if (cause instanceof BaseError && cause.walk((e) => e instanceof ContractFunctionZeroDataError)) return ZERO
      throw cause
    }
  }

  // ------------------------------------------------------------------ snapshot

  async function snapshot(tokens: bigint): Promise<KeeperSnapshot> {
    const quotes = {} as Record<KeeperChain, ChainQuote>
    const lag = {} as KeeperSnapshot['lag']
    const heads: Record<string, bigint> = {}
    for (const chain of KEEPER_CHAINS) {
      quotes[chain] = await readChainQuote(clients[chain], chains[chain], account.address, tokens)
      lag[chain] = await quoteLag(clients[chain], quotes[chain])
      heads[chain] = await clients[chain].getBlockNumber({ cacheTime: 0 })
    }
    // A chain is unavailable when its quote is older than the availability window AND its head has
    // not moved past the quote: a pinned or halted chain, not merely a slow one.
    const stalled = KEEPER_CHAINS.filter((chain) => lag[chain].seconds > config.policy.maxHeadAgeSeconds && lag[chain].blocks === 0)
    const totals = store.totals()
    return {
      at: now(), tokens: tokens.toString(), quotes, lag, stalled,
      loss: totals.loss, net: totals.net,
      unresolved: store.unresolved().map((cycle) => cycle.id),
    }
  }

  async function consider(tokens: bigint) {
    const taken = await snapshot(tokens)
    const decision = decide(taken, config.policy)
    store.recordSnapshot(taken.at, null, { snapshot: taken, decision })
    return { snapshot: taken, decision }
  }

  // ---------------------------------------------------------------------- legs

  function planLeg(cycle: string, kind: LegKind, chain: KeeperChain, tokens: bigint, limit: bigint, deadline: number, fromBlock: bigint): LegPlan {
    const c = chains[chain]
    const parts = { cycle, kind, chainId: c.chainId, keeper: c.keeper, pool: c.pool, tokens: tokens.toString(), limit: limit.toString(), deadline }
    const plan: LegPlan = {
      chain, chainId: c.chainId, keeper: c.keeper, cycle, kind, id: legId(parts), digest: ZERO,
      pool: c.pool, tokens: tokens.toString(), limit: limit.toString(), deadline,
      fromBlock: (fromBlock > c.fromBlock ? fromBlock : c.fromBlock).toString(),
    }
    return { ...plan, digest: legDigest(plan) }
  }

  /** What the leg actually did, from its finalized receipt. Never from what the runner intended. */
  function legResult(chain: KeeperChain, plan: LegPlan, receipt: TransactionReceipt): LegResult {
    const c = chains[chain]
    const cost = toQuoteAtoms(c, weiOf(receipt))
    const run = receipt.logs
      .filter((log) => log.address.toLowerCase() === c.keeper.toLowerCase())
      .flatMap((log) => {
        try {
          const event = decodeEventLog({ abi: keeperAbi, data: log.data, topics: log.topics })
          if (event.eventName !== 'LegRun') return []
          const args = event.args
          return args.leg.toLowerCase() === plan.id.toLowerCase() ? [{ amountIn: args.amountIn, amountOut: args.amountOut }] : []
        } catch { return [] }
      })
    if (run.length !== 1) throw new KeeperError('leg_failed', `${plan.cycle} ${plan.kind}: ${receipt.transactionHash} carries ${run.length} LegRun logs for ${plan.id}.`)
    return { transaction: receipt.transactionHash, amountIn: run[0].amountIn.toString(), amountOut: run[0].amountOut.toString(), cost: cost.toString(), finalized: true }
  }

  /** Has this leg run? Executed-but-not-final or still in the mempool is pending, never absent. */
  async function observeLeg(plan: LegPlan): Promise<LegResult | 'pending' | 'absent'> {
    const client = clients[plan.chain]
    const finalized = await finalizedBlock(plan.chain)
    const atFinal = await legOf(plan.chain, plan.id, finalized)
    if (atFinal !== ZERO) {
      if (atFinal !== plan.digest) throw new KeeperError('leg_failed', `${plan.cycle} ${plan.kind}: leg ${plan.id} is bound to other bytes on ${plan.chain}.`)
      const logs = await client.getLogs({ address: plan.keeper, event: LEG_RUN, args: { leg: plan.id }, fromBlock: BigInt(plan.fromBlock), toBlock: finalized }) as { transactionHash: Hex }[]
      if (!logs.length) throw new KeeperError('leg_failed', `${plan.cycle} ${plan.kind}: leg ran but has no log in the searched range.`)
      return legResult(plan.chain, plan, await client.getTransactionReceipt({ hash: logs[0].transactionHash }))
    }
    if (await legOf(plan.chain, plan.id, await client.getBlockNumber({ cacheTime: 0 })) === plan.digest) return 'pending'
    for (const tx of store.sendsFor(plan.id)) {
      if (await client.getTransaction({ hash: tx as Hex }).then((t) => t.blockNumber === null, () => false)) return 'pending'
    }
    return 'absent'
  }

  /**
   * Refuse to send a leg whose measured worst case exceeds what the candidate was costed with, so a
   * gas spike can never silently turn a profitable cycle into a loss-making one.
   */
  async function assertLegAffordable(chain: KeeperChain, plan: LegPlan, gas: bigint, maxFeePerGas: bigint, budget: bigint) {
    const worst = await legCost(clients[chain], chains[chain], gas, maxFeePerGas)
    if (worst > budget) {
      throw new KeeperError('leg_failed', `${plan.cycle} ${plan.kind} on ${chain} could cost up to ${worst} quote atoms, above the ${budget} it was costed with. Nothing was sent.`)
    }
  }

  async function sendLeg(plan: LegPlan, budget: bigint): Promise<void> {
    const client = clients[plan.chain]
    const run = async () => {
      const current = await legOf(plan.chain, plan.id, await client.getBlockNumber({ cacheTime: 0 }))
      if (current === plan.digest) return
      if (current !== ZERO) throw new KeeperError('leg_failed', `${plan.cycle} ${plan.kind}: leg ${plan.id} is bound to other bytes.`)
      const leg = legStruct(plan)
      let gas: bigint
      try {
        await client.simulateContract({ account, address: plan.keeper, abi: keeperAbi, functionName: 'run', args: [leg] })
        gas = await client.estimateContractGas({ account, address: plan.keeper, abi: keeperAbi, functionName: 'run', args: [leg] })
      } catch (cause) {
        const revert = cause instanceof BaseError ? cause.walk((e) => e instanceof ContractFunctionRevertedError) : null
        if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName === 'LegDone') return
        throw cause
      }
      const limit = (gas * 12n) / 10n
      const fee = await legFees(client, chains[plan.chain])
      await assertLegAffordable(plan.chain, plan, limit, fee.maxFeePerGas, budget)
      let tx: Hex | undefined
      for (let attempt = 0; attempt < 3 && !tx; attempt++) {
        try {
          tx = await wallets[plan.chain].writeContract({ account, chain: keeperChain(chains[plan.chain]), address: plan.keeper, abi: keeperAbi, functionName: 'run', args: [leg], gas: limit, ...fee })
        } catch (cause) {
          // Another process's send landed between the simulation and this one: nothing to send.
          if (await legOf(plan.chain, plan.id, await client.getBlockNumber({ cacheTime: 0 })) === plan.digest) return
          if (attempt === 2 || !/nonce|underpriced|already known/i.test(String(cause))) throw cause
        }
      }
      store.recordSend(plan, tx!, Date.now())
      const receipt = await client.waitForTransactionReceipt({ hash: tx!, timeout: config.receiptTimeoutMs ?? 120_000 })
      if (receipt.status !== 'success') throw new KeeperError('leg_failed', `${plan.cycle} ${plan.kind} reverted in ${tx}.`)
    }
    const next = sending[plan.chain].then(run, run)
    sending[plan.chain] = next.catch(() => undefined)
    await next
  }

  /** Plan, observe, send, observe. The observation before the send is what makes a repeat harmless. */
  async function runLeg(cycle: string, kind: LegKind, chain: KeeperChain, tokens: bigint, limit: bigint, deadline: number, budget: bigint): Promise<LegResult> {
    const head = await clients[chain].getBlockNumber({ cacheTime: 0 })
    const plan = planLeg(cycle, kind, chain, tokens, limit, deadline, head)
    const record = store.planLeg(plan)
    const bound = record.plan
    const already = await observeLeg(bound)
    if (already !== 'absent' && already !== 'pending') {
      store.settleLeg(bound, already, now())
      return already
    }
    if (already === 'absent') await sendLeg(bound, budget)
    for (let attempt = 0; attempt < 60; attempt++) {
      const observed = await observeLeg(bound)
      if (observed !== 'pending' && observed !== 'absent') {
        store.settleLeg(bound, observed, now())
        return observed
      }
      if (observed === 'absent' && attempt > 0) break
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    store.failLeg(bound, 'The leg did not finalize within the observation window.', now())
    throw new KeeperError('leg_failed', `${cycle} ${kind} on ${chain} did not finalize. The record keeps its plan; reconcile before planning anything else.`)
  }

  // -------------------------------------------------------------------- control

  async function vaultCall(chain: KeeperChain, data: Hex): Promise<Hex> {
    const client = clients[chain]
    const run = async () => {
      const gas = await client.estimateGas({ account, to: chains[chain].keeper, data })
      const fee = await legFees(client, chains[chain])
      const tx = await wallets[chain].sendTransaction({ account, chain: keeperChain(chains[chain]), to: chains[chain].keeper, data, gas: (gas * 12n) / 10n, ...fee })
      const receipt = await client.waitForTransactionReceipt({ hash: tx, timeout: config.receiptTimeoutMs ?? 120_000 })
      if (receipt.status !== 'success') throw new KeeperError('leg_failed', `Vault call on ${chain} reverted in ${tx}.`)
      return tx
    }
    const next = sending[chain].then(run, run)
    sending[chain] = next.then(() => undefined, () => undefined)
    return next
  }

  async function haltChain(chain: KeeperChain, reason: string) {
    if (await clients[chain].readContract({ address: chains[chain].keeper, abi: keeperAbi, functionName: 'halted' })) return
    await vaultCall(chain, encodeFunctionData({ abi: keeperAbi, functionName: 'halt', args: [reason.slice(0, 200)] }))
  }

  /** Both vaults halt together: a failure on one chain must not leave the other opening exposure. */
  async function halt(reason: string) {
    for (const chain of KEEPER_CHAINS) await haltChain(chain, reason)
  }

  async function resume() {
    for (const chain of KEEPER_CHAINS) {
      const [halted, open] = await Promise.all([
        clients[chain].readContract({ address: chains[chain].keeper, abi: keeperAbi, functionName: 'halted' }),
        clients[chain].readContract({ address: chains[chain].keeper, abi: keeperAbi, functionName: 'openCycles' }),
      ])
      if (Number(open) !== 0) {
        throw new KeeperError('unresolved_exposure', `${chain} still reports ${open} open cycle(s); the vault refuses to resume over unresolved exposure. Run reconcile first: it finishes a cycle whose trade completed but whose close attestation did not land.`)
      }
      if (halted) await vaultCall(chain, encodeFunctionData({ abi: keeperAbi, functionName: 'resume' }))
    }
    if (store.unresolved().length) throw new KeeperError('unresolved_exposure', 'The durable record still holds an unresolved cycle.')
  }

  /**
   * Record the finalized remote sale against the purchase chain's vault. An operator attestation of
   * an observed receipt, not a proof: no message crosses between the chains.
   */
  async function attestClosed(chain: KeeperChain, cycle: string, remoteLeg: Hex) {
    const open = await clients[chain].readContract({ address: chains[chain].keeper, abi: keeperAbi, functionName: 'openTokensOf', args: [cycleId(cycle)] })
    if (open === 0n) return
    await vaultCall(chain, encodeFunctionData({ abi: keeperAbi, functionName: 'attestClosed', args: [cycleId(cycle), remoteLeg] }))
  }

  // -------------------------------------------------------------------- cycles

  const netOf = (cycle: CycleRecord): bigint => {
    let net = 0n
    for (const leg of cycle.legs) {
      if (leg.state !== 'settled' || !leg.result) continue
      if (leg.kind === 'buy') net -= BigInt(leg.result.amountIn)
      else net += BigInt(leg.result.amountOut)
      net -= BigInt(leg.result.cost)
    }
    return net
  }

  /**
   * Finish a cycle whose trade is done: attest the close on the purchase vault, then write the
   * terminal state. Two steps that cannot be one — the attestation is a transaction on the purchase
   * chain, the state is a local write — so this is written to be safe to call again at any point in
   * between. `attestClosed` is a no-op once the vault reports nothing open, and `setCycle` is
   * idempotent, so a throw anywhere here leaves a record the next reconcile finishes.
   */
  async function finish(cycle: CycleRecord): Promise<CycleRecord> {
    const closer = cycle.legs.find((leg) => (leg.kind === 'sell' || leg.kind === 'recover') && leg.state === 'settled')
    if (!closer) throw new KeeperError('leg_failed', `Cycle ${cycle.id} has no settled sale or recovery to close.`)
    const buy = cycle.legs.find((leg) => leg.kind === 'buy')
    if (buy) await attestClosed(buy.chain, cycle.id, closer.plan.id)
    store.setCycle(cycle.id, closer.kind === 'sell' ? 'closed' : 'recovered', now(), { net: netOf(cycle).toString() })
    return store.get(cycle.id)!
  }

  /**
   * Leave a finished-but-unclosed cycle in the shape `store.unfinished()` looks for, with a note
   * saying why, rather than reporting a completed trade the vault still thinks is open.
   */
  function noteUnclosed(cycle: CycleRecord, cause: unknown): string {
    const detail = (cause instanceof Error ? cause.message : String(cause)).replace(/\.*$/, '')
    const note = `Both legs settled, but the close attestation on the purchase vault did not land: ${detail}. The purchase vault still reports the position open; the next reconcile finishes it.`
    store.setCycle(cycle.id, cycle.state, now(), { note })
    return note
  }

  async function runCycle(tokens: bigint, options: { id?: string; failSell?: boolean; failAttest?: boolean } = {}): Promise<CycleRecord> {
    // `failSell` is the rehearsal device that produces a partial cycle on purpose. It abandons a
    // settled purchase, so it exists only where no real money is at stake.
    if ((options.failSell || options.failAttest) && config.mode !== 'fork') {
      throw new KeeperError('invalid_configuration', 'A deliberately failed sale or close attestation is a fork rehearsal device; it is refused outside fork mode.')
    }
    const { snapshot: taken, decision } = await consider(tokens)
    if (!decision.candidate) throw new KeeperError(decision.reason, decision.detail)
    const candidate = decision.candidate
    const id = options.id ?? `cycle-${taken.at}-${taken.tokens}`
    store.open(id, candidate, taken.at, config.policy.maxOpenCycles)
    store.recordSnapshot(taken.at, id, { snapshot: taken, decision })
    const { buyLimit, sellFloor } = legLimits(candidate, config.policy)
    const buyQuote = taken.quotes[candidate.buy]
    const sellQuote = taken.quotes[candidate.sell]
    // Deadlines are in each chain's own clock, taken from the block the quote was read at.
    const buyDeadline = buyQuote.observedAt + config.policy.legTtlSeconds
    const sellDeadline = sellQuote.observedAt + config.policy.legTtlSeconds

    const buy = await runLeg(id, 'buy', candidate.buy, tokens, buyLimit, buyDeadline, legBudget(candidate, config.policy, buyQuote.legCost))
    const overrun = BigInt(buy.cost) > BigInt(buyQuote.legCost) ? BigInt(buy.cost) - BigInt(buyQuote.legCost) : 0n
    if (options.failSell) {
      // A deliberately unexecutable sale, standing in for a leg the destination chain refuses.
      const note = 'The sale leg failed after the purchase settled. The position is open on the purchase market.'
      store.setCycle(id, 'halted', now(), { note })
      await halt(note)
      return store.get(id)!
    }
    try {
      await runLeg(id, 'sell', candidate.sell, tokens, sellFloor, sellDeadline, legBudget(candidate, config.policy, sellQuote.legCost, overrun))
    } catch (cause) {
      const note = `The sale leg failed after the purchase settled: ${cause instanceof Error ? cause.message : String(cause)}`
      store.setCycle(id, 'halted', now(), { note })
      await halt(note)
      throw cause
    }
    try {
      // A deliberately thrown close attestation stands in for a lost RPC or a stopped process here.
      if (options.failAttest) throw new KeeperError('leg_failed', 'Rehearsal: the close attestation was not sent.')
      return await finish(store.get(id)!)
    } catch (cause) {
      throw new KeeperError('leg_failed', noteUnclosed(store.get(id)!, cause))
    }
  }

  async function recover(id: string): Promise<CycleRecord> {
    const cycle = store.get(id)
    if (!cycle) throw new KeeperError('leg_failed', `Unknown cycle ${id}.`)
    const buy = cycle.legs.find((leg) => leg.kind === 'buy')
    if (!buy?.result || buy.state !== 'settled') throw new KeeperError('leg_failed', `Cycle ${id} has no settled purchase to unwind.`)
    if (cycle.legs.some((leg) => (leg.kind === 'sell' || leg.kind === 'recover') && leg.state === 'settled')) return cycle
    const tokens = BigInt(buy.result.amountOut)
    const taken = await snapshot(tokens)
    const outcome = decideRecovery(taken, config.policy, { cycle: id, buy: buy.chain, tokens: tokens.toString(), spent: buy.result.amountIn })
    store.recordSnapshot(taken.at, id, { snapshot: taken, recovery: outcome })
    if ('refused' in outcome) {
      store.setCycle(id, 'halted', now(), { note: outcome.refused })
      await halt(outcome.refused)
      throw new KeeperError('loss_cap', outcome.refused)
    }
    const quote = taken.quotes[buy.chain]
    // The recovery leg spends the capacity the vault reserved for exactly this purpose, and clears
    // the position on the purchase vault itself, so `finish` only has the terminal state left to write.
    await runLeg(id, 'recover', buy.chain, tokens, BigInt(outcome.floor), quote.observedAt + config.policy.legTtlSeconds, BigInt(quote.legCost) + BigInt(config.policy.recoveryCost))
    try {
      return await finish(store.get(id)!)
    } catch (cause) {
      throw new KeeperError('leg_failed', noteUnclosed(store.get(id)!, cause))
    }
  }

  /**
   * What a restart must do before anything else: find every cycle whose purchase settled without a
   * sale, work out from the chains whether the sale in fact landed, and halt on whatever is still
   * open. Cycles that sent nothing are abandoned, because no money moved.
   */
  async function reconcile(): Promise<CycleRecord[]> {
    const touched: CycleRecord[] = []
    // A trade that finished without its close: attest it and write the terminal state. This runs
    // before anything else, because it is the only state that blocks trading, resuming and
    // withdrawing while nothing is actually at risk.
    for (const cycle of store.unfinished()) touched.push(await finish(cycle))
    for (const cycle of store.untouched()) {
      const planned = cycle.legs.filter((leg) => leg.state !== 'settled')
      let anything = false
      for (const leg of planned) {
        const observed = await observeLeg(leg.plan)
        if (observed !== 'absent' && observed !== 'pending') { store.settleLeg(leg.plan, observed, now()); anything = true }
      }
      if (!anything) {
        store.setCycle(cycle.id, 'abandoned', now(), { note: 'No leg of this cycle ever executed on-chain; nothing to unwind.' })
        touched.push(store.get(cycle.id)!)
      }
    }
    for (const cycle of store.unresolved()) {
      const sell = cycle.legs.find((leg) => leg.kind === 'sell' || leg.kind === 'recover')
      if (sell && sell.state !== 'settled') {
        const observed = await observeLeg(sell.plan)
        if (observed !== 'absent' && observed !== 'pending') store.settleLeg(sell.plan, observed, now())
      }
      const refreshed = store.get(cycle.id)!
      const buy = refreshed.legs.find((leg) => leg.kind === 'buy')!
      if (refreshed.legs.some((leg) => (leg.kind === 'sell' || leg.kind === 'recover') && leg.state === 'settled')) {
        touched.push(await finish(refreshed))
        continue
      }
      const note = `Cycle ${refreshed.id} settled its purchase on ${buy.chain} and has no settled sale. Recovery comes before any new cycle.`
      store.setCycle(refreshed.id, 'halted', now(), { note })
      await halt(note)
      touched.push(store.get(refreshed.id)!)
    }
    return touched
  }

  return {
    version, manifest, clients,
    async verify() {
      if (config.mode === 'testnet' && !config.approval) {
        throw new KeeperError('not_approved', 'A testnet keeper refuses to start without EQUILIBRIUM_KEEPER_APPROVAL matching the approved preview digest.')
      }
      for (const chain of KEEPER_CHAINS) {
        const c = chains[chain]
        const client = clients[chain]
        if (await client.getChainId() !== c.chainId) throw new KeeperError('invalid_configuration', `${chain} RPC reports a different chain id.`)
        const [owner, token, quote, pool, venue, maxTokens, maxQuote, spendCap, reserve, maxOpen] = await Promise.all([
          client.readContract({ address: c.keeper, abi: keeperAbi, functionName: 'owner' }),
          client.readContract({ address: c.keeper, abi: keeperAbi, functionName: 'token' }),
          client.readContract({ address: c.keeper, abi: keeperAbi, functionName: 'quote' }),
          client.readContract({ address: c.keeper, abi: keeperAbi, functionName: 'pool' }),
          client.readContract({ address: c.keeper, abi: keeperAbi, functionName: 'venue' }),
          client.readContract({ address: c.keeper, abi: keeperAbi, functionName: 'maxTokensPerLeg' }),
          client.readContract({ address: c.keeper, abi: keeperAbi, functionName: 'maxQuotePerLeg' }),
          client.readContract({ address: c.keeper, abi: keeperAbi, functionName: 'spendCap' }),
          client.readContract({ address: c.keeper, abi: keeperAbi, functionName: 'recoveryReserve' }),
          client.readContract({ address: c.keeper, abi: keeperAbi, functionName: 'maxOpenCycles' }),
        ])
        const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
        if (!same(owner, account.address)) throw new KeeperError('invalid_configuration', `${chain} vault is owned by ${owner}, not the operator ${account.address}.`)
        if (!same(token, c.token) || !same(quote, c.quote) || !same(pool, c.pool)) throw new KeeperError('invalid_configuration', `${chain} vault is bound to different assets or a different pool than the configuration.`)
        if (Number(venue) !== (c.venue === 'architex-pair' ? 0 : 1)) throw new KeeperError('invalid_configuration', `${chain} vault venue differs from the configuration.`)
        // The vault's own bounds must be at least as tight as the policy the runner applies.
        if (maxTokens > BigInt(config.policy.maxTokens)) throw new KeeperError('invalid_configuration', `${chain} vault allows ${maxTokens} tokens per leg, above the policy's ${config.policy.maxTokens}.`)
        if (spendCap > BigInt(config.policy.spendCap)) throw new KeeperError('invalid_configuration', `${chain} vault spend cap ${spendCap} is above the policy's ${config.policy.spendCap}.`)
        if (reserve < BigInt(config.policy.recoveryReserve)) throw new KeeperError('invalid_configuration', `${chain} vault reserves ${reserve}, below the policy's ${config.policy.recoveryReserve}.`)
        if (Number(maxOpen) > config.policy.maxOpenCycles) throw new KeeperError('invalid_configuration', `${chain} vault allows ${maxOpen} open cycles, above the policy's ${config.policy.maxOpenCycles}.`)
        if (maxQuote === 0n) throw new KeeperError('invalid_configuration', `${chain} vault has no per-leg quote limit.`)
        for (const address of [c.token, c.quote, c.pool] as Address[]) if (!(await client.getCode({ address }))) throw new KeeperError('invalid_configuration', `${chain}: no code at ${address}.`)
      }
      // A vault with a wider per-leg gas allowance than the planner assumes would be undercosted.
      for (const chain of KEEPER_CHAINS) if (!LEG_GAS[chains[chain].venue]) throw new KeeperError('invalid_configuration', `No leg gas allowance for ${chains[chain].venue}.`)
    },
    snapshot, consider, runCycle, recover, reconcile, halt, resume,
  }
}
