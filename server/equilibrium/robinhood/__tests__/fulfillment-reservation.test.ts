/**
 * MIXED-ENVIRONMENT FORK REGRESSIONS for the Robinhood launch job's asset reservation: who may hold
 * the existing canonical asset while a payment is unsettled, when that hold is released, and what a
 * released job can still do. Arc testnet fork + Robinhood mainnet fork; payments are fork fixtures
 * (ForkUsdc, anvil payer). Own ports (Arc 18657, Robinhood 18658, service 4047) and own journals, so
 * it never collides with the fulfillment suite (18655/18656/4046). Opt-in because it starts two forks:
 *
 *   EQUILIBRIUM_ROBINHOOD_FULFILLMENT=1 bun test server/equilibrium/robinhood/__tests__/fulfillment-reservation.test.ts
 *
 * Three assets on the same forks, one per scenario, each with its own journal and service config:
 * - "uncertain": the payment send has no receipt (Arc automine off), so its outcome is unknown.
 * - "failed": the payer's balance is gone, so the send reverts in estimation, and then the
 *   authorization expires: the payment can provably never settle.
 * - "transferred": Arc confirmations 2. The payer submits the job's signed authorization directly,
 *   so its funds reach the executor outside the job. The release must attribute them to the
 *   original job, a successor must not spend them, and only one refund may ever return them.
 * - "race": Arc confirmations 2. Separate processes send executor USDC while another send is still
 *   in the mempool; the residual must survive, and the public refund state must move through
 *   prepared, uncertain, submitted and refunded truthfully across a restart.
 * - "unmatched": Arc confirmations 2. Another authorization under the job's nonce moves a different
 *   amount to the executor. It is not the launch payment, but it is held and returned, with no other
 *   residual outstanding in that journal.
 *
 * Evidence is written to output/robinhood-reservation-evidence.json.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestClient, createWalletClient, encodeFunctionData, http, parseSignature, publicActions, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { erc20Abi, executorAbi, usdcAbi } from '../../evm/contracts'
import { DEV } from '../../evm/fork'
import { signedHeader } from '../../evm/__tests__/harness'
import { AUTHORIZATION_TYPES, paymentDomain } from '../../payment'
import { publicJob } from '../../runner'
import { JobStore } from '../../store'
import { LaunchError, type Job, type LaunchRequest } from '../../types'
import { robinhoodFulfillment, type RobinhoodFulfillmentConfig } from '../fulfillment'
import { fulfillmentForkEnvironment, fulfillmentToJson, type FulfillmentForkEnvironment } from '../fulfillment-fork'
import type { Side } from '../route'

const enabled = process.env.EQUILIBRIUM_ROBINHOOD_FULFILLMENT === '1'
const suite = enabled ? describe : describe.skip
const test_ = (name: string, fn: () => Promise<void>) => test(name, fn, 900_000)
const PORTS = { arc: 18657, robinhood: 18658, service: 4047 } as const
const SERVICE = `http://127.0.0.1:${PORTS.service}`
const LEASE_MS = 3000
const recipient = '0x00000000000000000000000000000000000000a1' as Address
const operator = privateKeyToAccount(DEV.operator)
const payerKey = privateKeyToAccount(DEV.payer)
const sink = privateKeyToAccount('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a').address

interface Scenario { name: string; config: RobinhoodFulfillmentConfig; dir: string; dbPath: string; configPath: string; store: JobStore; adapter: ReturnType<typeof robinhoodFulfillment> }
let env: FulfillmentForkEnvironment
let uncertain: Scenario
let failed: Scenario
let transferred: Scenario
let race: Scenario
let unmatched: Scenario
let service: ChildProcess | null = null
const evidence: Record<string, unknown> = {}
const json = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_, x: unknown) => (typeof x === 'bigint' ? x.toString() : x)))

const client = (side: Side) => createTestClient({ mode: 'anvil', transport: http(env.config[side].rpc) }).extend(publicActions)
const usdc = () => env.fulfillment.arc.usdc
const balance = (owner: Address) => client('arc').readContract({ address: usdc(), abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
const now = () => Math.floor(Date.now() / 1000)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function launchRequest(requestId: string, expiresIn = 280): LaunchRequest {
  return { requestId, payer: env.payer.toLowerCase() as Address,
    canonical: { chain: 'arc', name: 'Equilibrium', symbol: 'EQL', decimals: 6, issuance: '1000000000000', recipient },
    destinations: [
      { chain: 'arc', recipient, amount: '500000000000', poolTokens: '5000000000', poolQuote: '10000000' },
      { chain: 'robinhood', recipient, amount: '10000000000', poolTokens: '5000000000', poolQuote: '10000000' },
    ], quote: { expires: now() + expiresIn, costCap: '100000000' } }
}
type Reply = { status: number; body: { error?: string; jobId?: Hex; state?: string; steps?: { id: string; state: string }[] } }
async function post(body: unknown, payment?: string): Promise<Reply> {
  const r = await fetch(`${SERVICE}/x402/equilibrium`, { method: 'POST', body: JSON.stringify(body), headers: payment ? { 'payment-signature': payment } : {} })
  expect(r.headers.get('x-equilibrium-environment')).toBe('mixed:arc-testnet-fork+robinhood-mainnet-fork')
  expect(r.headers.get('x-equilibrium-payment')).toBe('fork-fixture')
  return { status: r.status, body: await r.json() as Reply['body'] }
}
/** Quote over HTTP and sign the payment for it. */
async function quoted(s: Scenario, request: LaunchRequest) {
  const q = await post(request)
  expect(q.status).toBe(402)
  const job = s.store.get(q.body.jobId!)!
  return { request, job, header: await signedHeader(job) }
}
const holder = (s: Scenario) => s.store.db.query<{ job: string; settled: number }, []>('SELECT job, settled FROM robinhood_launches').get() ?? null
const releasedRow = (s: Scenario, job: string) => s.store.db.query<{ reason: string; block: string }, [string]>('SELECT reason, block FROM robinhood_released WHERE job=?').get(job) ?? null

/** How many times the destination executor executed each route operation a job's steps name. */
async function executions(job: Job) {
  const out: Record<string, number> = {}
  for (const step of job.steps) {
    if (!step.prepared) continue
    const b = JSON.parse(step.prepared.bytes) as { side: Side; operation: Hex }
    const logs = await client(b.side).getLogs({ address: env.config[b.side].executor, event: executorAbi.find((x) => x.type === 'event' && x.name === 'Executed')!, args: { operation: b.operation }, fromBlock: env.config[b.side].fromBlock })
    out[step.id] = logs.length
  }
  return out
}

async function scenario(name: string, assetId: string, arcConfirmations?: number): Promise<Scenario> {
  // Receipts are instant with automine on; a short wait is what makes a withheld receipt an unknown outcome.
  const route = env.fulfillment.route
  const config: RobinhoodFulfillmentConfig = { ...env.fulfillment, route: { ...route, asset: { ...route.asset, id: assetId }, receiptTimeoutMs: 5000,
    arc: { ...route.arc, confirmations: arcConfirmations ?? route.arc.confirmations } } }
  const dir = mkdtempSync(join(process.cwd(), 'output', `robinhood-reservation-${name}-`))
  const dbPath = join(dir, 'jobs.sqlite')
  const configPath = join(dir, 'fulfillment.json')
  const store = new JobStore(dbPath, { leaseMs: LEASE_MS })
  const adapter = robinhoodFulfillment(config, store.db)
  writeFileSync(configPath, fulfillmentToJson(config, env.guardianSets))
  // The existing canonical asset: issued and hubbed once, before any launch job exists.
  const hub = await adapter.route.deployHub()
  evidence[`asset:${name}`] = { id: assetId, canonical: adapter.route.layout.canonical, hub: adapter.route.layout.hub.proxy, hubTx: hub.transactionHash, journal: dir, adapter: adapter.version }
  return { name, config, dir, dbPath, configPath, store, adapter }
}

function startService(s: Scenario, extra: Record<string, string> = {}): Promise<ChildProcess> {
  const child = spawn('bun', ['run', join(import.meta.dir, '..', 'serve.ts')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    EQUILIBRIUM_ROBINHOOD_FULFILLMENT_CONFIG: s.configPath, EQUILIBRIUM_DB: s.dbPath, EQUILIBRIUM_PORT: String(PORTS.service),
    EQUILIBRIUM_LEASE_MS: String(LEASE_MS), EQUILIBRIUM_RECONCILE_MS: '1000', ...extra } })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  child.on('exit', (code, signal) => { evidence[`service:${s.name}:${child.pid}`] = { code, signal, log: log.slice(-2000) } })
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return reject(new Error(`service exited: ${log}`))
      try { if ((await fetch(SERVICE)).ok) return resolve(child) } catch { /* starting */ }
      if (Date.now() - started > 60_000) { child.kill(); return reject(new Error(`service did not start: ${log}`)) }
      setTimeout(() => void poll(), 250)
    }
    void poll()
  })
}
const exited = (child: ChildProcess) => new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve({ code: child.exitCode, signal: child.signalCode })
  child.on('exit', (code, signal) => resolve({ code, signal }))
})
async function stopService(signal: NodeJS.Signals = 'SIGTERM') {
  if (!service) return
  if (service.exitCode === null && service.signalCode === null) {
    const done = exited(service)
    service.kill(signal)
    const timer = setTimeout(() => service?.kill('SIGKILL'), 2000)
    await done
    clearTimeout(timer)
  }
  service = null
}
function worker(s: Scenario, jobId: Hex): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('bun', ['run', join(import.meta.dir, 'fulfillment-worker.ts'), s.configPath, s.dbPath, jobId, 'none', '2000'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('exit', (code) => resolve({ code, out: out.trim() }))
  })
}
/** A separate process moving executor USDC through the route on this scenario's journal. */
function spend(s: Scenario, name: string, amount: bigint): Promise<{ code: number | null; out: { ok: boolean; tx?: Hex; code?: string; error?: string } }> {
  return new Promise((resolve) => {
    const child = spawn('bun', ['run', join(import.meta.dir, 'usdc-spend-worker.ts'), s.configPath, s.dbPath, name, sink, amount.toString()], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('exit', (code) => resolve({ code, out: lastLine(out) }))
  })
}
/** Release a job's reservation with its payer's funds moved by `submit` outside the job, as the reviewer did. */
async function releasedBy(s: Scenario, requestId: string, submit: (job: Job) => Promise<Hex>) {
  const x = await quoted(s, launchRequest(requestId))
  const funded = await balance(env.payer)
  await payerTo(0n)
  const attempt = await post(x.request, x.header)
  expect([attempt.status, attempt.body.error]).toEqual([503, 'reconciliation_required'])
  await payerTo(funded)
  const job = s.store.get(x.job.id)!
  const spendTx = await submit(job)
  expect((await client('arc').waitForTransactionReceipt({ hash: spendTx })).status).toBe('success')
  await client('arc').mine({ blocks: s.config.route.arc.confirmations })
  const reply = await post(x.request, x.header)
  expect([reply.status, reply.body.error]).toEqual([409, 'payment_failed'])
  return { x, job, spendTx }
}
const lastLine = (out: string) => JSON.parse(out.trim().split('\n').pop()!) as { ok: boolean; code?: string }
async function waitFor(s: Scenario, id: Hex, done: (job: Job) => boolean, ms = 300_000) {
  const deadline = Date.now() + ms
  let job = s.store.get(id)!
  while (!done(job) && Date.now() < deadline) { await sleep(1000); job = s.store.get(id)! }
  return job
}
async function supply(s: Scenario) {
  const x = await s.adapter.route.supply()
  return { spokeSupply: x.spokeSupply, custody: x.custody, pending: x.pending, reconciled: x.reconciled }
}
async function payerTo(amount: bigint) {
  const wallet = createWalletClient({ account: payerKey, transport: http(env.config.arc.rpc) })
  const current = await balance(env.payer)
  if (current > amount) await client('arc').waitForTransactionReceipt({ hash: await wallet.writeContract({ account: payerKey, chain: null, address: usdc(), abi: erc20Abi, functionName: 'transfer', args: [sink, current - amount] }) })
  if (current < amount) {
    const minter = createWalletClient({ account: operator, transport: http(env.config.arc.rpc) })
    await client('arc').waitForTransactionReceipt({ hash: await minter.writeContract({ account: operator, chain: null, address: usdc(), abi: usdcAbi, functionName: 'mint', args: [env.payer, amount - current] }) })
  }
  expect(await balance(env.payer)).toBe(amount)
}
async function refusal(fn: () => Promise<unknown>) {
  try { await fn(); return null } catch (cause) { return cause instanceof LaunchError ? cause.code : String(cause).slice(0, 200) }
}
async function reverts(side: Side, from: Address, to: Address, data: Hex) {
  try { await client(side).call({ account: from, to, data }); return false } catch { return true }
}

suite('EQUILIBRIUM Robinhood launch job: asset reservation on the mixed Arc-testnet/Robinhood-mainnet fork', () => {
  beforeAll(async () => {
    const started = Date.now()
    const occupied = await fetch(SERVICE).then(() => true, () => false)
    if (occupied) throw new Error(`${SERVICE} is already serving; stop the leftover process first`)
    env = await fulfillmentForkEnvironment({ arcPort: PORTS.arc, robinhoodPort: PORTS.robinhood, assetId: 'equilibrium-robinhood-reservation-uncertain' })
    mkdirSync(join(process.cwd(), 'output'), { recursive: true })
    uncertain = await scenario('uncertain', 'equilibrium-robinhood-reservation-uncertain')
    failed = await scenario('failed', 'equilibrium-robinhood-reservation-failed')
    transferred = await scenario('transferred', 'equilibrium-robinhood-reservation-transferred', 2)
    race = await scenario('race', 'equilibrium-robinhood-reservation-race', 2)
    unmatched = await scenario('unmatched', 'equilibrium-robinhood-reservation-unmatched', 2)
    Object.assign(evidence, { labels: env.fulfillment.labels, ports: PORTS,
      forks: { arc: { url: env.arc.url, chainId: env.config.arc.chainId, note: 'Arc TESTNET fork' }, robinhood: { url: env.robinhood.url, chainId: env.config.robinhood.chainId, block: env.robinhood.block.toString(), note: 'Robinhood MAINNET fork' } },
      setupSeconds: (Date.now() - started) / 1000 })
  }, 600_000)
  afterAll(async () => {
    if (env) await client('arc').setAutomine(true).catch(() => undefined)
    await stopService()
    uncertain?.store.close()
    failed?.store.close()
    transferred?.store.close()
    race?.store.close()
    unmatched?.store.close()
    env?.stop()
    if (enabled) writeFileSync(join(process.cwd(), 'output', 'robinhood-reservation-evidence.json'), JSON.stringify(json(evidence), null, 2) + '\n')
  }, 30_000)

  test_('an uncertain payment send keeps the asset across concurrent requests and a crash, then recovers to one charge', async () => {
    const s = uncertain
    service = await startService(s)
    const u = await quoted(s, launchRequest('reservation-uncertain-u'))
    const payerBefore = await balance(env.payer)
    // Withhold receipts: the payment is handed to the RPC and its outcome stays unknown.
    await client('arc').setAutomine(false)
    const sent = await post(u.request, u.header)
    expect(sent.status).toBe(202)
    expect(sent.body.state).toBe('partial')
    let job = s.store.get(u.job.id)!
    expect(job.steps[0].state).toBe('prepared')
    expect(job.sweep).toBe('eligible')
    expect(holder(s)).toEqual({ job: u.job.id, settled: 0 })
    const operation = (JSON.parse(job.steps[0].prepared!.bytes) as { operation: Hex; digest: Hex })
    expect(await s.adapter.route.digestOf('arc', operation.operation)).toBe(`0x${'0'.repeat(64)}`)
    const inMempool = await s.adapter.route.digestOf('arc', operation.operation, 'pending')
    // Concurrent: two other launches and two resends of the same paid request.
    const [v, w, again1, again2] = await Promise.all([post(launchRequest('reservation-uncertain-v')), post(launchRequest('reservation-uncertain-w')), post(u.request, u.header), post(u.request, u.header)])
    expect([v.status, v.body.error, w.status, w.body.error]).toEqual([409, 'asset_launched', 409, 'asset_launched'])
    for (const r of [again1, again2]) expect(r.status === 202 || (r.status === 409 && r.body.error === 'job_busy')).toBe(true)
    expect(holder(s)).toEqual({ job: u.job.id, settled: 0 })
    // Crash, restart from the same journal: still held, still refused to others, nothing charged yet.
    await stopService('SIGKILL')
    service = await startService(s)
    await sleep(3000)
    const afterRestart = await post(launchRequest('reservation-uncertain-v'))
    expect([afterRestart.status, afterRestart.body.error]).toEqual([409, 'asset_launched'])
    expect(holder(s)).toEqual({ job: u.job.id, settled: 0 })
    expect(await balance(env.payer)).toBe(payerBefore)
    const heldWhileUnknown = { job: publicJob(s.store.get(u.job.id)!), inMempool, others: [v.body.error, w.body.error, afterRestart.body.error], resends: [again1.status, again2.status] }
    // The unknown send lands. The sweep, with no client resend, recovers the same job to completion.
    await client('arc').mine({ blocks: 1 })
    await client('arc').setAutomine(true)
    job = await waitFor(s, u.job.id, (j) => j.state === 'complete')
    expect(job.state).toBe('complete')
    const counts = await executions(job)
    expect(Object.keys(counts).length).toBe(8)
    for (const [step, n] of Object.entries(counts)) expect([step, n]).toEqual([step, 1])
    expect(await balance(env.payer)).toBe(payerBefore - BigInt(job.total))
    const x = await supply(s)
    expect(x).toEqual({ spokeSupply: 10_000_000_000n, custody: 10_000_000_000n, pending: 0n, reconciled: true })
    expect(holder(s)).toEqual({ job: u.job.id, settled: 1 })
    const late = await post(launchRequest('reservation-uncertain-late'))
    expect([late.status, late.body.error]).toEqual([409, 'asset_launched'])
    evidence.uncertain = { heldWhileUnknown, complete: publicJob(job), executions: counts, charged: job.total, supply: json(x), afterSettlement: late.body.error }
    await stopService()
  })

  test_('a definitively failed payment releases the asset; the released job can never charge or fulfil after ownership moves', async () => {
    const s = failed
    service = await startService(s)
    const funded = await balance(env.payer)
    const x = await quoted(s, launchRequest('reservation-failed-x', 20))
    // The reviewer's case: the payer's funds are gone, so the transfer reverts in estimation.
    await payerTo(0n)
    const attempt = await post(x.request, x.header)
    expect([attempt.status, attempt.body.error]).toEqual([503, 'reconciliation_required'])
    expect(holder(s)).toEqual({ job: x.job.id, settled: 0 })
    // Not yet definitive: the authorization is still valid, so the reservation holds and a retry keeps it.
    const early = await post(launchRequest('reservation-failed-early'))
    expect([early.status, early.body.error]).toEqual([409, 'asset_launched'])
    const retry = await post(x.request, x.header)
    expect([retry.status, retry.body.error]).toEqual([503, 'reconciliation_required'])
    expect(holder(s)).toEqual({ job: x.job.id, settled: 0 })
    // The authorization lapses on chain. Only now can the payment provably never settle.
    while (now() <= x.request.quote.expires) await sleep(500)
    // Fork artifact: anvil's Arc clock starts at the fork block and can trail the wall clock. Chain
    // time decides expiry, so bring the next block up to the wall clock, never past it.
    const lag = BigInt(now()) - (await client('arc').getBlock()).timestamp
    if (lag > 0n) await client('arc').setNextBlockTimestamp({ timestamp: BigInt(now()) })
    await client('arc').mine({ blocks: 1 })
    evidence.arcClockLagSeconds = lag.toString()
    await payerTo(funded)
    // Two new launches and the failed job race for the asset.
    const y = await quoted(s, launchRequest('reservation-failed-y'))
    const z = await quoted(s, launchRequest('reservation-failed-z'))
    const [ry, rz, rx] = await Promise.all([post(y.request, y.header), post(z.request, z.header), post(x.request, x.header)])
    expect([rx.status, rx.body.error]).toEqual([409, 'payment_failed'])
    // The winner may finish in this request (200) or leave the rest to the sweep (202).
    const outcome = (r: Reply) => r.status === 200 || r.status === 202 ? 'accepted' : r.body.error
    expect([outcome(ry), outcome(rz)].sort()).toEqual(['accepted', 'asset_launched'])
    const winner = outcome(ry) === 'accepted' ? y : z
    const loser = winner === y ? z : y
    const won = await waitFor(s, winner.job.id, (j) => j.state === 'complete')
    expect(won.state).toBe('complete')
    expect(holder(s)).toEqual({ job: winner.job.id, settled: 1 })
    expect(releasedRow(s, x.job.id)?.reason).toBe('authorization expired')
    // Exactly one charge: the winner's. The failed job and the refused one moved nothing.
    expect(await balance(env.payer)).toBe(funded - BigInt(won.total))
    const loserJob = s.store.get(loser.job.id)!
    expect(loserJob.steps.every((st) => st.state === 'planned')).toBe(true)
    // The released job, by every path: HTTP retry, a separate worker, the adapter directly.
    const old = s.store.get(x.job.id)!
    const viaHttp = await post(x.request, x.header)
    const viaWorker = await worker(s, x.job.id)
    const direct = {
      prepareCanonical: await refusal(() => s.adapter.prepare({ job: old, step: old.steps[1] })),
      observePayment: await refusal(() => s.adapter.observe({ job: old, step: old.steps[0] }, old.steps[0].prepared!)),
      broadcastPayment: await refusal(() => s.adapter.broadcast({ job: old, step: old.steps[0] }, old.steps[0].prepared!)),
    }
    expect([viaHttp.status, viaHttp.body.error]).toEqual([409, 'payment_failed'])
    expect([viaWorker.code, lastLine(viaWorker.out).code]).toEqual([3, 'payment_failed'])
    expect(direct).toEqual({ prepareCanonical: 'payment_failed', observePayment: 'payment_failed', broadcastPayment: 'payment_failed' })
    // Even outside the job: its persisted executor bytes and its signed authorization both revert.
    const b = JSON.parse(old.steps[0].prepared!.bytes) as { plan: string; digest: Hex }
    const p = JSON.parse(b.plan) as { operation: Hex; calls: { target: Address; value: string; data: Hex }[] }
    const a = old.payment!.authorization
    const { r, s: sig, v } = parseSignature(old.payment!.signature)
    const replays = {
      executorBytes: await reverts('arc', operator.address, env.config.arc.executor, encodeFunctionData({ abi: executorAbi, functionName: 'execute', args: [p.operation, b.digest, p.calls.map((c) => ({ target: c.target, value: BigInt(c.value), data: c.data }))] })),
      authorization: await reverts('arc', sink, usdc(), encodeFunctionData({ abi: usdcAbi, functionName: 'transferWithAuthorization', args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, Number(v ?? 27n), r, sig] })),
    }
    expect(replays).toEqual({ executorBytes: true, authorization: true })
    expect((await executions(old))['payment:arc']).toBe(0)
    // A restart changes none of it.
    await stopService('SIGKILL')
    service = await startService(s)
    await sleep(3000)
    const afterRestart = await post(x.request, x.header)
    const another = await post(launchRequest('reservation-failed-after'))
    expect([afterRestart.body.error, another.body.error]).toEqual(['payment_failed', 'asset_launched'])
    expect(await balance(env.payer)).toBe(funded - BigInt(won.total))
    const counts = await executions(won)
    for (const [step, n] of Object.entries(counts)) expect([step, n]).toEqual([step, 1])
    const sup = await supply(s)
    expect(sup).toEqual({ spokeSupply: 10_000_000_000n, custody: 10_000_000_000n, pending: 0n, reconciled: true })
    evidence.failed = { failedJob: publicJob(old), released: releasedRow(s, x.job.id), whileValid: [attempt.body.error, early.body.error, retry.body.error],
      race: { y: outcome(ry), z: outcome(rz), x: rx.body.error },
      releasedJob: { http: viaHttp.body.error, worker: lastLine(viaWorker.out).code, direct, replays }, afterRestart: [afterRestart.body.error, another.body.error],
      winner: publicJob(won), executions: counts, charged: won.total, supply: json(sup) }
    await stopService()
  })
  test_('a payment transferred outside the job is attributed to the original job, held from successors and refunded once', async () => {
    const s = transferred
    const X = env.config.arc.executor
    const confirmations = s.config.route.arc.confirmations
    expect(confirmations).toBe(2)
    service = await startService(s)
    const funded = await balance(env.payer)
    const x = await quoted(s, launchRequest('reservation-transferred-x'))
    // The payment cannot settle through the job while the payer is empty.
    await payerTo(0n)
    const attempt = await post(x.request, x.header)
    expect([attempt.status, attempt.body.error]).toEqual([503, 'reconciliation_required'])
    expect(holder(s)).toEqual({ job: x.job.id, settled: 0 })
    await payerTo(funded)
    // The payer submits X's own signed authorization directly: the funds reach the executor outside the job.
    const executorBefore = await balance(X)
    const signed = s.store.get(x.job.id)!.payment!
    const a = signed.authorization
    const { r, s: sig, v } = parseSignature(signed.signature)
    const direct = createWalletClient({ account: payerKey, transport: http(env.config.arc.rpc) })
    const spend = await client('arc').waitForTransactionReceipt({ hash: await direct.writeContract({ account: payerKey, chain: null, address: usdc(), abi: usdcAbi, functionName: 'transferWithAuthorization',
      args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, Number(v ?? 27n), r, sig] }) })
    expect(spend.status).toBe('success')
    expect(await balance(X)).toBe(executorBefore + BigInt(x.job.total))
    // Not yet final: the reservation holds and nothing is attributed or released.
    const depth: { mined: number; status: number; error?: string; holder: unknown }[] = []
    for (let mined = 0; mined <= confirmations; mined++) {
      if (mined) await client('arc').mine({ blocks: 1 })
      const reply = await post(x.request, x.header)
      depth.push({ mined, status: reply.status, error: reply.body.error, holder: holder(s) })
    }
    expect(depth.slice(0, confirmations).map((d) => [d.status, d.error])).toEqual(Array.from({ length: confirmations }, () => [503, 'reconciliation_required']))
    expect(depth[confirmations].status).toBe(409)
    expect(depth[confirmations].error).toBe('payment_failed')
    expect(holder(s)).toBeNull()
    const ledger = s.adapter.ledger(x.job.id)!
    expect(ledger).toMatchObject({ outcome: 'used_outside_job', authorized: x.job.total, received: x.job.total, fees_spent: '0', residual: x.job.total, evidence_tx: spend.transactionHash, refund: 'owed', refund_tx: null })
    expect(BigInt(ledger.evidence_block)).toBe(spend.blockNumber)
    expect(releasedRow(s, x.job.id)?.reason).toBe('authorization used outside the job')
    const released = s.store.get(x.job.id)!
    expect(released.steps.every((st, i) => i === 0 ? st.state === 'prepared' : st.state === 'planned')).toBe(true)
    expect(released.error).toContain(`${x.job.total} USDC atoms reached the Arc executor`)
    expect(released.error).not.toContain('Nothing was charged')
    // The public view reports the transferred funds and the owed refund, not paid: 0.
    const view = async () => (await (await fetch(`${SERVICE}/equilibrium/jobs/${x.job.id}`)).json() as { jobs: { error: string; funds: { paid: string; unallocatedHeld: string; refundable: boolean; refundableAmount: string }; attribution: { outcome: string; refund: { state: string; transaction: string | null; block: string | null } } }[] }).jobs[0]
    const owedView = await view()
    expect(owedView.funds).toMatchObject({ paid: x.job.total, unallocatedHeld: x.job.total, refundable: true, refundableAmount: x.job.total })
    expect(owedView.attribution).toMatchObject({ outcome: 'used_outside_job', refund: { state: 'owed', transaction: null, block: null } })
    // Repeated reconciliation — HTTP, a separate worker, a restart — changes nothing in the ledger.
    const again = await Promise.all([post(x.request, x.header), post(x.request, x.header)])
    const viaWorker = await worker(s, x.job.id)
    await stopService('SIGKILL')
    service = await startService(s)
    await sleep(3000)
    const afterRestart = await post(x.request, x.header)
    expect([...again.map((g) => g.body.error), lastLine(viaWorker.out).code, afterRestart.body.error]).toEqual(['payment_failed', 'payment_failed', 'payment_failed', 'payment_failed'])
    expect(s.store.db.query('SELECT COUNT(*) AS n FROM robinhood_payment_ledger').get()).toEqual({ n: 1 })
    expect(s.adapter.ledger(x.job.id)).toEqual(ledger)
    expect((await executions(released))['payment:arc']).toBe(0)
    await stopService()
    // A successor pays for itself. Crash it right after its payment, then take the executor's
    // USDC down to X's residual plus less than Y's pool quote: only X's money could fund the pool.
    service = await startService(s, { EQUILIBRIUM_ROBINHOOD_KILL_AFTER_SEND: 'payment:arc' })
    const y = await quoted(s, launchRequest('reservation-transferred-y'))
    await post(y.request, y.header).catch(() => undefined)
    await exited(service)
    service = null
    // The payment was handed to the RPC just before the kill; let it execute before counting depth from it.
    const yPayment = (JSON.parse(s.store.get(y.job.id)!.steps[0].prepared!.bytes) as { operation: Hex }).operation
    for (let i = 0; i < 40 && await s.adapter.route.digestOf('arc', yPayment) === `0x${'0'.repeat(64)}`; i++) await sleep(250)
    await client('arc').mine({ blocks: confirmations })
    const poolQuote = BigInt(y.request.destinations.find((d) => d.chain === 'arc')!.poolQuote)
    const ownFunds = await balance(X) - BigInt(ledger.residual)
    expect(ownFunds).toBe(executorBefore + BigInt(y.job.total))
    const drain = ownFunds - poolQuote / 2n
    await s.adapter.route.execute('test:drain-successor-funds', 'arc', () => [{ target: usdc(), value: '0', data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [sink, drain] }) }])
    expect(await balance(X)).toBe(BigInt(ledger.residual) + poolQuote / 2n)
    // The killed service's lease must lapse before another worker may claim the job.
    await sleep(LEASE_MS + 500)
    const blocked = await worker(s, y.job.id)
    expect(lastLine(blocked.out)).toMatchObject({ ok: false, code: 'residual_reserved' })
    let yJob = s.store.get(y.job.id)!
    expect(yJob.steps.find((st) => st.id === 'pool:arc')!.state).not.toBe('complete')
    expect(await balance(X)).toBe(BigInt(ledger.residual) + poolQuote / 2n)
    // Restore the successor's own funds; it finishes without touching X's residual.
    await client('arc').waitForTransactionReceipt({ hash: await createWalletClient({ account: operator, transport: http(env.config.arc.rpc) }).writeContract({ account: operator, chain: null, address: usdc(), abi: usdcAbi, functionName: 'mint', args: [X, drain] }) })
    // Spendable funds are read `confirmations` deep, so the restored funds count only from there.
    await client('arc').mine({ blocks: confirmations })
    service = await startService(s)
    const miner = setInterval(() => { void client('arc').mine({ blocks: 1 }).catch(() => undefined) }, 700)
    try {
      await post(y.request, y.header)
      yJob = await waitFor(s, y.job.id, (j) => j.state === 'complete')
    } finally { clearInterval(miner) }
    expect(yJob.state).toBe('complete')
    const yCounts = await executions(yJob)
    for (const [step, n] of Object.entries(yCounts)) expect([step, n]).toEqual([step, 1])
    expect(yJob.settlement?.amount).toBe(yJob.total)
    expect(publicJob(yJob).funds.paid).toBe(yJob.total)
    expect(await balance(X)).toBe(BigInt(ledger.residual) + executorBefore + BigInt(yJob.total) - poolQuote)
    expect(s.adapter.ledger(x.job.id)).toEqual(ledger)
    const sup = await supply(s)
    expect(sup).toEqual({ spokeSupply: 10_000_000_000n, custody: 10_000_000_000n, pending: 0n, reconciled: true })
    await stopService()
    // The operator refund: concurrent calls, a fresh process's adapter, and repeats execute it once.
    const payerBeforeRefund = await balance(env.payer)
    const [first, second] = await Promise.all([s.adapter.refund(x.job.id), s.adapter.refund(x.job.id)])
    expect(first.refund_tx).toBe(second.refund_tx)
    expect(first.refund).toBe('submitted')
    const reopened = new JobStore(s.dbPath, { leaseMs: LEASE_MS })
    const restarted = robinhoodFulfillment(s.config, reopened.db)
    expect((await restarted.refund(x.job.id)).refund).toBe('submitted')
    await client('arc').mine({ blocks: confirmations })
    const done = await restarted.refund(x.job.id)
    expect(done).toMatchObject({ refund: 'refunded', refund_tx: first.refund_tx, residual: x.job.total })
    expect(await s.adapter.refund(x.job.id)).toEqual(done)
    reopened.close()
    const refundOp = s.adapter.route.layout.op(`job:${x.job.id}:refund:arc`)
    const refundLogs = await client('arc').getLogs({ address: X, event: executorAbi.find((e) => e.type === 'event' && e.name === 'Executed')!, args: { operation: refundOp }, fromBlock: env.config.arc.fromBlock })
    expect(refundLogs.length).toBe(1)
    expect(await balance(env.payer)).toBe(payerBeforeRefund + BigInt(x.job.total))
    expect(await balance(X)).toBe(executorBefore + BigInt(yJob.total) - poolQuote)
    const refundedView = await (async () => { service = await startService(s); try { return await view() } finally { await stopService() } })()
    expect(refundedView.funds).toMatchObject({ paid: x.job.total, unallocatedHeld: '0', refundable: false, refundableAmount: '0' })
    expect(refundedView.attribution.refund).toEqual({ state: 'refunded', transaction: first.refund_tx, block: done.refund_block })
    expect(refundedView.error).toContain(`refunded to ${x.job.request.payer} in ${first.refund_tx}`)
    expect(owedView.error).toContain(`refund owed to ${x.job.request.payer}; no refund has been sent`)
    evidence.transferred = { job: x.job.id, arcConfirmations: confirmations, directSpend: { tx: spend.transactionHash, block: spend.blockNumber.toString() }, depth,
      ledgerAtRelease: ledger, owedView, repeated: { http: again.map((g) => g.body.error), worker: lastLine(viaWorker.out).code, afterRestart: afterRestart.body.error },
      successor: { job: y.job.id, blocked: lastLine(blocked.out), drained: drain.toString(), executions: yCounts, charged: yJob.total, settlement: yJob.settlement, supply: json(sup) },
      refund: { concurrent: [first.refund_tx, second.refund_tx], final: done, executedLogs: refundLogs.length, refundedView } }
  })
  type View = { error: string; funds: Record<string, unknown>; attribution: { outcome: string; received: string; residual: string; refund: { state: string; transaction: string | null; block: string | null } } }
  const viewOf = async (id: Hex) => (await (await fetch(`${SERVICE}/equilibrium/jobs/${id}`)).json() as { jobs: View[] }).jobs[0]

  test_('separate processes cannot spend a residual while another send is pending, and the refund state is reported truthfully', async () => {
    const s = race
    const X = env.config.arc.executor
    const confirmations = s.config.route.arc.confirmations
    service = await startService(s)
    const directTx = (job: Job) => {
      const a = job.payment!.authorization
      const { r, s: sig, v } = parseSignature(job.payment!.signature)
      return createWalletClient({ account: payerKey, transport: http(env.config.arc.rpc) }).writeContract({ account: payerKey, chain: null, address: usdc(), abi: usdcAbi, functionName: 'transferWithAuthorization',
        args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, Number(v ?? 27n), r, sig] })
    }
    const { x } = await releasedBy(s, 'reservation-race-x', directTx)
    const residual = BigInt(s.adapter.ledger(x.job.id)!.residual)
    expect(residual).toBe(BigInt(x.job.total))
    // Leave exactly 5 USDC the residual does not cover, final at depth.
    const free = await balance(X) - residual
    const FIVE = 5_000_000n
    if (free > FIVE) expect((await spend(s, 'test:race-setup', free - FIVE)).out.ok).toBe(true)
    if (free < FIVE) await client('arc').waitForTransactionReceipt({ hash: await createWalletClient({ account: operator, transport: http(env.config.arc.rpc) }).writeContract({ account: operator, chain: null, address: usdc(), abi: usdcAbi, functionName: 'mint', args: [X, FIVE - free] }) })
    await client('arc').mine({ blocks: confirmations })
    expect(await balance(X)).toBe(residual + FIVE)
    // Two processes at once, each sending 5 USDC: at most one may send.
    await client('arc').setAutomine(false)
    const pair = await Promise.all([spend(s, 'test:race-a', FIVE), spend(s, 'test:race-b', FIVE)])
    const sent = pair.filter((p) => p.out.code === 'broadcast_uncertain')
    expect(sent.length).toBeLessThanOrEqual(1)
    for (const p of pair) expect(['broadcast_uncertain', 'residual_reserved']).toContain(p.out.code ?? 'none')
    // The reviewer's order: one send sits in the mempool, then another process tries.
    let first = sent[0]
    if (!first) { first = await spend(s, 'test:race-a', FIVE); expect(first.out.code).toBe('broadcast_uncertain') }
    const mempoolRace = await spend(s, 'test:race-c', FIVE)
    expect(mempoolRace.out.code).toBe('residual_reserved')
    expect(mempoolRace.out.error ?? '').toContain('are claimed by sends not yet final')
    // The sender exited without a receipt; its claim outlives it, and a later process is still refused.
    const afterExit = await spend(s, 'test:race-d', 1n)
    expect(afterExit.out.code).toBe('residual_reserved')
    await client('arc').mine({ blocks: 1 })
    await client('arc').setAutomine(true)
    await client('arc').mine({ blocks: confirmations })
    expect(await balance(X)).toBe(residual)
    const claims = s.store.db.query<{ name: string; state: string }, []>('SELECT name, state FROM robinhood_usdc_claims ORDER BY name').all()
    expect(claims.filter((c) => c.name.startsWith('test:race-') && c.name !== 'test:race-setup').length).toBe(1)
    const afterFinal = await spend(s, 'test:race-e', 1n)
    expect(afterFinal.out.code).toBe('residual_reserved')
    // Refund states, read publicly. Owed, then prepared (journalled, maybe sent), then uncertain (on the wire).
    const owedView = await viewOf(x.job.id)
    expect(owedView.attribution.refund).toEqual({ state: 'owed', transaction: null, block: null })
    expect(owedView.error).toContain('no refund has been sent')
    const refundName = `job:${x.job.id}:refund:arc`
    await s.adapter.route.persist(refundName, 'arc', () => [{ target: usdc(), value: '0', data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [x.job.request.payer, residual] }) }])
    const preparedView = await viewOf(x.job.id)
    expect(preparedView.attribution.refund.state).toBe('prepared')
    expect(preparedView.funds.refundable).toBe(false)
    expect(preparedView.error).toContain('may already have been sent; its outcome is unknown')
    await client('arc').setAutomine(false)
    expect(await refusal(() => s.adapter.refund(x.job.id))).toBe('broadcast_uncertain')
    const uncertainView = await viewOf(x.job.id)
    const refundTx = uncertainView.attribution.refund.transaction
    expect(uncertainView.attribution.refund.state).toBe('uncertain')
    expect(refundTx).toMatch(/^0x[0-9a-f]{64}$/)
    expect(uncertainView.error).toContain(`was sent in ${refundTx} and has not executed yet`)
    expect(uncertainView.error).not.toContain('no refund has been sent')
    // While the refund is uncertain, nothing else may touch the residual; a restart changes nothing.
    expect((await spend(s, 'test:race-f', 1n)).out.code).toBe('residual_reserved')
    await stopService('SIGKILL')
    service = await startService(s)
    expect((await viewOf(x.job.id)).attribution.refund).toEqual(uncertainView.attribution.refund)
    await client('arc').mine({ blocks: 1 })
    await client('arc').setAutomine(true)
    const submitted = await s.adapter.refund(x.job.id)
    expect(submitted).toMatchObject({ refund: 'submitted', refund_tx: refundTx })
    const submittedView = await viewOf(x.job.id)
    expect(submittedView.attribution.refund.state).toBe('submitted')
    expect(submittedView.error).toContain('not yet final. It stays held')
    await client('arc').mine({ blocks: confirmations })
    const done = await s.adapter.refund(x.job.id)
    expect(done).toMatchObject({ refund: 'refunded', refund_tx: refundTx })
    expect(await s.adapter.refund(x.job.id)).toEqual(done)
    const doneView = await viewOf(x.job.id)
    expect(doneView.attribution.refund).toEqual({ state: 'refunded', transaction: refundTx, block: done.refund_block })
    expect(doneView.error).toContain('Nothing of it remains on the executor')
    expect(doneView.error).not.toContain('held')
    expect(doneView.funds).toMatchObject({ unallocatedHeld: '0', heldForPayer: '0', refundable: false })
    const refundLogs = await client('arc').getLogs({ address: X, event: executorAbi.find((e) => e.type === 'event' && e.name === 'Executed')!, args: { operation: s.adapter.route.layout.op(refundName) }, fromBlock: env.config.arc.fromBlock })
    expect(refundLogs.length).toBe(1)
    expect(await balance(X)).toBe(0n)
    evidence.race = { job: x.job.id, residual: residual.toString(), concurrentPair: pair.map((p) => p.out), mempoolSender: first.out, mempoolRace: mempoolRace.out, afterExit: afterExit.out, afterFinal: afterFinal.out, claims,
      refund: { owed: owedView.attribution.refund, prepared: preparedView.attribution.refund, uncertain: { ...uncertainView.attribution.refund, error: uncertainView.error }, submitted: { ...submittedView.attribution.refund, error: submittedView.error },
        refunded: { ...doneView.attribution.refund, error: doneView.error }, executedLogs: refundLogs.length } }
    await stopService()
  })

  test_('an unmatched transfer under the job nonce is held and returned, never accepted as the launch payment', async () => {
    const s = unmatched
    const X = env.config.arc.executor
    const confirmations = s.config.route.arc.confirmations
    service = await startService(s)
    const STRAY = 30_000_000n
    // The payer signs other terms under the same nonce: a different amount to the executor.
    const other = async (job: Job) => {
      const message = { from: env.payer, to: X, value: STRAY, validAfter: 0n, validBefore: BigInt(job.request.quote.expires), nonce: job.id }
      const signature = await payerKey.signTypedData({ domain: paymentDomain(job), types: AUTHORIZATION_TYPES, primaryType: 'TransferWithAuthorization', message })
      const { r, s: sig, v } = parseSignature(signature)
      return createWalletClient({ account: payerKey, transport: http(env.config.arc.rpc) }).writeContract({ account: payerKey, chain: null, address: usdc(), abi: usdcAbi, functionName: 'transferWithAuthorization',
        args: [message.from, message.to, message.value, message.validAfter, message.validBefore, message.nonce, Number(v ?? 27n), r, sig] })
    }
    const payerBefore = await balance(env.payer)
    const { x, spendTx } = await releasedBy(s, 'reservation-unmatched-x', other)
    expect(await balance(env.payer)).toBe(payerBefore - STRAY)
    const ledger = s.adapter.ledger(x.job.id)!
    expect(ledger).toMatchObject({ outcome: 'spent_by_other_authorization', authorized: x.job.total, received: STRAY.toString(), residual: STRAY.toString(), fees_spent: '0', evidence_tx: spendTx, refund: 'owed' })
    expect(s.store.db.query('SELECT COUNT(*) AS n FROM robinhood_payment_ledger').get()).toEqual({ n: 1 })
    const job = s.store.get(x.job.id)!
    expect(job.settlement).toBeUndefined()
    expect(job.steps[0].state).not.toBe('complete')
    const view = await viewOf(x.job.id)
    expect(view.funds).toMatchObject({ paid: '0', heldForPayer: STRAY.toString(), refundable: true })
    expect(view.error).toContain(`which moved ${STRAY} USDC atoms to the Arc executor. That is not this job's payment`)
    // No other residual is outstanding in this journal: spend everything else, then nothing more moves.
    const free = await balance(X) - STRAY
    if (free > 0n) expect((await spend(s, 'test:unmatched-free', free)).out.ok).toBe(true)
    await client('arc').mine({ blocks: confirmations })
    expect(await balance(X)).toBe(STRAY)
    const intoStray = await spend(s, 'test:unmatched-into', 1n)
    expect(intoStray.out.code).toBe('residual_reserved')
    // A restart and retries change nothing; the refund returns exactly the stray amount once.
    await stopService('SIGKILL')
    service = await startService(s)
    expect((await post(x.request, x.header)).body.error).toBe('payment_failed')
    expect(s.adapter.ledger(x.job.id)).toEqual(ledger)
    const before = await balance(env.payer)
    expect((await s.adapter.refund(x.job.id)).refund).toBe('submitted')
    await client('arc').mine({ blocks: confirmations })
    const done = await s.adapter.refund(x.job.id)
    expect(done.refund).toBe('refunded')
    expect(await balance(env.payer)).toBe(before + STRAY)
    expect(await balance(X)).toBe(0n)
    evidence.unmatched = { job: x.job.id, otherTerms: { value: STRAY.toString(), tx: spendTx }, ledger, view: { funds: view.funds, error: view.error }, intoStray: intoStray.out, refund: done }
    await stopService()
  })
})
