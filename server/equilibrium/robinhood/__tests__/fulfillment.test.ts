/**
 * MIXED-ENVIRONMENT FORK REHEARSAL of the paid Robinhood launch job: the HTTP quote/payment/job path
 * of the durable shared-supply launch, served by a real separate service process, fulfilled by the
 * route engine against the existing canonical asset on an Arc TESTNET fork and a Robinhood MAINNET
 * fork. Payments are fork fixtures (ForkUsdc, anvil payer); the Robinhood quote is the USDG fixture.
 * Opt-in because it starts two anvil forks from public RPCs:
 *
 *   EQUILIBRIUM_ROBINHOOD_FULFILLMENT=1 bun test server/equilibrium/robinhood/__tests__/fulfillment.test.ts
 *
 * Evidence is written to output/robinhood-fulfillment-evidence.json.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestClient, encodeFunctionData, http, parseSignature, publicActions, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { erc20Abi, executorAbi, transceiverAbi, usdcAbi } from '../../evm/contracts'
import { DEV } from '../../evm/fork'
import { signedHeader } from '../../evm/__tests__/harness'
import { publicJob, runJob } from '../../runner'
import { JobStore } from '../../store'
import type { Job, LaunchRequest } from '../../types'
import { robinhoodFulfillment, transferId } from '../fulfillment'
import { FULFILLMENT_PORTS, fulfillmentForkEnvironment, fulfillmentToJson, type FulfillmentForkEnvironment } from '../fulfillment-fork'
import type { Side } from '../route'

const enabled = process.env.EQUILIBRIUM_ROBINHOOD_FULFILLMENT === '1'
const suite = enabled ? describe : describe.skip
const test_ = (name: string, fn: () => Promise<void>) => test(name, fn, 600_000)
const SERVICE = `http://127.0.0.1:${FULFILLMENT_PORTS.service}`
const LEASE_MS = 3000
const recipient = '0x00000000000000000000000000000000000000a1' as Address
const operator = privateKeyToAccount(DEV.operator)
const outsider = privateKeyToAccount('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a')

let env: FulfillmentForkEnvironment
let dir: string
let dbPath: string
let configPath: string
let store: JobStore
let adapter: ReturnType<typeof robinhoodFulfillment>
let service: ChildProcess | null = null
let jobId: Hex
let r1: LaunchRequest
let header: string
let crashed: Job
let payerBefore: bigint
const evidence: Record<string, unknown> = {}
const json = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_, x: unknown) => (typeof x === 'bigint' ? x.toString() : x)))
const lastLine = (out: string) => JSON.parse(out.trim().split('\n').pop()!) as { ok: boolean; state?: string; code?: string; error?: string }

const client = (side: Side) => createTestClient({ mode: 'anvil', transport: http(env.config[side].rpc) }).extend(publicActions)
const balance = (side: Side, token: Address, owner: Address) => client(side).readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
const usdc = () => env.fulfillment.arc.usdc

function launchRequest(requestId: string, now: number): LaunchRequest {
  return { requestId, payer: env.payer.toLowerCase() as Address,
    canonical: { chain: 'arc', name: 'Equilibrium', symbol: 'EQL', decimals: 6, issuance: '1000000000000', recipient },
    destinations: [
      { chain: 'arc', recipient, amount: '500000000000', poolTokens: '5000000000', poolQuote: '10000000' },
      { chain: 'robinhood', recipient, amount: '10000000000', poolTokens: '5000000000', poolQuote: '10000000' },
    ], quote: { expires: now + 280, costCap: '100000000' } }
}
const post = (body: unknown, payment?: string) => fetch(`${SERVICE}/x402/equilibrium`, { method: 'POST', body: JSON.stringify(body), headers: payment ? { 'payment-signature': payment } : {} })
const readJob = () => store.get(jobId)!

/** Every route operation a job step runs, with how many times the destination executor executed it. */
async function executions(job: Job) {
  const out: Record<string, number> = {}
  for (const step of job.steps) {
    if (!step.prepared) continue
    const b = JSON.parse(step.prepared.bytes) as { name: string; side: Side; operation: Hex }
    const logs = await client(b.side).getLogs({ address: env.config[b.side].executor, event: executorAbi.find((x) => x.type === 'event' && x.name === 'Executed')!, args: { operation: b.operation }, fromBlock: env.config[b.side].fromBlock })
    out[step.id] = logs.length
  }
  return out
}
async function snapshot(label: string) {
  const L = adapter.route.layout
  const s = await adapter.route.supply()
  const state = {
    payer: await balance('arc', usdc(), env.payer), arcExecutorUsdc: await balance('arc', usdc(), env.config.arc.executor),
    recipientArc: await balance('arc', L.canonical, recipient), recipientRobinhood: await balance('robinhood', L.spoke, recipient),
    spokeSupply: s.spokeSupply, custody: s.custody, pending: s.pending, reconciled: s.reconciled,
  }
  evidence[`state:${label}`] = json(state)
  return state
}

function startService(kill?: string): Promise<ChildProcess> {
  const child = spawn('bun', ['run', join(import.meta.dir, '..', 'serve.ts')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    EQUILIBRIUM_ROBINHOOD_FULFILLMENT_CONFIG: configPath, EQUILIBRIUM_DB: dbPath, EQUILIBRIUM_PORT: String(FULFILLMENT_PORTS.service),
    EQUILIBRIUM_LEASE_MS: String(LEASE_MS), EQUILIBRIUM_RECONCILE_MS: '1000', ...(kill ? { EQUILIBRIUM_ROBINHOOD_KILL_AFTER_SEND: kill } : {}) } })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  child.on('exit', (code, signal) => { evidence[`service:${child.pid}`] = { kill: kill ?? null, code, signal, log: log.slice(-2000) } })
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
async function stopService() {
  if (!service) return
  if (service.exitCode === null && service.signalCode === null) {
    const done = exited(service)
    service.kill('SIGTERM')
    const timer = setTimeout(() => service?.kill('SIGKILL'), 2000)
    await done
    clearTimeout(timer)
  }
  service = null
}
function worker(mode: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('bun', ['run', join(import.meta.dir, 'fulfillment-worker.ts'), configPath, dbPath, jobId, mode, '2000'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('exit', (code, signal) => resolve({ code, signal, out: out.trim() }))
  })
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Send from an EOA as a call and report whether it reverts. Nothing is mined. */
async function reverts(side: Side, from: Address, to: Address, data: Hex): Promise<boolean> {
  try { await client(side).call({ account: from, to, data }); return false } catch { return true }
}

suite('EQUILIBRIUM Robinhood paid launch job: mixed Arc-testnet/Robinhood-mainnet fork rehearsal', () => {
  beforeAll(async () => {
    const started = Date.now()
    // A service left on this port by an earlier run would answer from another journal.
    const occupied = await fetch(SERVICE).then(() => true, () => false)
    if (occupied) throw new Error(`${SERVICE} is already serving; stop the leftover process first`)
    env = await fulfillmentForkEnvironment()
    mkdirSync(join(process.cwd(), 'output'), { recursive: true })
    dir = mkdtempSync(join(process.cwd(), 'output', 'robinhood-fulfillment-'))
    dbPath = join(dir, 'jobs.sqlite')
    configPath = join(dir, 'fulfillment.json')
    store = new JobStore(dbPath, { leaseMs: LEASE_MS })
    adapter = robinhoodFulfillment(env.fulfillment, store.db)
    writeFileSync(configPath, fulfillmentToJson(env.fulfillment, env.guardianSets))
    // The existing canonical asset: issued and hubbed once, before any launch job exists.
    const hub = await adapter.route.deployHub()
    Object.assign(evidence, {
      labels: env.fulfillment.labels, adapter: adapter.version, journal: dir,
      forks: { arc: { url: env.arc.url, chainId: env.config.arc.chainId, note: 'Arc TESTNET fork' }, robinhood: { url: env.robinhood.url, chainId: env.config.robinhood.chainId, block: env.robinhood.block.toString(), note: 'Robinhood MAINNET fork' } },
      existingAsset: { id: env.config.asset.id, canonical: adapter.route.layout.canonical, hub: adapter.route.layout.hub.proxy, hubTx: hub.transactionHash },
      setupSeconds: (Date.now() - started) / 1000,
    })
  }, 600_000)
  afterAll(async () => {
    await stopService()
    store?.close()
    env?.stop()
    if (enabled) writeFileSync(join(process.cwd(), 'output', 'robinhood-fulfillment-evidence.json'), JSON.stringify(json(evidence), null, 2) + '\n')
  }, 30_000)

  test_('quotes over HTTP with labelled fixtures; conflicting payloads and closed chains are refused', async () => {
    service = await startService()
    const status = await (await fetch(`${SERVICE}/api/equilibrium`)).json() as { labels: Record<string, string>; mode: string }
    expect(status.mode).toBe('fork')
    expect(status.labels.environment).toBe('mixed:arc-testnet-fork+robinhood-mainnet-fork')
    expect(status.labels.payment).toStartWith('fork-fixture')
    expect(status.labels.quoteInventory).toStartWith('fork-fixture')
    expect(status.labels.publicRoute).toBe('closed')
    const now = Math.floor(Date.now() / 1000)
    r1 = launchRequest('robinhood-launch-0001', now)
    const quoted = await post(r1)
    expect(quoted.status).toBe(402)
    expect(quoted.headers.get('x-equilibrium-environment')).toBe('mixed:arc-testnet-fork+robinhood-mainnet-fork')
    expect(quoted.headers.get('x-equilibrium-payment')).toBe('fork-fixture')
    const body = await quoted.json() as { jobId: Hex; total: string; accepts: { payTo: string; amount: string }[] }
    jobId = body.jobId
    expect(body.accepts[0].payTo).toBe(env.config.arc.executor)
    expect(body.accepts[0].amount).toBe(body.total)
    // Same requestId, other payload: refused, never a second job.
    const conflict = await post({ ...r1, destinations: r1.destinations.map((d) => ({ ...d, poolQuote: '20000000' })) })
    expect(conflict.status).toBe(409)
    expect((await conflict.json() as { error: string }).error).toBe('identity_conflict')
    const base = await post({ ...launchRequest('robinhood-launch-base', now), destinations: [r1.destinations[0], { ...r1.destinations[1], chain: 'base' }] })
    expect(base.status).toBe(503)
    const otherAsset = await post({ ...launchRequest('robinhood-launch-other', now), canonical: { ...r1.canonical, symbol: 'OTHER' } })
    expect((await otherAsset.json() as { error: string }).error).toBe('asset_mismatch')
    header = await signedHeader(readJob())
    // A header signed for this job does not pay for any other quote: the nonce is the job id.
    const r3 = launchRequest('robinhood-launch-0003', now)
    const foreign = await post(r3, header)
    expect(foreign.status).toBe(402)
    expect((await foreign.json() as { error: string }).error).toBe('invalid_payment')
    payerBefore = await balance('arc', usdc(), env.payer)
    evidence.quote = { jobId, total: body.total, conflicts: ['identity_conflict', 'route_closed:base', 'asset_mismatch', 'invalid_payment:foreign-header'] }
    await stopService()
  })

  test_('the service dies right after the payment send: charged exactly once, nothing recorded yet', async () => {
    service = await startService('payment:arc')
    const died = exited(service)
    await post(r1, header).catch((cause: unknown) => cause)
    expect((await died).signal).toBe('SIGKILL')
    service = null
    crashed = readJob()
    expect(crashed.state).toBe('running')
    expect(crashed.steps[0].state).toBe('prepared')
    expect(crashed.steps[0].result).toBeUndefined()
    // The send was handed to the RPC and nothing about it was recorded; it lands on its own.
    for (let i = 0; i < 40 && (await executions(crashed))['payment:arc'] === 0; i++) await sleep(250)
    expect((await executions(crashed))['payment:arc']).toBe(1)
    const total = BigInt(crashed.total)
    expect(await balance('arc', usdc(), env.payer)).toBe(payerBefore - total)
    evidence.crashAfterPayment = { job: publicJob(crashed), executions: await executions(crashed) }
  })

  test_('a worker killed after the debit send, then two racing workers killed after the credit send: one debit, one credit', async () => {
    await sleep(LEASE_MS + 500)
    const w1 = await worker('kill-after-send:debit:robinhood')
    expect(w1.signal).toBe('SIGKILL')
    await sleep(2500)
    const [w2, w3] = await Promise.all([worker('kill-after-send:credit:robinhood'), worker('kill-after-send:credit:robinhood')])
    const killed = [w2, w3].filter((w) => w.signal === 'SIGKILL')
    const busy = [w2, w3].filter((w) => w.code === 3).map((w) => lastLine(w.out))
    expect(killed.length).toBe(1)
    expect(busy.map((b) => b.code)).toEqual(['job_busy'])
    const job = readJob()
    const counts = await executions(job)
    expect(counts['debit:robinhood']).toBe(1)
    expect(counts['credit:robinhood']).toBe(1)
    expect(adapter.route.get(transferId(job))!.state).not.toBe('planned')
    evidence.workers = { w1: { signal: w1.signal }, race: [w2, w3].map((w) => ({ signal: w.signal, code: w.code, out: w.out.slice(-300) })), executions: counts, job: publicJob(job) }
  })

  test_('the restarted service resumes from its journal with no client resend; every effect executed once and supply reconciles', async () => {
    await sleep(2500)
    service = await startService()
    const deadline = Date.now() + 300_000
    let job = readJob()
    while (job.state !== 'complete' && Date.now() < deadline) { await sleep(1000); job = readJob() }
    expect(job.state).toBe('complete')
    const counts = await executions(job)
    expect(Object.keys(counts).length).toBe(8)
    for (const [step, n] of Object.entries(counts)) expect([step, n]).toEqual([step, 1])
    const L = adapter.route.layout
    const s = await snapshot('complete')
    expect(s.reconciled).toBe(true)
    expect(s.spokeSupply).toBe(10_000_000_000n)
    expect(s.custody).toBe(10_000_000_000n)
    expect(s.pending).toBe(0n)
    expect(s.payer).toBe(payerBefore - BigInt(job.total))
    expect(s.recipientRobinhood).toBe(5_000_000_000n)
    // Arc recipient: its remainder plus every unallocated token.
    expect(s.recipientArc).toBe(495_000_000_000n + 490_000_000_000n)
    const view = await (await fetch(`${SERVICE}/equilibrium/jobs/${jobId}`)).json() as { jobs: ReturnType<typeof publicJob>[] }
    const pub = view.jobs[0]
    expect(pub.state).toBe('complete')
    expect(pub.settlement!.amount).toBe(job.total)
    expect(pub.funds.determinate).toBe(true)
    // The pool is real: QuoterV2 prices both directions against the job's Robinhood pool.
    const pool = await adapter.route.pool()
    expect(pool).toBe(job.steps.find((x) => x.id === 'pool:robinhood')!.result!.address as Address)
    const sell = await adapter.route.quote(100_000_000n, 'spoke')
    const buy = await adapter.route.quote(1_000_000n, 'quote')
    expect(sell.amountOut > 0n && buy.amountOut > 0n).toBe(true)
    evidence.complete = { job: pub, executions: counts, addresses: { canonical: L.canonical, hub: L.hub.proxy, spoke: L.spoke, spokeManager: L.spokeManager.proxy, robinhoodPool: pool, arcPool: job.steps.find((x) => x.id === 'pool:arc')!.result!.address },
      quotes: json({ sell, buy }), costs: Object.fromEntries(job.steps.map((x) => [x.id, x.result!.cost])) }
  })

  test_('a replayed paid request returns the same job without charging, issuing, debiting or crediting again', async () => {
    const before = await snapshot('before-replay')
    const job = readJob()
    const countsBefore = await executions(job)
    const replay = await post(r1, header)
    expect(replay.status).toBe(200)
    const body = await replay.json() as ReturnType<typeof publicJob>
    expect(body.id).toBe(jobId)
    expect(body.steps.map((x) => x.result?.transaction)).toEqual(job.steps.map((x) => x.result!.transaction))
    expect(replay.headers.get('payment-response')).not.toBeNull()
    expect(await executions(readJob())).toEqual(countsBefore)
    expect(await snapshot('after-replay')).toEqual(before)
    // A second launch of the same asset is refused at quote time: nothing to pay, nothing charged.
    const second = await post(launchRequest('robinhood-launch-0002', Math.floor(Date.now() / 1000)))
    expect(second.status).toBe(409)
    expect((await second.json() as { error: string }).error).toBe('asset_launched')
    expect(await balance('arc', usdc(), env.payer)).toBe(before.payer)
    evidence.replay = { status: 200, sameTransactions: true, secondLaunch: 'asset_launched' }
  })

  test_('stale workers, replayed executor calls, a replayed authorization and a replayed VAA cannot repeat any effect', async () => {
    await stopService()
    const job = readJob()
    const counts = await executions(job)
    const before = await snapshot('before-stale')
    // A worker whose lease lapsed but which still reaches broadcast with persisted bytes: every call is a no-op.
    for (const step of job.steps) await adapter.broadcast({ job, step }, step.prepared!)
    // The same, from the stale job snapshot the crashed service left behind.
    await adapter.broadcast({ job: crashed, step: crashed.steps[0] }, crashed.steps[0].prepared!)
    expect(await executions(job)).toEqual(counts)
    expect(await snapshot('after-stale')).toEqual(before)
    // The stale snapshot cannot be written back: revision and lease fencing.
    expect(() => store.save(crashed, 'stale-worker', Date.now())).toThrow('lost its lease')
    // A completed job re-run does nothing.
    expect((await runJob(store, adapter, jobId)).state).toBe('complete')
    expect(await executions(job)).toEqual(counts)
    const replays: Record<string, boolean> = {}
    for (const step of job.steps) {
      const b = JSON.parse(step.prepared!.bytes) as { side: Side; plan: string; digest: Hex }
      const p = JSON.parse(b.plan) as { operation: Hex; calls: { target: Address; value: string; data: Hex }[] }
      const data = encodeFunctionData({ abi: executorAbi, functionName: 'execute', args: [p.operation, b.digest, p.calls.map((x) => ({ target: x.target, value: BigInt(x.value), data: x.data }))] })
      replays[`execute:${step.id}`] = await reverts(b.side, operator.address, env.config[b.side].executor, data)
    }
    const a = job.payment!.authorization
    const { r, s, v } = parseSignature(job.payment!.signature)
    replays['transferWithAuthorization'] = await reverts('arc', outsider.address, usdc(), encodeFunctionData({ abi: usdcAbi, functionName: 'transferWithAuthorization',
      args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, Number(v ?? 27n), r, s] }))
    const t = adapter.route.get(transferId(job))!
    replays['receiveMessage:vaa'] = await reverts('robinhood', outsider.address, adapter.route.layout.spokeManager.transceiver, encodeFunctionData({ abi: transceiverAbi, functionName: 'receiveMessage', args: [t.vaa!] }))
    for (const [name, reverted] of Object.entries(replays)) expect([name, reverted]).toEqual([name, true])
    evidence.replays = replays
  })
})
