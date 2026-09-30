/** Combined pinned-fork proof. All sends are local; no service survives this foreground rehearsal. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeFunctionData, type Hex } from 'viem'
import { coreAbi, executorAbi } from '../evm/contracts'
import { conservation } from '../evm/transfers/returns'
import { transferApprovalDigest } from '../evm/transfers/config'
import { CCTP_TESTNET } from '../evm/transfers/cctp'
import type { EvmFileConfig } from '../evm/config'
import type { KeeperFileConfig } from './config'
import { keeperApprovalDigest } from './approval'
import { keeperAbi } from './contracts'
import { createKeeper } from './keeper'
import { createMaintenance } from './maintenance'
import { maintenanceForkEnvironment, MAINTENANCE_REQUEST, MAINTENANCE_TOKENS } from './maintenance-fork'
import { keeperPreview, vaultFacts } from './preview'
import { KeeperStore } from './store'
import { tick, type SessionResult } from './run'

export async function rehearseMaintenance(options: { writeArtifacts?: boolean } = {}) {
  const fixture = await maintenanceForkEnvironment()
  let store = new KeeperStore(fixture.path)
  try {
    let keeper = createKeeper(fixture.config, store)
    const initialPreview = keeperPreview(fixture.config, await vaultFacts(fixture.config), keeper.version, new Date().toISOString())
    const context = { ...fixture.texts, keeperPreview: initialPreview, env: fixture.keys }
    const paths = {
      keeper: join(fixture.dir, 'keeper.json'), adapter: join(fixture.dir, 'adapter.json'),
      settings: join(fixture.dir, 'settings.json'), preview: join(fixture.dir, 'keeper-preview.md'),
    }
    writeFileSync(paths.keeper, context.keeperConfigText)
    writeFileSync(paths.adapter, context.adapterConfigText)
    writeFileSync(paths.settings, context.transferSettingsText)
    writeFileSync(paths.preview, initialPreview)
    const processRestarts: { command: string; exitCode: number }[] = []
    // Each invocation is a new foreground process using only the persisted record and exact files.
    function cli<T>(command: string, args: string[] = []): T {
      const child = spawnSync(process.execPath, ['run', 'server/equilibrium/keeper/cli.ts', command, '--config', paths.keeper, ...args], {
        encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...fixture.keys,
          EQUILIBRIUM_KEEPER_DB: fixture.path, EQUILIBRIUM_DB: fixture.path,
          EQUILIBRIUM_EVM_CONFIG: paths.adapter, EQUILIBRIUM_TRANSFER_SETTINGS: paths.settings, EQUILIBRIUM_KEEPER_PREVIEW: paths.preview },
      })
      assert.equal(child.error, undefined)
      assert.equal(child.status, 0, child.stderr)
      processRestarts.push({ command, exitCode: child.status })
      return JSON.parse(child.stdout) as T
    }
    const make = (afterBroadcast?: (step: string) => void) => createMaintenance(context, store, (id) => fixture.jobs.get(id), { afterBroadcast })
    let maintenance = make()
    const before = await fixture.nonces()
    assert.throws(() => createMaintenance({ ...context, transferSettingsText: JSON.stringify({ ...fixture.settings,
      operatorGas: { arc: fixture.settings.operatorGas!.arc } }) }, store, (id) => fixture.jobs.get(id)), /base requires an explicit decimal transfer gas cap/)
    assert.throws(() => createMaintenance({ ...context, transferSettingsText: JSON.stringify({ ...fixture.settings,
      refill: { ...fixture.settings.refill!, cctp: { ...CCTP_TESTNET, arc: { ...CCTP_TESTNET.arc, usdc: CCTP_TESTNET.base.usdc } } } }) }, store, (id) => fixture.jobs.get(id)), /arc keeper and approved transfer configuration differ/)

    // A negative probe changes only the messageFee read; forwarding all other calls to the real fork.
    const feeCall = encodeFunctionData({ abi: coreAbi, functionName: 'messageFee' })
    const feeProxy = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const body = await request.json() as { id: number; method: string; params?: { to?: string; data?: Hex }[] }
      if (body.method === 'eth_call' && body.params?.[0]?.to?.toLowerCase() === fixture.env.config.base.core.toLowerCase() && body.params[0].data === feeCall) {
        return Response.json({ jsonrpc: '2.0', id: body.id, result: `0x${'1'.padStart(64, '0')}` })
      }
      return fetch(fixture.env.base.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    } })
    const feeStore = new KeeperStore(join(fixture.dir, 'fee-refusal.sqlite'))
    try {
      const feeRpc = `http://127.0.0.1:${feeProxy.port}`
      const keeperFile = JSON.parse(context.keeperConfigText) as KeeperFileConfig
      const adapterFile = JSON.parse(context.adapterConfigText) as EvmFileConfig
      const feeMaintenance = createMaintenance({ ...context,
        keeperConfigText: JSON.stringify({ ...keeperFile, base: { ...keeperFile.base, rpc: feeRpc } }),
        adapterConfigText: JSON.stringify({ ...adapterFile, base: { ...adapterFile.base, rpc: feeRpc } }),
      }, feeStore, (id) => fixture.jobs.get(id))
      await assert.rejects(feeMaintenance.run(MAINTENANCE_REQUEST), /only zero-message-fee NTT returns/)
      const refused = feeMaintenance.status(MAINTENANCE_REQUEST.requestId)!
      assert.equal(refused.state, 'pending')
      assert.match(refused.transfers[0].error!, /only zero-message-fee NTT returns/)
      assert.equal(refused.transfers[0].steps[0].state, 'planned')
      assert.deepEqual(refused.costs, { realized: '0', reserved: '0' })
    } finally { feeStore.close(); await feeProxy.stop(true) }
    assert.deepEqual(await fixture.nonces(), before)

    // Neither existing approval authorizes the other gate. These refusal probes cannot reach RPC sends.
    const publicKeeperFile: KeeperFileConfig = { ...(JSON.parse(fixture.texts.keeperConfigText) as KeeperFileConfig), mode: 'testnet' }
    const publicAdapterFile: EvmFileConfig = { ...(JSON.parse(fixture.texts.adapterConfigText) as EvmFileConfig), mode: 'testnet',
      vaa: { kind: 'wormholescan', api: 'https://example.invalid' }, scope: { launches: 1,
        payer: fixture.launch.request.payer, recipient: fixture.operator.address, issuance: fixture.launch.request.canonical.issuance,
        destinations: fixture.launch.request.destinations.map((destination) => ({ ...destination, chain: destination.chain as 'arc' | 'base' })),
        maxTotal: fixture.launch.total, operatorGas: fixture.settings.operatorGas! } }
    const publicSettings = { ...fixture.settings, refill: { ...fixture.settings.refill!, attestation: { kind: 'iris', api: 'https://example.invalid' } } }
    const publicContext = { ...context, keeperConfigText: JSON.stringify(publicKeeperFile), adapterConfigText: JSON.stringify(publicAdapterFile), transferSettingsText: JSON.stringify(publicSettings) }
    const keeperOnly = createMaintenance({ ...publicContext, env: { ...fixture.keys,
      EQUILIBRIUM_KEEPER_APPROVAL: keeperApprovalDigest(publicContext.keeperPreview, publicContext.keeperConfigText) } }, store, (id) => fixture.jobs.get(id))
    await assert.rejects(keeperOnly.run(MAINTENANCE_REQUEST), /without owner approval of this exact configuration and code/)
    const transferOnly = createMaintenance({ ...publicContext, env: { ...fixture.keys, EQUILIBRIUM_KEEPER_APPROVAL: 'wrong',
      EQUILIBRIUM_TRANSFER_APPROVAL: transferApprovalDigest(publicContext.adapterConfigText, publicContext.transferSettingsText) } }, store, (id) => fixture.jobs.get(id))
    await assert.rejects(transferOnly.run(MAINTENANCE_REQUEST), /without owner approval of this exact keeper preview/)
    assert.deepEqual(await fixture.nonces(), before)
    assert.equal(await fixture.balance('arc', 'token'), 0n)
    assert.equal(await fixture.balance('base', 'quote'), 0n)
    const depleted = await tick(keeper, store, MAINTENANCE_TOKENS)
    assert.equal(depleted.cycle, null)
    assert.equal(depleted.decision!.reason, 'inventory')
    assert.deepEqual(await fixture.nonces(), before)
    await assert.rejects(maintenance.run({ ...MAINTENANCE_REQUEST, requestId: 'maintenance-per-cap', tokens: '500000001' }), /per-transfer bounds/)
    assert.equal(store.maintenancePending().length, 0)
    assert.deepEqual(await fixture.nonces(), before)

    // First real send: authenticated Base NTT burn. Lose its result write and restart SQLite.
    maintenance = make((step) => { if (step === 'burn:base') throw new Error('Fork crash after the Base token burn.') })
    await assert.rejects(maintenance.run(MAINTENANCE_REQUEST), /Fork crash after the Base token burn/)
    assert.equal(store.maintenancePending().length, 1)
    const burnedNonce = await fixture.nonces()
    assert.deepEqual(burnedNonce, { arc: before.arc, base: before.base + 1 })
    assert.equal((await keeper.consider(MAINTENANCE_TOKENS)).decision.reason, 'unresolved_exposure')
    await assert.rejects(keeper.runCycle(MAINTENANCE_TOKENS, { id: 'blocked-over-maintenance' }), /Inventory maintenance is unfinished/)
    assert.deepEqual(await fixture.nonces(), burnedNonce)
    store.close(); store = new KeeperStore(fixture.path)

    // Resume the burn; lose the final deposit's write after it has mined. Every credit is already present.
    maintenance = make((step) => { if (step === 'deposit:base-vault') throw new Error('Fork crash after the Base vault deposit.') })
    await assert.rejects(maintenance.reconcile(), /Fork crash after the Base vault deposit/)
    const depositedNonce = await fixture.nonces()
    assert.deepEqual(depositedNonce, { arc: before.arc + 2, base: before.base + 3 })
    assert.equal(await fixture.balance('arc', 'token'), BigInt(MAINTENANCE_REQUEST.tokens))
    assert.equal(await fixture.balance('base', 'quote'), BigInt(MAINTENANCE_REQUEST.quote))
    assert.equal(store.maintenancePending().length, 1)
    assert.equal((await maintenance.keeper.consider(MAINTENANCE_TOKENS)).decision.reason, 'unresolved_exposure')
    const costBeforeFinalWrite = maintenance.totals().maintenance
    assert.equal(costBeforeFinalWrite.reserved, '0')
    assert(BigInt(costBeforeFinalWrite.realized) > 0n)
    store.close()
    const resumed = cli<{ result: { state: string }[] }>('maintenance-reconcile', ['--yes']).result
    store = new KeeperStore(fixture.path)
    maintenance = make()
    assert.equal(resumed.length, 1)
    assert.equal(resumed[0].state, 'complete')
    assert.deepEqual(await maintenance.reconcile(), [])
    assert.deepEqual(await fixture.nonces(), depositedNonce)
    assert.equal(store.maintenancePending().length, 0)
    assert.deepEqual(maintenance.totals().trading, { loss: '0', net: '0', closed: 0 })
    assert.deepEqual(maintenance.totals().maintenance, costBeforeFinalWrite)

    const complete = maintenance.status(MAINTENANCE_REQUEST.requestId)!
    const operations = complete.transfers.flatMap((transfer) => transfer.steps.map((step) => ({ chain: step.chain, ...step.result! })))
    assert.equal(operations.length, 5)
    const transactions = new Set(operations.map((operation) => `${operation.chain}:${operation.transaction}`))
    assert.equal(transactions.size, 5)
    let independentCost = 0n
    const receiptCosts = []
    for (const operation of operations) {
      const client = fixture.clients[operation.chain]
      const receipt = await client.getTransactionReceipt({ hash: operation.transaction })
      const rawL1 = (receipt as typeof receipt & { l1Fee?: string | bigint }).l1Fee ?? 0n
      const wei = receipt.gasUsed * receipt.effectiveGasPrice + BigInt(rawL1)
      const scale = 10n ** 18n
      const cost = (wei * fixture.env.config[operation.chain].usdcAtomsPerNative + scale - 1n) / scale
      assert.equal(operation.cost, cost.toString())
      independentCost += cost
      const event = executorAbi.find((item) => item.type === 'event' && item.name === 'Executed')!
      const logs = await client.getLogs({ address: fixture.env.config[operation.chain].executor, event, args: { operation: operation.operation }, fromBlock: fixture.env.config[operation.chain].fromBlock })
      assert.equal(logs.length, 1)
      receiptCosts.push({ chain: operation.chain, transaction: receipt.transactionHash, operation: operation.operation, gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: receipt.effectiveGasPrice.toString(), l1Fee: rawL1.toString(), cost: cost.toString(), executionLogs: logs.length })
    }
    assert.equal(complete.costs.realized, independentCost.toString())
    const supply = await conservation(maintenance.sender, fixture.env.config, fixture.launch)
    assert.equal(supply.conserved, true)
    assert.equal(supply.inFlight, '0')

    // Completed request/reconcile are no-ops after another restart, including maintenance accounting.
    store.close(); store = new KeeperStore(fixture.path)
    maintenance = make(); keeper = maintenance.keeper
    assert.deepEqual(await maintenance.reconcile(), [])
    await maintenance.run(MAINTENANCE_REQUEST)
    assert.deepEqual(await fixture.nonces(), depositedNonce)
    assert.deepEqual(maintenance.totals().maintenance, costBeforeFinalWrite)
    await assert.rejects(maintenance.run({ ...MAINTENANCE_REQUEST, tokens: '499999999' }), /already bound/)
    await assert.rejects(maintenance.run({ requestId: 'maintenance-over-cap', tokens: '1', quote: '0' }), /cumulative bounds/)
    assert.deepEqual(await fixture.nonces(), depositedNonce)

    // The restarted keeper can now execute a bounded cycle on the very same canonical/spoke markets.
    const decision = await keeper.consider(MAINTENANCE_TOKENS)
    assert.equal(decision.decision.reason, 'ok')
    assert.equal(decision.decision.candidate!.buy, 'base')
    assert.equal(decision.decision.candidate!.sell, 'arc')
    store.close()
    const session = cli<SessionResult>('run', ['--tokens', MAINTENANCE_TOKENS.toString(), '--ticks', '1', '--yes'])
    assert.equal(session.stopped, null)
    assert.equal(session.ticks.length, 1)
    store = new KeeperStore(fixture.path)
    maintenance = make(); keeper = maintenance.keeper
    const cycle = store.get(session.ticks[0].cycle!.id)!
    assert.equal(cycle.state, 'closed')
    const legs = cycle.legs.map((leg) => ({ ...leg.result!, chain: leg.chain, id: leg.plan.id }))
    const buy = legs.find((leg) => leg.chain === 'base')!
    const sell = legs.find((leg) => leg.chain === 'arc')!
    const tradeNet = BigInt(sell.amountOut) - BigInt(buy.amountIn) - BigInt(sell.cost) - BigInt(buy.cost)
    assert.equal(cycle.net, tradeNet.toString())
    assert.deepEqual(maintenance.totals().maintenance, costBeforeFinalWrite)
    assert.equal(maintenance.totals().combinedNet, (tradeNet - independentCost).toString())
    const afterTrade = await fixture.nonces()
    const tradedBalances = { arcTokens: (await fixture.balance('arc', 'token')).toString(), baseQuote: (await fixture.balance('base', 'quote')).toString() }
    const tradedTotals = maintenance.totals()
    store.close()
    assert.deepEqual(cli<{ result: unknown[] }>('maintenance-reconcile', ['--yes']).result, [])
    store = new KeeperStore(fixture.path)
    maintenance = make(); keeper = maintenance.keeper
    assert.deepEqual(await keeper.reconcile(), [])
    assert.deepEqual(await maintenance.reconcile(), [])
    await maintenance.run(MAINTENANCE_REQUEST)
    assert.deepEqual(await fixture.nonces(), afterTrade)
    assert.deepEqual(maintenance.totals(), tradedTotals)
    assert.deepEqual({ arcTokens: (await fixture.balance('arc', 'token')).toString(), baseQuote: (await fixture.balance('base', 'quote')).toString() }, tradedBalances)
    for (const leg of cycle.legs) {
      const event = keeperAbi.find((item) => item.type === 'event' && item.name === 'LegRun')!
      const logs = await fixture.clients[leg.chain].getLogs({ address: fixture.config[leg.chain].keeper, event, args: { leg: leg.plan.id }, fromBlock: fixture.config[leg.chain].fromBlock })
      assert.equal(logs.length, 1)
    }

    // Refuse local exposure and on-chain exposure even when the caller's separate store is empty.
    const exposure = await keeper.runCycle(MAINTENANCE_TOKENS, { id: 'maintenance-exposure', failSell: true })
    assert.equal(exposure.state, 'halted')
    const exposedNonce = await fixture.nonces()
    await assert.rejects(maintenance.run({ requestId: 'must-refuse-exposure', tokens: '1', quote: '0' }), /Maintenance refuses open/)
    const empty = new KeeperStore(join(fixture.dir, 'empty.sqlite'))
    try {
      const other = createMaintenance(context, empty, (id) => fixture.jobs.get(id))
      await assert.rejects(other.run({ requestId: 'must-refuse-chain-exposure', tokens: '1', quote: '0' }), /open position on base/)
    } finally { empty.close() }
    assert.deepEqual(await fixture.nonces(), exposedNonce)
    assert.equal((await keeper.recover(exposure.id)).state, 'recovered')
    await keeper.resume()

    const preview = keeperPreview(fixture.config, await vaultFacts(fixture.config), keeper.version, new Date().toISOString())
    maintenance = createMaintenance({ ...context, keeperPreview: preview }, store, (id) => fixture.jobs.get(id))
    if (options.writeArtifacts !== false) {
      writeFileSync('public/equilibrium-keeper-preview.md', preview)
      writeFileSync('public/equilibrium-maintenance-preview.md', maintenance.preview())
      writeFileSync('output/equilibrium-keeper-maintenance.json', fixture.texts.keeperConfigText)
      writeFileSync('output/equilibrium-maintenance-adapter.json', fixture.texts.adapterConfigText)
      writeFileSync('output/equilibrium-maintenance-transfer-settings.json', fixture.texts.transferSettingsText)
    }
    const evidence = {
      mode: 'fork', generatedAt: new Date().toISOString(), launch: fixture.launch.id,
      processRestarts,
      substitutions: ['Local Wormhole Guardian set and local CCTP attester set, threshold 1', 'Arc USDC precompile replaced with ForkUsdcCctp',
        'Development-key fork gas; initial payer USDC is a local stand-in balance', 'Base starts with zero USDC; its pool and keeper cash arrive through CCTP',
        'Keeper uses the launch canonical and authenticated NTT spoke, with existing operator-issued inventory staged in its executor before the experiment',
        'Anvil receipts usually omit L1 fees; real Base L1 fee calculation remains unproven',
        'One refusal probe overrides only the Base core messageFee RPC read on loopback; no sends occur'],
      depleted: { reason: depleted.decision!.reason, noncesBefore: before, noncesAfter: before },
      burnRestart: { nonces: burnedNonce, pendingBlocksTrading: true },
      depositRestart: { nonces: depositedNonce, pendingBlocksTrading: true, tokenBalance: MAINTENANCE_REQUEST.tokens, quoteBalance: MAINTENANCE_REQUEST.quote },
      maintenance: { ...complete, receiptCosts, independentCost: independentCost.toString(), finalNonces: depositedNonce },
      supply, cycle: { id: cycle.id, state: cycle.state, candidate: cycle.candidate, net: cycle.net, legs },
      afterTrading: { nonces: afterTrade, balances: tradedBalances, totals: tradedTotals },
      finalTotals: maintenance.totals(),
      keeperApproval: keeperApprovalDigest(preview, fixture.texts.keeperConfigText),
      checks: { depletedSendsNothing: true, authenticatedMaintenanceRestoresInventory: true, pendingBlocksTrading: true,
        burnRestartNoDuplicate: true, depositRestartNoDuplicate: true, cumulativeCapsAndIdentityRefused: true,
        supplyConserved: true, boundedCycleAfterRestart: true, secondReconcileSendsNothing: true, maintenanceCostCountedOnceAndSeparate: true,
        localExposureRefused: true, onChainExposureRefused: true, independentApprovalGatesRefused: true, freshProcessRestart: true,
        missingGasCapAndWrongUsdcRefused: true, unapprovedProtocolFeeRefused: true },
    }
    if (options.writeArtifacts !== false) writeFileSync('output/equilibrium-keeper-maintenance-evidence.json', JSON.stringify(evidence, null, 2) + '\n')
    return evidence
  } finally { store.close(); fixture.stop() }
}

if (import.meta.main) {
  const evidence = await rehearseMaintenance()
  console.log(JSON.stringify({ checks: evidence.checks, totals: evidence.afterTrading.totals, keeperApproval: evidence.keeperApproval }, null, 2))
}
