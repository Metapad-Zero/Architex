/**
 * MIXED-ENVIRONMENT FORK REGRESSIONS for the Robinhood launch job's asset reservation: who may hold
 * the existing canonical asset while a payment is unsettled, when that hold is released, and what a
 * released job can still do. Arc testnet fork + Robinhood mainnet fork; payments are fork fixtures
 * (ForkUsdc, anvil payer). Own ports (Arc 18657, Robinhood 18658, service 4047) and own journals, so
 * it never collides with the fulfillment suite (18655/18656/4046). Opt-in because it starts two forks:
 *
 *   EQUILIBRIUM_ROBINHOOD_FULFILLMENT=1 bun test server/equilibrium/robinhood/__tests__/fulfillment-reservation.test.ts
 *
 * Two assets on the same forks, one per scenario, each with its own journal and service config:
 * - "uncertain": the payment send has no receipt (Arc automine off), so its outcome is unknown.
 * - "failed": the payer's balance is gone, so the send reverts in estimation, and then the
 *   authorization expires: the payment can provably never settle.
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

async function scenario(name: string, assetId: string): Promise<Scenario> {
  // Receipts are instant with automine on; a short wait is what makes a withheld receipt an unknown outcome.
  const config: RobinhoodFulfillmentConfig = { ...env.fulfillment, route: { ...env.fulfillment.route, asset: { ...env.fulfillment.route.asset, id: assetId }, receiptTimeoutMs: 5000 } }
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

function startService(s: Scenario): Promise<ChildProcess> {
  const child = spawn('bun', ['run', join(import.meta.dir, '..', 'serve.ts')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    EQUILIBRIUM_ROBINHOOD_FULFILLMENT_CONFIG: s.configPath, EQUILIBRIUM_DB: s.dbPath, EQUILIBRIUM_PORT: String(PORTS.service),
    EQUILIBRIUM_LEASE_MS: String(LEASE_MS), EQUILIBRIUM_RECONCILE_MS: '1000' } })
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
    Object.assign(evidence, { labels: env.fulfillment.labels, ports: PORTS,
      forks: { arc: { url: env.arc.url, chainId: env.config.arc.chainId, note: 'Arc TESTNET fork' }, robinhood: { url: env.robinhood.url, chainId: env.config.robinhood.chainId, block: env.robinhood.block.toString(), note: 'Robinhood MAINNET fork' } },
      setupSeconds: (Date.now() - started) / 1000 })
  }, 600_000)
  afterAll(async () => {
    if (env) await client('arc').setAutomine(true).catch(() => undefined)
    await stopService()
    uncertain?.store.close()
    failed?.store.close()
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
})
