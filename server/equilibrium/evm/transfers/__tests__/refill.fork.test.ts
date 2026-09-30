/**
 * FORK REHEARSAL of the CCTP V2 USDC quote-inventory refill against the pinned Arc testnet and Base
 * Sepolia forks. Opt-in because it starts two anvil forks from public RPCs:
 *
 *   EQUILIBRIUM_FORK=1 bun test server/equilibrium/evm/transfers/__tests__/refill.fork.test.ts
 *
 * Circle's deployed TokenMessengerV2, MessageTransmitterV2 and TokenMinterV2 run as deployed on both
 * forks, and Base Sepolia USDC is the real FiatToken. Substitutions: fork.ts's (local Guardian, Arc
 * USDC stand-in) and transfers/fork.ts's (one local CCTP attester; the Arc stand-in gains `burn`).
 * Unlike the launch suite, the Base executor starts with NO storage-funded USDC: the Base pool's
 * quote inventory arrives only through the refill, from USDC the launch payment left on Arc.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { concat, createTestClient, createWalletClient, encodeFunctionData, http, keccak256, numberToHex, publicActions, slice, type Address, type Hex } from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'
import { JobStore } from '../../../store'
import { quote, runJob } from '../../../runner'
import { hash } from '../../../request'
import type { Job } from '../../../types'
import { evmAdapter } from '../../adapter'
import { toFile } from '../../config'
import { erc20Abi, executorAbi } from '../../contracts'
import { DEV, PINNED, forkEnvironment, type ForkEnvironment } from '../../fork'
import { request, signedPayment } from '../../__tests__/harness'
import { CCTP_TESTNET, TESTNET_ATTESTERS, bytes32, localAttester, messageTransmitterAbi, parseMessage, tokenMessengerAbi, tokenMinterAbi } from '../cctp'
import { transferRoutes, type TransferSettings } from '../config'
import { FORK_ATTESTER_KEY, forkCctp } from '../fork'
import { refillRoute } from '../refill'
import { createTransfer, reconcileTransfers, runTransfer } from '../runner'
import { TransferStore } from '../store'
import type { RefillRequest, TransferRoute } from '../types'

const enabled = process.env.EQUILIBRIUM_FORK === '1'
const suite = enabled ? describe : describe.skip
const operator = privateKeyToAccount(DEV.operator)
const USDC = { arc: PINNED.arc.usdc, base: PINNED.base.usdc }
const settings: TransferSettings = { returns: { maxPerTransfer: '1' }, refill: { attestation: { kind: 'local-attester' }, maxPerTransfer: '20000000', maxTotal: '40000000' } }
const test_ = (name: string, fn: () => Promise<void>) => test(name, fn, 600_000)
const now = () => Math.floor(Date.now() / 1000)

let env: ForkEnvironment
let dir: string
let jobs: JobStore
let transfers: TransferStore
let routes: ReturnType<typeof transferRoutes>
let refill: TransferRoute<RefillRequest>
let launch: Job
const official: Record<string, unknown> = {}

function chain(name: 'arc' | 'base') {
  const url = env[name].url
  return { test: createTestClient({ mode: 'anvil', transport: http(url) }).extend(publicActions), wallet: createWalletClient({ account: operator, transport: http(url) }) }
}
const balance = (name: 'arc' | 'base', owner: Address) => chain(name).test.readContract({ address: USDC[name], abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
const supply = (name: 'arc' | 'base') => chain(name).test.readContract({ address: USDC[name], abi: erc20Abi, functionName: 'totalSupply' })
async function executions(name: 'arc' | 'base', operation: Hex) {
  return (await chain(name).test.getLogs({ address: env.config[name].executor, event: executorAbi.find((x) => x.type === 'event' && x.name === 'Executed')!, args: { operation }, fromBlock: PINNED[name].block })).length
}
const refillOf = (requestId: string, from: 'arc' | 'base', to: 'arc' | 'base', amount: string) => ({ kind: 'refill', requestId, from, to, amount, maxFee: '0' })
const attestationOf = (id: Hex) => jobs.db.query<{ message: string; attestation: string }, [string]>('SELECT message, attestation FROM evm_transfer_attestations WHERE transfer=?').get(id)!

suite('EQUILIBRIUM USDC quote refill over CCTP V2 on pinned testnet forks', () => {
  beforeAll(async () => {
    env = await forkEnvironment({ arcPort: 18565, basePort: 18566, baseUsdc: 0n })
    // Read Circle's deployment on the forks BEFORE any substitution: these are the pinned blocks' facts.
    for (const name of ['arc', 'base'] as const) {
      const c = CCTP_TESTNET[name]; const other = CCTP_TESTNET[name === 'arc' ? 'base' : 'arc']
      const { test } = chain(name)
      const readAny = test.readContract as unknown as (request: { address: Address; abi: readonly unknown[]; functionName: string; args: unknown[] }) => Promise<unknown>
      const read = async <T>(address: Address, abi: readonly unknown[], functionName: string, args: unknown[] = []) => (await readAny({ address, abi, functionName, args })) as T
      const attesters = await read<bigint>(c.messageTransmitter, messageTransmitterAbi, 'getNumEnabledAttesters')
      official[name] = {
        localDomain: await read(c.messageTransmitter, messageTransmitterAbi, 'localDomain'), version: await read(c.messageTransmitter, messageTransmitterAbi, 'version'),
        paused: await read(c.messageTransmitter, messageTransmitterAbi, 'paused'), threshold: await read(c.messageTransmitter, messageTransmitterAbi, 'signatureThreshold'),
        attesters: await Promise.all(Array.from({ length: Number(attesters) }, (_, i) => read<Address>(c.messageTransmitter, messageTransmitterAbi, 'getEnabledAttester', [BigInt(i)]))),
        transmitter: await read(c.tokenMessenger, tokenMessengerAbi, 'localMessageTransmitter'), minter: await read(c.tokenMessenger, tokenMessengerAbi, 'localMinter'),
        remoteMessenger: await read(c.tokenMessenger, tokenMessengerAbi, 'remoteTokenMessengers', [other.domain]),
        remoteUsdc: await read(c.tokenMinter, tokenMinterAbi, 'getLocalToken', [other.domain, bytes32(other.usdc)]),
        burnLimit: await read(c.tokenMinter, tokenMinterAbi, 'burnLimitsPerMessage', [c.usdc]),
      }
    }
    await forkCctp(env.arc.url, env.base.url)
    mkdirSync(join(process.cwd(), 'output'), { recursive: true })
    dir = mkdtempSync(join(process.cwd(), 'output', 'refill-'))
    jobs = new JobStore(join(dir, 'jobs.sqlite'), { leaseMs: 1000 })
    transfers = new TransferStore(jobs.db, 1000)
    routes = transferRoutes(env.config, settings, jobs.db, (id) => jobs.get(id), { EQUILIBRIUM_FORK_ATTESTER_KEY: FORK_ATTESTER_KEY })
    refill = routes.refill!
  }, 900_000)
  afterAll(() => { jobs?.close(); env?.stop(); if (dir) rmSync(dir, { recursive: true, force: true }) })

  test('Circle\'s CCTP V2 deployment at the pinned blocks is what the route pins', () => {
    for (const name of ['arc', 'base'] as const) {
      const c = CCTP_TESTNET[name]; const other = CCTP_TESTNET[name === 'arc' ? 'base' : 'arc']
      expect(official[name]).toMatchObject({ localDomain: c.domain, version: 1, paused: false, threshold: 2n, transmitter: c.messageTransmitter, minter: c.tokenMinter,
        remoteMessenger: bytes32(other.tokenMessenger), remoteUsdc: c.usdc, burnLimit: 10_000_000_000_000n })
      expect((official[name] as { attesters: string[] }).attesters.map((a) => a.toLowerCase()).sort()).toEqual(TESTNET_ATTESTERS.map((a) => a.toLowerCase()).sort())
    }
  })

  test_('without refilled inventory the launch stops at the Base pool, with nothing sent for it', async () => {
    const adapter = evmAdapter(env.config, jobs.db)
    const job = quote(jobs, adapter, request('refill-launch-01', now()), now())
    let failure: unknown; try { await runJob(jobs, adapter, job.id, await signedPayment(job)) } catch (cause) { failure = cause }
    expect(failure).toBeTruthy()
    launch = jobs.get(job.id)!
    expect(launch.steps.filter((s) => s.state !== 'complete').map((s) => s.id)).toEqual(['pool:base'])
    expect(await executions('base', hash([launch.id, 'pool:base']))).toBe(0)
    // The payment left 39 USDC on the Arc executor; the Arc pool took its 10. The Base pool's 10 is still on Arc.
    expect(await balance('arc', env.config.arc.executor)).toBe(29_000_000n)
    expect(await balance('base', env.config.base.executor)).toBe(0n)
  })

  test_('a refill burns Arc USDC, and only after the attested burn does Base mint the same amount to the Base executor, once', async () => {
    const [arcSupply, baseSupply] = [await supply('arc'), await supply('base')]
    const t = await createTransfer(transfers, refill, refillOf('refill-pool-quote', 'arc', 'base', launch.request.destinations[1].poolQuote), now())
    const done = await runTransfer(transfers, refill, t.id)
    expect([done.state, done.error]).toEqual(['complete', undefined])
    expect(done.steps.map((s) => [s.id, s.result!.amount])).toEqual([['burn:arc', '10000000'], ['mint:base', '10000000']])
    expect(await balance('base', env.config.base.executor)).toBe(10_000_000n)
    expect(await balance('arc', env.config.arc.executor)).toBe(19_000_000n)
    // Conservation across the rail: Arc supply fell by what Base supply rose.
    expect(arcSupply - await supply('arc')).toBe(10_000_000n)
    expect(await supply('base') - baseSupply).toBe(10_000_000n)
    const m = parseMessage(attestationOf(done.id).message as Hex)
    expect(m).toMatchObject({ sourceDomain: 26, destinationDomain: 6, minFinalityThreshold: 2000, finalityThresholdExecuted: 2000 })
    expect(m.destinationCaller).toBe(bytes32(env.config.base.executor))
    for (const s of done.steps) expect(await executions(s.chain, hash([done.id, s.id]))).toBe(1)
    // The same request resumes the same record and executes nothing new.
    expect((await createTransfer(transfers, refill, done.request, now())).id).toBe(done.id)
    expect((await runTransfer(transfers, refill, done.id)).state).toBe('complete')
    for (const s of done.steps) expect(await executions(s.chain, hash([done.id, s.id]))).toBe(1)
  })

  test_('the stalled launch resumes and seeds the Base pool from refilled inventory, every step once', async () => {
    const adapter = evmAdapter(env.config, jobs.db)
    const done = await runJob(jobs, adapter, launch.id)
    expect([done.state, done.error]).toEqual(['complete', undefined])
    const pool = done.steps.find((s) => s.id === 'pool:base')!.result!.address as Address
    expect(await balance('base', pool)).toBe(10_000_000n)
    expect(await balance('base', env.config.base.executor)).toBe(0n)
    for (const s of done.steps) expect(await executions(s.id.endsWith(':arc') || s.id.startsWith('debit') ? 'arc' : 'base', hash([done.id, s.id]))).toBe(1)
    launch = done
  })

  test_('the attested message cannot mint again, cannot be received by anyone but the Base executor, and forged or altered attestations fail', async () => {
    const t = transfers.byIdentity(hash(['refill', 'refill-pool-quote']))!
    const { message, attestation } = attestationOf(t.id) as { message: Hex; attestation: Hex }
    const { wallet, test } = chain('base')
    const before = await supply('base')
    const forged = await sign({ hash: keccak256(message), privateKey: DEV.payer })
    const altered = concat([slice(message, 0, 148 + 68), numberToHex(parseMessage(message).body.amount + 1n, { size: 32 }), slice(message, 148 + 100)])
    const viaExecutor = (op: string, m: Hex, a: Hex) => wallet.writeContract({ chain: null, address: env.config.base.executor, abi: executorAbi, functionName: 'execute', gas: 2_000_000n,
      args: [hash([op]), hash(op), [{ target: CCTP_TESTNET.base.messageTransmitter, value: 0n, data: encodeFunctionData({ abi: messageTransmitterAbi, functionName: 'receiveMessage', args: [m, a] }) }]] })
    const attempts: Hex[] = [
      await viaExecutor('refill-replay', message, attestation),
      await wallet.writeContract({ chain: null, address: CCTP_TESTNET.base.messageTransmitter, abi: messageTransmitterAbi, functionName: 'receiveMessage', args: [message, attestation], gas: 2_000_000n }),
      await viaExecutor('refill-forged', message, concat([forged.r, forged.s, numberToHex(Number(forged.v ?? 27n), { size: 1 })])),
      await viaExecutor('refill-altered', altered, attestation),
    ]
    for (const tx of attempts) expect((await test.waitForTransactionReceipt({ hash: tx })).status).toBe('reverted')
    expect(await supply('base')).toBe(before)
    // A fresh, correctly signed message to a different caller is still refused by the destination-caller check.
    const other = await localAttester(FORK_ATTESTER_KEY).attested({ sourceDomain: 26, transaction: hash('other'), message: concat([slice(message, 0, 12), `0x${'0'.repeat(64)}`, slice(message, 44)]) })
    const direct = await wallet.writeContract({ chain: null, address: CCTP_TESTNET.base.messageTransmitter, abi: messageTransmitterAbi, functionName: 'receiveMessage', args: [other!.message, other!.attestation], gas: 2_000_000n })
    expect((await test.waitForTransactionReceipt({ hash: direct })).status).toBe('reverted')
    expect(await supply('base')).toBe(before)
  })

  test_('a stale worker racing a live worker on the same prepared mint mints once', async () => {
    const t = await createTransfer(transfers, refill, refillOf('refill-race-0001', 'arc', 'base', '1000000'), now())
    const stale = transferRoutes(env.config, settings, jobs.db, (id) => jobs.get(id), { EQUILIBRIUM_FORK_ATTESTER_KEY: FORK_ATTESTER_KEY }).refill!
    const racing: TransferRoute<RefillRequest> = { ...refill, broadcast: async (x, step, effect) => {
      if (step.id !== 'mint:base') return refill.broadcast(x, step, effect)
      await Promise.all([refill.broadcast(x, step, effect), stale.broadcast(x, step, effect)])
    } }
    const before = await balance('base', env.config.base.executor)
    const done = await runTransfer(transfers, racing, t.id)
    expect(done.state).toBe('complete')
    expect(await executions('base', hash([done.id, 'mint:base']))).toBe(1)
    expect(await balance('base', env.config.base.executor) - before).toBe(1_000_000n)
  })

  test_('an unattested burn is pending, not absent: nothing is minted or re-burned until the attestation exists', async () => {
    let ready = false
    const real = localAttester(FORK_ATTESTER_KEY)
    const slow = refillRoute(env.config, { cctp: CCTP_TESTNET, attestation: { kind: 'iris', attested: async (burn) => (ready ? real.attested(burn) : null) }, maxPerTransfer: '20000000', maxTotal: '40000000' }, routes.sender, jobs.db)
    const t = await createTransfer(transfers, slow, refillOf('refill-slow-0001', 'arc', 'base', '1000000'), now())
    const first = await runTransfer(transfers, slow, t.id)
    expect([first.state, first.steps[0].state, first.steps[1].state]).toEqual(['partial', 'prepared', 'planned'])
    expect(await runTransfer(transfers, slow, t.id).then((x) => x.state)).toBe('partial')
    expect(await executions('arc', hash([t.id, 'burn:arc']))).toBe(1)
    ready = true
    const done = await runTransfer(transfers, slow, t.id)
    expect(done.state).toBe('complete')
    expect(await executions('arc', hash([t.id, 'burn:arc']))).toBe(1)
    expect(await executions('base', hash([t.id, 'mint:base']))).toBe(1)
  })

  for (const crash of ['after:burn:arc', 'before:mint:base', 'after:mint:base']) {
    test_(`a worker killed ${crash.replace(':', ' broadcast of ')} is finished by the sweep with every effect exactly once`, async () => {
      const t = await createTransfer(transfers, refill, refillOf(`refill-crash-${crash.replace(/:/g, '-')}`, 'arc', 'base', '1000000'), now())
      if (crash !== 'after:burn:arc') {
        const burnOnly: TransferRoute<RefillRequest> = { ...refill, prepare: async (x, s) => {
          if (s.id === 'mint:base') throw new Error('stop before the mint')
          return refill.prepare(x, s)
        } }
        await runTransfer(transfers, burnOnly, t.id).catch((cause) => expect(String(cause)).toContain('stop before the mint'))
        expect(transfers.get(t.id)!.steps.map((s) => s.state)).toEqual(['complete', 'planned'])
      }
      const configPath = join(dir, 'transfer-config.json')
      writeFileSync(configPath, JSON.stringify({ adapter: toFile(env.config, 0), settings }))
      const before = await balance('base', env.config.base.executor)
      const child = spawnSync('bun', ['run', 'server/equilibrium/evm/transfers/__tests__/crash-worker.ts', configPath, join(dir, 'jobs.sqlite'), 'refill', t.id, crash],
        { env: { ...process.env, EQUILIBRIUM_OPERATOR_KEY: DEV.operator, EQUILIBRIUM_FORK_GUARDIAN_KEY: DEV.guardian, EQUILIBRIUM_FORK_ATTESTER_KEY: FORK_ATTESTER_KEY }, encoding: 'utf8', timeout: 300_000 })
      expect([child.status, (child.stdout + child.stderr).slice(-1500)]).toEqual([crash.startsWith('before') ? 78 : 77, (child.stdout + child.stderr).slice(-1500)])
      expect(transfers.get(t.id)!.state).not.toBe('complete')
      await new Promise((r) => setTimeout(r, 1500)) // the dead worker's lease expires
      const swept = await reconcileTransfers(transfers, refill)
      // Only this transfer was unfinished; anything else left partial by an earlier test would show here.
      expect(swept.map((r) => [r.id, r.state])).toEqual([[t.id, 'complete']])
      const done = transfers.get(t.id)!
      for (const s of done.steps) expect(await executions(s.chain, hash([done.id, s.id]))).toBe(1)
      expect(await balance('base', env.config.base.executor) - before).toBe(1_000_000n)
    })
  }

  test_('the reverse rail works too: Base USDC burns and the Arc executor receives it', async () => {
    const [arcBefore, baseSupply] = [await balance('arc', env.config.arc.executor), await supply('base')]
    const t = await createTransfer(transfers, refill, refillOf('refill-back-0001', 'base', 'arc', '2000000'), now())
    const done = await runTransfer(transfers, refill, t.id)
    expect([done.state, done.error]).toEqual(['complete', undefined])
    expect(await balance('arc', env.config.arc.executor) - arcBefore).toBe(2_000_000n)
    expect(baseSupply - await supply('base')).toBe(2_000_000n)
    expect(parseMessage(attestationOf(done.id).message as Hex)).toMatchObject({ sourceDomain: 6, destinationDomain: 26 })
  })

  test_('caps, inventory and closed rails refuse before anything is sent; the cumulative cap holds across racing refills', async () => {
    const cases: [unknown, string][] = [
      [refillOf('refill-cap-0001', 'arc', 'base', '20000001'), 'capped at'],
      [refillOf('refill-inv-0001', 'base', 'arc', '19000000'), 'base executor holds'],
      [refillOf('refill-sol-0001', 'arc', 'solana' as 'base', '1'), '49TH-26'],
      [refillOf('refill-rh-00001', 'robinhood' as 'arc', 'base', '1'), 'stays closed'],
      [{ ...refillOf('refill-fee-0001', 'arc', 'base', '1'), maxFee: '1' }, 'zero-fee'],
      [refillOf('refill-pool-quote', 'arc', 'base', '1'), 'bound to a different request'],
    ]
    for (const [raw, message] of cases) {
      let error: unknown; try { await createTransfer(transfers, refill, raw, now()) } catch (cause) { error = cause }
      expect(String(error).toLowerCase()).toContain(message.toLowerCase())
    }
    // Two refills that each fit, but not together: both bind, only one reserves; the other sends nothing.
    const reserved = jobs.db.query<{ amount: string }, []>('SELECT amount FROM evm_refill_reservations').all().reduce((n, r) => n + BigInt(r.amount), 0n)
    const tight = refillRoute(env.config, { cctp: CCTP_TESTNET, attestation: localAttester(FORK_ATTESTER_KEY), maxPerTransfer: '20000000', maxTotal: (reserved + 2_000_000n).toString() }, routes.sender, jobs.db)
    const a = await createTransfer(transfers, tight, refillOf('refill-tight-001', 'arc', 'base', '1500000'), now())
    const b = await createTransfer(transfers, tight, refillOf('refill-tight-002', 'arc', 'base', '1500000'), now())
    expect((await runTransfer(transfers, tight, a.id)).state).toBe('complete')
    let refused: unknown; try { await runTransfer(transfers, tight, b.id) } catch (cause) { refused = cause }
    expect(String(refused)).toContain('exceed the approved')
    expect(await executions('arc', hash([b.id, 'burn:arc']))).toBe(0)
    expect(jobs.db.query('SELECT COUNT(*) AS n FROM evm_transfer_broadcasts WHERE operation=?').get(hash([b.id, 'burn:arc']))).toEqual({ n: 0 })
  })
})
