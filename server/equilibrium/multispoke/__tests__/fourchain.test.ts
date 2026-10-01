/**
 * FOUR-CHAIN COMPOSED REHEARSAL (49TH-44): ONE x402-paid launch job, ONE canonical issuance on an
 * Arc testnet fork, ONE Arc locking hub peered to a Base Sepolia fork, a Robinhood mainnet fork and
 * the pinned SVM NTT programs on a local Solana validator. Everything a single job has to survive is
 * exercised on that one job, because the pinned SVM manager holds one config per program and so one
 * mint per validator: a second job could not have its own Solana leg here.
 *
 *   EQUILIBRIUM_FOURCHAIN=1 bun test server/equilibrium/multispoke/__tests__/fourchain.test.ts
 *
 * Needs the pinned SVM programs (bun run equilibrium:solana:build) and network access to fork Arc
 * testnet, Base Sepolia and Robinhood mainnet. Evidence: output/equilibrium/fourchain-evidence.json.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Connection, PublicKey } from '@solana/web3.js'
import { createTestClient, encodeFunctionData, http, parseSignature, publicActions, type Address, type Hex } from 'viem'
import { reviewReleaseBoundary, seedDifferences } from '../../../../src/lib/equilibriumArcSolana'
import { SOLANA_NTT, TOKEN_PROGRAM } from '../../../../src/lib/equilibriumSolana'
import { clockShiftEnvironment, prepareClockShift } from '../../../../scripts/solana/clockShift'
import { readChainClock, refusalReason, send } from '../../../../scripts/solana/localValidator'
import { associatedTokenAddress, readMint, readTokenBalance } from '../../../../scripts/solana/splToken'
import { dumpSpokeLedger, readSeeded, writeSeedDirectory } from '../../../../scripts/solana/spokeSeed'
import { erc20Abi, executorAbi, usdcAbi } from '../../evm/contracts'
import { PINNED } from '../../evm/fork'
import { payer as payerKey, signedHeader } from '../../evm/__tests__/harness'
import { hash } from '../../request'
import { publicJob, reconcile } from '../../runner'
import { createLaunchService } from '../../service'
import { JobStore } from '../../store'
import type { Job, LaunchRequest } from '../../types'
import { layout, laneOf, multispokeAdapter, type MultispokeAdapter, type Side } from '../adapter'
import { FOURCHAIN_PORTS, SVM_DEPLOY, configToJson, fourChainEnvironment, restartSolanaSpoke, type FourChainEnvironment } from '../fourchain'
import { SPOKE_PROGRAMS, spokeOf } from '../solana'

const enabled = process.env.EQUILIBRIUM_FOURCHAIN === '1'
const suite = enabled ? describe : describe.skip
const test_ = (name: string, fn: () => Promise<void>) => test(name, fn, 900_000)
const ROOT = resolve(import.meta.dir, '../../../..')
const OUT = join(ROOT, 'output/equilibrium')
const recipient = '0x00000000000000000000000000000000000000a1' as Address
/** Any valid base58 key that is not the custody owner; the customer's Solana address. */
const SOLANA_RECIPIENT = new PublicKey(Buffer.alloc(32, 7)).toBase58()
const ISSUANCE = 1_000_000_000_000n
const ALLOCATION = { arc: 500_000_000_000n, base: 10_000_000_000n, solana: 30_000_000_000n, robinhood: 20_000_000_000n }
/** Below the Solana allocation, so the pinned spoke manager holds this launch's delivery for its 24-hour window. */
const SOLANA_INBOUND_LIMIT = 10_000_000_000n
const RATE_LIMIT_DURATION = 86_400
const DELAY_SLACK = 60

let env: FourChainEnvironment
let dir: string
let dbPath: string
let configPath: string
let store: JobStore
let adapter: MultispokeAdapter
let job: Job
let request: LaunchRequest
const evidence: Record<string, unknown> = {}
const ledgers: string[] = []
const json = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_, x: unknown) => (typeof x === 'bigint' ? x.toString() : x)))
const now = () => Math.floor(Date.now() / 1000)
const client = (side: Side) => createTestClient({ mode: 'anvil', transport: http(env.urls[side]) }).extend(publicActions)
const balance = (side: Side, token: Address, owner: Address) => client(side).readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
const usdc = PINNED.arc.usdc
const solanaConnection = (): Connection => env.config.solana!.infrastructure.connection
const lamports = () => solanaConnection().getBalance(env.config.solana!.infrastructure.payer.publicKey, 'confirmed').then(BigInt)
const step = (j: Job, id: string) => j.steps.find((s) => s.id === id)!
const states = (j: Job) => Object.fromEntries(j.steps.map((s) => [s.id, s.state]))

function launchRequest(requestId: string): LaunchRequest {
  return { requestId, payer: payerKey.address.toLowerCase() as Address,
    canonical: { chain: 'arc', name: 'Equilibrium', symbol: 'EQL', decimals: 6, issuance: ISSUANCE.toString(), recipient },
    destinations: [
      { chain: 'arc', recipient, amount: ALLOCATION.arc.toString(), poolTokens: '5000000000', poolQuote: '10000000' },
      { chain: 'base', recipient, amount: ALLOCATION.base.toString(), poolTokens: '5000000000', poolQuote: '10000000' },
      { chain: 'solana', recipient: SOLANA_RECIPIENT, amount: ALLOCATION.solana.toString(), poolTokens: '5000000000', poolQuote: '10000000' },
      { chain: 'robinhood', recipient, amount: ALLOCATION.robinhood.toString(), poolTokens: '5000000000', poolQuote: '10000000' },
    ], quote: { expires: now() + 280, costCap: '150000000' } }
}

type Reply = { status: number; headers: Headers; body: Record<string, unknown> & { error?: string; jobId?: Hex; total?: string } }
async function post(body: unknown, payment?: string): Promise<Reply> {
  const r = await createLaunchService(store, adapter)(new Request('http://fourchain/x402/equilibrium', { method: 'POST', body: JSON.stringify(body), headers: payment ? { 'payment-signature': payment } : {} }))
  return { status: r.status, headers: r.headers, body: await r.json() as Reply['body'] }
}

/** How many times each EVM step's operation executed on its chain. Every value must be 1 once a step is complete. */
async function executions(j: Job) {
  const out: Record<string, number> = {}
  for (const s of j.steps) {
    const lane = laneOf(s)
    if (lane === 'solana') continue
    const c = lane === 'arc' ? env.config.arc : env.config.spokes[lane]
    const logs = await client(lane).getLogs({ address: c.executor, event: executorAbi.find((x) => x.type === 'event' && x.name === 'Executed')!, args: { operation: hash([j.id, s.id]) }, fromBlock: c.fromBlock })
    out[s.id] = logs.length
  }
  return out
}
async function awaitFinalizedAccount(address: PublicKey, seconds = 120) {
  const deadline = Date.now() + seconds * 1000
  while (!await solanaConnection().getAccountInfo(address, 'finalized')) {
    if (Date.now() > deadline) throw new Error(`${address.toBase58()} was not finalized on the local validator.`)
    await new Promise((wait) => setTimeout(wait, 400))
  }
}
/** Close and reopen the journal, as a restarted service would: a new store, a new adapter, nothing in memory. */
function reopen() {
  store.close()
  store = new JobStore(dbPath, { leaseMs: 3000 })
  adapter = multispokeAdapter(env.config, store.db)
}
async function supply(j: Job) { return json(await adapter.supply(j)) as Record<string, unknown> & { reconciled: boolean } }

suite('EQUILIBRIUM one paid launch job across Arc, Base, Solana and Robinhood', () => {
  beforeAll(async () => {
    for (const program of ['example_native_token_transfers.so', 'ntt_transceiver.so']) {
      if (!existsSync(join(SVM_DEPLOY, program))) throw new Error(`Missing ${program}. Build the pinned SVM programs first: bun run equilibrium:solana:build`)
    }
    const started = Date.now()
    mkdirSync(OUT, { recursive: true })
    env = await fourChainEnvironment({ solanaInboundLimit: SOLANA_INBOUND_LIMIT })
    dir = mkdtempSync(join(OUT, 'fourchain-journal-'))
    dbPath = join(dir, 'jobs.sqlite')
    configPath = join(dir, 'fourchain.json')
    writeFileSync(configPath, configToJson(env.config, env.guardianSets), { mode: 0o600 })
    store = new JobStore(dbPath, { leaseMs: 3000 })
    adapter = multispokeAdapter(env.config, store.db)
    await adapter.verify()
    Object.assign(evidence, { labels: env.config.labels, adapter: adapter.version, ports: FOURCHAIN_PORTS, journal: dir,
      forks: { arc: { chainId: env.config.arc.chainId, block: PINNED.arc.block.toString(), note: 'Arc TESTNET fork' },
        base: { chainId: env.config.spokes.base.chainId, block: PINNED.base.block.toString(), note: 'Base SEPOLIA fork' },
        robinhood: { chainId: env.config.spokes.robinhood.chainId, block: env.robinhood.block.toString(), note: 'Robinhood MAINNET fork, reached through a loopback proxy', pins: env.robinhood.pins },
        solana: { note: 'local solana-test-validator with the pinned SVM NTT programs and the mainnet core bridge binary; one development guardian key', svmCommit: SOLANA_NTT.commit, rpcPort: FOURCHAIN_PORTS.solana } },
      executors: { arc: env.config.arc.executor, base: env.config.spokes.base.executor, robinhood: env.config.spokes.robinhood.executor },
      solanaCustodyOwner: env.config.solana!.infrastructure.payer.publicKey.toBase58(), solanaQuoteMint: env.config.solana!.infrastructure.quoteMint.toBase58(),
      solanaInboundLimit: SOLANA_INBOUND_LIMIT, guardianSets: env.guardianSets, setupSeconds: (Date.now() - started) / 1000, checkpoints: [] })
  }, 900_000)
  afterAll(() => {
    store?.close()
    env?.stop()
    if (enabled) writeFileSync(join(OUT, 'fourchain-evidence.json'), JSON.stringify(json(evidence), null, 2) + '\n')
  })
  const checkpoint = (name: string, detail: unknown) => (evidence.checkpoints as unknown[]).push({ name, at: new Date().toISOString(), detail: json(detail) })

  test_('the quote binds the four chains to one payment; conflicting and three-chain requests are refused before any charge', async () => {
    request = launchRequest('fourchain-launch-0001')
    const payerBefore = await balance('arc', usdc, payerKey.address)
    const q = await post(request)
    expect(q.status).toBe(402)
    expect(q.headers.get('payment-required')).toBeTruthy()
    job = store.get(q.body.jobId!)!
    expect(job.steps.map((s) => s.id)).toEqual(['payment:arc', 'canonical:arc', 'manager:arc', 'pool:arc',
      'manager:base', 'debit:base', 'credit:base', 'pool:base', 'manager:solana', 'debit:solana', 'credit:solana', 'pool:solana',
      'manager:robinhood', 'debit:robinhood', 'credit:robinhood', 'pool:robinhood'])
    const again = await post(request)
    expect([again.status, again.body.jobId]).toEqual([402, job.id])
    const conflict = await post({ ...request, destinations: request.destinations.map((d) => (d.chain === 'solana' ? { ...d, amount: '30000000001' } : d)) })
    const threeChain = await post({ ...launchRequest('fourchain-launch-0002'), destinations: request.destinations.filter((d) => d.chain !== 'solana') })
    expect([conflict.status, conflict.body.error]).toEqual([409, 'identity_conflict'])
    expect([threeChain.status, threeChain.body.error]).toEqual([503, 'route_closed'])
    expect(await balance('arc', usdc, payerKey.address)).toBe(payerBefore)
    checkpoint('quote and refusals', { jobId: job.id, total: job.total, sameQuoteOnRetry: again.body.jobId === job.id, conflict: conflict.body.error, threeChain: threeChain.body.error, charged: '0' })
  })

  test_('paid once: Base completes while Solana holds a queued claim and Robinhood is unreachable; payment is inspectable apart from fulfillment', async () => {
    env.robinhoodProxy.close()
    const payerBefore = await balance('arc', usdc, payerKey.address)
    const lamportsBefore = await lamports()
    const paid = await post(request, await signedHeader(job))
    expect(paid.status).toBe(202)
    expect(paid.headers.get('payment-response')).toBeTruthy()
    job = store.get(job.id)!
    expect(job.state).toBe('partial')
    expect(job.settlement?.amount).toBe(job.total)
    expect(payerBefore - await balance('arc', usdc, payerKey.address)).toBe(BigInt(job.total))
    for (const id of ['payment:arc', 'canonical:arc', 'manager:arc', 'pool:arc', 'manager:base', 'debit:base', 'credit:base', 'pool:base', 'manager:solana', 'debit:solana']) expect(step(job, id).state).toBe('complete')
    expect(step(job, 'credit:solana').state).toBe('prepared')
    expect(step(job, 'pool:solana').state).toBe('planned')
    for (const id of ['manager:robinhood', 'debit:robinhood', 'credit:robinhood', 'pool:robinhood']) expect(step(job, id).state).toBe('planned')
    const claim = step(job, 'credit:solana').claim!
    expect(claim.amount).toBe(ALLOCATION.solana.toString())
    expect(claim.recipient).toBe(env.config.solana!.infrastructure.payer.publicKey.toBase58())
    const atQueue = reviewReleaseBoundary({ queueClock: BigInt(claim.observedClock), releaseAfter: BigInt(claim.releaseAfter), observedClock: BigInt(claim.observedClock), duration: RATE_LIMIT_DURATION, slack: DELAY_SLACK })
    expect(atQueue.matchesDuration).toBe(true)
    expect(atQueue.releasable).toBe(false)
    expect(job.error).toContain('credit:solana holds a claim')
    expect(job.error).toContain('manager:robinhood could not reach its chain')
    expect(job.sweep).toBe('eligible')
    const record = publicJob(job)
    expect(record.payment.settled).toBe(true)
    expect(record.payment.fulfillment).toBe('incomplete')
    expect(record.supply.queued).toBe(ALLOCATION.solana.toString())
    // Robinhood is reachable again only for the observation: supply is read from all four chains.
    env.robinhoodProxy.open()
    const s = await supply(job)
    expect(s.reconciled).toBe(true)
    expect(s.spokes).toEqual({ base: ALLOCATION.base.toString(), robinhood: '0', solana: '0' })
    expect(s.inFlight).toEqual({ base: '0', robinhood: '0', solana: ALLOCATION.solana.toString() })
    expect(s.queued).toBe(ALLOCATION.solana.toString())
    expect(s.custody).toBe((ALLOCATION.base + ALLOCATION.solana).toString())
    env.robinhoodProxy.close()
    checkpoint('paid, partially fulfilled', { states: states(job), settlement: job.settlement, error: job.error, claim, programDelay: atQueue.programDelay, supply: s, record: { payment: record.payment, funds: record.funds, claims: record.claims }, lamportsSpent: lamportsBefore - await lamports() })
  })

  test_('the early release of the Solana claim is refused by the pinned manager; the sweep holds it and still cannot reach Robinhood', async () => {
    const claim = step(job, 'credit:solana').claim!
    const spoke = spokeOf(job)
    const infra = env.config.solana!.infrastructure
    let early = 'accepted, which it must not be'
    try {
      await send(solanaConnection(), infra.payer, [spoke.releaseInboundMint(infra.payer.publicKey, Buffer.from(claim.reference.slice(2), 'hex'), associatedTokenAddress(spoke.mint, infra.payer.publicKey), true)])
    } catch (error) { early = refusalReason(error) }
    expect(early.startsWith('accepted')).toBe(false)
    expect((await readMint(solanaConnection(), spoke.mint)).supply).toBe(0n)
    reopen()
    const swept = await reconcile(store, adapter, Date.now, 5)
    job = store.get(job.id)!
    expect(job.state).toBe('partial')
    expect(step(job, 'credit:solana').claim!.queuedAt).toBe(claim.queuedAt)
    expect(step(job, 'manager:robinhood').state).toBe('planned')
    checkpoint('early release refused, sweep holds', { refusal: early, swept, error: job.error })
  })

  test_('Robinhood returns; a worker killed right after sending the irreversible Robinhood credit is finished by a restart without a second credit', async () => {
    env.robinhoodProxy.open()
    store.close()
    const worker = spawn('bun', ['run', join(import.meta.dir, 'fourchain-worker.ts'), configPath, dbPath, job.id, 'kill-after-send:credit:robinhood'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    worker.stdout.on('data', (d) => { out += d })
    worker.stderr.on('data', (d) => { out += d })
    const death = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => worker.on('exit', (code, signal) => done({ code, signal })))
    expect(death.signal).toBe('SIGKILL')
    store = new JobStore(dbPath, { leaseMs: 3000 })
    adapter = multispokeAdapter(env.config, store.db)
    const killed = store.get(job.id)!
    expect(step(killed, 'credit:robinhood').state).toBe('prepared')
    const L = layout(killed, env.config)
    // The credit is on chain although nothing recorded it: executed once, minted to the spoke executor.
    expect(await client('robinhood').readContract({ address: env.config.spokes.robinhood.executor, abi: executorAbi, functionName: 'digestOf', args: [hash([job.id, 'credit:robinhood'])] })).toBe(step(killed, 'credit:robinhood').prepared!.digest)
    expect(await balance('robinhood', L.spokes.robinhood.token, env.config.spokes.robinhood.executor)).toBe(ALLOCATION.robinhood)
    const mid = await supply(killed)
    expect(mid.reconciled).toBe(true)
    // The killed worker still holds its 2-second lease; while it is live no other process may claim the job.
    expect(await reconcile(store, adapter, Date.now, 5)).toEqual([])
    await new Promise((done) => setTimeout(done, 2_500))
    reopen()
    const resumed = await reconcile(store, adapter, Date.now, 5)
    expect(resumed.map((x) => x.id)).toEqual([job.id])
    job = store.get(job.id)!
    for (const id of ['manager:robinhood', 'debit:robinhood', 'credit:robinhood', 'pool:robinhood']) expect(step(job, id).state).toBe('complete')
    expect(job.state).toBe('partial')
    expect(step(job, 'credit:solana').state).toBe('prepared')
    // The killed worker died before journalling its send, and the restart observed the execution instead
    // of sending again: no send of credit:robinhood is journalled at all, and it executed exactly once.
    const sends = store.db.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM multispoke_broadcasts WHERE operation=?').get(hash([job.id, 'credit:robinhood']))!.n
    expect(sends).toBe(0)
    expect(await client('robinhood').readContract({ address: L.spokes.robinhood.token, abi: erc20Abi, functionName: 'totalSupply' })).toBe(ALLOCATION.robinhood)
    const e = await executions(job)
    for (const s of job.steps.filter((x) => laneOf(x) !== 'solana' && x.state === 'complete')) expect(e[s.id]).toBe(1)
    checkpoint('restart after an irreversible credit', { worker: { ...death, output: out.slice(-400) }, stateWhenKilled: states(killed), supplyWhenKilled: mid, resumed, creditRobinhoodSends: sends, executions: e, states: states(job) })
  })

  test_('the Solana validator is SIGKILLed and reopened with the claim outstanding; the claim comes back unchanged', async () => {
    const claim = step(job, 'credit:solana').claim!
    const spoke = spokeOf(job)
    const inbox = spoke.at.inboxItem(Buffer.from(claim.reference.slice(2), 'hex'))
    await awaitFinalizedAccount(inbox)
    await restartSolanaSpoke(env.solana)
    reopen()
    await reconcile(store, adapter, Date.now, 5)
    job = store.get(job.id)!
    const after = step(job, 'credit:solana').claim!
    expect([after.reference, after.amount, after.recipient, after.releaseAfter, after.queuedAt]).toEqual([claim.reference, claim.amount, claim.recipient, claim.releaseAfter, claim.queuedAt])
    const s = await supply(job)
    expect(s.reconciled).toBe(true)
    expect(s.queued).toBe(ALLOCATION.solana.toString())
    checkpoint('spoke restart with claim outstanding', { claim: after, supply: s })
  })

  test_('after the 24-hour boundary the sweep releases the claim once and places the Solana inventory; the job completes', async () => {
    const shift = prepareClockShift()
    if (!shift.available) throw new Error(`The clock fixture is unavailable: ${shift.why}`)
    const claim = step(job, 'credit:solana').claim!
    const spoke = spokeOf(job)
    const inbox = spoke.at.inboxItem(Buffer.from(claim.reference.slice(2), 'hex'))
    await awaitFinalizedAccount(inbox)
    const dumped = await dumpSpokeLedger(solanaConnection(), [...SPOKE_PROGRAMS], [spoke.at.feeCollector])
    expect(dumped.some((a) => a.pubkey === inbox.toBase58())).toBe(true)
    const seed = mkdtempSync(join(OUT, 'fourchain-seed-'))
    writeSeedDirectory(seed, dumped)
    const advanced = mkdtempSync(join(tmpdir(), 'equilibrium-fourchain-advanced-'))
    ledgers.push(advanced)
    const advanceBy = RATE_LIMIT_DURATION + 60
    const infra = env.config.solana!.infrastructure
    await restartSolanaSpoke(env.solana, { seedDirectory: seed, ledger: advanced, environment: clockShiftEnvironment(shift, advanceBy), fund: [infra.payer, infra.admin] })
    const differences = seedDifferences(dumped, await readSeeded(solanaConnection(), dumped))
    expect(differences).toEqual([])
    const clock = await readChainClock(solanaConnection())
    const boundary = reviewReleaseBoundary({ queueClock: BigInt(claim.observedClock), releaseAfter: BigInt(claim.releaseAfter), observedClock: clock, duration: RATE_LIMIT_DURATION, slack: DELAY_SLACK })
    expect(boundary.releasable).toBe(true)
    const lamportsBefore = await lamports()
    reopen()
    const resumed = await reconcile(store, adapter, Date.now, 5)
    job = store.get(job.id)!
    expect(job.state).toBe('complete')
    expect(job.error).toBeUndefined()
    const released = step(job, 'credit:solana').claim!
    expect(released.releasedAt).toBeNumber()
    expect(released.queuedAt).toBe(claim.queuedAt)
    expect((await readMint(solanaConnection(), spoke.mint)).supply).toBe(ALLOCATION.solana)
    const holder = new PublicKey(step(job, 'pool:solana').result!.address!)
    expect(await readTokenBalance(solanaConnection(), associatedTokenAddress(spoke.mint, holder))).toBe(5_000_000_000n)
    expect(await readTokenBalance(solanaConnection(), associatedTokenAddress(infra.quoteMint, holder))).toBe(10_000_000n)
    expect(await readTokenBalance(solanaConnection(), associatedTokenAddress(spoke.mint, new PublicKey(SOLANA_RECIPIENT)))).toBe(ALLOCATION.solana - 5_000_000_000n)
    // Released once: the program refuses a second release of the same claim.
    let again = 'accepted, which it must not be'
    try { await send(solanaConnection(), infra.payer, [spoke.releaseInboundMint(infra.payer.publicKey, Buffer.from(claim.reference.slice(2), 'hex'), associatedTokenAddress(spoke.mint, infra.payer.publicKey), true)]) } catch (error) { again = refusalReason(error) }
    expect(again.startsWith('accepted')).toBe(false)
    expect((await readMint(solanaConnection(), spoke.mint)).supply).toBe(ALLOCATION.solana)
    checkpoint('boundary passed, released once, complete', { clockFixture: shift.label, advanceBy, seededAccounts: dumped.length, boundary, resumed, claim: released, secondRelease: again, lamportsSpent: lamportsBefore - await lamports(), states: states(job) })
  })

  test_('replays change nothing and the finished job reconciles supply, USDC and costs across all four chains', async () => {
    const payerBefore = await balance('arc', usdc, payerKey.address)
    const before = await executions(job)
    const replay = await post(request, await signedHeader(job))
    expect(replay.status).toBe(200)
    expect(store.get(job.id)!.settlement).toEqual(job.settlement)
    const conflict = await post({ ...request, destinations: request.destinations.map((d) => (d.chain === 'robinhood' ? { ...d, amount: '20000000001' } : d)) })
    expect(conflict.body.error).toBe('identity_conflict')
    // The settled authorization resubmitted straight to USDC is refused by the token.
    const a = job.payment!.authorization
    const { r, s: sig, v } = parseSignature(job.payment!.signature)
    let tokenReplay = 'accepted, which it must not be'
    try {
      await client('arc').call({ to: usdc, data: encodeFunctionData({ abi: usdcAbi, functionName: 'transferWithAuthorization', args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, Number(v ?? 27n), r, sig] }) })
    } catch (error) { tokenReplay = (error instanceof Error ? error.message : String(error)).split('\n')[0] }
    expect(tokenReplay.startsWith('accepted')).toBe(false)
    expect(await balance('arc', usdc, payerKey.address)).toBe(payerBefore)
    const after = await executions(job)
    expect(after).toEqual(before)
    for (const n of Object.values(after)) expect(n).toBe(1)

    const s = await supply(job)
    expect(s.reconciled).toBe(true)
    expect(s.issued).toBe(ISSUANCE.toString())
    expect(s.spokes).toEqual({ base: ALLOCATION.base.toString(), robinhood: ALLOCATION.robinhood.toString(), solana: ALLOCATION.solana.toString() })
    expect(s.inFlight).toEqual({ base: '0', robinhood: '0', solana: '0' })
    expect(s.queued).toBe('0')
    expect(s.custody).toBe((ALLOCATION.base + ALLOCATION.solana + ALLOCATION.robinhood).toString())
    const account = adapter.usdcAccount(job)!
    expect(account.reconciled).toBe(true)
    const executor = json(await adapter.executorUsdc()) as { unattributed: string }
    expect(executor.unattributed).toBe('0')
    const record = adapter.view(job)
    const L = layout(job, env.config)
    evidence.result = { jobId: job.id, total: job.total, settlement: job.settlement, record, supply: s, usdcAccount: account, executorUsdc: executor, executions: after,
      replay: { status: replay.status, conflict: conflict.body.error, tokenReplay },
      addresses: { canonical: L.canonical, hub: L.hub.proxy, hubTransceiver: L.hub.transceiver, baseSpoke: L.spokes.base.token, robinhoodSpoke: L.spokes.robinhood.token,
        solanaMint: spokeOf(job).mint.toBase58(), solanaManagerProgram: SOLANA_NTT.manager, solanaTokenProgram: TOKEN_PROGRAM.toBase58(),
        pools: Object.fromEntries(job.steps.filter((x) => x.kind === 'pool').map((x) => [x.id, x.result!.address])) },
      steps: Object.fromEntries(job.steps.map((x) => [x.id, { state: x.state, transaction: x.result?.transaction, costUsdcAtoms: x.result?.cost, budget: x.budget, claim: x.claim }])),
      obligations: {
        platformFee: account.disposition.platformFee, operatorGasReimbursable: account.disposition.operatorReimbursable, unspentStepBudget: account.disposition.unspentBudget,
        spokeQuoteReserve: account.disposition.spokeQuoteReserve, solanaOperatorLamportsMeasuredInProcess: account.solanaOperatorLamports?.measured ?? null,
        note: 'All held on the Arc executor and reported, not moved: operator gas is not reimbursed, the platform fee is not disbursed, the unspent budget is not refunded, and Solana fees (SOL) are not converted. Quote inventory is fixture liquidity and is not revenue.',
      } }
    checkpoint('replays and reconciliation', { executions: after, supply: s, reconciled: account.reconciled, unattributed: executor.unattributed })
  })
})
