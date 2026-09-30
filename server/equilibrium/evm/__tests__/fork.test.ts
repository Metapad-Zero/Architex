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
import { evmAdapter, layout } from '../adapter'
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
  const logs = await chainClient(chain).test.getLogs({ address: env.config[chain].executor, event: executorAbi.find((x) => x.type === 'event' && x.name === 'Executed')!, args: { operation }, fromBlock: PINNED[chain].block })
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
