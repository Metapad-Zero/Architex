/**
 * Gas-ledger and chain-binding regressions for the transfer sender, against a plain local anvil (no
 * fork, no public RPC) behind a proxy that can add an OP Stack `l1Fee` to receipts the way a Base
 * RPC does: as a hex string, which viem leaves unformatted. Runs whenever `anvil` is installed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPublicClient, createWalletClient, http, zeroAddress, type Address, type Hex, type TransactionReceipt } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { JobStore } from '../../../store'
import { hash } from '../../../request'
import { l1FeeOf, weiOf } from '../../adapter'
import { CODE, executorAbi, linked, withArgs } from '../../contracts'
import { DEV } from '../../fork'
import type { ChainConfig } from '../../types'
import { executorSender, prepared, type ExecutorPlan, type SenderConfig } from '../executor'

const suite = Bun.which('anvil') ? describe : describe.skip
const ANVIL_PORT = 18595
const PROXY_PORT = 18596
const BASE_ID = 84532
const operator = privateKeyToAccount(DEV.operator)
let anvil: ChildProcess
let proxy: ReturnType<typeof Bun.serve>
let dir: string
let executor: Address
let config: SenderConfig
/** What the proxy writes into every receipt's `l1Fee`; undefined leaves receipts as anvil returns them. */
let injected: unknown
const client = () => createPublicClient({ transport: http(`http://127.0.0.1:${ANVIL_PORT}`) })
const nonce = () => client().getTransactionCount({ address: operator.address })
const planFor = (seed: string, overrides: Partial<ExecutorPlan> = {}): ExecutorPlan => ({ chain: 'base', chainId: BASE_ID, executor, operation: hash([seed]), calls: [], value: '0', fromBlock: '0', expect: {}, ...overrides })
const count = (db: JobStore, sql: string) => (db.db.query(sql).get() as { n: number }).n
async function failure(p: Promise<unknown>) { try { await p } catch (cause) { return String(cause) } return 'resolved' }

suite('transfer sender: numeric gas ledger, chain binding and process-safe reservations', () => {
  beforeAll(async () => {
    anvil = spawn('anvil', ['--chain-id', String(BASE_ID), '--port', String(ANVIL_PORT), '--silent'], { stdio: 'ignore' })
    for (let i = 0; i < 80; i++) { try { await client().getChainId(); break } catch { await new Promise((r) => setTimeout(r, 100)) } }
    proxy = Bun.serve({ port: PROXY_PORT, hostname: '127.0.0.1', async fetch(request) {
      const body = await request.text()
      const upstream = await fetch(`http://127.0.0.1:${ANVIL_PORT}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      const json = await upstream.json() as { result?: Record<string, unknown> | null } | { result?: Record<string, unknown> | null }[]
      const call = JSON.parse(body) as { method: string } | { method: string }[]
      const patch = (m: string, r: { result?: Record<string, unknown> | null }) => { if (m === 'eth_getTransactionReceipt' && r.result && injected !== undefined) r.result.l1Fee = injected }
      if (Array.isArray(call)) call.forEach((c, i) => patch(c.method, (json as { result?: Record<string, unknown> | null }[])[i]))
      else patch(call.method, json as { result?: Record<string, unknown> | null })
      return Response.json(json)
    } })
    const wallet = createWalletClient({ account: operator, transport: http(`http://127.0.0.1:${ANVIL_PORT}`) })
    await client().request({ method: 'anvil_setBalance' as never, params: [operator.address, '0x3635c9adc5dea00000'] as never })
    const tx = await wallet.sendTransaction({ account: operator, chain: null, data: withArgs(linked(CODE.EquilibriumExecutor), [{ type: 'address' }, { type: 'address' }], [operator.address, zeroAddress]) })
    executor = (await client().waitForTransactionReceipt({ hash: tx })).contractAddress!
    const chain = (name: 'arc' | 'base', chainId: number): ChainConfig => ({ chain: name, rpc: `http://127.0.0.1:${PROXY_PORT}`, chainId, wormholeChainId: 1, core: executor, executor, transceiverStructs: executor,
      usdc: executor, finality: 0, usdcAtomsPerNative: 5_000_000_000n, venue: { kind: 'architex', factory: executor }, fromBlock: 0n, priorityFeeWei: 1_000_000n, maxFeePerGasWei: 2_000_000_000n })
    // Arc is deliberately configured with a chain id this RPC does not serve.
    config = { operatorKey: DEV.operator, arc: chain('arc', 5042002), base: chain('base', BASE_ID) }
    mkdirSync(join(process.cwd(), 'output'), { recursive: true })
    dir = mkdtempSync(join(process.cwd(), 'output', 'gas-'))
  }, 60_000)
  afterAll(() => { void proxy?.stop(true); anvil?.kill(); if (dir) rmSync(dir, { recursive: true, force: true }) })

  test('the shared fee parser reads zero and nonzero L1 fees as hex, decimal, number or bigint, and refuses anything else', () => {
    const receipt = (l1Fee: unknown) => ({ gasUsed: 100n, effectiveGasPrice: 3n, transactionHash: hash('r'), l1Fee }) as unknown as TransactionReceipt
    for (const [value, expected] of [[undefined, 0n], [null, 0n], ['0x0', 0n], ['0x10', 16n], ['0', 0n], ['16', 16n], [16, 16n], [16n, 16n]] as const) {
      expect(l1FeeOf(receipt(value))).toBe(expected)
      expect(weiOf(receipt(value))).toBe(300n + expected)
    }
    for (const value of ['00x0', '0x', '1e3', '-1', ' 16', {}]) expect(() => l1FeeOf(receipt(value))).toThrow('Unreadable l1Fee')
  })

  test('a Base receipt with a hex or decimal L1 fee is accounted as a decimal integer, and cost() and the cap read it', async () => {
    const db = new JobStore(join(dir, 'fees.sqlite'))
    const sender = executorSender({ ...config, operatorGas: { arc: '1', base: (10n ** 18n).toString() } }, db.db)
    for (const [seed, fee, extra] of [['fee-hex-zero', '0x0', 0n], ['fee-hex', '0x10', 16n], ['fee-decimal', '16', 16n], ['fee-decimal-zero', '0', 0n], ['fee-absent', undefined, 0n]] as const) {
      injected = fee
      const plan = planFor(seed)
      await sender.broadcast(plan, prepared(plan).digest)
      const row = db.db.query<{ tx: string; actual: string }, [string]>('SELECT tx, actual FROM evm_transfer_gas WHERE operation=?').get(plan.operation)!
      expect(row.actual).toMatch(/^(0|[1-9]\d*)$/)
      const receipt = await client().getTransactionReceipt({ hash: row.tx as Hex })
      expect(BigInt(row.actual)).toBe(receipt.gasUsed * receipt.effectiveGasPrice + extra)
      const seen = await sender.observe(plan, prepared(plan).digest)
      expect(typeof seen).toBe('object')
      expect(sender.cost('base', seen as TransactionReceipt)).toMatch(/^\d+$/)
    }
    expect(sender.committed('base') > 0n).toBe(true)
    injected = undefined
    db.close()
  }, 120_000)

  test('a wrong chain is refused before anything is reserved, signed or sent', async () => {
    const db = new JobStore(join(dir, 'chain.sqlite'))
    const sender = executorSender(config, db.db)
    const before = await nonce()
    // The Arc configuration names 5042002; this RPC serves 84532.
    expect(await failure(sender.broadcast(planFor('wrong-chain', { chain: 'arc', chainId: 5042002 }), prepared(planFor('wrong-chain', { chain: 'arc', chainId: 5042002 })).digest))).toContain('reports chain 84532')
    // A plan naming another chain id is refused even on the right RPC.
    const other = planFor('wrong-plan', { chainId: 1 })
    expect(await failure(sender.broadcast(other, prepared(other).digest))).toContain('the plan names 1')
    expect(await failure(sender.verify())).toContain('reports chain 84532')
    expect(await nonce()).toBe(before)
    expect(count(db, 'SELECT COUNT(*) AS n FROM evm_transfer_gas')).toBe(0)
    expect(count(db, 'SELECT COUNT(*) AS n FROM evm_transfer_broadcasts')).toBe(0)
    db.close()
  }, 120_000)

  test('a malformed spend row from before the repair is recovered from its finalized receipt without resubmitting; an unrecoverable one stops sends', async () => {
    const db = new JobStore(join(dir, 'legacy.sqlite'))
    const first = executorSender(config, db.db)
    injected = '0x10'
    const plan = planFor('legacy-mined')
    await first.broadcast(plan, prepared(plan).digest)
    const tx = db.db.query<{ tx: string }, []>('SELECT tx FROM evm_transfer_gas').get()!.tx
    // Recreate the pre-repair state the review found: the old table, the concatenated wei, no numeric row.
    db.db.exec("DELETE FROM evm_transfer_gas; CREATE TABLE evm_transfer_spend (tx TEXT PRIMARY KEY, chain TEXT NOT NULL, wei TEXT NOT NULL);")
    db.db.query('INSERT INTO evm_transfer_spend(tx, chain, wei) VALUES(?,?,?)').run(tx, 'base', '552240552240x10')
    const sender = executorSender({ ...config, operatorGas: { arc: '1', base: (10n ** 18n).toString() } }, db.db)
    expect(() => sender.committed('base')).toThrow('unreadable spend row')
    const before = await nonce()
    await sender.settleGas('base')
    expect(await nonce()).toBe(before)
    const receipt = await client().getTransactionReceipt({ hash: tx as Hex })
    expect(db.db.query<{ actual: string; operation: string }, [string]>('SELECT actual, operation FROM evm_transfer_gas WHERE tx=?').get(tx)).toEqual({ actual: (receipt.gasUsed * receipt.effectiveGasPrice + 16n).toString(), operation: plan.operation })
    expect(count(db, 'SELECT COUNT(*) AS n FROM evm_transfer_spend')).toBe(0)
    expect(sender.committed('base')).toBe(receipt.gasUsed * receipt.effectiveGasPrice + 16n)
    // A malformed row whose transaction no RPC knows cannot be recovered: nothing further is sent on that chain.
    db.db.query('INSERT INTO evm_transfer_spend(tx, chain, wei) VALUES(?,?,?)').run(hash('never mined'), 'base', '10x0')
    const next = planFor('legacy-blocked')
    expect(await failure(sender.broadcast(next, prepared(next).digest))).toContain('unreadable spend row')
    expect(await nonce()).toBe(before)
    injected = undefined
    db.close()
  }, 120_000)

  const worker = (db: string, seed: string, mode: string, cap: bigint) => {
    const path = join(dir, `worker-${seed}.json`)
    writeFileSync(path, JSON.stringify({ ...config, operatorGas: { arc: '1', base: cap.toString() } }, (_, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v)))
    return ['run', 'server/equilibrium/evm/transfers/__tests__/gas-worker.ts', path, db, seed, mode]
  }
  /** Async on purpose: the receipt proxy runs in this process, so a blocking spawn would starve the child's RPC calls. */
  const run = (args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn('bun', args, { env: process.env })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('exit', (status) => resolve({ status, stdout, stderr }))
  })
  /** One send's worst case under this config, read from a reservation in a scratch store. */
  async function worstCase() {
    const scratch = new JobStore(join(dir, 'worst.sqlite'))
    const plan = planFor(`worst-${Date.now()}`)
    await executorSender(config, scratch.db).broadcast(plan, prepared(plan).digest)
    const worst = BigInt(scratch.db.query<{ worst: string }, []>('SELECT worst FROM evm_transfer_gas').get()!.worst)
    scratch.close()
    return worst
  }

  test('three competing processes against a cap of one and a half sends: exactly one reserves and sends, the others send nothing', async () => {
    const worst = await worstCase()
    const cap = worst + worst / 2n
    const path = join(dir, 'race.sqlite')
    new JobStore(path).close()
    const before = await nonce()
    const children = ['race-a', 'race-b', 'race-c'].map((seed) => new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn('bun', worker(path, seed, 'send', cap), { env: process.env })
      let out = ''
      child.stdout.on('data', (d: Buffer) => { out += d.toString() })
      child.stderr.on('data', (d: Buffer) => { out += d.toString() })
      child.on('exit', (code) => resolve({ code, out }))
    }))
    const results = await Promise.all(children)
    expect(results.map((r) => `${r.code}`).sort()).toEqual(results.every((r) => r.code === 0 || r.code === 3) ? ['0', '3', '3'] : results.map((r) => `${r.code}: ${r.out.slice(-400)}`))
    for (const r of results.filter((x) => x.code === 3)) expect(r.out).toContain('Nothing was sent')
    expect(await nonce()).toBe(before + 1)
    const db = new JobStore(path)
    const rows = db.db.query<{ worst: string; actual: string | null }, []>('SELECT worst, actual FROM evm_transfer_gas').all()
    expect(rows.length).toBe(1)
    expect(rows.reduce((n, r) => n + BigInt(r.actual ?? r.worst), 0n) <= cap).toBe(true)
    db.close()
  }, 120_000)

  test('a process killed after the send and before any accounting is settled from the receipt, and the effect is never resubmitted', async () => {
    const path = join(dir, 'kill-after.sqlite')
    new JobStore(path).close()
    const before = await nonce()
    const child = await run(worker(path, 'kill-after', 'kill-after-send', 10n ** 18n))
    expect([child.status, (child.stdout + child.stderr).slice(-900)]).toEqual([77, (child.stdout + child.stderr).slice(-900)])
    const db = new JobStore(path)
    const row = db.db.query<{ tx: string; worst: string; actual: string | null }, []>('SELECT tx, worst, actual FROM evm_transfer_gas').get()!
    expect([row.tx !== null, row.actual]).toEqual([true, null])
    // The hash recorded before the send is the transaction that went out; it mines once.
    await client().waitForTransactionReceipt({ hash: row.tx as Hex, pollingInterval: 100 })
    expect(await nonce()).toBe(before + 1)
    const sender = executorSender({ ...config, operatorGas: { arc: '1', base: (10n ** 18n).toString() } }, db.db)
    expect(sender.committed('base')).toBe(BigInt(row.worst))
    await sender.settleGas('base')
    expect(sender.committed('base')).toBe(weiOf(await client().getTransactionReceipt({ hash: row.tx as Hex })))
    // The restarted sender sees the operation executed and sends nothing.
    const plan = planFor('kill-after')
    await sender.broadcast(plan, prepared(plan).digest)
    expect(await nonce()).toBe(before + 1)
    expect((await client().getLogs({ address: executor, event: executorAbi.find((x) => x.type === 'event' && x.name === 'Executed')!, args: { operation: plan.operation }, fromBlock: 0n })).length).toBe(1)
    db.close()
  }, 120_000)

  test('a process killed after signing and recording but before sending keeps its worst case reserved; the retry sends once', async () => {
    const path = join(dir, 'kill-before.sqlite')
    new JobStore(path).close()
    const before = await nonce()
    const child = await run(worker(path, 'kill-before', 'kill-before-send', 10n ** 18n))
    expect([child.status, (child.stdout + child.stderr).slice(-900)]).toEqual([78, (child.stdout + child.stderr).slice(-900)])
    expect(await nonce()).toBe(before)
    const db = new JobStore(path)
    const sender = executorSender({ ...config, operatorGas: { arc: '1', base: (10n ** 18n).toString() } }, db.db)
    const orphan = db.db.query<{ worst: string }, []>('SELECT worst FROM evm_transfer_gas').get()!
    await sender.settleGas('base')
    // Never mined, so it stays at worst case: the ledger over-counts rather than under-counts.
    expect(sender.committed('base')).toBe(BigInt(orphan.worst))
    const plan = planFor('kill-before')
    await sender.broadcast(plan, prepared(plan).digest)
    expect(await nonce()).toBe(before + 1)
    expect((await client().getLogs({ address: executor, event: executorAbi.find((x) => x.type === 'event' && x.name === 'Executed')!, args: { operation: plan.operation }, fromBlock: 0n })).length).toBe(1)
    db.close()
  }, 120_000)
})
