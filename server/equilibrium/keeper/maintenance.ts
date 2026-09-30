/** Bounded executor inventory → authenticated NTT/CCTP transfer → keeper vault, beside trading. */
import { decodeEventLog, encodeFunctionData, isAddress, type Hex } from 'viem'
import { hash } from '../request'
import type { Job, PreparedEffect } from '../types'
import { layout } from '../evm/adapter'
import { fromFile as adapterFromFile, type EvmFileConfig } from '../evm/config'
import { erc20Abi } from '../evm/contracts'
import { assertTransfersApproved, transferApprovalDigest, transferRoutes, type TransferSettings } from '../evm/transfers/config'
import { CCTP_TESTNET } from '../evm/transfers/cctp'
import { call, parsePlan, prepared } from '../evm/transfers/executor'
import { createTransfer, publicTransfer, runTransfer } from '../evm/transfers/runner'
import { TransferStore } from '../evm/transfers/store'
import type { RefillRequest, ReturnRequest, TransferRoute } from '../evm/transfers/types'
import { assertKeeperApproved, keeperApprovalDigest } from './approval'
import { fromFile, type KeeperFileConfig } from './config'
import { keeperAbi } from './contracts'
import { createKeeper } from './keeper'
import type { KeeperStore } from './store'
import { KeeperError } from './types'

export interface MaintenanceContext {
  keeperConfigText: string
  keeperPreview: string
  adapterConfigText: string
  transferSettingsText: string
  env?: Record<string, string | undefined>
}
export interface MaintenanceRequest { requestId: string; tokens: string; quote: string }
interface Row { id: string; binding: string; request: string; state: string; tokens: string; quote: string; token_transfer: string | null; quote_transfer: string | null }
export interface MaintenanceOptions {
  /** Fork-only crash seam, after an actual transfer send and before its result is stored. */
  afterBroadcast?: (step: string) => void
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const fail = (message: string): never => { throw new KeeperError('invalid_configuration', message) }

export function createMaintenance(context: MaintenanceContext, store: KeeperStore, launchOf: (id: Hex) => Job | undefined, options: MaintenanceOptions = {}) {
  const env = context.env ?? process.env
  const config = fromFile(JSON.parse(context.keeperConfigText) as KeeperFileConfig, env)
  const adapter = adapterFromFile(JSON.parse(context.adapterConfigText) as EvmFileConfig, env)
  const settings = JSON.parse(context.transferSettingsText) as TransferSettings
  const scope = config.maintenance ?? fail('The keeper maintenance rail is closed: no approved maintenance scope.')
  if (config.mode !== 'fork' && config.mode !== 'testnet') fail('Maintenance supports only fork or bounded testnet mode.')
  if (config.mode !== adapter.mode) fail('Keeper and transfer modes must match.')
  if (options.afterBroadcast && config.mode !== 'fork') fail('Maintenance crash seams are fork-only.')
  const operatorGas = settings.operatorGas ?? fail('Maintenance requires explicit transfer gas caps on both chains.')
  const refillSettings = settings.refill ?? fail('Maintenance requires the approved CCTP refill rail.')
  const cctp = refillSettings.cctp ?? CCTP_TESTNET
  if (!/^0x[0-9a-fA-F]{64}$/.test(scope.launch)) fail('Maintenance must name one completed launch.')
  for (const key of ['maxTokenPerTransfer', 'maxTokenTotal', 'maxQuotePerTransfer', 'maxQuoteTotal'] as const) {
    if (typeof scope[key] !== 'string' || !/^[1-9]\d*$/.test(scope[key])) fail(`maintenance.${key} must be a positive decimal amount.`)
  }
  if (BigInt(scope.maxTokenTotal) < BigInt(scope.maxTokenPerTransfer) || BigInt(scope.maxQuoteTotal) < BigInt(scope.maxQuotePerTransfer)) fail('Maintenance totals must cover one transfer.')
  for (const chain of ['arc', 'base'] as const) {
    const c = config[chain]; const a = adapter[chain]
    if (typeof operatorGas[chain] !== 'string' || !/^(0|[1-9]\d*)$/.test(operatorGas[chain])) fail(`${chain} requires an explicit decimal transfer gas cap.`)
    if (!isAddress(scope.executors[chain]) || !same(a.executor, scope.executors[chain]) || c.chainId !== a.chainId || c.rpc !== a.rpc
      || !same(c.quote, a.usdc) || !same(c.quote, cctp[chain].usdc) || c.quoteAtomsPerNative !== a.usdcAtomsPerNative || c.finality !== a.finality) fail(`${chain} keeper and approved transfer configuration differ.`)
  }
  const keeper = createKeeper(config, store)
  const routes = transferRoutes(adapter, settings, store.db, launchOf, env)
  const transfers = new TransferStore(store.db)
  const binding = hash(['keeper-maintenance-v1', JSON.parse(context.keeperConfigText), JSON.parse(context.adapterConfigText), settings])
  const rows = () => store.db.query<Row, []>('SELECT * FROM keeper_maintenance ORDER BY rowid').all()
  const rowOf = (id: string) => store.db.query<Row, [string]>('SELECT * FROM keeper_maintenance WHERE id=?').get(id)

  function approved() {
    assertKeeperApproved(config.mode, context.keeperPreview, context.keeperConfigText, env.EQUILIBRIUM_KEEPER_APPROVAL, [config.arc.rpc, config.base.rpc])
    assertTransfersApproved(adapter.mode, context.adapterConfigText, context.transferSettingsText, env.EQUILIBRIUM_TRANSFER_APPROVAL, [adapter.arc.rpc, adapter.base.rpc])
  }

  /** Local cycle admission and maintenance reservation share the same IMMEDIATE SQLite lock. */
  function noRecordedExposure() {
    if (store.db.query("SELECT 1 FROM keeper_cycles WHERE state IN ('open','halted')").get()) {
      throw new KeeperError('unresolved_exposure', 'Maintenance refuses open, halted or finished-but-unclosed cycles. Reconcile/recover first.')
    }
  }
  async function guard() {
    approved()
    noRecordedExposure()
    await keeper.verify()
    await routes.sender.verify()
    const launch = launchOf(scope.launch) ?? fail('Maintenance requires its approved completed launch.')
    if (launch.state !== 'complete') fail('Maintenance requires its approved completed launch.')
    const L = layout(launch, adapter)
    for (const chain of ['arc', 'base'] as const) {
      const c = config[chain]
      const token = chain === 'arc' ? L.canonical : L.spoke
      const pool = launch.steps.find((step) => step.id === `pool:${chain}`)?.result?.address
      if (!same(c.token, token) || !pool || !same(c.pool, pool)) fail(`${chain} vault is not bound to this launch's asset and pool.`)
      const open = await keeper.clients[chain].readContract({ address: c.keeper, abi: keeperAbi, functionName: 'openCycles' })
      if (Number(open) !== 0) throw new KeeperError('unresolved_exposure', `Maintenance refuses the open position on ${chain}, including exposure absent from the local record.`)
    }
  }

  /** Each maintenance broadcast rechecks both chain and local exposure, including on restart. */
  function guarded<R>(route: TransferRoute<R>): TransferRoute<R> {
    return { ...route,
      async assertAllowed(request, existing) { await guard(); await route.assertAllowed(request, existing) },
      async broadcast(t, step, effect) { await guard(); await route.broadcast(t, step, effect) },
    }
  }
  // Gas caps do not authorize an additional native protocol payment. Keep that rail closed.
  const zeroFeeReturn = (id: string, step: string, effect: PreparedEffect) => {
    const plan = parsePlan(effect, hash([id, step]))
    if (plan.value !== '0' || plan.calls.some((call) => call.value !== '0')) {
      fail('Keeper maintenance accepts only zero-message-fee NTT returns. A native protocol fee needs separately bounded accounting and approval.')
    }
  }
  const returns: TransferRoute<ReturnRequest> = guarded({
    ...routes.returns,
    async prepare(t, step) {
      const effect = await routes.returns.prepare(t, step)
      zeroFeeReturn(t.id, step.id, effect)
      return effect
    },
    async observe(t, step, effect) { zeroFeeReturn(t.id, step.id, effect); return routes.returns.observe(t, step, effect) },
    async broadcast(t, step, effect) { zeroFeeReturn(t.id, step.id, effect); await routes.returns.broadcast(t, step, effect) },
  })
  const baseRefill = routes.refill!
  const refill: TransferRoute<RefillRequest> = guarded({
    ...baseRefill,
    version: `keeper-refill-v1:${hash([baseRefill.version, binding]).slice(2, 18)}`,
    steps: (request) => [...baseRefill.steps(request), { id: 'deposit:base-vault', chain: 'base' }],
    async prepare(t, step) {
      if (step.id !== 'deposit:base-vault') return baseRefill.prepare(t, step)
      return prepared({ chain: 'base', chainId: adapter.base.chainId, executor: adapter.base.executor,
        operation: hash([t.id, step.id]), value: '0', fromBlock: (await routes.sender.clients.base.getBlockNumber({ cacheTime: 0 })).toString(),
        calls: [call(config.base.quote, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [config.base.keeper, BigInt(t.request.amount)] }))],
        expect: { asset: config.base.quote, recipient: config.base.keeper, amount: t.request.amount } })
    },
    async observe(t, step, effect) {
      if (step.id !== 'deposit:base-vault') return baseRefill.observe(t, step, effect)
      const p = parsePlan(effect, hash([t.id, step.id]))
      const receipt = await routes.sender.observe(p, effect.digest)
      if (receipt === 'absent' || receipt === 'pending') return receipt
      const moved = receipt.logs.filter((log) => same(log.address, config.base.quote)).reduce((sum, log) => {
        try {
          const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics })
          return event.eventName === 'Transfer' && same(event.args.from, adapter.base.executor) && same(event.args.to, config.base.keeper) ? sum + event.args.value : sum
        } catch { return sum }
      }, 0n)
      return { operation: p.operation, transaction: receipt.transactionHash, finalized: true, amount: moved.toString(), cost: routes.sender.cost('base', receipt), by: 'executor' }
    },
    async broadcast(t, step, effect) {
      if (step.id !== 'deposit:base-vault') return baseRefill.broadcast(t, step, effect)
      await routes.sender.broadcast(parsePlan(effect, hash([t.id, step.id])), effect.digest)
    },
    validate(t, step, result) {
      if (step.id !== 'deposit:base-vault') return baseRefill.validate(t, step, result)
      if (result.amount !== t.request.amount) throw new Error('Keeper USDC deposit differs from its authenticated refill.')
    },
  })

  function parse(raw: MaintenanceRequest): MaintenanceRequest {
    if (!raw || typeof raw !== 'object' || Object.keys(raw).some((key) => !['requestId', 'tokens', 'quote'].includes(key))) fail('Expected a maintenance request with requestId, tokens and quote.')
    if (typeof raw.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,60}$/.test(raw.requestId)) fail('Invalid maintenance requestId.')
    if (![raw.tokens, raw.quote].every((value) => typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value)) || BigInt(raw.tokens) + BigInt(raw.quote) === 0n) fail('Maintenance amounts must be decimal atoms, with at least one positive amount.')
    if (BigInt(raw.tokens) > BigInt(scope.maxTokenPerTransfer) || BigInt(raw.quote) > BigInt(scope.maxQuotePerTransfer)) fail('Maintenance exceeds the approved per-transfer bounds.')
    return { requestId: raw.requestId, tokens: raw.tokens, quote: raw.quote }
  }

  function reserve(request: MaintenanceRequest): Row {
    return store.db.transaction(() => {
      const prior = rowOf(request.requestId)
      if (prior) {
        if (prior.binding !== binding || prior.request !== JSON.stringify(request)) fail('Maintenance identity is already bound to different bytes or settings.')
        return prior
      }
      noRecordedExposure()
      if (store.maintenancePending().length) throw new KeeperError('unresolved_exposure', 'Resume the unfinished maintenance before creating another.')
      const totals = rows().reduce((sum, row) => ({ tokens: sum.tokens + BigInt(row.tokens), quote: sum.quote + BigInt(row.quote) }), { tokens: 0n, quote: 0n })
      if (totals.tokens + BigInt(request.tokens) > BigInt(scope.maxTokenTotal) || totals.quote + BigInt(request.quote) > BigInt(scope.maxQuoteTotal)) fail('Maintenance exceeds the approved cumulative bounds; pending transfers still count.')
      store.db.query("INSERT INTO keeper_maintenance(id,binding,request,state,tokens,quote) VALUES(?,?,?,'pending',?,?)")
        .run(request.requestId, binding, JSON.stringify(request), request.tokens, request.quote)
      return rowOf(request.requestId)!
    }).immediate()
  }

  /** Actual mined send costs, including retries, counted once per chain/transaction; principal is excluded. */
  function costs(selected = rows()) {
    const operations = new Set(selected.flatMap((row) => [row.token_transfer, row.quote_transfer])
      .flatMap((id) => id ? transfers.get(id)?.steps.flatMap((step) => step.prepared ? [step.prepared.operation] : []) ?? [] : []))
    const seen = new Set<string>()
    let realized = 0n; let reserved = 0n
    for (const row of store.db.query<{ chain: 'arc' | 'base'; operation: string; tx: string | null; worst: string; actual: string | null }, []>('SELECT chain,operation,tx,worst,actual FROM evm_transfer_gas').all()) {
      if (!operations.has(row.operation as Hex)) continue
      const key = `${row.chain}:${row.tx}`
      if (row.tx && seen.has(key)) continue
      if (row.tx) seen.add(key)
      const wei = BigInt(row.actual ?? row.worst)
      const atoms = (wei * adapter[row.chain].usdcAtomsPerNative + 10n ** 18n - 1n) / 10n ** 18n
      if (row.actual === null) reserved += atoms
      else realized += atoms
    }
    return { realized: realized.toString(), reserved: reserved.toString() }
  }
  const status = (id: string) => {
    const row = rowOf(id)
    return row ? { id: row.id, state: row.state, request: JSON.parse(row.request) as MaintenanceRequest,
      transfers: [row.token_transfer, row.quote_transfer].flatMap((tx) => tx ? [publicTransfer(transfers.get(tx)!)] : []), costs: costs([row]) } : undefined
  }

  async function run(raw: MaintenanceRequest) {
    approved()
    const request = parse(raw)
    const existing = rowOf(request.requestId)
    if (existing && (existing.binding !== binding || existing.request !== JSON.stringify(request))) fail('Maintenance identity is already bound to different bytes or settings.')
    if (existing?.state === 'complete') return status(request.requestId)!
    await guard()
    reserve(request)
    if (BigInt(request.tokens) > 0n) {
      const transfer = await createTransfer(transfers, returns, { kind: 'return', source: 'executor', requestId: `${request.requestId}-tokens`, launch: scope.launch, amount: request.tokens, recipient: config.arc.keeper }, Math.floor(Date.now() / 1000))
      store.db.query('UPDATE keeper_maintenance SET token_transfer=? WHERE id=?').run(transfer.id, request.requestId)
      if ((await runTransfer(transfers, returns, transfer.id, Date.now, options.afterBroadcast)).state !== 'complete') return status(request.requestId)!
    }
    if (BigInt(request.quote) > 0n) {
      const transfer = await createTransfer(transfers, refill, { kind: 'refill', requestId: `${request.requestId}-quote`, from: 'arc', to: 'base', amount: request.quote, maxFee: '0' }, Math.floor(Date.now() / 1000))
      store.db.query('UPDATE keeper_maintenance SET quote_transfer=? WHERE id=?').run(transfer.id, request.requestId)
      if ((await runTransfer(transfers, refill, transfer.id, Date.now, options.afterBroadcast)).state !== 'complete') return status(request.requestId)!
    }
    await routes.sender.settleGas('arc'); await routes.sender.settleGas('base')
    if (BigInt(costs([rowOf(request.requestId)!]).reserved) !== 0n) throw new Error('Maintenance has unaccounted sends; reconcile before trading.')
    store.db.query("UPDATE keeper_maintenance SET state='complete' WHERE id=?").run(request.requestId)
    return status(request.requestId)!
  }

  return {
    keeper, sender: routes.sender, run, status,
    async reconcile() {
      const touched = []
      for (const id of store.maintenancePending()) touched.push(await run(JSON.parse(rowOf(id)!.request) as MaintenanceRequest))
      return touched
    },
    totals() {
      const maintenance = costs()
      const trading = store.totals()
      return { trading, maintenance, combinedNet: (BigInt(trading.net) - BigInt(maintenance.realized)).toString() }
    },
    preview() {
      const launch = launchOf(scope.launch)
      const L = launch ? layout(launch, adapter) : undefined
      return `## EQUILIBRIUM keeper inventory maintenance preview

Mode **${config.mode}**${config.mode === 'fork' ? ' — local fork rehearsal, not public approval' : ''}.

Existing launch: ${scope.launch}. No issuance, pool reseeding or holder inventory changes.

- Token route: Base executor ${adapter.base.executor} → authenticated NTT burn/Arc unlock → Arc keeper ${config.arc.keeper}.
- USDC route: Arc executor ${adapter.arc.executor} → authenticated CCTP V2 burn/mint → Base executor ${adapter.base.executor} → replay-protected deposit to Base keeper ${config.base.keeper}.
- Canonical/spoke assets: Arc ${config.arc.token}, Base ${config.base.token}.
- NTT managers: Arc ${L?.hub.proxy ?? 'unavailable'}, Base ${L?.spokeManager.proxy ?? 'unavailable'}.
- CCTP domains: Arc ${cctp.arc.domain}, Base ${cctp.base.domain}; attestation source ${settings.refill!.attestation.kind}.
- CCTP transmitters: Arc ${cctp.arc.messageTransmitter}, Base ${cctp.base.messageTransmitter}.
- Token bounds: ${scope.maxTokenPerTransfer} atoms per transfer, ${scope.maxTokenTotal} total.
- USDC bounds: ${scope.maxQuotePerTransfer} atoms per transfer, ${scope.maxQuoteTotal} total.
- Underlying transfer bounds: return ${settings.returns.maxPerTransfer} atoms; CCTP ${settings.refill!.maxPerTransfer} per transfer and ${settings.refill!.maxTotal} total.
- Transfer operator gas caps: Arc ${settings.operatorGas!.arc} wei; Base ${settings.operatorGas!.base} wei, L1 fee included.
- Protocol fees: zero-message-fee NTT and zero-fee CCTP only. Native protocol payments refuse before broadcast.

Maintenance refuses local or on-chain exposure. Pending maintenance blocks new keeper cycles. It resumes the same prepared executor operations after restart. Costs are counted once by mined transaction, separate from trading profit; transferred principal is neither profit nor cost.

${config.mode === 'fork' ? 'Fork substitutions: local Wormhole Guardian and CCTP attester sets, threshold 1; Arc USDC stand-in; development-key fork gas. Base starts at zero USDC and receives it through CCTP. These do not prove public attestations, Arc precompile settlement or real Base L1 fees.\n\n' : ''}Only Base→Arc token maintenance is available here. Arc→Base token refill remains closed; the keeper continues to refuse a depleted Base token inventory.

Requires both exact keeper approval ${keeperApprovalDigest(context.keeperPreview, context.keeperConfigText)} and separate transfer approval ${transferApprovalDigest(context.adapterConfigText, context.transferSettingsText)}. Launch approval is unchanged and authorizes no maintenance. No public authorization is inherited from a fork preview.

Stop: leave a pending transfer and its reserved bounds intact; reconcile it before starting a cycle. Never fund, change caps or replace a pending request to get past a stop.
`
    },
  }
}
