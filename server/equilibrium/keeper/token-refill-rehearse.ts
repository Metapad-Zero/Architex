/** Pinned Arc/Base fork proof; no public sends, no production keys, no surviving services. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestClient, createWalletClient, encodeFunctionData, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { hash } from '../request'
import { layout } from '../evm/adapter'
import { coreAbi, erc20Abi, executorAbi, transceiverAbi } from '../evm/contracts'
import { DEV, PINNED } from '../evm/fork'
import { publishedFrom } from '../evm/vaa'
import { fromFile as adapterFromFile, type EvmFileConfig } from '../evm/config'
import { transferApprovalDigest, TRANSFER_FILES, transferRoutes } from '../evm/transfers/config'
import { parsePlan } from '../evm/transfers/executor'
import { conservation } from '../evm/transfers/returns'
import { createTransfer, runTransfer } from '../evm/transfers/runner'
import { TransferStore } from '../evm/transfers/store'
import { keeperApprovalDigest, keeperManifest } from './approval'
import type { KeeperFileConfig } from './config'
import { createMaintenance, type MaintenanceRequest } from './maintenance'
import { createKeeper } from './keeper'
import { maintenanceForkEnvironment, MAINTENANCE_TOKENS } from './maintenance-fork'
import { keeperPreview, vaultFacts } from './preview'
import { KeeperStore } from './store'

export async function rehearseTokenRefill(options: { writeArtifacts?: boolean } = {}) {
  const fixture = await maintenanceForkEnvironment({ tokenRefill: true })
  let store = new KeeperStore(fixture.path)
  const artifacts = 'output/49th-38'
  try {
    const preview = keeperPreview(fixture.config, await vaultFacts(fixture.config), createKeeper(fixture.config, store).version, new Date().toISOString())
    const context = { ...fixture.texts, keeperPreview: preview, env: fixture.keys }
    for (const [file, text] of Object.entries({ 'keeper.json': context.keeperConfigText, 'adapter.json': context.adapterConfigText, 'settings.json': context.transferSettingsText, 'keeper-preview.md': preview })) writeFileSync(join(fixture.dir, file), text)
    const make = () => createMaintenance(context, store, (id) => fixture.jobs.get(id))
    let maintenance = make()
    const L = layout(fixture.launch, fixture.env.config)
    const testClients = { arc: createTestClient({ mode: 'anvil', transport: http(fixture.env.arc.url) }), base: createTestClient({ mode: 'anvil', transport: http(fixture.env.base.url) }) }
    const wallet = (chain: 'arc' | 'base', account = fixture.operator) => createWalletClient({ account, transport: http(fixture.env[chain].url) })
    const request: MaintenanceRequest = { requestId: 'keeper-forward-001', tokens: '500000000', quote: '0', tokenDirection: 'arc-to-base' }
    const before = await fixture.nonces()
    assert.equal(await fixture.balance('base', 'token'), 0n)
    await assert.rejects(maintenance.run(request), /Arc executor holds 0 atoms/)
    assert.deepEqual(await fixture.nonces(), before)
    assert.equal(maintenance.status(request.requestId)!.state, 'pending')
    assert.equal((await maintenance.keeper.consider(MAINTENANCE_TOKENS)).decision.reason, 'unresolved_exposure')
    await assert.rejects(maintenance.keeper.runCycle(MAINTENANCE_TOKENS, { id: 'forward-blocked' }), /Inventory maintenance is unfinished/)
    // Stage only existing, operator-owned canonical inventory. This setup is labelled and excluded from refill costs.
    const stock = await wallet('arc').writeContract({ account: fixture.operator, chain: null, address: L.canonical, abi: erc20Abi, functionName: 'transfer', args: [fixture.env.config.arc.executor, 1_000_000_000n] })
    await fixture.clients.arc.waitForTransactionReceipt({ hash: stock })
    const supplyBefore = await conservation(maintenance.sender, fixture.env.config, fixture.launch)

    // Fee read override is on loopback and forwards every other call to the real pinned fork.
    const feeCall = encodeFunctionData({ abi: coreAbi, functionName: 'messageFee' })
    const feeProxy = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
      const body = await req.json() as { id: number; method: string; params?: { to?: string; data?: Hex }[] }
      if (body.method === 'eth_call' && body.params?.[0]?.to?.toLowerCase() === fixture.env.config.arc.core.toLowerCase() && body.params[0].data === feeCall) return Response.json({ jsonrpc: '2.0', id: body.id, result: `0x${'1'.padStart(64, '0')}` })
      return fetch(fixture.env.arc.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    } })
    const probes = new KeeperStore(join(fixture.dir, 'fee.sqlite'))
    const nonceBeforeProbes = await fixture.nonces()
    try {
      const rpc = `http://127.0.0.1:${feeProxy.port}`
      const k = JSON.parse(context.keeperConfigText) as KeeperFileConfig; const a = JSON.parse(context.adapterConfigText) as EvmFileConfig
      const feeMaintenance = createMaintenance({ ...context, keeperConfigText: JSON.stringify({ ...k, arc: { ...k.arc, rpc } }), adapterConfigText: JSON.stringify({ ...a, arc: { ...a.arc, rpc } }) }, probes, (id) => fixture.jobs.get(id))
      await assert.rejects(feeMaintenance.run(request), /only zero-message-fee NTT/)
      assert.deepEqual(feeMaintenance.status(request.requestId)!.costs, { realized: '0', reserved: '0' })
      assert.equal(feeMaintenance.status(request.requestId)!.transfers[0].steps[0].state, 'planned')
    } finally { probes.close(); await feeProxy.stop(true) }
    const capped = new KeeperStore(join(fixture.dir, 'cap.sqlite'))
    try {
      const noGas = createMaintenance({ ...context, transferSettingsText: JSON.stringify({ ...fixture.settings, operatorGas: { arc: '0', base: '0' } }) }, capped, (id) => fixture.jobs.get(id))
      await assert.rejects(noGas.run(request), /gas would exceed/)
      assert.deepEqual(noGas.status(request.requestId)!.costs, { realized: '0', reserved: '0' })
    } finally { capped.close() }
    await assert.rejects(maintenance.run({ ...request, requestId: 'forward-per-cap', tokens: '500000001' }), /per-transfer bounds/)
    assert.deepEqual(await fixture.nonces(), nonceBeforeProbes)
    assert.throws(() => createMaintenance({ ...context, keeperConfigText: context.keeperConfigText.replace('"fork"', '"testnet"'), adapterConfigText: context.adapterConfigText.replace('"fork"', '"testnet"') }, store, (id) => fixture.jobs.get(id), { checkpoint() {} }), /fork-only/)

    // Hold the destination unfinalized: a finalized lock is a claim, never an extra circulating token.
    const delayedConfig = adapterFromFile(JSON.parse(context.adapterConfigText) as EvmFileConfig, fixture.keys)
    delayedConfig.base.finality = 2
    const delayed = transferRoutes(delayedConfig, fixture.settings, store.db, (id) => fixture.jobs.get(id), fixture.keys)
    const transfers = new TransferStore(store.db)
    const direct = await createTransfer(transfers, delayed.tokenRefill!, { kind: 'token-refill', requestId: 'forward-delayed-01', launch: fixture.launch.id, amount: '10000000', recipient: fixture.config.base.keeper }, Math.floor(Date.now() / 1000))
    // Authentication probes run against a fresh, unredeemed claim, before its valid mint.
    await assert.rejects(runTransfer(transfers, delayed.tokenRefill!, direct.id, Date.now, (step) => { if (step === 'lock:arc') throw new Error('stop-after-lock') }), /stop-after-lock/)
    const lockStep = transfers.get(direct.id)!.steps[0]
    const debit = await delayed.tokenRefill!.observe(direct, lockStep, lockStep.prepared!)
    assert(debit !== 'pending' && debit !== 'absent')
    const freshVaa = store.db.query<{ vaa: Hex }, [string]>('SELECT vaa FROM evm_token_refill_vaas WHERE transfer=?').get(direct.id)!.vaa
    const forgedFresh = `${freshVaa.slice(0, 22)}${freshVaa.slice(22, 24) === '00' ? '01' : '00'}${freshVaa.slice(24)}` as Hex
    await assert.rejects(fixture.clients.base.simulateContract({ account: fixture.operator, address: L.spokeManager.transceiver, abi: transceiverAbi, functionName: 'receiveMessage', args: [forgedFresh] }))
    const lockReceipt = await fixture.clients.arc.getTransactionReceipt({ hash: debit.transaction })
    const lockBlock = await fixture.clients.arc.getBlock({ blockNumber: lockReceipt.blockNumber })
    const message = publishedFrom(lockReceipt.logs, fixture.env.config.arc.core, fixture.env.config.arc.wormholeChainId, Number(lockBlock.timestamp))[0]
    const wrongPeer = await fixture.env.config.vaa.signed({ ...message, emitter: hash('unapproved-ntt-peer') })
    assert(wrongPeer)
    await assert.rejects(fixture.clients.base.simulateContract({ account: fixture.operator, address: L.spokeManager.transceiver, abi: transceiverAbi, functionName: 'receiveMessage', args: [wrongPeer] }))
    assert.equal(await fixture.balance('base', 'token'), 0n)
    let pending = await runTransfer(transfers, delayed.tokenRefill!, direct.id)
    assert.equal(pending.state, 'partial'); assert.equal(pending.steps[1].state, 'prepared')
    const supplyPending = await conservation(delayed.sender, delayedConfig, fixture.launch)
    assert.equal(supplyPending.conserved, true); assert.equal(supplyPending.inFlight, '10000000')
    const pendingNonce = await fixture.nonces()
    await runTransfer(transfers, delayed.tokenRefill!, direct.id)
    assert.deepEqual(await fixture.nonces(), pendingNonce)
    await testClients.base.mine({ blocks: 2 })
    pending = await runTransfer(transfers, delayed.tokenRefill!, direct.id)
    assert.equal(pending.state, 'complete')
    assert.equal((await conservation(delayed.sender, delayedConfig, fixture.launch)).inFlight, '0')

    // Every checkpoint kills a real child process. Only the fork lease is accelerated to 200ms.
    const crashes = []
    const points = ['before-send', 'after-send', 'before-cost-write', 'after-cost-write', 'before-receipt-write', 'after-receipt-write']
    for (const step of ['lock:arc', 'mint:base']) for (const point of points) {
      const r: MaintenanceRequest = { ...request, requestId: `forward-${step.split(':')[0]}-${point}`, tokens: '10000000' }
      // Finish the initial maintenance before admitting another. It also proves recovery of the depleted request.
      if (store.maintenancePending().length) await maintenance.reconcile()
      const nonce = await fixture.nonces(); const baseBalance = await fixture.balance('base', 'token')
      store.close()
      const child = spawnSync(process.execPath, ['run', 'server/equilibrium/keeper/__tests__/token-refill-worker.ts', fixture.dir, fixture.path, point, step, JSON.stringify(r)], {
        encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...fixture.keys },
      })
      assert.equal(child.error, undefined); assert.equal(child.status, 86, child.stderr + child.stdout)
      const boundary = JSON.parse(child.stdout.trim()) as { point: string; step: string; operation: Hex; transfer: Hex }
      await new Promise((resolve) => setTimeout(resolve, 250))
      store = new KeeperStore(fixture.path); maintenance = make()
      assert.equal(store.maintenancePending().length, 1)
      assert.equal((await maintenance.keeper.consider(MAINTENANCE_TOKENS)).decision.reason, 'unresolved_exposure')
      const reserved = maintenance.status(r.requestId)!.costs
      const recovered = await maintenance.reconcile()
      assert.equal(recovered[0].state, 'complete')
      assert.deepEqual(await fixture.nonces(), { arc: nonce.arc + 1, base: nonce.base + 1 })
      assert.equal(await fixture.balance('base', 'token'), baseBalance + BigInt(r.tokens))
      const costs = maintenance.status(r.requestId)!.costs
      assert.equal(costs.reserved, '0')
      assert(BigInt(costs.realized) > 0n)
      await maintenance.run(r); assert.deepEqual(await maintenance.reconcile(), [])
      assert.deepEqual(await fixture.nonces(), { arc: nonce.arc + 1, base: nonce.base + 1 })
      assert.deepEqual(maintenance.status(r.requestId)!.costs, costs)
      crashes.push({ ...boundary, exitCode: child.status, reservedAtCrash: reserved, finalCosts: costs, noncesBefore: nonce, noncesAfter: await fixture.nonces() })
    }
    const complete = maintenance.status(request.requestId)!
    assert.equal(complete.state, 'complete')
    await assert.rejects(maintenance.run({ ...request, tokenDirection: 'base-to-arc' }), /already bound/)
    const finalNonce = await fixture.nonces()
    const raceStore = new KeeperStore(join(fixture.dir, 'reservation-race.sqlite'))
    try {
      const raceRoutes = transferRoutes(fixture.env.config, { ...fixture.settings, tokenRefill: { maxPerTransfer: '1000', maxTotal: '1000' } }, raceStore.db, (id) => fixture.jobs.get(id), fixture.keys)
      const raceTransfers = new TransferStore(raceStore.db)
      const admissions = await Promise.allSettled(['a','b'].map((suffix) => createTransfer(raceTransfers, raceRoutes.tokenRefill!, {
        kind: 'token-refill', requestId: `forward-race-${suffix}`, launch: fixture.launch.id, amount: '1000', recipient: fixture.config.base.keeper,
      }, Math.floor(Date.now() / 1000))))
      assert.equal(admissions.filter((r) => r.status === 'fulfilled').length, 1)
      assert.equal(admissions.filter((r) => r.status === 'rejected').length, 1)
      const failure = admissions.find((r) => r.status === 'rejected') as PromiseRejectedResult
      assert.match(String(failure.reason), /cumulative cap/)
    } finally { raceStore.close() }
    const initialTransfer = new TransferStore(store.db).get(complete.transfers[0].id)!
    const mint = initialTransfer.steps[1]
    const mintPlan = parsePlan(mint.prepared!, hash([initialTransfer.id, mint.id]))
    // Both protocol VAA replay and executor-operation replay revert in contract simulation.
    await assert.rejects(fixture.clients.base.simulateContract({ account: fixture.operator, address: mintPlan.calls[0].target, abi: transceiverAbi, functionName: 'receiveMessage', args: [store.db.query<{ vaa: Hex }, [string]>('SELECT vaa FROM evm_token_refill_vaas WHERE transfer=?').get(initialTransfer.id)!.vaa] }))
    await assert.rejects(fixture.clients.base.simulateContract({ account: fixture.operator, address: fixture.env.config.base.executor, abi: executorAbi, functionName: 'execute', args: [mintPlan.operation, mint.prepared!.digest, mintPlan.calls.map((c) => ({ ...c, value: BigInt(c.value) }))] }))
    // A forged signature cannot redeem an unrecognized claim; unauthorized users cannot use the executor.
    const vaa = store.db.query<{ vaa: Hex }, [string]>('SELECT vaa FROM evm_token_refill_vaas WHERE transfer=?').get(initialTransfer.id)!.vaa
    const forged = `${vaa.slice(0, 22)}${vaa.slice(22, 24) === '00' ? '01' : '00'}${vaa.slice(24)}` as Hex
    await assert.rejects(fixture.clients.base.simulateContract({ account: fixture.operator, address: mintPlan.calls[0].target, abi: transceiverAbi, functionName: 'receiveMessage', args: [forged] }))
    await assert.rejects(fixture.clients.arc.simulateContract({ account: privateKeyToAccount(DEV.payer), address: fixture.env.config.arc.executor, abi: executorAbi, functionName: 'execute', args: [hash('unauthorized-refill'), hash('unauthorized-refill-bytes'), []] }))
    assert.deepEqual(await fixture.nonces(), finalNonce)

    const receiptCosts = []
    let independentCost = 0n
    for (const row of store.db.query<{ data: string }, []>('SELECT data FROM evm_transfers').all()) {
      const t = JSON.parse(row.data) as typeof initialTransfer
      if (t.kind !== 'token-refill') continue
      for (const step of t.steps) {
        const result = step.result!; const receipt = await fixture.clients[step.chain].getTransactionReceipt({ hash: result.transaction })
        const l1Fee = BigInt((receipt as typeof receipt & { l1Fee?: string | bigint }).l1Fee ?? 0n)
        const wei = receipt.gasUsed * receipt.effectiveGasPrice + l1Fee
        const cost = (wei * fixture.env.config[step.chain].usdcAtomsPerNative + 10n ** 18n - 1n) / 10n ** 18n
        assert.equal(result.cost, cost.toString())
        const executions = await fixture.clients[step.chain].getLogs({ address: fixture.env.config[step.chain].executor, event: executorAbi.find((e) => e.type === 'event' && e.name === 'Executed')!, args: { operation: result.operation }, fromBlock: fixture.env.config[step.chain].fromBlock })
        assert.equal(executions.length, 1)
        // The separate finalized-delay probe is a transfer, outside maintenance accounting.
        if (t.id !== direct.id) independentCost += cost
        receiptCosts.push({ transfer: t.id, chain: step.chain, transaction: result.transaction, operation: result.operation, gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: receipt.effectiveGasPrice.toString(), l1Fee: l1Fee.toString(), cost: cost.toString(), executionLogs: executions.length })
      }
    }
    assert.equal(maintenance.totals().maintenance.realized, independentCost.toString())
    assert.equal(maintenance.totals().maintenance.reserved, '0')
    for (const chain of ['arc','base'] as const) assert(maintenance.sender.committed(chain) <= BigInt(fixture.settings.operatorGas![chain]))
    const supply = await conservation(maintenance.sender, fixture.env.config, fixture.launch)
    assert.equal(supply.conserved, true); assert.equal(supply.inFlight, '0')
    assert.equal(supply.issuance, supplyBefore.issuance)
    const transferred = 630_000_000n // 500m initial + 10m finalized-delay probe + twelve 10m crash probes
    assert.equal(BigInt(supply.custody) - BigInt(supplyBefore.custody), transferred)
    assert.equal(BigInt(supply.remote) - BigInt(supplyBefore.remote), transferred)
    assert.equal(await fixture.balance('base', 'token'), transferred)
    const finalTotals = maintenance.totals()
    store.close(); store = new KeeperStore(fixture.path); maintenance = make()
    await maintenance.run(request); assert.deepEqual(await maintenance.reconcile(), [])
    assert.deepEqual(maintenance.totals(), finalTotals); assert.deepEqual(await fixture.nonces(), finalNonce)
    const evidence = {
      issue: '49TH-38', mode: 'fork', baseRevision: '4f48dfa6953d105d175ba15e9aa2af25628dfb34', generatedAt: new Date().toISOString(),
      pins: { arc: { chainId: PINNED.arc.chainId, block: PINNED.arc.block.toString() }, base: { chainId: PINNED.base.chainId, block: PINNED.base.block.toString() } },
      substitutions: ['Local Guardian and CCTP attester sets, threshold 1', 'Arc USDC stand-in and development-key gas only on loopback forks',
        'Existing issued canonical inventory staged by operator transfer, excluded from refill costs', 'Crash worker lease accelerated to 200ms; public default remains 30000ms',
        'Anvil omits real Base L1 fees; live fee calculation remains unproven', 'Fee refusal overrides only the Arc messageFee read on loopback'],
      request, initial: complete, crashes, receiptCosts, independentMaintenanceCost: independentCost.toString(), supplyBefore, supplyPending, supply, finalTotals,
      checks: { authenticatedDebitCredit: true, independentFinalizedSupply: true, depletedInventoryRefused: true, pendingBlocksTrading: true,
        boundedGasAndCosts: true, nonzeroProtocolFeeRefused: true, replayRejected: true, forgedAndUnauthorizedRejected: true,
        allTwelveProcessCrashesRecovered: true, completedRestartSendsNothing: true, conflictingDirectionRefused: true, racingCumulativeCapReservedOnce: true, freshClaimAuthenticationRefused: true },
      keeperApproval: keeperApprovalDigest(preview, context.keeperConfigText), transferApproval: transferApprovalDigest(context.adapterConfigText, context.transferSettingsText),
      keeperManifest: keeperManifest(),
    }
    if (options.writeArtifacts !== false) {
      mkdirSync(artifacts, { recursive: true })
      for (const [file, text] of Object.entries({ 'keeper.json': context.keeperConfigText, 'adapter.json': context.adapterConfigText, 'transfer-settings.json': context.transferSettingsText, 'keeper-preview.md': preview, 'maintenance-preview.md': maintenance.preview() })) writeFileSync(join(artifacts, file), text)
      writeFileSync(join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
      const { readFileSync } = await import('node:fs')
      writeFileSync(join(artifacts, 'approval-manifests.json'), JSON.stringify({ keeper: keeperManifest(), transfer: TRANSFER_FILES.map((file) => ({ file, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') })), keeperApproval: evidence.keeperApproval, transferApproval: evidence.transferApproval }, null, 2) + '\n')
    }
    return evidence
  } finally { store.close(); await fixture.stop() }
}
if (import.meta.main) console.log(JSON.stringify((await rehearseTokenRefill()).checks, null, 2))
