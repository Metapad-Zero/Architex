import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeEventLog, encodeFunctionData, type Hex } from 'viem'
import { DEV } from '../../evm/fork'
import { executorAbi, transceiverAbi, erc20Abi, nttAbi } from '../../evm/contracts'
import { createKeeper } from './keeper'
import { keeperAbi, legStruct } from './contracts'
import { createMaintenance } from './maintenance'
import { keeperFork, LABELS, SCOPE, stringify, configToJson } from './fork'
import { decide } from './policy'
import { boundedSender } from './sender'
import { KeeperStore } from './store'

/** Assertions and evidence come from actual fork receipts and child-process death, not a mock runner. */
export async function rehearse(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const journal = join(directory, '49th40.sqlite')
  const f = await keeperFork(journal)
  const { store, tests, keeperConfig: config, routeConfig } = f
  const keeperFile = join(directory, 'private-keeper.json'); const routeFile = join(directory, 'private-route.json')
  writeFileSync(keeperFile, stringify(config), { mode: 0o600 })
  writeFileSync(routeFile, configToJson(routeConfig, f.env.guardianSets), { mode: 0o600 })
  let mining = true; let miningWork = Promise.resolve()
  const timer = setInterval(() => {
    if (mining) miningWork = miningWork.then(async () => {
      await tests.arc.mine({ blocks: 1, interval: 1 }); await tests.robinhood.mine({ blocks: 1, interval: 1 })
    })
  }, 300)
  const mineBoth = async () => { await tests.arc.mine({ blocks: 3, interval: 1 }); await tests.robinhood.mine({ blocks: 3, interval: 1 }) }
  const evidence: Record<string, unknown> = { labels: LABELS, scope: SCOPE, fork: { arc: f.env.config.arc.fromBlock.toString(), robinhood: f.env.robinhood.block.toString(), pins: f.env.robinhood.pins }, publicRoutes: 'closed', quoteAssetRefill: 'unavailable' }
  const keeper = createKeeper(config, store)
  const maintenance = createMaintenance(config, routeConfig, SCOPE, store)
  const settleRefill = async (id: string, tokens: string) => {
    for (let i = 0; i < 8; i++) {
      const result = await maintenance.run({ requestId: id, tokens })
      if (result.state === 'complete') return result
      await mineBoth()
    }
    throw new Error(`Refill ${id} failed to complete`)
  }
  const crashes: unknown[] = []
  async function crash(action: string, id: string, point: string, side: string) {
    const worker = spawn('bun', [join(import.meta.dir, 'worker.ts'), journal, keeperFile, routeFile, action, id, point, side], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''; let err = ''
    worker.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    worker.stderr.on('data', (chunk: Buffer) => { err += chunk.toString() })
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      const timeout = setTimeout(() => { worker.kill('SIGKILL'); reject(new Error(`Worker timeout: ${action} ${point} ${side}`)) }, 40_000)
      worker.on('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }) })
      worker.on('error', reject)
    })
    assert.equal(result.signal, 'SIGKILL', `Crash seam was not reached: ${out} ${err}`)
    assert(out.includes('killed'), 'Worker was killed by the harness timeout, not its selected seam')
    crashes.push({ action, id, point, side, pid: worker.pid, ...result, checkpoint: JSON.parse(out.trim()) as unknown })
  }
  try {
    await keeper.verify()
    const missingInventory = await keeper.consider(1_000_000_000n)
    assert.equal(missingInventory.decision.reason, 'inventory')
    await assert.rejects(maintenance.run({ requestId: 'no-usdg-refill', tokens: '1', quote: '1' }), /USDG quote-asset refill is unavailable/)
    await assert.rejects(maintenance.run({ requestId: 'too-large-refill', tokens: '4000000001' }), /per-transfer cap/)
    // A debit may be mined but neither authenticated nor finalized yet. No credit or trade is allowed.
    mining = false; await miningWork
    const first = await maintenance.run({ requestId: 'initial-keeper-refill', tokens: '4000000000' })
    assert.equal(first.state, 'awaiting_finality')
    assert.equal((await keeper.consider(1_000_000_000n)).decision.reason, 'unresolved_exposure')
    await mineBoth()
    const pendingSupply = await maintenance.supply()
    assert.equal(pendingSupply.pending, 4_000_000_000n); assert(pendingSupply.reconciled)
    const credit = await maintenance.run({ requestId: 'initial-keeper-refill', tokens: '4000000000' })
    assert.equal(credit.state, 'awaiting_credit_finality')
    await mineBoth()
    const initial = await settleRefill('initial-keeper-refill', '4000000000')
    assert(initial.supply?.reconciled)
    evidence.initialRefill = { before: missingInventory, debit: first, pendingSupply, credit, final: initial }
    const vaa = maintenance.route.get('initial-keeper-refill')!.vaa!
    const forged = `${vaa.slice(0, -2)}${vaa.endsWith('00') ? '01' : '00'}` as Hex
    await assert.rejects(maintenance.route.clients.robinhood.call({ to: maintenance.route.layout.spokeManager.transceiver, data: encodeFunctionData({ abi: transceiverAbi, functionName: 'receiveMessage', args: [forged] }) }))
    await assert.rejects(maintenance.route.clients.robinhood.call({ to: maintenance.route.layout.spokeManager.transceiver, data: encodeFunctionData({ abi: transceiverAbi, functionName: 'receiveMessage', args: [vaa] }) }))
    await assert.rejects(maintenance.run({ requestId: 'initial-keeper-refill', tokens: '1' }), /different bytes/)
    const refillReplay = await settleRefill('initial-keeper-refill', '4000000000')
    assert.equal(refillReplay.transfer?.creditTx, initial.transfer?.creditTx)
    evidence.authentication = { forgedVaaRejected: true, vaaReplayRejected: true, conflictingIdentityRejected: true, creditReplaySameTransaction: true }
    mining = true
    const before = await keeper.consider(1_000_000_000n)
    assert.equal(before.decision.reason, 'ok')
    const success = await keeper.runCycle(1_000_000_000n, { id: 'quote-versus-fill' })
    assert.equal(success.state, 'closed')
    for (const leg of success.legs) {
      const q = before.snapshot.quotes[leg.chain]
      if (leg.kind === 'buy') assert.equal(leg.result!.amountIn, q.rawBuyCost)
      if (leg.kind === 'sell') assert.equal(leg.result!.amountOut, q.rawSellProceeds)
      assert.equal(leg.result!.finalized, true)
      await assert.rejects(keeper.clients[leg.chain].call({ account: (await import('viem/accounts')).privateKeyToAccount(DEV.operator).address, to: leg.plan.keeper, data: encodeFunctionData({ abi: keeperAbi, functionName: 'run', args: [legStruct(leg.plan)] }) }))
    }
    evidence.quotesVsFills = { snapshot: before.snapshot, cycle: success, usdRate: config.robinhood.valuation, equalityInOriginalAssets: true, poolFeesCountedOnce: true, keeperReplayRejected: true }
    const stale = structuredClone(before.snapshot); stale.lag.robinhood.seconds = config.policy.maxQuoteAgeSeconds + 1
    assert.equal(decide(stale, config.policy).reason, 'stale_quote')
    const unavailable = structuredClone(before.snapshot); unavailable.stalled = ['robinhood']
    assert.equal(decide(unavailable, config.policy).reason, 'chain_unavailable')
    const spent = structuredClone(before.snapshot); spent.quotes.arc.spentQuote = config.policy.spendCap
    assert.equal(decide(spent, config.policy).reason, 'spend_cap')
    const loss = structuredClone(before.snapshot); loss.loss = config.policy.lossCap
    assert.equal(decide(loss, config.policy).reason, 'loss_cap')
    const reserve = structuredClone(before.snapshot); reserve.quotes.arc.keeperQuote = (BigInt(reserve.quotes.arc.buyCost) + BigInt(reserve.quotes.arc.legCost)).toString()
    assert.equal(decide(reserve, config.policy).reason, 'recovery_reserve')
    const absentRate = structuredClone(config); delete (absentRate.robinhood as Partial<typeof absentRate.robinhood>).valuation
    await assert.rejects(async () => createKeeper(absentRate, new (await import('./store')).KeeperStore(':memory:', { allowEphemeral: true })).consider(1n), /valuation is unavailable/)
    const absentFee = structuredClone(config); delete (absentFee.robinhood as Partial<typeof absentFee.robinhood>).feeInput
    await assert.rejects(async () => createKeeper(absentFee, new (await import('./store')).KeeperStore(':memory:', { allowEphemeral: true })).consider(1n), /fee fixture is unavailable/)
    evidence.refusals = ['stale_quote', 'chain_unavailable', 'inventory', 'spend_cap', 'loss_cap', 'recovery_reserve', 'token_per_transfer', 'unavailable_usdg_refill', 'missing_valuation', 'missing_l1_input']
    const partial = await keeper.runCycle(1_000_000_000n, { id: 'partial-recovery', failSell: true })
    assert.equal(partial.state, 'halted')
    await assert.rejects(keeper.runCycle(1_000_000_000n), /halted|open position/)
    await assert.rejects(maintenance.run({ requestId: 'exposed-refill', tokens: '1' }), /exposure/)
    await crash('recover', 'partial-recovery', 'after-send', 'arc')
    await mineBoth(); await keeper.reconcile()
    const recovered = store.get('partial-recovery')!
    assert.equal(recovered.state, 'recovered')
    assert(BigInt(recovered.net!) < 0n)
    await keeper.resume()
    evidence.partialLeg = { partial, recovered, tradingHalted: true, maintenanceRefused: true }
    // Twelve independent real SIGKILLs cover signed-before-send and both sides of receipt/cost writes.
    for (const side of ['arc', 'robinhood']) {
      for (const point of ['after-sign', 'after-send', 'after-receipt', 'before-cost', 'after-cost']) {
        const id = `crash-${side}-${point}`
        await crash('maintenance', id, point, side)
        const reserved = store.maintenancePending(); assert(reserved.includes(id))
        assert.equal((await keeper.consider(100_000_000n)).decision.reason, 'unresolved_exposure')
        const completed = await settleRefill(id, '100000000')
        assert(completed.supply?.reconciled)
      }
    }
    for (const [side, point] of [['arc','after-sign'], ['robinhood','after-send']] as const) {
      const id = `trade-crash-${side}`
      await crash('trade', id, point, side)
      await keeper.sender.reconcile(); await mineBoth(); await keeper.reconcile()
      if (side === 'arc') {
        assert.equal(store.get(id)!.state, 'halted')
        await keeper.recover(id); await keeper.resume()
      } else assert.equal(store.get(id)!.state, 'closed')
    }
    evidence.processCrashes = crashes
    // Gas/cumulative-cost/native inventory refusals execute the actual sender preflight.
    const capProof = async (change: 'leg' | 'operating') => {
      const bounded = structuredClone(config)
      if (change === 'leg') bounded.policy.maxLegCost = '1'
      else bounded.policy.operatingCap = '1'
      const isolated = new KeeperStore(':memory:', { allowEphemeral: true })
      try {
        const sender = boundedSender(bounded, isolated.db)
        await assert.rejects(sender.send(`refuse-${change}`, 'robinhood', config.robinhood.keeper, encodeFunctionData({ abi: keeperAbi, functionName: 'halt', args: ['cost cap fixture'] })), change === 'leg' ? /leg cost budget/ : /operating cost cap/)
        assert.equal(sender.rows().length, 0)
      } finally { isolated.close() }
    }
    await capProof('leg'); await capProof('operating')
    // Cumulative token bounds include every completed and pending admission.
    await settleRefill('cumulative-token-1', '4000000000')
    await settleRefill('cumulative-token-2', '4000000000')
    await assert.rejects(maintenance.run({ requestId: 'cumulative-token-3', tokens: '4000000000' }), /Cumulative token cap/)
    mining = false; await miningWork
    const snapshotId = await tests.arc.snapshot()
    const held = await keeper.clients.arc.readContract({ address: config.arc.token, abi: erc20Abi, functionName: 'balanceOf', args: [routeConfig.arc.executor] })
    await f.route.execute('fixture-deplete-source', 'arc', () => [{ target: config.arc.token, value: '0', data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [(keeper.manifest.operator as Hex), held] }) }])
    await assert.rejects(maintenance.run({ requestId: 'depleted-source-refill', tokens: '1' }), /inventory is depleted/)
    await tests.arc.revert({ id: snapshotId })
    const rateSnapshot = await tests.arc.snapshot()
    await f.route.execute('fixture-deplete-capacity', 'arc', () => [{ target: f.route.layout.hub.proxy, value: '0', data: encodeFunctionData({ abi: nttAbi, functionName: 'setOutboundLimit', args: [0n] }) }])
    await assert.rejects(maintenance.run({ requestId: 'depleted-ntt-capacity', tokens: '1' }), /NTT capacity/)
    await tests.arc.revert({ id: rateSnapshot })
    const nativeBalance = await keeper.clients.robinhood.getBalance({ address: keeper.manifest.operator as Hex })
    await tests.robinhood.setBalance({ address: keeper.manifest.operator as Hex, value: 0n })
    const nativeStore = new KeeperStore(':memory:', { allowEphemeral: true })
    try {
      await assert.rejects(boundedSender(config, nativeStore.db).send('native-empty', 'robinhood', config.robinhood.keeper, encodeFunctionData({ abi: keeperAbi, functionName: 'halt', args: ['native inventory fixture'] })), /gas inventory|insufficient funds/i)
      assert.equal(nativeStore.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM rh_sends').get()?.n, 0)
    } finally { nativeStore.close(); await tests.robinhood.setBalance({ address: keeper.manifest.operator as Hex, value: nativeBalance }) }
    mining = true
    evidence.boundedPreflight = { legCost: 'refused before signing', cumulativeOperating: 'refused before signing', cumulativeTokens: 'refused before debit', depletedCanonical: 'refused before debit', depletedNttCapacity: 'refused before debit', depletedNative: 'refused before signing', rollback: 'fork snapshot fixtures only' }
    await mineBoth(); await keeper.sender.reconcile()
    const supply = await maintenance.supply(); assert(supply.reconciled); assert.equal(supply.pending, 0n)
    const operations = store.db.query<{ operation: Hex; side: 'arc' | 'robinhood'; name: string }, []>("SELECT operation,side,name FROM robinhood_ops WHERE name LIKE 'transfer:%'").all()
    const transferReceipts = []
    for (const op of operations) {
      const receipt = await maintenance.route.executedReceipt(op.side, op.operation)
      const executed = receipt.logs.filter((l) => l.address.toLowerCase() === routeConfig[op.side].executor.toLowerCase()).flatMap((l) => {
        try { const event = decodeEventLog({ abi: executorAbi, data: l.data, topics: l.topics }); return event.eventName === 'Executed' && event.args.operation === op.operation ? [event] : [] } catch { return [] }
      })
      assert.equal(executed.length, 1)
      transferReceipts.push({ ...op, tx: receipt.transactionHash, block: receipt.blockNumber.toString(), executions: executed.length })
      const persisted = store.db.query<{ digest: Hex; bytes: string }, [Hex]>('SELECT digest,bytes FROM robinhood_ops WHERE operation=?').get(op.operation)!
      const plan = JSON.parse(persisted.bytes) as { calls: { target: Hex; value: string; data: Hex }[] }
      await assert.rejects(maintenance.route.clients[op.side].call({ account: (await import('viem/accounts')).privateKeyToAccount(DEV.operator).address, to: routeConfig[op.side].executor, data: encodeFunctionData({ abi: executorAbi, functionName: 'execute', args: [op.operation, persisted.digest, plan.calls.map((c) => ({ ...c, value: BigInt(c.value) }))] }) }))
    }
    const rows = keeper.sender.rows(); const costs = keeper.sender.totals()
    assert.equal(costs.reserved, 0n); assert(costs.realized <= BigInt(config.policy.operatingCap))
    let independent = 0n
    for (const row of rows) {
      const receipt = await keeper.clients[row.side].getTransactionReceipt({ hash: row.tx })
      const c = config[row.side]
      const atoms = (receipt.gasUsed * receipt.effectiveGasPrice + BigInt(c.feeInput.l1UpperWei)) * c.quoteAtomsPerNative
      const expected = (atoms + 10n ** 18n - 1n) / 10n ** 18n
      assert.equal(BigInt(row.actual!), expected); independent += expected
    }
    assert.equal(costs.realized, independent)
    const trading = store.totals()
    // net includes leg gas; controls and maintenance are the rest, counted once in combined cash result.
    const legGas = store.list().flatMap((c) => c.legs).reduce((n, l) => n + BigInt(l.result?.cost ?? '0'), 0n)
    evidence.costs = { trading, gas: costs, independentlyReconciled: independent, legGas, otherOperating: costs.realized - legGas, combinedNet: BigInt(trading.net) - (costs.realized - legGas), internalVolumeIsRevenue: false, valuation: 'conservative USDC reference; no USDG conversion executed', rows }
    evidence.finalSupply = supply; evidence.transferReceipts = transferReceipts
    evidence.assetBalances = {
      arc: await keeper.clients.arc.readContract({ address: config.arc.token, abi: erc20Abi, functionName: 'balanceOf', args: [config.arc.keeper] }),
      robinhood: await keeper.clients.robinhood.readContract({ address: config.robinhood.token, abi: erc20Abi, functionName: 'balanceOf', args: [config.robinhood.keeper] }),
    }
    evidence.manifests = { keeper: keeper.manifest, transfer: { binding: maintenance.binding, scope: SCOPE, environment: routeConfig.environment, asset: routeConfig.asset, chains: { arc: { ...routeConfig.arc }, robinhood: { ...routeConfig.robinhood } }, guardian: { kind: 'fork-local', sets: f.env.guardianSets } } }
    return evidence
  } finally {
    clearInterval(timer); mining = false; await miningWork
    store.close(); await f.stop()
  }
}
