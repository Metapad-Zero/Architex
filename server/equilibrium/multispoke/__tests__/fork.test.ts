/**
 * MIXED-ENVIRONMENT FORK REHEARSAL of ONE paid launch job across Arc, Base and Robinhood: an Arc
 * testnet fork, a Base Sepolia fork and a Robinhood mainnet fork (see ../fork.ts). Payments are fork
 * fixtures (ForkUsdc, anvil payer); spoke quote inventory is credited by storage write. Own ports
 * (18755/18756/18757, service 4048) and own journals. Opt-in because it starts three forks:
 *
 *   EQUILIBRIUM_MULTISPOKE_FORK=1 bun test server/equilibrium/multispoke
 *
 * Evidence is written to output/multispoke-fork-evidence.json.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestClient, createWalletClient, encodeFunctionData, http, parseAbi, parseSignature, publicActions, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { erc20Abi, executorAbi, transceiverAbi, usdcAbi } from '../../evm/contracts'
import { DEV, PINNED, deployInfrastructure } from '../../evm/fork'
import { AUTHORIZATION_TYPES, paymentDomain } from '../../payment'
import { signedHeader, signedPayment } from '../../evm/__tests__/harness'
import { ROBINHOOD_MAINNET } from '../../robinhood/pins'
import { hash } from '../../request'
import { publicJob, quote, runJob } from '../../runner'
import { createLaunchService } from '../../service'
import { JobStore } from '../../store'
import { LaunchError, type Job, type LaunchRequest, type PromotionalTokenAdapter } from '../../types'
import { layout, multispokeAdapter, sideOf, type MultispokeAdapter, type MultispokeConfig, type Side } from '../adapter'
import { MULTISPOKE_PORTS, configToJson, multispokeForkEnvironment, type MultispokeForkEnvironment } from '../fork'

const enabled = process.env.EQUILIBRIUM_MULTISPOKE_FORK === '1'
const suite = enabled ? describe : describe.skip
const test_ = (name: string, fn: () => Promise<void>) => test(name, fn, 900_000)
const SERVICE = `http://127.0.0.1:${MULTISPOKE_PORTS.service}`
const LEASE_MS = 3000
const recipient = '0x00000000000000000000000000000000000000a1' as Address
const operator = privateKeyToAccount(DEV.operator)
const payerKey = privateKeyToAccount(DEV.payer)
const SINK_KEY = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a' as Hex
const sink = privateKeyToAccount(SINK_KEY).address
const quoterAbi = parseAbi([
  'struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }',
  'function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
])

interface Journal { config: MultispokeConfig; dir: string; dbPath: string; configPath: string; store: JobStore; adapter: MultispokeAdapter }
let env: MultispokeForkEnvironment
let main: Journal
let service: ChildProcess | null = null
const evidence: Record<string, unknown> = {}
const json = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_, x: unknown) => (typeof x === 'bigint' ? x.toString() : x)))
const now = () => Math.floor(Date.now() / 1000)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const client = (side: Side) => createTestClient({ mode: 'anvil', transport: http(env.urls[side]) }).extend(publicActions)
const balance = (side: Side, token: Address, owner: Address) => client(side).readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
const usdc = PINNED.arc.usdc

function launchRequest(requestId: string, expiresIn = 280): LaunchRequest {
  return { requestId, payer: payerKey.address.toLowerCase() as Address,
    canonical: { chain: 'arc', name: 'Equilibrium', symbol: 'EQL', decimals: 6, issuance: '1000000000000', recipient },
    destinations: [
      { chain: 'arc', recipient, amount: '500000000000', poolTokens: '5000000000', poolQuote: '10000000' },
      { chain: 'base', recipient, amount: '10000000000', poolTokens: '5000000000', poolQuote: '10000000' },
      { chain: 'robinhood', recipient, amount: '20000000000', poolTokens: '5000000000', poolQuote: '10000000' },
    ], quote: { expires: now() + expiresIn, costCap: '100000000' } }
}

function journal(name: string, overrides: Partial<MultispokeConfig> = {}): Journal {
  const config: MultispokeConfig = { ...env.config, ...overrides }
  const dir = mkdtempSync(join(process.cwd(), 'output', `multispoke-${name}-`))
  const dbPath = join(dir, 'jobs.sqlite')
  const configPath = join(dir, 'multispoke.json')
  writeFileSync(configPath, configToJson(config, env.guardianSets))
  const store = new JobStore(dbPath, { leaseMs: LEASE_MS })
  return { config, dir, dbPath, configPath, store, adapter: multispokeAdapter(config, store.db) }
}

/** How many times each step's operation executed on its chain. Every value must be 1 for a finished job. */
async function executions(job: Job, config: MultispokeConfig = main.config) {
  const out: Record<string, number> = {}
  for (const step of job.steps) {
    const side = sideOf(step)
    const c = side === 'arc' ? config.arc : config.spokes[side]
    const logs = await client(side).getLogs({ address: c.executor, event: executorAbi.find((x) => x.type === 'event' && x.name === 'Executed')!, args: { operation: hash([job.id, step.id]) }, fromBlock: c.fromBlock })
    out[step.id] = logs.length
  }
  return out
}
const once = (job: Job) => Object.fromEntries(job.steps.map((s) => [s.id, 1]))

type Reply = { status: number; body: { error?: string; jobId?: Hex; id?: Hex; state?: string; total?: string; accepts?: { payTo: string; amount: string }[] } }
async function post(body: unknown, payment?: string, base = SERVICE): Promise<Reply> {
  const r = await fetch(`${base}/x402/equilibrium`, { method: 'POST', body: JSON.stringify(body), headers: payment ? { 'payment-signature': payment } : {} })
  if (base === SERVICE) {
    expect(r.headers.get('x-equilibrium-environment')).toBe('mixed:arc-testnet-fork+base-sepolia-fork+robinhood-mainnet-fork')
    expect(r.headers.get('x-equilibrium-payment')).toBe('fork-fixture')
  }
  return { status: r.status, body: await r.json() as Reply['body'] }
}
/** The same HTTP surface in-process, for journals that are not served by the child process. */
async function postTo(j: Journal, body: unknown, payment?: string): Promise<Reply> {
  const r = await createLaunchService(j.store, j.adapter)(new Request('http://fork/x402/equilibrium', { method: 'POST', body: JSON.stringify(body), headers: payment ? { 'payment-signature': payment } : {} }))
  return { status: r.status, body: await r.json() as Reply['body'] }
}

function startService(j: Journal, extra: Record<string, string> = {}): Promise<ChildProcess> {
  const child = spawn('bun', ['run', join(import.meta.dir, '..', 'serve.ts')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    EQUILIBRIUM_MULTISPOKE_CONFIG: j.configPath, EQUILIBRIUM_DB: j.dbPath, EQUILIBRIUM_PORT: String(MULTISPOKE_PORTS.service),
    EQUILIBRIUM_LEASE_MS: String(LEASE_MS), EQUILIBRIUM_RECONCILE_MS: '1000', ...extra } })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  child.on('exit', (code, signal) => { evidence[`service:${child.pid}`] = { code, signal, log: log.slice(-2000) } })
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
function worker(j: Journal, jobId: string, mode: string, kill?: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('bun', ['run', join(import.meta.dir, 'worker.ts'), j.configPath, j.dbPath, jobId, mode, '2000', ...(kill ? [kill] : [])], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('exit', (code, signal) => resolve({ code, signal, out: out.trim() }))
  })
}
const lastLine = (out: string) => JSON.parse(out.trim().split('\n').pop()!) as { ok: boolean; state?: string; code?: string }
async function waitFor(j: Journal, id: Hex, done: (job: Job) => boolean, ms = 300_000) {
  const deadline = Date.now() + ms
  let job = j.store.get(id)!
  while (!done(job) && Date.now() < deadline) { await sleep(1000); job = j.store.get(id)! }
  return job
}
async function payerTo(amount: bigint) {
  const current = await balance('arc', usdc, payerKey.address)
  if (current > amount) {
    await client('arc').setBalance({ address: payerKey.address, value: 10n ** 20n })
    const wallet = createWalletClient({ account: payerKey, transport: http(env.urls.arc) })
    await client('arc').waitForTransactionReceipt({ hash: await wallet.writeContract({ account: payerKey, chain: null, address: usdc, abi: erc20Abi, functionName: 'transfer', args: [sink, current - amount] }) })
  }
  if (current < amount) {
    const minter = createWalletClient({ account: operator, transport: http(env.urls.arc) })
    await client('arc').waitForTransactionReceipt({ hash: await minter.writeContract({ account: operator, chain: null, address: usdc, abi: usdcAbi, functionName: 'mint', args: [payerKey.address, amount - current] }) })
  }
  expect(await balance('arc', usdc, payerKey.address)).toBe(amount)
}
const authorizationSpent = (job: Job) => client('arc').readContract({ address: usdc, abi: usdcAbi, functionName: 'authorizationState', args: [payerKey.address, job.id] })
const hasCode = async (side: Side, address: Address) => ((await client(side).getCode({ address })) ?? '0x') !== '0x'
async function reverts(side: Side, from: Address, to: Address, data: Hex) {
  try { await client(side).call({ account: from, to, data }); return false } catch { return true }
}

/** Everything one completed job must show on the three chains. */
async function assertLaunched(j: Journal, job: Job) {
  const L = layout(job, j.config)
  const [arcD, baseD, rhD] = job.request.destinations
  const s = await j.adapter.supply(job)
  expect(json(s)).toEqual(json({ issued: 1_000_000_000_000n, custody: BigInt(baseD.amount) + BigInt(rhD.amount), spokes: { base: BigInt(baseD.amount), robinhood: BigInt(rhD.amount) },
    inFlight: { base: 0n, robinhood: 0n }, outside: 1_000_000_000_000n - BigInt(baseD.amount) - BigInt(rhD.amount), accounted: 1_000_000_000_000n, reconciled: true }))
  const pool = (id: string) => job.steps.find((x) => x.id === id)!.result!.address as Address
  expect(await balance('arc', L.canonical, pool('pool:arc'))).toBe(BigInt(arcD.poolTokens))
  expect(await balance('arc', usdc, pool('pool:arc'))).toBe(BigInt(arcD.poolQuote))
  expect(await balance('base', L.spokes.base.token, pool('pool:base'))).toBe(BigInt(baseD.poolTokens))
  expect(await balance('base', PINNED.base.usdc, pool('pool:base'))).toBe(BigInt(baseD.poolQuote))
  expect(await balance('robinhood', L.spokes.robinhood.token, pool('pool:robinhood'))).toBe(BigInt(rhD.poolTokens))
  expect(await balance('robinhood', ROBINHOOD_MAINNET.usdgFixture, pool('pool:robinhood'))).toBe(BigInt(rhD.poolQuote))
  // Allocations reached the recipient; no EQUILIBRIUM stays in any executor.
  expect(await balance('arc', L.canonical, recipient)).toBe(1_000_000_000_000n - BigInt(baseD.amount) - BigInt(rhD.amount) - BigInt(arcD.poolTokens))
  expect(await balance('base', L.spokes.base.token, recipient)).toBe(BigInt(baseD.amount) - BigInt(baseD.poolTokens))
  expect(await balance('robinhood', L.spokes.robinhood.token, recipient)).toBe(BigInt(rhD.amount) - BigInt(rhD.poolTokens))
  expect(await balance('arc', L.canonical, j.config.arc.executor)).toBe(0n)
  expect(await balance('base', L.spokes.base.token, j.config.spokes.base.executor)).toBe(0n)
  expect(await balance('robinhood', L.spokes.robinhood.token, j.config.spokes.robinhood.executor)).toBe(0n)
  expect(await executions(job, j.config)).toEqual(once(job))
  return { L, supply: s }
}

suite('EQUILIBRIUM one paid launch job across Arc, Base and Robinhood forks', () => {
  beforeAll(async () => {
    const started = Date.now()
    if (await fetch(SERVICE).then(() => true, () => false)) throw new Error(`${SERVICE} is already serving; stop the leftover process first`)
    env = await multispokeForkEnvironment()
    mkdirSync(join(process.cwd(), 'output'), { recursive: true })
    main = journal('main')
    await main.adapter.verify()
    Object.assign(evidence, { labels: env.config.labels, adapter: main.adapter.version, ports: MULTISPOKE_PORTS, journal: main.dir,
      sources: { pr12: '5a65b2080e6865c95fd2d549ace0206610ea1a76', pr18: 'a019f432c0d855b11ac078faf98372c995a046f2' },
      forks: { arc: { url: env.arc.url, chainId: env.config.arc.chainId, block: PINNED.arc.block.toString(), note: 'Arc TESTNET fork' },
        base: { url: env.base.url, chainId: env.config.spokes.base.chainId, block: PINNED.base.block.toString(), note: 'Base SEPOLIA fork' },
        robinhood: { url: env.robinhood.url, chainId: env.config.spokes.robinhood.chainId, block: env.robinhood.block.toString(), note: 'Robinhood MAINNET fork', pins: env.robinhood.pins } },
      executors: { arc: env.config.arc.executor, base: env.config.spokes.base.executor, robinhood: env.config.spokes.robinhood.executor },
      guardianSets: env.guardianSets, setupSeconds: (Date.now() - started) / 1000 })
  }, 900_000)
  afterAll(async () => {
    await stopService()
    main?.store.close()
    attr?.store.close()
    env?.stop()
    if (enabled) writeFileSync(join(process.cwd(), 'output', 'multispoke-fork-evidence.json'), JSON.stringify(json(evidence), null, 2) + '\n')
  }, 30_000)

  test_('the quote binds one payment to the Arc executor; conflicting or foreign requests are refused before any charge', async () => {
    service = await startService(main)
    const request = launchRequest('multispoke-conflict-0001')
    const payerBefore = await balance('arc', usdc, payerKey.address)
    const q = await post(request)
    expect(q.status).toBe(402)
    expect(q.body.accepts![0].payTo.toLowerCase()).toBe(env.config.arc.executor.toLowerCase())
    expect(q.body.accepts![0].amount).toBe(q.body.total!)
    const job = main.store.get(q.body.jobId!)!
    expect(job.steps.map((s) => s.id)).toEqual(['payment:arc', 'canonical:arc', 'manager:arc', 'pool:arc', 'manager:base', 'debit:base', 'credit:base', 'pool:base', 'manager:robinhood', 'debit:robinhood', 'credit:robinhood', 'pool:robinhood'])
    const changed = { ...request, destinations: request.destinations.map((d) => (d.chain === 'robinhood' ? { ...d, amount: '20000000001' } : d)) }
    const conflict = await post(changed)
    const baseOnly = await post({ ...launchRequest('multispoke-conflict-0002'), destinations: request.destinations.slice(0, 2) })
    const robinhoodOnly = await post({ ...launchRequest('multispoke-conflict-0003'), destinations: [request.destinations[0], request.destinations[2]] })
    // A header signed for another job's quote cannot pay this one.
    const other = quote(main.store, main.adapter, launchRequest('multispoke-conflict-0004'), now())
    const foreign = await post(request, await signedHeader(other))
    expect([conflict.status, conflict.body.error]).toEqual([409, 'identity_conflict'])
    expect([baseOnly.status, baseOnly.body.error]).toEqual([503, 'route_closed'])
    expect([robinhoodOnly.status, robinhoodOnly.body.error]).toEqual([503, 'route_closed'])
    expect([foreign.status, foreign.body.error]).toEqual([402, 'invalid_payment'])
    expect(await balance('arc', usdc, payerKey.address)).toBe(payerBefore)
    expect(await authorizationSpent(job)).toBe(false)
    expect(await hasCode('arc', layout(job, main.config).canonical)).toBe(false)
    evidence.conflicts = { quote: { status: q.status, jobId: job.id, total: q.body.total }, conflict: conflict.body.error, baseOnly: baseOnly.body.error, robinhoodOnly: robinhoodOnly.body.error, foreignHeader: foreign.body.error }
    await stopService()
  })

  let first: Job
  test_('one paid request issues once and credits both spokes; a crash between debit and credit is finished by the restart sweep with supply conserved', async () => {
    const request = launchRequest('multispoke-launch-0001')
    service = await startService(main, { EQUILIBRIUM_MULTISPOKE_KILL_AFTER_SEND: 'debit:robinhood' })
    const q = await post(request)
    const job = main.store.get(q.body.jobId!)!
    const payerBefore = await balance('arc', usdc, payerKey.address)
    const crashed = await fetch(`${SERVICE}/x402/equilibrium`, { method: 'POST', body: JSON.stringify(request), headers: { 'payment-signature': await signedHeader(job) } }).then((r) => r.status, (e: unknown) => String(e).slice(0, 80))
    const death = await exited(service)
    service = null
    expect(death.signal).toBe('SIGKILL')
    // Mid-flight: the Robinhood debit is locked on Arc, nothing is minted there yet, and supply still conserves.
    const mid = main.store.get(job.id)!
    const midSupply = await main.adapter.supply(mid)
    expect(midSupply.inFlight).toEqual({ base: 0n, robinhood: 20_000_000_000n })
    expect(midSupply.spokes).toEqual({ base: 10_000_000_000n, robinhood: 0n })
    expect(midSupply.reconciled).toBe(true)
    expect(mid.state).not.toBe('complete')
    // Restart from the same journal. The sweep resumes the job with no client resend.
    service = await startService(main)
    first = await waitFor(main, job.id, (j) => j.state === 'complete')
    expect(first.state).toBe('complete')
    const record = publicJob(first)
    expect([record.payment.settled, record.supply.reconciled, record.settlement?.amount]).toEqual([true, true, first.total])
    // One payment of exactly the quoted total.
    expect(payerBefore - await balance('arc', usdc, payerKey.address)).toBe(BigInt(first.total))
    expect(await authorizationSpent(first)).toBe(true)
    const { L, supply } = await assertLaunched(main, first)
    // Both spoke pools price the same asset through the real Robinhood QuoterV2 and an exact receipt-proven Base deposit.
    const { result: sell } = await client('robinhood').simulateContract({ address: ROBINHOOD_MAINNET.venue.quoterV2, abi: quoterAbi, functionName: 'quoteExactInputSingle',
      args: [{ tokenIn: L.spokes.robinhood.token, tokenOut: ROBINHOOD_MAINNET.usdgFixture, amountIn: 1_000_000n, fee: 3000, sqrtPriceLimitX96: 0n }] })
    const { result: buy } = await client('robinhood').simulateContract({ address: ROBINHOOD_MAINNET.venue.quoterV2, abi: quoterAbi, functionName: 'quoteExactInputSingle',
      args: [{ tokenIn: ROBINHOOD_MAINNET.usdgFixture, tokenOut: L.spokes.robinhood.token, amountIn: 1_000_000n, fee: 3000, sqrtPriceLimitX96: 0n }] })
    expect(sell[0]).toBeGreaterThan(0n)
    expect(buy[0]).toBeGreaterThan(0n)
    // One asset identity: both spoke managers peer to the same Arc hub, and the hub to both.
    const hubPeer = (spoke: 'base' | 'robinhood') => client('arc').readContract({ address: L.hub.transceiver, abi: transceiverAbi, functionName: 'getWormholePeer', args: [env.config.spokes[spoke].wormholeChainId] })
    expect((await hubPeer('base')).toLowerCase()).toBe(`0x${L.spokes.base.manager.transceiver.slice(2).toLowerCase().padStart(64, '0')}`)
    expect((await hubPeer('robinhood')).toLowerCase()).toBe(`0x${L.spokes.robinhood.manager.transceiver.slice(2).toLowerCase().padStart(64, '0')}`)
    evidence.launch = { jobId: first.id, total: first.total, crashedResponse: crashed, killedAfter: 'debit:robinhood', midSupply, supply, addresses: {
      canonical: L.canonical, hub: L.hub.proxy, hubTransceiver: L.hub.transceiver, baseSpoke: L.spokes.base.token, baseManager: L.spokes.base.manager.proxy,
      robinhoodSpoke: L.spokes.robinhood.token, robinhoodManager: L.spokes.robinhood.manager.proxy,
      pools: Object.fromEntries(first.steps.filter((s) => s.kind === 'pool').map((s) => [s.id, s.result!.address])) },
      robinhoodQuoter: { sell1Spoke: sell[0], buyWith1Usdg: buy[0] }, executions: await executions(first),
      transactions: Object.fromEntries(first.steps.map((s) => [s.id, { tx: s.result!.transaction, cost: s.result!.cost }])), record }
  })

  test_('re-posting the paid request returns the same job and executes nothing again', async () => {
    const payerBefore = await balance('arc', usdc, payerKey.address)
    const again = await post(first.request, await signedHeader(first))
    expect([again.status, again.body.id, again.body.state]).toEqual([200, first.id, 'complete'])
    expect(await balance('arc', usdc, payerKey.address)).toBe(payerBefore)
    expect(await executions(first)).toEqual(once(first))
    await stopService()
  })

  test_('a worker SIGKILLed after the Base credit send, then two racing workers: the lease admits one and every effect happens once', async () => {
    const job = quote(main.store, main.adapter, launchRequest('multispoke-race-0001'), now())
    // Persist and settle the payment in-process, stopping before issuance, so the workers resume a paid job.
    const stop: PromotionalTokenAdapter = { ...main.adapter, broadcast: async (context, prepared) => {
      if (context.step.id === 'canonical:arc') throw new Error('stop before issuance')
      return main.adapter.broadcast(context, prepared)
    } }
    await runJob(main.store, stop, job.id, await signedPayment(job)).catch((e: unknown) => e)
    expect(main.store.get(job.id)!.steps[0].state).toBe('complete')
    const killed = await worker(main, job.id, 'kill-after-send:credit:base')
    expect(killed.signal).toBe('SIGKILL')
    const snapshot = main.store.get(job.id)!
    await sleep(2500)
    const [a, b] = await Promise.all([worker(main, job.id, 'none'), worker(main, job.id, 'none')])
    const outcomes = [lastLine(a.out), lastLine(b.out)]
    expect(outcomes.filter((o) => o.ok && o.state === 'complete').length).toBe(1)
    expect(outcomes.filter((o) => !o.ok && o.code === 'job_busy').length).toBe(1)
    const done = main.store.get(job.id)!
    expect(done.state).toBe('complete')
    await assertLaunched(main, done)
    // The snapshot taken after the crash is stale: it cannot be saved, and replaying its bytes changes nothing.
    const owner = 'stale-snapshot'
    main.store.claim(job.id, owner, Date.now())
    let refused: string | null = null
    try { main.store.save(snapshot, owner, Date.now()) } catch (cause) { refused = cause instanceof LaunchError ? cause.code : String(cause) }
    main.store.release(job.id, owner)
    expect(refused).toBe('stale_worker')
    for (const step of snapshot.steps) if (step.prepared) await main.adapter.broadcast({ job: snapshot, step }, step.prepared)
    expect(await executions(done)).toEqual(once(done))
    evidence.race = { jobId: job.id, killed: { signal: killed.signal, after: 'credit:base' }, workers: outcomes, staleSave: refused, executions: await executions(done) }
  })

  test_('a stale adapter racing a live one on the same prepared Robinhood debit moves the tokens once', async () => {
    const job = quote(main.store, main.adapter, launchRequest('multispoke-stale-0001'), now())
    const stale = multispokeAdapter(main.config, main.store.db)
    const racing: PromotionalTokenAdapter = { ...main.adapter, broadcast: async (context, prepared) => {
      if (context.step.id !== 'debit:robinhood') return main.adapter.broadcast(context, prepared)
      await Promise.all([main.adapter.broadcast(context, prepared), stale.broadcast(context, prepared)])
    } }
    const result = await runJob(main.store, racing, job.id, await signedPayment(job))
    expect([result.state, result.error]).toEqual(['complete', undefined])
    await assertLaunched(main, result)
    evidence.stale = { jobId: job.id, executions: await executions(result) }
  })

  test_('late duplicates, raw replays and altered bytes are refused; supply is unchanged', async () => {
    const L = layout(first, main.config)
    const before = await main.adapter.supply(first)
    for (const step of first.steps) await main.adapter.broadcast({ job: first, step }, step.prepared!)
    // The operator's own raw execute of the Robinhood credit reverts OperationDone.
    const credit = first.steps.find((s) => s.id === 'credit:robinhood')!
    const plan = JSON.parse(credit.prepared!.bytes) as { operation: Hex; calls: { target: Address; value: string; data: Hex }[] }
    const rawExecute = encodeFunctionData({ abi: executorAbi, functionName: 'execute', args: [plan.operation, credit.prepared!.digest, plan.calls.map((c) => ({ target: c.target, value: BigInt(c.value), data: c.data }))] })
    expect(await reverts('robinhood', operator.address, env.config.spokes.robinhood.executor, rawExecute)).toBe(true)
    // The VAA replayed straight to each spoke transceiver reverts.
    for (const spoke of ['base', 'robinhood'] as const) {
      const vaa = main.store.db.query<{ vaa: Hex }, [string]>('SELECT vaa FROM multispoke_vaas WHERE operation=?').get(hash([first.id, `debit:${spoke}`]))!.vaa
      expect(await reverts(spoke, operator.address, L.spokes[spoke].manager.transceiver, encodeFunctionData({ abi: transceiverAbi, functionName: 'receiveMessage', args: [vaa] }))).toBe(true)
    }
    // The payer's authorization replayed directly on USDC reverts.
    const a = first.payment!.authorization
    const { r, s, v } = parseSignature(first.payment!.signature)
    expect(await reverts('arc', sink, usdc, encodeFunctionData({ abi: usdcAbi, functionName: 'transferWithAuthorization', args: [a.from, a.to, BigInt(a.value), 0n, BigInt(a.validBefore), a.nonce, Number(v ?? 27n), r, s] }))).toBe(true)
    // Altered bytes: tampering is detected, and a re-signed plan for an executed operation is a conflict.
    const pool = first.steps.find((s) => s.id === 'pool:robinhood')!
    const tampered = { ...pool.prepared!, bytes: pool.prepared!.bytes.replace(recipient.slice(2), sink.slice(2).toLowerCase()) }
    expect(tampered.bytes).not.toBe(pool.prepared!.bytes)
    const altered = { ...tampered, digest: hash(tampered.bytes) }
    const codes: string[] = []
    for (const p of [tampered, altered]) {
      try { await main.adapter.observe({ job: first, step: pool }, p); codes.push('accepted') } catch (cause) { codes.push(cause instanceof LaunchError ? cause.code : String(cause).split('\n')[0].slice(0, 60)) }
    }
    expect(codes).toEqual(['Error: Prepared bytes changed', 'operation_conflict'])
    expect(json(await main.adapter.supply(first))).toEqual(json(before))
    expect(await executions(first)).toEqual(once(first))
    evidence.replays = { rawExecute: 'reverted', vaaReplay: 'reverted', authorizationReplay: 'reverted', alteredBytes: codes }
  })

  test_('a failed payment charges nothing and issues nothing; after a top-up the same request recovers to one charge', async () => {
    const request = launchRequest('multispoke-recover-0001')
    const q = await postTo(main, request)
    const job = main.store.get(q.body.jobId!)!
    const header = await signedHeader(job)
    const funds = await balance('arc', usdc, payerKey.address)
    await payerTo(0n)
    const failedReply = await postTo(main, request, header)
    const failed = main.store.get(job.id)!
    expect([failedReply.status, failedReply.body.error]).toEqual([503, 'reconciliation_required'])
    expect([failed.state, failed.steps[0].state, failed.sweep]).toEqual(['partial', 'prepared', 'blocked'])
    expect(await authorizationSpent(job)).toBe(false)
    expect(await hasCode('arc', layout(job, main.config).canonical)).toBe(false)
    expect(await executions(failed)).toEqual(Object.fromEntries(job.steps.map((s) => [s.id, 0])))
    await payerTo(funds)
    const recovered = await postTo(main, request, header)
    expect([recovered.status, recovered.body.state]).toEqual([200, 'complete'])
    const done = main.store.get(job.id)!
    expect(funds - await balance('arc', usdc, payerKey.address)).toBe(BigInt(done.total))
    await assertLaunched(main, done)
    evidence.recovery = { jobId: job.id, failed: { status: failedReply.status, error: failedReply.body.error, state: failed.state, error_: failed.error }, recovered: { status: recovered.status }, charged: done.total }
  })

  test_('one launch slot: a failed payment holds it until the authorization provably expires, then another launch proceeds', async () => {
    const scoped = journal('slot', { launches: 1 })
    const funds = await balance('arc', usdc, payerKey.address)
    try {
      const f = launchRequest('multispoke-slot-f001', 20)
      const fq = await postTo(scoped, f)
      const fJob = scoped.store.get(fq.body.jobId!)!
      const fHeader = await signedHeader(fJob)
      await payerTo(0n)
      const fReply = await postTo(scoped, f, fHeader)
      expect([fReply.status, fReply.body.error]).toEqual([503, 'reconciliation_required'])
      expect(scoped.adapter.slot(fJob.id)).toMatchObject({ settled: 0, released_reason: null })
      // While F's authorization could still settle, no other launch may even quote.
      await payerTo(funds)
      const blocked = await postTo(scoped, launchRequest('multispoke-slot-s001'))
      expect([blocked.status, blocked.body.error]).toEqual([409, 'launch_limit'])
      // F's authorization expires on chain; the next attempt proves it can never settle and releases the slot.
      await payerTo(0n)
      while (now() <= f.quote.expires) await sleep(500)
      // Fork artifact (as in #18): anvil's Arc clock can trail the wall clock. Chain time decides
      // expiry, so bring the next block up to the wall clock, never past it.
      const lag = BigInt(now()) - (await client('arc').getBlock()).timestamp
      if (lag > 0n) await client('arc').setNextBlockTimestamp({ timestamp: BigInt(now()) })
      await client('arc').mine({ blocks: 1 })
      evidence.arcClockLagSeconds = lag.toString()
      const released = await postTo(scoped, f, fHeader)
      expect([released.status, released.body.error]).toEqual([409, 'payment_failed'])
      expect(scoped.adapter.slot(fJob.id)).toMatchObject({ released_reason: 'authorization expired' })
      const releasedAgain = await postTo(scoped, f, fHeader)
      expect([releasedAgain.status, releasedAgain.body.error]).toEqual([409, 'payment_failed'])
      expect(await authorizationSpent(fJob)).toBe(false)
      await payerTo(funds)
      // The slot is free: a new request quotes, pays once and launches.
      const s = launchRequest('multispoke-slot-s002')
      const sq = await postTo(scoped, s)
      expect(sq.status).toBe(402)
      const sJob = scoped.store.get(sq.body.jobId!)!
      const sReply = await postTo(scoped, s, await signedHeader(sJob))
      expect([sReply.status, sReply.body.state]).toEqual([200, 'complete'])
      expect(funds - await balance('arc', usdc, payerKey.address)).toBe(BigInt(sJob.total))
      await assertLaunched(scoped, scoped.store.get(sJob.id)!)
      // F's expired authorization cannot be replayed on USDC, and a third launch is refused: the settled holder keeps the slot.
      const fPayment = await signedPayment(fJob)
      const a = fPayment.authorization
      const sig = parseSignature(fPayment.signature)
      expect(await reverts('arc', sink, usdc, encodeFunctionData({ abi: usdcAbi, functionName: 'transferWithAuthorization', args: [a.from, a.to, BigInt(a.value), 0n, BigInt(a.validBefore), a.nonce, Number(sig.v ?? 27n), sig.r, sig.s] }))).toBe(true)
      const third = await postTo(scoped, launchRequest('multispoke-slot-s003'))
      expect([third.status, third.body.error]).toEqual([409, 'launch_limit'])
      evidence.slot = { adapter: scoped.adapter.version, failedJob: fJob.id, heldRefusal: blocked.body.error, released: scoped.adapter.slot(fJob.id), releasedReplies: [released.body.error, releasedAgain.body.error],
        launched: sJob.id, charged: sJob.total, thirdRefusal: third.body.error }
    } finally {
      scoped.store.close()
      if (await balance('arc', usdc, payerKey.address) === 0n) await payerTo(funds)
    }
  })

  test_('with Robinhood confirmations required, every Robinhood step waits pending and completes without re-execution', async () => {
    const delayed = journal('finality', { spokes: { ...env.config.spokes, robinhood: { ...env.config.spokes.robinhood, confirmations: 3 } } })
    try {
      const job = quote(delayed.store, delayed.adapter, launchRequest('multispoke-final-0001'), now())
      let result = await runJob(delayed.store, delayed.adapter, job.id, await signedPayment(job))
      const waits: string[] = []
      for (let i = 0; i < 20 && result.state !== 'complete'; i++) {
        expect(result.state).toBe('partial')
        waits.push(result.error!.split(' ')[0])
        await client('robinhood').mine({ blocks: 3 })
        result = await runJob(delayed.store, delayed.adapter, job.id)
      }
      expect(result.state).toBe('complete')
      expect(waits).toEqual(['manager:robinhood', 'credit:robinhood', 'pool:robinhood'])
      await assertLaunched(delayed, result)
      evidence.finality = { robinhoodConfirmations: 3, pendingSteps: waits, executions: await executions(result, delayed.config) }
    } finally { delayed.store.close() }
  })

  // ---- Attribution, residuals, refunds and claims (carries #18 @ 22adede) on a fresh Arc executor
  // with 2 Arc confirmations, so every decision below is made under nonzero finality and the executor's
  // USDC reconciles exactly against this one journal.
  let attr: Journal
  let f1: { request: LaunchRequest; job: Job; header: string }
  let successor: Job
  const UNRELATED = 89_000_000n
  const mineArc = (blocks: number) => client('arc').mine({ blocks })
  /** Run a paid job to completion, mining Arc blocks while a step waits for its confirmations. */
  async function drive(j: Journal, id: Hex) {
    let job = j.store.get(id)!
    for (let i = 0; i < 40 && job.state !== 'complete'; i++) {
      await mineArc(2)
      job = await runJob(j.store, j.adapter, id)
    }
    return job
  }
  async function directAuthorization(job: Job, terms: { to: Address; value: bigint }) {
    await client('arc').setBalance({ address: payerKey.address, value: 10n ** 20n })
    const message = { from: payerKey.address, to: terms.to, value: terms.value, validAfter: 0n, validBefore: BigInt(job.request.quote.expires), nonce: job.id }
    const signature = await payerKey.signTypedData({ domain: paymentDomain(job), types: AUTHORIZATION_TYPES, primaryType: 'TransferWithAuthorization', message })
    const { r, s, v } = parseSignature(signature)
    const wallet = createWalletClient({ account: payerKey, transport: http(env.urls.arc) })
    const receipt = await client('arc').waitForTransactionReceipt({ hash: await wallet.writeContract({ account: payerKey, chain: null, address: usdc, abi: usdcAbi, functionName: 'transferWithAuthorization',
      args: [message.from, message.to, message.value, 0n, message.validBefore, message.nonce, Number(v ?? 27n), r, s] }) })
    expect(receipt.status).toBe('success')
    return receipt
  }
  const refundExecutions = async (job: Job) => (await client('arc').getLogs({ address: attr.config.arc.executor, event: executorAbi.find((x) => x.type === 'event' && x.name === 'Executed')!, args: { operation: hash([job.id, 'refund:arc']) }, fromBlock: attr.config.arc.fromBlock })).length

  test_('an unrelated USDC transfer to the executor is never attributed to a held job', async () => {
    const infra = await deployInfrastructure(env.urls.arc, DEV.operator, null)
    attr = journal('attr', { arc: { ...env.config.arc, ...infra, confirmations: 2 } })
    await attr.adapter.verify()
    const funds = await balance('arc', usdc, payerKey.address)
    f1 = { request: launchRequest('multispoke-attr-f001', 200), job: undefined as unknown as Job, header: '' }
    const q = await postTo(attr, f1.request)
    f1.job = attr.store.get(q.body.jobId!)!
    f1.header = await signedHeader(f1.job)
    await payerTo(0n)
    const first = await postTo(attr, f1.request, f1.header)
    expect([first.status, first.body.error]).toEqual([503, 'reconciliation_required'])
    // A stranger sends exactly the quoted amount straight to the executor. It is not this job's payment.
    const minter = createWalletClient({ account: operator, transport: http(env.urls.arc) })
    await client('arc').waitForTransactionReceipt({ hash: await minter.writeContract({ account: operator, chain: null, address: usdc, abi: usdcAbi, functionName: 'mint', args: [sink, UNRELATED] }) })
    await client('arc').setBalance({ address: sink, value: 10n ** 20n })
    const stranger = createWalletClient({ account: privateKeyToAccount(SINK_KEY), transport: http(env.urls.arc) })
    const unrelated = await client('arc').waitForTransactionReceipt({ hash: await stranger.writeContract({ account: privateKeyToAccount(SINK_KEY), chain: null, address: usdc, abi: erc20Abi, functionName: 'transfer', args: [infra.executor, UNRELATED] }) })
    await mineArc(3)
    const again = await postTo(attr, f1.request, f1.header)
    expect([again.status, again.body.error]).toEqual([503, 'reconciliation_required'])
    expect(attr.adapter.slot(f1.job.id)).toMatchObject({ released_reason: null, settled: 0 })
    expect(attr.adapter.ledger(f1.job.id)).toBeUndefined()
    const usdcView = await attr.adapter.executorUsdc()
    expect(json(usdcView) as object).toMatchObject(json({ balance: UNRELATED, jobs: 0n, residualsOwed: 0n, operatorSends: 0n, unattributed: UNRELATED }) as object)
    await payerTo(funds)
    evidence.unrelatedReceipt = { executor: infra.executor, job: f1.job.id, unrelatedTx: unrelated.transactionHash, held: attr.adapter.slot(f1.job.id), executorUsdc: usdcView }
  })

  test_('a nonce spent outside the job is attributed to the original job only once final; its residual is isolated from the successor and operator', async () => {
    const payerBefore = await balance('arc', usdc, payerKey.address)
    const spend = await directAuthorization(f1.job, { to: attr.config.arc.executor, value: BigInt(f1.job.total) })
    expect(payerBefore - await balance('arc', usdc, payerKey.address)).toBe(BigInt(f1.job.total))
    // Not yet 2 blocks deep: still held, nothing attributed.
    const shallow = await postTo(attr, f1.request, f1.header)
    expect(shallow.status).toBe(503)
    expect(attr.adapter.ledger(f1.job.id)).toBeUndefined()
    await mineArc(2)
    const released = await postTo(attr, f1.request, f1.header)
    expect([released.status, released.body.error]).toEqual([409, 'payment_failed'])
    const ledger = attr.adapter.ledger(f1.job.id)!
    expect(ledger).toMatchObject({ outcome: 'used_outside_job', authorized: f1.job.total, received: f1.job.total, residual: f1.job.total, fees_spent: '0', evidence_tx: spend.transactionHash, refund: 'owed' })
    expect(attr.adapter.explain(f1.job.id)).toContain('refund owed')
    const view = attr.adapter.view(attr.store.get(f1.job.id)!) as { funds: Record<string, unknown>; attribution: { refund: { state: string } } }
    expect(view.funds).toMatchObject({ paid: f1.job.total, heldForPayer: f1.job.total, refundable: true, refundableAmount: f1.job.total })
    expect(view.attribution.refund.state).toBe('owed')
    // Permanent: a repeat is refused with the same attribution.
    const repeat = await postTo(attr, f1.request, f1.header)
    expect([repeat.status, repeat.body.error]).toEqual([409, 'payment_failed'])
    // A successor launches with its own payment; the residual is untouched.
    const s = launchRequest('multispoke-attr-s001')
    const sq = await postTo(attr, s)
    successor = attr.store.get(sq.body.jobId!)!
    const paid = await postTo(attr, s, await signedHeader(successor))
    expect(paid.status).toBe(202)
    successor = await drive(attr, successor.id)
    expect(successor.state).toBe('complete')
    await assertLaunched(attr, successor)
    const account = attr.adapter.usdcAccount(successor)!
    expect(json(account) as object).toMatchObject(json({ inflow: 89_000_000n, usdcSpent: { arcPool: 10_000_000n }, held: 79_000_000n, spokeQuoteInjected: { base: 10_000_000n, robinhood: 10_000_000n },
      disposition: { platformFee: 1_000_000n, spokeQuoteReserve: 20_000_000n, stepBudgets: 58_000_000n }, reconciled: true }) as object)
    expect(account.disposition.operatorReimbursable).toBeGreaterThan(0n)
    const sv = attr.adapter.view(successor) as { funds: Record<string, unknown> }
    expect(sv.funds).toMatchObject({ quoteInventoryDeployed: '10000000', heldOnExecutor: '79000000', spokeQuoteInjected: { base: '10000000', robinhood: '10000000' }, feesSpent: '0', reconciled: true })
    await mineArc(2)
    const usdcView = await attr.adapter.executorUsdc()
    expect(json(usdcView) as object).toMatchObject(json({ balance: UNRELATED + 89_000_000n + 79_000_000n, jobs: 79_000_000n, residualsOwed: 89_000_000n, unattributed: UNRELATED }) as object)
    // An operator send that would reach into the residual is refused before anything is sent; one within the unowed balance is allowed.
    const spendable = usdcView.balance - usdcView.residualsOwed
    const greedy = await attr.adapter.operatorSend('greedy-1', sink, spendable + 1n).then(() => 'sent', (e: unknown) => (e instanceof LaunchError ? e.code : String(e)))
    expect(greedy).toBe('residual_reserved')
    expect(attr.adapter.ledger(f1.job.id)!.refund).toBe('owed')
    evidence.attribution = { job: f1.job.id, spendTx: spend.transactionHash, ledger, view: view.funds, successor: successor.id, successorUsdc: account, executorUsdc: usdcView, greedy }
  })

  test_('a refund killed after send is resumed once, stays held until final, and cannot be replayed', async () => {
    const payerBefore = await balance('arc', usdc, payerKey.address)
    const killed = await worker(attr, f1.job.id, 'refund', `kill-after-send:refund:${f1.job.id}`)
    expect(killed.signal).toBe('SIGKILL')
    // Restart: the journal knows a refund is prepared but not its outcome; the residual stays reserved.
    expect(attr.adapter.refundStatus(f1.job.id)!.state).toBe('prepared')
    expect(attr.adapter.ledger(f1.job.id)!.refund).toBe('owed')
    // Resume. Until the killed worker's execution is in a committed block with its receipt, the ledger truthfully stays 'owed'.
    let submitted = await attr.adapter.refund(f1.job.id)
    for (let i = 0; i < 20 && submitted.refund === 'owed'; i++) { await sleep(250); submitted = await attr.adapter.refund(f1.job.id) }
    expect(submitted.refund).toBe('submitted')
    expect(attr.adapter.explain(f1.job.id)).toContain('not yet final')
    await mineArc(2)
    const done = await attr.adapter.refund(f1.job.id)
    expect(done).toMatchObject({ refund: 'refunded', refund_tx: submitted.refund_tx })
    expect(await balance('arc', usdc, payerKey.address) - payerBefore).toBe(BigInt(f1.job.total))
    expect(await refundExecutions(f1.job)).toBe(1)
    // Replays: the adapter returns the final ledger; the operator's raw execute reverts.
    expect((await attr.adapter.refund(f1.job.id)).refund_tx).toBe(done.refund_tx)
    const op = attr.store.db.query<{ bytes: string; digest: Hex }, [string]>('SELECT bytes, digest FROM multispoke_ops WHERE operation=?').get(hash([f1.job.id, 'refund:arc']))!
    const plan = JSON.parse(op.bytes) as { operation: Hex; calls: { target: Address; value: string; data: Hex }[] }
    expect(await reverts('arc', operator.address, attr.config.arc.executor, encodeFunctionData({ abi: executorAbi, functionName: 'execute', args: [plan.operation, op.digest, plan.calls.map((c) => ({ target: c.target, value: BigInt(c.value), data: c.data }))] }))).toBe(true)
    expect(await refundExecutions(f1.job)).toBe(1)
    const view = attr.adapter.view(attr.store.get(f1.job.id)!) as { funds: Record<string, unknown> }
    expect(view.funds).toMatchObject({ paid: f1.job.total, heldForPayer: '0', refundable: false, refundableAmount: '0' })
    const usdcView = await attr.adapter.executorUsdc()
    expect(json(usdcView) as object).toMatchObject(json({ residualsOwed: 0n, jobs: 79_000_000n, unattributed: UNRELATED }) as object)
    evidence.refund = { job: f1.job.id, killed: killed.signal, submitted: submitted.refund, final: done, executions: await refundExecutions(f1.job), view: view.funds, executorUsdc: usdcView }
  })

  test_('an authorization with other terms under the job nonce is held for the payer, never counted as payment', async () => {
    const f2 = launchRequest('multispoke-attr-f002', 200)
    const q = await postTo(attr, f2)
    const job = attr.store.get(q.body.jobId!)!
    const spend = await directAuthorization(job, { to: attr.config.arc.executor, value: 50_000_000n })
    await mineArc(2)
    const reply = await postTo(attr, f2, await signedHeader(job))
    expect([reply.status, reply.body.error]).toEqual([409, 'payment_failed'])
    expect(attr.adapter.ledger(job.id)).toMatchObject({ outcome: 'spent_by_other_authorization', received: '50000000', residual: '50000000', evidence_tx: spend.transactionHash, refund: 'owed' })
    const view = attr.adapter.view(attr.store.get(job.id)!) as { funds: Record<string, unknown> }
    expect(view.funds).toMatchObject({ paid: '0', heldForPayer: '50000000', refundable: true })
    await attr.adapter.refund(job.id)
    await mineArc(2)
    expect((await attr.adapter.refund(job.id)).refund).toBe('refunded')
    evidence.otherTerms = { job: job.id, spendTx: spend.transactionHash, ledger: attr.adapter.ledger(job.id), view: view.funds }
  })

  test_('operator sends in two processes cannot together spend more than the unowed balance', async () => {
    await mineArc(2)
    const before = await attr.adapter.executorUsdc()
    expect(before.residualsOwed).toBe(0n)
    const each = before.balance / 2n + 1n
    const [a, b] = await Promise.all([worker(attr, '-', `operator:race-a:${sink}:${each}`), worker(attr, '-', `operator:race-b:${sink}:${each}`)])
    const outcomes = [lastLine(a.out), lastLine(b.out)]
    // Never both: each claim is committed before its check, so at least the later one sees the other.
    // Both may be refused when each sees the other's pending claim; that is the conservative outcome.
    expect(outcomes.filter((o) => o.ok).length).toBeLessThanOrEqual(1)
    for (const o of outcomes) if (!o.ok) expect(o.code).toBe('residual_reserved')
    let winner = outcomes[0].ok ? 'race-a' : outcomes[1].ok ? 'race-b' : null
    if (!winner) {
      // Neither was sent, so their claims were dropped; the same send alone now succeeds.
      expect(lastLine((await worker(attr, '-', `operator:race-a:${sink}:${each}`)).out).ok).toBe(true)
      winner = 'race-a'
    }
    // The same name with other parameters is a conflict, never a second transfer.

    const conflict = await attr.adapter.operatorSend(winner, sink, 1n).then(() => 'sent', (e: unknown) => (e instanceof LaunchError ? e.code : String(e)))
    expect(conflict).toBe('operation_conflict')
    await mineArc(2)
    const after = await attr.adapter.executorUsdc()
    expect(json(after) as object).toMatchObject(json({ balance: before.balance - each, operatorSends: each, residualsOwed: 0n, unattributed: UNRELATED }) as object)
    evidence.operatorRace = { each, outcomes, conflict, before, after }
  })

  test_('the public record shows labels and chain-read supply for every job', async () => {
    service = await startService(main)
    const r = await fetch(`${SERVICE}/api/equilibrium`)
    const body = await r.json() as { labels: { environment: string; publicRobinhoodRoute: string }; jobs: { id: string; state: string; chainSupply: { reconciled: boolean } }[] }
    expect(body.labels.environment).toBe('mixed:arc-testnet-fork+base-sepolia-fork+robinhood-mainnet-fork')
    expect(body.labels.publicRobinhoodRoute).toBe('closed')
    const complete = body.jobs.filter((j) => j.state === 'complete')
    expect(complete.length).toBe(4)
    for (const j of complete) expect(j.chainSupply.reconciled).toBe(true)
    evidence.publicRecord = { labels: body.labels, jobs: body.jobs.map((j) => ({ id: j.id, state: j.state, reconciled: j.chainSupply.reconciled })) }
    await stopService()
  })
})
