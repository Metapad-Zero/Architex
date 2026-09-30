/**
 * FORK REHEARSAL of the Arc hub and Base spoke adapter against pinned forks of the real public
 * testnets. Opt-in because it starts two anvil forks from public RPCs:
 *
 *   EQUILIBRIUM_FORK=1 bun test server/equilibrium/evm/__tests__/fork.test.ts
 *
 * Substitutions (guardian key, Arc USDC code, Base USDC inventory) are described in fork.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestClient, createWalletClient, encodeFunctionData, http, parseAbi, publicActions, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { JobStore } from '../../store'
import { createLaunchService } from '../../service'
import { publicJob, quote, reconcile, runJob } from '../../runner'
import { hash } from '../../request'
import type { Job, PromotionalTokenAdapter } from '../../types'
import { evmAdapter, layout, weiOf } from '../adapter'
import { toFile } from '../config'
import { erc20Abi, executorAbi, transceiverAbi } from '../contracts'
import { DEV, PINNED, forkEnvironment, type ForkEnvironment } from '../fork'
import { payer, request, signedHeader, signedPayment } from './harness'

const enabled = process.env.EQUILIBRIUM_FORK === '1'
const suite = enabled ? describe : describe.skip
const ZERO = `0x${'0'.repeat(64)}`
const operator = privateKeyToAccount(DEV.operator)
let env: ForkEnvironment
let dir: string
let store: JobStore
let adapter: ReturnType<typeof evmAdapter>
const now = () => Math.floor(Date.now() / 1000)
const test_ = (name: string, fn: () => Promise<void>) => test(name, fn, 600_000)

function chainClient(chain: 'arc' | 'base') {
  const url = env[chain].url
  return { test: createTestClient({ mode: 'anvil', transport: http(url) }).extend(publicActions), wallet: createWalletClient({ account: operator, transport: http(url) }) }
}
const balance = (chain: 'arc' | 'base', token: Address, owner: Address) => chainClient(chain).test.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
const supply = (chain: 'arc' | 'base', token: Address) => chainClient(chain).test.readContract({ address: token, abi: erc20Abi, functionName: 'totalSupply' })
async function executions(chain: 'arc' | 'base', operation: Hex) {
  const logs = await chainClient(chain).test.getLogs({ address: env.config[chain].executor, event: executorAbi.find((x) => x.type === 'event' && x.name === 'Executed')!, args: { operation }, fromBlock: PINNED[chain].block + 1n })
  return logs.length
}
const stepChain = (id: string): 'arc' | 'base' => (id.endsWith(':arc') || id.startsWith('debit') ? 'arc' : 'base')
async function everyStepOnce(job: Job) {
  for (const s of job.steps) expect([s.id, await executions(stepChain(s.id), hash([job.id, s.id]))]).toEqual([s.id, 1])
}
async function paid(requestId: string, a: PromotionalTokenAdapter = adapter) {
  const job = quote(store, a, request(requestId, now()), now())
  return { job, payment: await signedPayment(job) }
}

suite('EQUILIBRIUM Arc–Base adapter on pinned testnet forks', () => {
  beforeAll(async () => {
    env = await forkEnvironment()
    dir = mkdtempSync(join(process.cwd(), 'output', 'fork-'))
    store = new JobStore(join(dir, 'jobs.sqlite'), { leaseMs: 1000 })
    adapter = evmAdapter(env.config, store.db)
    await adapter.verify()
  }, 600_000)
  afterAll(() => { store?.close(); env?.stop(); if (dir) rmSync(dir, { recursive: true, force: true }) })

  let first: Job
  test_('a paid x402 request settles once, issues, bridges and seeds both pools; supply reconciles on-chain', async () => {
    const service = createLaunchService(store, adapter)
    const body = JSON.stringify(request('fork-launch-0001', now()))
    const quoted = await service(new Request('http://fork/x402/equilibrium', { method: 'POST', body }))
    expect(quoted.status).toBe(402)
    const job = quote(store, adapter, JSON.parse(body), now())
    const payerBefore = await balance('arc', PINNED.arc.usdc, payer.address)
    const response = await service(new Request('http://fork/x402/equilibrium', { method: 'POST', body, headers: { 'payment-signature': await signedHeader(job) } }))
    expect(response.status).toBe(200)
    expect(response.headers.get('payment-response')).toBeTruthy()
    first = store.get(job.id)!
    const record = publicJob(first)
    expect(record.state).toBe('complete')
    expect(record.supply.reconciled).toBe(true)

    const L = layout(first, env.config)
    const [arcDest, baseDest] = first.request.destinations
    // Canonical supply is fixed; custody backs exactly the Base representation.
    expect(await supply('arc', L.canonical)).toBe(1_000_000_000_000n)
    expect(await balance('arc', L.canonical, L.hub.proxy)).toBe(BigInt(baseDest.amount))
    expect(await supply('base', L.spoke)).toBe(BigInt(baseDest.amount))
    // Pools hold exactly the bound inventory, read from the pool contracts themselves.
    const arcPool = first.steps.find((s) => s.id === 'pool:arc')!.result!.address as Address
    const basePool = first.steps.find((s) => s.id === 'pool:base')!.result!.address as Address
    expect(await balance('arc', L.canonical, arcPool)).toBe(BigInt(arcDest.poolTokens))
    expect(await balance('arc', PINNED.arc.usdc, arcPool)).toBe(BigInt(arcDest.poolQuote))
    expect(await balance('base', L.spoke, basePool)).toBe(BigInt(baseDest.poolTokens))
    expect(await balance('base', PINNED.base.usdc, basePool)).toBe(BigInt(baseDest.poolQuote))
    // Allocations reached the recipient; nothing stays in the executors.
    const recipient = first.request.canonical.recipient
    expect(await balance('arc', L.canonical, recipient)).toBe(1_000_000_000_000n - BigInt(baseDest.amount) - BigInt(arcDest.poolTokens))
    expect(await balance('base', L.spoke, recipient)).toBe(BigInt(baseDest.amount) - BigInt(baseDest.poolTokens))
    expect(await balance('arc', L.canonical, env.config.arc.executor)).toBe(0n)
    expect(await balance('base', L.spoke, env.config.base.executor)).toBe(0n)
    // Settlement moved exactly the quoted total from the payer.
    expect(payerBefore - await balance('arc', PINNED.arc.usdc, payer.address)).toBe(BigInt(first.total))
    await everyStepOnce(first)
  })

  test_('resending the same paid request resumes the record and executes nothing again', async () => {
    const service = createLaunchService(store, adapter)
    const response = await service(new Request('http://fork/x402/equilibrium', { method: 'POST', body: JSON.stringify(first.request), headers: { 'payment-signature': await signedHeader(first) } }))
    expect(response.status).toBe(200)
    await everyStepOnce(first)
  })

  test_('a stale worker racing a live worker on the same prepared debit moves the tokens once', async () => {
    const { job, payment } = await paid('fork-stale-0001')
    // A second adapter instance stands in for a worker in another process: its own nonce view and send queue.
    const stale = evmAdapter(env.config, store.db)
    const racing: PromotionalTokenAdapter = { ...adapter, broadcast: async (context, prepared) => {
      if (context.step.id !== 'debit:base') return adapter.broadcast(context, prepared)
      await Promise.all([adapter.broadcast(context, prepared), stale.broadcast(context, prepared)])
    } }
    const result = await runJob(store, racing, job.id, payment)
    expect([result.state, result.error]).toEqual(['complete', undefined])
    const L = layout(result, env.config)
    expect(await balance('arc', L.canonical, L.hub.proxy)).toBe(BigInt(result.request.destinations[1].amount))
    expect(await supply('base', L.spoke)).toBe(BigInt(result.request.destinations[1].amount))
    await everyStepOnce(result)
  })

  test_('a late duplicate after completion sends nothing, and a raw resubmission reverts on-chain', async () => {
    const credit = first.steps.find((s) => s.id === 'credit:base')!
    const L = layout(first, env.config)
    const before = await supply('base', L.spoke)
    await adapter.broadcast({ job: first, step: credit }, credit.prepared!)
    const plan = JSON.parse(credit.prepared!.bytes) as { operation: Hex; calls: { target: Address; value: string; data: Hex }[] }
    const { wallet, test } = chainClient('base')
    const raw = wallet.writeContract({ chain: null, address: env.config.base.executor, abi: executorAbi, functionName: 'execute', gas: 2_000_000n,
      args: [plan.operation, credit.prepared!.digest, plan.calls.map((c) => ({ target: c.target, value: BigInt(c.value), data: c.data }))] })
    const receipt = await test.waitForTransactionReceipt({ hash: await raw })
    expect(receipt.status).toBe('reverted')
    expect(await supply('base', L.spoke)).toBe(before)
    expect(await executions('base', plan.operation)).toBe(1)
  })

  test_('a replayed or forged VAA cannot credit again, directly or through a fresh executor operation', async () => {
    const L = layout(first, env.config)
    const vaa = store.db.query<{ vaa: string }, [string]>('SELECT vaa FROM evm_vaas WHERE operation=?').get(hash([first.id, 'debit:base']))!.vaa as Hex
    const { wallet, test } = chainClient('base')
    const before = await supply('base', L.spoke)
    const attempts: Hex[] = [
      await wallet.writeContract({ chain: null, address: L.spokeManager.transceiver, abi: transceiverAbi, functionName: 'receiveMessage', args: [vaa], gas: 2_000_000n }),
      await wallet.writeContract({ chain: null, address: env.config.base.executor, abi: executorAbi, functionName: 'execute', gas: 2_000_000n,
        args: [hash(['replay', first.id]), hash('replay'), [{ target: L.spokeManager.transceiver, value: 0n, data: encodeFunctionData({ abi: transceiverAbi, functionName: 'receiveMessage', args: [vaa] }) }]] }),
      await wallet.writeContract({ chain: null, address: L.spokeManager.transceiver, abi: transceiverAbi, functionName: 'receiveMessage', args: [`${vaa.slice(0, 22)}${vaa[22] === 'a' ? 'b' : 'a'}${vaa.slice(23)}` as Hex], gas: 2_000_000n }),
    ]
    for (const hashValue of attempts) expect((await test.waitForTransactionReceipt({ hash: hashValue })).status).toBe('reverted')
    expect(await supply('base', L.spoke)).toBe(before)
  })

  test_('bytes that differ from what an operation executed are refused, not re-executed', async () => {
    const pool = first.steps.find((s) => s.id === 'pool:base')!
    const plan = JSON.parse(pool.prepared!.bytes) as { fromBlock: string }
    const bytes = JSON.stringify({ ...plan, fromBlock: (BigInt(plan.fromBlock) - 1n).toString() })
    const altered = { ...pool.prepared!, bytes, digest: hash(bytes) }
    let observed: unknown; try { await adapter.observe({ job: first, step: pool }, altered) } catch (cause) { observed = cause }
    expect(String(observed)).toContain('already bound to other bytes')
    let sent: unknown; try { await adapter.broadcast({ job: first, step: pool }, altered) } catch (cause) { sent = cause }
    expect(String(sent)).toContain('already bound to other bytes')
  })

  test_('only the owner can execute', async () => {
    const stranger = createWalletClient({ account: privateKeyToAccount(DEV.payer), transport: http(env.base.url) })
    const { test } = chainClient('base')
    await test.setBalance({ address: payer.address, value: 10n ** 18n })
    const tx = await stranger.writeContract({ chain: null, address: env.config.base.executor, abi: executorAbi, functionName: 'execute', args: [hash('x'), hash('y'), []], gas: 200_000n })
    expect((await test.waitForTransactionReceipt({ hash: tx })).status).toBe('reverted')
  })

  for (const crash of ['after:credit:base', 'before:debit:base', 'after:pool:arc']) {
    test_(`a worker process killed ${crash.replace(':', ' broadcast of ')} is finished by reconcile with every effect exactly once`, async () => {
      const { job, payment } = await paid(`fork-crash-${crash.replace(/:/g, '-')}`)
      const configPath = join(dir, 'config.json'); const paymentPath = join(dir, `${job.id}.json`)
      writeFileSync(configPath, JSON.stringify(toFile(env.config, 0)))
      writeFileSync(paymentPath, JSON.stringify(payment))
      const child = spawnSync('bun', ['run', 'server/equilibrium/evm/__tests__/crash-worker.ts', configPath, join(dir, 'jobs.sqlite'), job.id, paymentPath, crash],
        { env: { ...process.env, EQUILIBRIUM_OPERATOR_KEY: DEV.operator, EQUILIBRIUM_FORK_GUARDIAN_KEY: DEV.guardian }, encoding: 'utf8', timeout: 300_000 })
      expect([child.status, (child.stdout + child.stderr).slice(-1500)]).toEqual([crash.startsWith('before') ? 78 : 77, (child.stdout + child.stderr).slice(-1500)])
      expect(store.get(job.id)!.state).not.toBe('complete')
      await new Promise((r) => setTimeout(r, 1500)) // the dead worker's lease expires
      const resumed = await reconcile(store, adapter)
      expect(resumed.find((r) => r.id === job.id)?.state).toBe('complete')
      const done = store.get(job.id)!
      const L = layout(done, env.config)
      expect(await supply('base', L.spoke)).toBe(BigInt(done.request.destinations[1].amount))
      expect(await balance('arc', L.canonical, L.hub.proxy)).toBe(BigInt(done.request.destinations[1].amount))
      expect(publicJob(done).supply.reconciled).toBe(true)
      await everyStepOnce(done)
    })
  }

  test_('the approved scope allows one paid launch, refuses a second before any charge, and never sends past the gas cap', async () => {
    const scopedStore = new JobStore(join(dir, 'scoped.sqlite'), { leaseMs: 1000 })
    const r = request('scope-0001', now())
    const scope = { launches: 1, payer: r.payer, recipient: r.canonical.recipient, issuance: r.canonical.issuance,
      destinations: r.destinations.map(({ chain, amount, poolTokens, poolQuote }) => ({ chain: chain as 'arc' | 'base', amount, poolTokens, poolQuote })), maxTotal: '39000000',
      operatorGas: { arc: (10n ** 20n).toString(), base: (10n ** 18n).toString() } }
    const scoped = evmAdapter({ ...env.config, scope }, scopedStore.db)
    const service = createLaunchService(scopedStore, scoped)
    const post = async (body: typeof r) => {
      const job = quote(scopedStore, scoped, body, now())
      return service(new Request('http://fork/x402/equilibrium', { method: 'POST', body: JSON.stringify(body), headers: { 'payment-signature': await signedHeader(job) } }))
    }
    expect((await post(r)).status).toBe(200)
    const before = await balance('arc', PINNED.arc.usdc, payer.address)
    let refused: unknown; try { await post(request('scope-0002', now())) } catch (cause) { refused = cause }
    expect(String(refused)).toContain('already hold an authorization')
    expect(await balance('arc', PINNED.arc.usdc, payer.address)).toBe(before)
    // A cap below one send's worst case refuses before anything reaches the chain.
    const capStore = new JobStore(join(dir, 'capped.sqlite'), { leaseMs: 1000 })
    const capped = evmAdapter({ ...env.config, scope: { ...scope, operatorGas: { arc: '1', base: '1' } } }, capStore.db)
    const c = request('cap-0001', now())
    const job = quote(capStore, capped, c, now())
    let blocked: unknown; try { await runJob(capStore, capped, job.id, await signedPayment(job)) } catch (cause) { blocked = cause }
    expect(String(blocked)).toContain('operator gas would exceed')
    expect(capStore.db.query('SELECT COUNT(*) AS n FROM evm_broadcasts').get()).toEqual({ n: 0 })
    expect(await executions('arc', hash([job.id, 'payment:arc']))).toBe(0)
    scopedStore.close(); capStore.close()
  })

  /** A worker in its own process, sharing the store file. Resolves with its exit and its one-line report. */
  async function worker(config: object, db: string, job: Job, mode: string) {
    const configPath = join(dir, `config-${job.id.slice(2, 10)}.json`); const paymentPath = join(dir, `${job.id}.json`)
    writeFileSync(configPath, JSON.stringify(config)); writeFileSync(paymentPath, JSON.stringify(await signedPayment(job)))
    const child = Bun.spawn(['bun', 'run', 'server/equilibrium/evm/__tests__/crash-worker.ts', configPath, db, job.id, paymentPath, mode],
      { env: { ...process.env, EQUILIBRIUM_OPERATOR_KEY: DEV.operator, EQUILIBRIUM_FORK_GUARDIAN_KEY: DEV.guardian }, stdout: 'pipe', stderr: 'pipe' })
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    await child.exited
    return { code: child.exitCode, signal: child.signalCode, report: out.trim() ? JSON.parse(out.trim().split('\n').pop()!) as { ok: boolean; code?: string; state?: string } : null, err: err.slice(-600) }
  }
  const scopeOf = (r: ReturnType<typeof request>, launches: number, arcGas: bigint) => ({ launches, payer: r.payer, recipient: r.canonical.recipient, issuance: r.canonical.issuance,
    destinations: r.destinations.map(({ chain, amount, poolTokens, poolQuote }) => ({ chain: chain as 'arc' | 'base', amount, poolTokens, poolQuote })), maxTotal: '39000000',
    operatorGas: { arc: arcGas.toString(), base: (10n ** 18n).toString() } })
  async function receiptOf(chain: 'arc' | 'base', operation: Hex) {
    const [log] = await chainClient(chain).test.getLogs({ address: env.config[chain].executor, event: executorAbi.find((x) => x.type === 'event' && x.name === 'Executed')!, args: { operation }, fromBlock: PINNED[chain].block + 1n })
    return chainClient(chain).test.getTransactionReceipt({ hash: log.transactionHash })
  }
  let paymentWorst = 0n

  test_('a process SIGKILLed after sending, before any receipt accounting, stays counted at worst case and never under-counts the cap', async () => {
    const db = join(dir, 'killed.sqlite')
    const killedStore = new JobStore(db, { leaseMs: 1000 })
    const scoped = { ...env.config, scope: scopeOf(request('kill-0001', now()), 1, 10n ** 20n) }
    const job = quote(killedStore, evmAdapter(scoped, killedStore.db), request('kill-0001', now()), now())
    const run = await worker(toFile(scoped, 0), db, job, 'kill-after-send:canonical:arc')
    expect([run.signal, run.code, run.report, run.err]).toEqual(['SIGKILL', null, null, run.err])
    // The transaction reached the chain; the dead process recorded nothing about it but the reservation.
    const operation = hash([job.id, 'canonical:arc'])
    // The killed process handed the transaction to the node; the node mines it on its own schedule.
    for (let i = 0; i < 100 && (await executions('arc', operation)) === 0; i++) await new Promise((r) => setTimeout(r, 100))
    const mined = await receiptOf('arc', operation)
    const orphan = killedStore.db.query<{ worst: string; tx: string | null; actual: string | null }, [string]>('SELECT worst, tx, actual FROM evm_gas WHERE operation=?').get(operation)!
    expect([orphan.tx, orphan.actual]).toEqual([null, null])
    expect(BigInt(orphan.worst)).toBeGreaterThanOrEqual(weiOf(mined))
    await new Promise((r) => setTimeout(r, 1500))
    const resumed = evmAdapter(scoped, killedStore.db)
    // Reconcile as the sweep does: pending evidence is retried, never re-executed.
    for (let i = 0; i < 10 && killedStore.get(job.id)!.state !== 'complete'; i++) await reconcile(killedStore, resumed)
    expect([killedStore.get(job.id)!.state, killedStore.get(job.id)!.error]).toEqual(['complete', undefined])
    await resumed.settleGas('arc')
    const done = killedStore.get(job.id)!
    await everyStepOnce(done)
    // Committed gas equals every real Arc receipt, plus exactly the orphan's over-count.
    let real = 0n
    for (const s of done.steps.filter((x) => stepChain(x.id) === 'arc')) real += weiOf(await receiptOf('arc', hash([job.id, s.id])))
    expect(resumed.committed('arc')).toBe(real + BigInt(orphan.worst) - weiOf(mined))
    paymentWorst = BigInt(killedStore.db.query<{ worst: string }, [string]>('SELECT worst FROM evm_gas WHERE operation=?').get(hash([job.id, 'payment:arc']))!.worst)
    killedStore.close()
  })

  test_('gas reservations are shared across processes: a dead worker\'s unsettled reservation blocks a second send, and racing workers never commit past the cap', async () => {
    const cap = (paymentWorst * 15n) / 10n // one worst case fits; two unsettled ones do not
    // 1. Worker A is SIGKILLed right after sending its payment: its reservation can never settle.
    const db = join(dir, 'gas-shared.sqlite')
    const shared = new JobStore(db, { leaseMs: 1000 })
    const scoped = { ...env.config, scope: scopeOf(request('gas-0001', now()), 2, cap) }
    const a = quote(shared, evmAdapter(scoped, shared.db), request('gas-0001', now()), now())
    const b = quote(shared, evmAdapter(scoped, shared.db), request('gas-0002', now()), now())
    const file = toFile(scoped, 0)
    expect((await worker(file, db, a, 'kill-after-send:payment:arc')).signal).toBe('SIGKILL')
    for (let i = 0; i < 100 && (await executions('arc', hash([a.id, 'payment:arc']))) === 0; i++) await new Promise((r) => setTimeout(r, 100))
    // 2. Worker B, a different process, sees A's reservation and refuses before sending anything.
    const run = await worker(file, db, b, 'none')
    expect(run.report).toMatchObject({ ok: false, code: 'gas_cap' })
    expect(await executions('arc', hash([b.id, 'payment:arc']))).toBe(0)
    expect(shared.db.query('SELECT COUNT(*) AS n FROM evm_broadcasts WHERE operation=?').get(hash([b.id, 'payment:arc']))).toEqual({ n: 0 })
    expect(evmAdapter(scoped, shared.db).committed('arc')).toBeLessThanOrEqual(cap)
    shared.close()
    // 3. Two workers started together: whatever interleaving happens, the ledger never commits past the cap.
    const racedb = join(dir, 'gas-race.sqlite')
    const race = new JobStore(racedb, { leaseMs: 1000 })
    const c = quote(race, evmAdapter(scoped, race.db), request('gas-0003', now()), now())
    const d = quote(race, evmAdapter(scoped, race.db), request('gas-0004', now()), now())
    const runs = await Promise.all([worker(file, racedb, c, 'none'), worker(file, racedb, d, 'none')])
    expect(runs.every((r) => r.report?.code === 'gas_cap')).toBe(true)
    const ledger = evmAdapter(scoped, race.db)
    await ledger.settleGas('arc')
    expect(ledger.committed('arc')).toBeLessThanOrEqual(cap)
    let actual = 0n
    for (const j of [c, d]) for (const s of j.steps.filter((x) => stepChain(x.id) === 'arc')) {
      if (await executions('arc', hash([j.id, s.id]))) actual += weiOf(await receiptOf('arc', hash([j.id, s.id])))
    }
    expect(actual).toBeLessThanOrEqual(cap)
    race.close()
  })

  test_('two worker processes racing for the one approved launch: exactly one payment executes', async () => {
    const db = join(dir, 'slot-race.sqlite')
    const raceStore = new JobStore(db, { leaseMs: 1000 })
    const scoped = { ...env.config, scope: scopeOf(request('slot-0001', now()), 1, 10n ** 20n) }
    const a = quote(raceStore, evmAdapter(scoped, raceStore.db), request('slot-0001', now()), now())
    const b = quote(raceStore, evmAdapter(scoped, raceStore.db), request('slot-0002', now()), now())
    const file = toFile(scoped, 0)
    const runs = await Promise.all([worker(file, db, a, 'none'), worker(file, db, b, 'none')])
    expect(runs.map((r) => r.report?.ok ? r.report.state : r.report?.code).sort()).toEqual(['complete', 'pilot_scope'])
    expect((await executions('arc', hash([a.id, 'payment:arc']))) + (await executions('arc', hash([b.id, 'payment:arc'])))).toBe(1)
    expect(raceStore.db.query('SELECT COUNT(*) AS n FROM evm_payments').get()).toEqual({ n: 1 })
    raceStore.close()
  })

  test_('Base receipts carrying a hex l1Fee are accounted as numbers end to end', async () => {
    // An RPC proxy in front of the Base fork adds l1Fee "0x10" to every receipt, as OP Stack nodes return it.
    const proxy = Bun.serve({ port: 18547, async fetch(req) {
      const body = await req.text()
      const upstream = await (await fetch(env.base.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).json() as unknown
      const patch = (m: { id: unknown; result?: Record<string, unknown> | null }, q: { method: string }) => (q.method === 'eth_getTransactionReceipt' && m.result ? { ...m, result: { ...m.result, l1Fee: '0x10' } } : m)
      const parsed = JSON.parse(body) as { method: string } | { method: string }[]
      const out = Array.isArray(upstream) ? upstream.map((m, i) => patch(m as never, (parsed as { method: string }[])[i])) : patch(upstream as never, parsed as { method: string })
      return Response.json(out)
    } })
    try {
      const l1Store = new JobStore(join(dir, 'l1.sqlite'), { leaseMs: 1000 })
      const proxied = evmAdapter({ ...env.config, base: { ...env.config.base, rpc: 'http://127.0.0.1:18547' }, scope: scopeOf(request('l1fee-0001', now()), 1, 10n ** 20n) }, l1Store.db)
      const job = quote(l1Store, proxied, request('l1fee-0001', now()), now())
      const result = await runJob(l1Store, proxied, job.id, await signedPayment(job))
      expect([result.state, result.error]).toEqual(['complete', undefined])
      let expected = 0n
      for (const s of result.steps.filter((x) => stepChain(x.id) === 'base')) {
        expect(s.result!.cost).toMatch(/^[0-9]+$/)
        expected += weiOf(await receiptOf('base', hash([job.id, s.id]))) + 16n
      }
      await proxied.settleGas('base')
      expect(proxied.committed('base')).toBe(expected)
      l1Store.close()
    } finally { void proxy.stop(true) }
  })

  test_('unfinalized Base effects are pending, never absent: the job waits and finishes without re-executing', async () => {
    const slow = evmAdapter({ ...env.config, base: { ...env.config.base, finality: 3 } }, store.db)
    const { job, payment } = await paid('fork-finality-0001', slow)
    const attempt = async (pay?: typeof payment) => {
      try { return await runJob(store, slow, job.id, pay) } catch (cause) { throw new Error(`${String(cause).slice(0, 300)} | job: ${store.get(job.id)!.error}`) }
    }
    let result = await attempt(payment)
    let rounds = 0
    while (result.state !== 'complete' && rounds++ < 20) {
      expect(result.state).toBe('partial')
      expect(result.error ?? '').toContain('awaits finalized evidence')
      await chainClient('base').test.mine({ blocks: 3 })
      result = await attempt()
    }
    expect([result.state, result.error]).toEqual(['complete', undefined])
    expect(rounds).toBeGreaterThan(0)
    await everyStepOnce(result)
  })
})
