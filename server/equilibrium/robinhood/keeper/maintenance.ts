import { decodeEventLog, parseAbi, type TransactionReceipt } from 'viem'
import { hash } from '../../request'
import { coreAbi, erc20Abi, universal } from '../../evm/contracts'
import { publishedFrom } from '../../evm/vaa'
import { parseTransfer, managerDigest } from '../../evm/transfers/ntt'
import { nttViewAbi } from '../../evm/transfers/returns'
import { robinhoodRoute, type RobinhoodRouteConfig, type Side } from '../route'
import { createKeeper } from './keeper'
import { boundedSender, type SendOptions } from './sender'
import type { KeeperStore } from './store'
import { KeeperError, type KeeperConfig } from './types'

export interface MaintenanceScope { maxPerTransfer: string; maxTotal: string }
interface Row { id: string; binding: string; amount: string; state: string }
const capacityAbi = parseAbi(['function getCurrentOutboundCapacity() view returns (uint256)'])
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** Token refill only. No USDG refill rail, and no permission inherited from Base approvals. */
export function createMaintenance(config: KeeperConfig, routeConfig: RobinhoodRouteConfig, scope: MaintenanceScope, store: KeeperStore, options: SendOptions = {}) {
  config = structuredClone(config)
  scope = { ...scope }
  for (const value of [scope.maxPerTransfer, scope.maxTotal]) if (!/^[1-9]\d*$/.test(value)) throw new KeeperError('invalid_configuration', 'Explicit positive token bounds are required.')
  if (BigInt(scope.maxTotal) < BigInt(scope.maxPerTransfer)) throw new KeeperError('invalid_configuration', 'Total token cap cannot be smaller than one transfer.')
  const sender = boundedSender(config, store.db, options)
  const keeper = createKeeper(config, store)
  const route = robinhoodRoute(routeConfig, store.db, {
    async send(side, name, executor, data, value) {
      if (!name.startsWith('transfer:')) throw new KeeperError('not_approved', 'This scope permits token maintenance only.')
      await guard()
      return sender.send(route.layout.op(name), side, executor, data, value)
    },
  })
  const L = route.layout
  const binding = hash(JSON.stringify([keeper.manifest, routeConfig.asset, scope, routeConfig.arc, routeConfig.robinhood], (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v))
  const rows = () => store.db.query<Row, []>('SELECT id,binding,tokens AS amount,state FROM keeper_maintenance ORDER BY rowid').all()
  const rowOf = (id: string) => rows().find((r) => r.id === id)

  async function guard() {
    await keeper.verify()
    if (store.db.query("SELECT 1 FROM keeper_cycles WHERE state IN ('open','halted')").get()) throw new KeeperError('unresolved_exposure', 'Token maintenance refuses recorded exposure.')
    if (!same(config.arc.token, L.canonical) || !same(config.robinhood.token, L.spoke) || !same(config.robinhood.pool, await route.pool())) throw new KeeperError('invalid_configuration', 'Maintenance does not match the keeper asset/pool.')
    for (const side of ['arc', 'robinhood'] as const) {
      const c = config[side]; const r = routeConfig[side]
      if (c.chainId !== r.chainId || c.rpc !== r.rpc || c.finality !== r.confirmations || config.operatorKey !== routeConfig.operatorKey) throw new KeeperError('invalid_configuration', 'Keeper/route identity or finality differs.')
      if (await keeper.clients[side].readContract({ address: c.keeper, abi: (await import('./contracts')).keeperAbi, functionName: 'openCycles' }) !== 0) throw new KeeperError('unresolved_exposure', 'Token maintenance refuses on-chain exposure.')
    }
  }
  async function finalized(side: Side) {
    const head = await route.clients[side].getBlockNumber({ cacheTime: 0 })
    return head - BigInt(routeConfig[side].confirmations)
  }
  async function receipt(name: string, side: Side): Promise<TransactionReceipt | null> {
    const at = await finalized(side)
    if (await route.digestOf(side, L.op(name), at) === `0x${'0'.repeat(64)}`) return null
    const r = await route.executedReceipt(side, L.op(name))
    const block = await route.clients[side].getBlock({ blockNumber: r.blockNumber })
    if (block.hash !== r.blockHash || r.blockNumber > at) throw new KeeperError('chain_unavailable', 'Transfer receipt is not canonical and finalized.')
    return r
  }
  async function authenticated(id: string) {
    const t = route.get(id)!
    const debit = await receipt(`transfer:${id}:debit`, 'arc')
    if (!debit) return null
    const b = await route.clients.arc.getBlock({ blockNumber: debit.blockNumber })
    const messages = publishedFrom(debit.logs, routeConfig.arc.core, routeConfig.arc.wormholeChainId, Number(b.timestamp))
    if (messages.length !== 1 || !same(messages[0].emitter, universal(L.hub.transceiver))) throw new KeeperError('leg_failed', 'Debit has no unique bound Wormhole publication.')
    const x = parseTransfer(messages[0].payload)
    if (!same(x.sourceManager, universal(L.hub.proxy)) || !same(x.recipientManager, universal(L.spokeManager.proxy)) || x.toChain !== routeConfig.robinhood.wormholeChainId || !same(x.sourceToken, universal(L.canonical)) || x.decimals !== 6 || !same(x.sender, universal(routeConfig.arc.executor)) || !same(x.to, universal(config.robinhood.keeper)) || x.amount !== t.amount) throw new KeeperError('leg_failed', 'Authenticated debit differs from the reserved keeper refill.')
    return { digest: managerDigest(routeConfig.arc.wormholeChainId, x), debit }
  }
  async function supply() {
    const arcBlock = await finalized('arc'); const rhBlock = await finalized('robinhood')
    const issued = await route.clients.arc.readContract({ address: L.canonical, abi: erc20Abi, functionName: 'totalSupply', blockNumber: arcBlock })
    const custody = await route.clients.arc.readContract({ address: L.canonical, abi: erc20Abi, functionName: 'balanceOf', args: [L.hub.proxy], blockNumber: arcBlock })
    const spokeSupply = await route.clients.robinhood.readContract({ address: L.spoke, abi: erc20Abi, functionName: 'totalSupply', blockNumber: rhBlock })
    let pending = 0n
    const transfers = store.db.query<{ id: string; direction: string; amount: string }, []>('SELECT id,direction,amount FROM robinhood_transfers').all()
    for (const t of transfers) {
      const source = t.direction === 'outbound' ? 'arc' : 'robinhood'; const dest = source === 'arc' ? 'robinhood' : 'arc'
      if (await receipt(`transfer:${t.id}:debit`, source) && !await receipt(`transfer:${t.id}:credit`, dest)) pending += BigInt(t.amount)
    }
    const accounted = issued - custody + spokeSupply + pending
    return { arcBlock, rhBlock, issued, custody, spokeSupply, pending, accounted, reconciled: issued === routeConfig.asset.issuance && accounted === issued && custody === spokeSupply + pending }
  }

  async function run(request: { requestId: string; tokens: string; quote?: string }) {
    if (!request || Object.keys(request).some((k) => !['requestId','tokens','quote'].includes(k)) || !/^[a-zA-Z0-9_-]{8,60}$/.test(request.requestId) || !/^[1-9]\d{0,19}$/.test(request.tokens)) throw new KeeperError('invalid_configuration', 'Expected bounded token refill request.')
    if (request.quote !== undefined && request.quote !== '0') throw new KeeperError('chain_unavailable', 'USDG quote-asset refill is unavailable; Arc USDC is not USDG.')
    const amount = BigInt(request.tokens)
    if (amount > BigInt(scope.maxPerTransfer)) throw new KeeperError('size', 'Token per-transfer cap exceeded.')
    const prior = rowOf(request.requestId)
    if (prior && (prior.binding !== binding || prior.amount !== request.tokens)) throw new KeeperError('invalid_configuration', 'Refill identity is bound to different bytes/settings.')
    if (prior?.state === 'complete') return { state: 'complete', transfer: route.get(request.requestId), supply: await supply() }
    await guard()
    if (!prior) {
      const balance = await route.clients.arc.readContract({ address: L.canonical, abi: erc20Abi, functionName: 'balanceOf', args: [routeConfig.arc.executor] })
      const out = await route.clients.arc.readContract({ address: L.hub.proxy, abi: capacityAbi, functionName: 'getCurrentOutboundCapacity' })
      const inbound = await route.clients.robinhood.readContract({ address: L.spokeManager.proxy, abi: nttViewAbi, functionName: 'getCurrentInboundCapacity', args: [routeConfig.arc.wormholeChainId] })
      if (balance < amount) throw new KeeperError('inventory', 'Canonical executor inventory is depleted.')
      if (out < amount || inbound < amount) throw new KeeperError('size', 'NTT capacity would queue this refill.')
      const fee = await route.clients.arc.readContract({ address: routeConfig.arc.core, abi: coreAbi, functionName: 'messageFee' })
      if (fee !== 0n) throw new KeeperError('invalid_configuration', 'Nonzero native protocol fees remain closed.')
      store.db.transaction(() => {
        const raced = rowOf(request.requestId)
        if (raced) { if (raced.binding !== binding || raced.amount !== request.tokens) throw new KeeperError('invalid_configuration', 'Conflicting refill.'); return }
        if (store.db.query("SELECT 1 FROM keeper_cycles WHERE state IN ('open','halted')").get() || store.maintenancePending().length) throw new KeeperError('unresolved_exposure', 'Reconcile pending maintenance or exposure first.')
        if (rows().reduce((n, r) => n + BigInt(r.amount), 0n) + amount > BigInt(scope.maxTotal)) throw new KeeperError('spend_cap', 'Cumulative token cap exceeded; pending claims count.')
        store.db.query("INSERT INTO keeper_maintenance(id,binding,request,state,tokens,quote,token_transfer) VALUES(?,?,?,'pending',?,'0',?)").run(request.requestId, binding, JSON.stringify(request), request.tokens, request.requestId)
        route.transfer(request.requestId, 'outbound', amount, config.robinhood.keeper)
      }).immediate()
    }
    // Recover a signed-before-send or sent-before-receipt crash with the same private bytes.
    await sender.reconcile()
    const debit = await route.advance(request.requestId, 'attested')
    if (debit !== 'attested' && debit !== 'credited') return { state: debit }
    const proof = await authenticated(request.requestId)
    if (!proof) return { state: 'awaiting_finality' }
    await route.advance(request.requestId)
    const credit = await receipt(`transfer:${request.requestId}:credit`, 'robinhood')
    if (!credit) return { state: 'awaiting_credit_finality' }
    const redeemed = credit.logs.some((log) => same(log.address, L.spokeManager.proxy) && (() => {
      try { const e = decodeEventLog({ abi: nttViewAbi, data: log.data, topics: log.topics }); return e.eventName === 'TransferRedeemed' && same(e.args.digest, proof.digest) } catch { return false }
    })())
    const minted = credit.logs.filter((log) => same(log.address, L.spoke)).reduce((n, log) => {
      try { const e = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics }); return e.eventName === 'Transfer' && /^0x0+$/.test(e.args.from) && same(e.args.to, config.robinhood.keeper) ? n + e.args.value : n } catch { return n }
    }, 0n)
    if (minted !== amount) throw new KeeperError('leg_failed', 'Finalized mint amount/recipient differs.')
    if (!redeemed) throw new KeeperError('leg_failed', 'No authenticated matching redemption.')
    const reconciled = await supply()
    if (!reconciled.reconciled) throw new KeeperError('leg_failed', 'Finalized supply does not reconcile; trading remains closed.')
    await sender.reconcile()
    store.db.query("UPDATE keeper_maintenance SET state='complete' WHERE id=?").run(request.requestId)
    return { state: 'complete', transfer: route.get(request.requestId), supply: reconciled }
  }
  return { run, supply, route, sender, binding, scope }
}
