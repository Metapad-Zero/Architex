/**
 * FORK REHEARSAL of the Base→Arc return route against the pinned Arc testnet and Base Sepolia forks.
 * Opt-in because it starts two anvil forks from public RPCs:
 *
 *   EQUILIBRIUM_FORK=1 bun test server/equilibrium/evm/transfers/__tests__/returns.fork.test.ts
 *
 * The launch it returns from is a real fork launch through the frozen PR #12 adapter. Substitutions
 * are fork.ts's: one local Guardian key signs VAAs, Arc USDC is an EIP-3009 stand-in, Base quote
 * inventory is written to storage. Base finality is counted in confirmations so burns can be held
 * unfinalized on purpose.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestClient, createWalletClient, encodeFunctionData, http, publicActions, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { JobStore } from '../../../store'
import { quote, runJob } from '../../../runner'
import { hash } from '../../../request'
import type { Job } from '../../../types'
import { evmAdapter, layout } from '../../adapter'
import { toFile } from '../../config'
import { erc20Abi, executorAbi, nttAbi, transceiverAbi, universal } from '../../contracts'
import { DEV, PINNED, forkEnvironment, type ForkEnvironment } from '../../fork'
import { request, signedPayment } from '../../__tests__/harness'
import { transferRoutes, type TransferSettings } from '../config'
import { conservation } from '../returns'
import { createTransfer, publicTransfer, reconcileTransfers, runTransfer } from '../runner'
import { TransferStore } from '../store'
import type { ReturnRequest, Transfer, TransferRoute } from '../types'

const enabled = process.env.EQUILIBRIUM_FORK === '1'
const suite = enabled ? describe : describe.skip
/** anvil development key #3: the holder of the Base allocation in this rehearsal. */
const HOLDER_KEY = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as Hex
const holder = privateKeyToAccount(HOLDER_KEY)
const operator = privateKeyToAccount(DEV.operator)
const ARC_RECIPIENT = '0x00000000000000000000000000000000000000b2' as Address
const BASE_CONFIRMATIONS = 2
const settings: TransferSettings = { returns: { maxPerTransfer: '5000000000' } }
const test_ = (name: string, fn: () => Promise<void>) => test(name, fn, 600_000)
const now = () => Math.floor(Date.now() / 1000)

let env: ForkEnvironment
let dir: string
let jobs: JobStore
let transfers: TransferStore
let routes: ReturnType<typeof transferRoutes>
let launch: Job
let L: ReturnType<typeof layout>

function chain(name: 'arc' | 'base', key: Hex = DEV.operator) {
  const url = env[name].url
  return { test: createTestClient({ mode: 'anvil', transport: http(url) }).extend(publicActions), wallet: createWalletClient({ account: privateKeyToAccount(key), transport: http(url) }) }
}
const balance = (name: 'arc' | 'base', token: Address, owner: Address) => chain(name).test.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
const supply = (name: 'arc' | 'base', token: Address) => chain(name).test.readContract({ address: token, abi: erc20Abi, functionName: 'totalSupply' })
const mineBase = () => chain('base').test.mine({ blocks: BASE_CONFIRMATIONS + 1 })
async function executions(name: 'arc' | 'base', operation: Hex) {
  return (await chain(name).test.getLogs({ address: env.config[name].executor, event: executorAbi.find((x) => x.type === 'event' && x.name === 'Executed')!, args: { operation }, fromBlock: PINNED[name].block })).length
}
/** Holder's own NTT transfer on Base: approve, then burn toward Arc. Returns the transfer tx. */
async function holderBurn(amount: bigint, to: Address = ARC_RECIPIENT): Promise<Hex> {
  const { test, wallet } = chain('base', HOLDER_KEY)
  await test.waitForTransactionReceipt({ hash: await wallet.writeContract({ chain: null, address: L.spoke, abi: erc20Abi, functionName: 'approve', args: [L.spokeManager.proxy, amount] }) })
  const tx = await wallet.writeContract({ chain: null, address: L.spokeManager.proxy, abi: nttAbi, functionName: 'transfer', args: [amount, PINNED.arc.wormholeChainId, universal(to)] })
  expect((await test.waitForTransactionReceipt({ hash: tx })).status).toBe('success')
  return tx
}
/** Run until complete, mining Base between rounds so confirmations accrue. */
async function settle(route: TransferRoute<ReturnRequest>, id: Hex) {
  let t = await runTransfer(transfers, route, id)
  for (let round = 0; t.state !== 'complete' && round < 10; round++) {
    expect(t.error ?? '').toContain('awaits finalized evidence')
    await mineBase()
    t = await runTransfer(transfers, route, id)
  }
  return t as Transfer<ReturnRequest>
}

suite('EQUILIBRIUM Base→Arc return on pinned testnet forks', () => {
  beforeAll(async () => {
    env = await forkEnvironment({ arcPort: 18555, basePort: 18556, baseFinality: BASE_CONFIRMATIONS })
    mkdirSync(join(process.cwd(), 'output'), { recursive: true })
    dir = mkdtempSync(join(process.cwd(), 'output', 'return-'))
    jobs = new JobStore(join(dir, 'jobs.sqlite'), { leaseMs: 1000 })
    transfers = new TransferStore(jobs.db, 1000)
    await chain('base').test.setBalance({ address: holder.address, value: 10n ** 18n })
    // A real fork launch through the frozen adapter; the holder receives the Base allocation.
    const adapter = evmAdapter(env.config, jobs.db)
    const job = quote(jobs, adapter, request('return-launch-01', now(), holder.address.toLowerCase() as Address), now())
    let done = await runJob(jobs, adapter, job.id, await signedPayment(job))
    for (let round = 0; done.state !== 'complete' && round < 20; round++) { await mineBase(); done = await runJob(jobs, adapter, job.id) }
    expect(done.state).toBe('complete')
    launch = done
    L = layout(launch, env.config)
    routes = transferRoutes(env.config, settings, jobs.db, (id) => jobs.get(id))
  }, 900_000)
  afterAll(() => { jobs?.close(); env?.stop(); if (dir) rmSync(dir, { recursive: true, force: true }) })

  test_('after the launch, finalized custody backs the Base supply exactly', async () => {
    await mineBase()
    const s = await conservation(routes.sender, env.config, launch)
    expect(s).toMatchObject({ issuance: '1000000000000', custody: '10000000000', remote: '10000000000', inFlight: '0', conserved: true })
    expect(await balance('base', L.spoke, holder.address)).toBe(5_000_000_000n)
  })

  test_('operator inventory returns from the Base executor: burn finalizes, then Arc custody unlocks the same amount once', async () => {
    const { test, wallet } = chain('base', HOLDER_KEY)
    await test.waitForTransactionReceipt({ hash: await wallet.writeContract({ chain: null, address: L.spoke, abi: erc20Abi, functionName: 'transfer', args: [env.config.base.executor, 2_000_000_000n] }) })
    const custodyBefore = await balance('arc', L.canonical, L.hub.proxy)
    const t = await createTransfer(transfers, routes.returns, { kind: 'return', source: 'executor', requestId: 'return-exec-0001', launch: launch.id, amount: '1500000000', recipient: ARC_RECIPIENT }, now())
    // The burn is held unfinalized for BASE_CONFIRMATIONS blocks: the unlock waits, nothing is prepared early.
    const first = await runTransfer(transfers, routes.returns, t.id)
    expect(first.state).toBe('partial')
    expect(first.steps[1].state).toBe('planned')
    const midway = await conservation(routes.sender, env.config, launch)
    const done = await settle(routes.returns, t.id)
    expect(done.state).toBe('complete')
    expect(done.steps.map((s) => [s.id, s.result!.amount, s.result!.by])).toEqual([['burn:base', '1500000000', 'executor'], ['unlock:arc', '1500000000', 'executor']])
    expect(custodyBefore - await balance('arc', L.canonical, L.hub.proxy)).toBe(1_500_000_000n)
    expect(await balance('arc', L.canonical, ARC_RECIPIENT)).toBe(1_500_000_000n)
    expect(await balance('base', L.spoke, env.config.base.executor)).toBe(500_000_000n)
    for (const s of done.steps) expect(await executions(s.chain, hash([done.id, s.id]))).toBe(1)
    // Before the burn finalized, Base had already shrunk while custody had not: in flight, never inflated.
    expect(BigInt(midway.remote) <= BigInt(midway.custody)).toBe(true)
    await mineBase()
    expect(await conservation(routes.sender, env.config, launch)).toMatchObject({ custody: '8500000000', remote: '8500000000', inFlight: '0', conserved: true })
    // Resending the same request resumes the record and executes nothing new.
    const again = await createTransfer(transfers, routes.returns, done.request, now())
    expect(again.id).toBe(done.id)
    expect((await runTransfer(transfers, routes.returns, done.id)).state).toBe('complete')
    for (const s of done.steps) expect(await executions(s.chain, hash([done.id, s.id]))).toBe(1)
    expect(publicTransfer(done).steps.every((s) => !('prepared' in s))).toBe(true)
  })

  test_('a holder burn is relayed only after it finalizes, and a second request for the same burn resumes the same record', async () => {
    const tx = await holderBurn(700_000_000n)
    const t = await createTransfer(transfers, routes.returns, { kind: 'return', source: 'holder', launch: launch.id, transaction: tx }, now())
    const early = await runTransfer(transfers, routes.returns, t.id)
    expect([early.state, early.steps[0].state, early.steps[1].state]).toEqual(['partial', 'prepared', 'planned'])
    const pending = await conservation(routes.sender, env.config, launch)
    const done = await settle(routes.returns, t.id)
    expect(done.steps.map((s) => [s.id, s.result!.amount, s.result!.by])).toEqual([['burn:base', '700000000', 'holder'], ['unlock:arc', '700000000', 'executor']])
    expect(done.steps[0].result!.cost).toBe('0')
    expect(await balance('arc', L.canonical, ARC_RECIPIENT)).toBe(2_200_000_000n)
    expect((await createTransfer(transfers, routes.returns, { kind: 'return', source: 'holder', launch: launch.id, transaction: tx }, now())).id).toBe(done.id)
    expect(BigInt(pending.remote) <= BigInt(pending.custody)).toBe(true)
    await mineBase()
    expect(await conservation(routes.sender, env.config, launch)).toMatchObject({ custody: '7800000000', remote: '7800000000', inFlight: '0', conserved: true })
  })

  test_('the redeemed VAA cannot unlock again: directly, through a fresh executor operation, or altered', async () => {
    const vaa = jobs.db.query<{ vaa: string }, []>('SELECT vaa FROM evm_transfer_vaas LIMIT 1').get()!.vaa as Hex
    const { wallet, test } = chain('arc')
    const custody = await balance('arc', L.canonical, L.hub.proxy)
    const attempts: Hex[] = [
      await wallet.writeContract({ chain: null, address: L.hub.transceiver, abi: transceiverAbi, functionName: 'receiveMessage', args: [vaa], gas: 2_000_000n }),
      await wallet.writeContract({ chain: null, address: env.config.arc.executor, abi: executorAbi, functionName: 'execute', gas: 2_000_000n,
        args: [hash(['return-replay']), hash('replay'), [{ target: L.hub.transceiver, value: 0n, data: encodeFunctionData({ abi: transceiverAbi, functionName: 'receiveMessage', args: [vaa] }) }]] }),
      await wallet.writeContract({ chain: null, address: L.hub.transceiver, abi: transceiverAbi, functionName: 'receiveMessage', args: [`${vaa.slice(0, -2)}${vaa.endsWith('00') ? '01' : '00'}` as Hex], gas: 2_000_000n }),
    ]
    for (const tx of attempts) expect((await test.waitForTransactionReceipt({ hash: tx })).status).toBe('reverted')
    expect(await balance('arc', L.canonical, L.hub.proxy)).toBe(custody)
  })

  test_('an unauthorized credit is refused: a burn of another token or route is not relayed, and unknown transactions are rejected', async () => {
    // A Base transaction that is not an NTT burn of this launch (the holder's plain ERC-20 transfer).
    const { test, wallet } = chain('base', HOLDER_KEY)
    const plain = await wallet.writeContract({ chain: null, address: L.spoke, abi: erc20Abi, functionName: 'transfer', args: [operator.address, 1n] })
    await test.waitForTransactionReceipt({ hash: plain })
    await mineBase()
    const t = await createTransfer(transfers, routes.returns, { kind: 'return', source: 'holder', launch: launch.id, transaction: plain }, now())
    let refused: unknown; try { await runTransfer(transfers, routes.returns, t.id) } catch (cause) { refused = cause }
    expect(String(refused)).toContain('expected exactly one')
    expect(transfers.get(t.id)!.steps[1].state).toBe('planned')
    const unknown = await createTransfer(transfers, routes.returns, { kind: 'return', source: 'holder', launch: launch.id, transaction: hash('no such tx') }, now())
    let missing: unknown; try { await runTransfer(transfers, routes.returns, unknown.id) } catch (cause) { missing = cause }
    expect(String(missing)).toContain('unknown to the Base RPC')
    // Operator returns are bounded by inventory, the per-transfer cap and a strict request shape.
    const cases: [unknown, string][] = [
      [{ kind: 'return', source: 'executor', requestId: 'return-over-01', launch: launch.id, amount: '4000000000', recipient: ARC_RECIPIENT }, 'Base executor holds'],
      [{ kind: 'return', source: 'executor', requestId: 'return-over-02', launch: launch.id, amount: '6000000000', recipient: ARC_RECIPIENT }, 'capped'],
      [{ kind: 'return', source: 'executor', requestId: 'return-over-03', launch: hash('no launch'), amount: '1', recipient: ARC_RECIPIENT }, 'completed launch'],
      [{ kind: 'return', source: 'executor', requestId: 'return-over-04', launch: launch.id, amount: '1', recipient: ARC_RECIPIENT, extra: 1 }, 'Unknown request field'],
    ]
    for (const [raw, message] of cases) {
      let error: unknown; try { await createTransfer(transfers, routes.returns, raw, now()) } catch (cause) { error = cause }
      expect(String(error)).toContain(message)
    }
    // The same request id with a different payload is a conflict, not a second transfer.
    let conflict: unknown
    try { await createTransfer(transfers, routes.returns, { kind: 'return', source: 'executor', requestId: 'return-exec-0001', launch: launch.id, amount: '1', recipient: ARC_RECIPIENT }, now()) } catch (cause) { conflict = cause }
    expect(String(conflict)).toContain('bound to a different request')
  })

  test_('a third party relaying the VAA first is recorded as the redemption; the executor sends nothing and custody moves once', async () => {
    const tx = await holderBurn(300_000_000n)
    const t = await createTransfer(transfers, routes.returns, { kind: 'return', source: 'holder', launch: launch.id, transaction: tx }, now())
    const custody = await balance('arc', L.canonical, L.hub.proxy)
    const frontRun: TransferRoute<ReturnRequest> = { ...routes.returns, broadcast: async (x, step, effect) => {
      if (step.id === 'unlock:arc') {
        const vaa = jobs.db.query<{ vaa: string }, [string]>('SELECT vaa FROM evm_transfer_vaas WHERE transfer=?').get(x.id)!.vaa as Hex
        const { wallet, test } = chain('arc', HOLDER_KEY)
        await chain('arc').test.setBalance({ address: holder.address, value: 10n ** 20n })
        expect((await test.waitForTransactionReceipt({ hash: await wallet.writeContract({ chain: null, address: L.hub.transceiver, abi: transceiverAbi, functionName: 'receiveMessage', args: [vaa] }) })).status).toBe('success')
      }
      return routes.returns.broadcast(x, step, effect)
    } }
    const done = await settle(frontRun, t.id)
    expect(done.steps[1].result).toMatchObject({ amount: '300000000', by: 'third-party', cost: '0' })
    expect(await executions('arc', hash([done.id, 'unlock:arc']))).toBe(0)
    expect(custody - await balance('arc', L.canonical, L.hub.proxy)).toBe(300_000_000n)
  })

  test_('a stale worker racing a live worker on the same prepared unlock moves custody once', async () => {
    const tx = await holderBurn(200_000_000n)
    await mineBase()
    const t = await createTransfer(transfers, routes.returns, { kind: 'return', source: 'holder', launch: launch.id, transaction: tx }, now())
    // A second, independent sender stands in for a worker in another process.
    const stale = transferRoutes(env.config, settings, jobs.db, (id) => jobs.get(id)).returns
    const racing: TransferRoute<ReturnRequest> = { ...routes.returns, broadcast: async (x, step, effect) => {
      if (step.id !== 'unlock:arc') return routes.returns.broadcast(x, step, effect)
      await Promise.all([routes.returns.broadcast(x, step, effect), stale.broadcast(x, step, effect)])
    } }
    const custody = await balance('arc', L.canonical, L.hub.proxy)
    const done = await settle(racing, t.id)
    expect(done.steps[1].result!.by).toBe('executor')
    expect(await executions('arc', hash([done.id, 'unlock:arc']))).toBe(1)
    expect(custody - await balance('arc', L.canonical, L.hub.proxy)).toBe(200_000_000n)
  })

  for (const crash of ['after:burn:base', 'before:unlock:arc', 'after:unlock:arc']) {
    test_(`a worker killed ${crash.replace(':', ' broadcast of ')} is finished by the sweep with every effect exactly once`, async () => {
      const { test, wallet } = chain('base', HOLDER_KEY)
      await test.waitForTransactionReceipt({ hash: await wallet.writeContract({ chain: null, address: L.spoke, abi: erc20Abi, functionName: 'transfer', args: [env.config.base.executor, 100_000_000n] }) })
      const t = await createTransfer(transfers, routes.returns, { kind: 'return', source: 'executor', requestId: `return-crash-${crash.replace(/:/g, '-')}`, launch: launch.id, amount: '100000000', recipient: ARC_RECIPIENT }, now())
      if (crash !== 'after:burn:base') { // get past the burn first, so the crash lands on the unlock
        const burnOnly: TransferRoute<ReturnRequest> = { ...routes.returns, prepare: async (x, s) => {
          if (s.id === 'unlock:arc') throw new Error('stop before the unlock')
          return routes.returns.prepare(x, s)
        } }
        for (let i = 0; transfers.get(t.id)!.steps[0].state !== 'complete' && i < 10; i++) {
          await runTransfer(transfers, burnOnly, t.id).catch((cause) => expect(String(cause)).toContain('stop before the unlock'))
          await mineBase()
        }
        expect(transfers.get(t.id)!.steps.map((s) => s.state)).toEqual(['complete', 'planned'])
      }
      const configPath = join(dir, 'transfer-config.json')
      writeFileSync(configPath, JSON.stringify({ adapter: toFile(env.config, 0), settings }))
      const child = spawnSync('bun', ['run', 'server/equilibrium/evm/transfers/__tests__/crash-worker.ts', configPath, join(dir, 'jobs.sqlite'), 'return', t.id, crash],
        { env: { ...process.env, EQUILIBRIUM_OPERATOR_KEY: DEV.operator, EQUILIBRIUM_FORK_GUARDIAN_KEY: DEV.guardian }, encoding: 'utf8', timeout: 300_000 })
      expect([child.status, (child.stdout + child.stderr).slice(-1500)]).toEqual([crash.startsWith('before') ? 78 : 77, (child.stdout + child.stderr).slice(-1500)])
      expect(transfers.get(t.id)!.state).not.toBe('complete')
      await new Promise((r) => setTimeout(r, 1500)) // the dead worker's lease expires
      let state = ''
      for (let round = 0; state !== 'complete' && round < 10; round++) {
        await mineBase()
        state = (await reconcileTransfers(transfers, routes.returns)).find((r) => r.id === t.id)?.state ?? transfers.get(t.id)!.state
      }
      expect(state).toBe('complete')
      const done = transfers.get(t.id)!
      for (const s of done.steps) expect(await executions(s.chain, hash([done.id, s.id]))).toBe(1)
      await mineBase()
      expect(await conservation(routes.sender, env.config, launch)).toMatchObject({ inFlight: '0', conserved: true })
    })
  }

  test_('after every return, finalized supply reconciles: Base supply equals Arc custody and issuance is unchanged', async () => {
    await mineBase()
    const s = await conservation(routes.sender, env.config, launch)
    expect(s).toMatchObject({ issuance: '1000000000000', inFlight: '0', conserved: true })
    expect(BigInt(s.remote)).toBe(await supply('base', L.spoke))
    // 10,000 launched; returned 1,500 + 700 + 300 + 200 + 3 × 100.
    expect(s.custody).toBe((10_000_000_000n - 1_500_000_000n - 700_000_000n - 300_000_000n - 200_000_000n - 300_000_000n).toString())
  })
})
