/**
 * Replays the independent verifier's release-gate challenge (49TH-25, against 75447f5) on local
 * forks only. Every send goes to anvil; nothing touches a public chain.
 *
 *   bun run equilibrium:gate-challenge      (server/equilibrium/evm/challenge.ts)
 *
 * EXPR    a hex l1Fee is added as a number.
 * PHASE_A Base L1 fee bound above the remaining cap: gas_cap before anything is sent.
 * PHASE_B every Base receipt carries l1Fee "0x10" (RPC proxy): the launch completes and the ledger
 *         holds numbers equal to gas * price + 16.
 * PHASE_C a worker SIGKILLed right after sending a Base step, before any receipt accounting: the
 *         reservation stays at worst case, reconcile finishes, committed = real receipts + over-count.
 * PHASE_D two worker processes race for a one-launch scope: exactly one payment executes.
 * Prints one line per check and exits 1 if any fails.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestClient, http, pad, publicActions, toHex, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { JobStore } from '../store'
import { quote, reconcile, runJob } from '../runner'
import { hash } from '../request'
import type { Job } from '../types'
import { evmAdapter, l1FeeOf, weiOf } from './adapter'
import { toFile } from './config'
import { executorAbi } from './contracts'
import { DEV, PINNED, forkEnvironment } from './fork'
import type { EvmAdapterConfig } from './types'
import { request, signedPayment } from './__tests__/harness'

const ORACLE = '0x420000000000000000000000000000000000000F' as const
/** Returns storage slot 0 for any call: a GasPriceOracle whose getL1FeeUpperBound the challenge sets. */
const STUB_ORACLE = '0x60005460005260206000f3' as const
let failed = 0
const check = (label: string, ok: boolean, detail: unknown = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} ${typeof detail === 'string' ? detail : JSON.stringify(detail, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}`)
}
const now = () => Math.floor(Date.now() / 1000)

const env = await forkEnvironment({ arcPort: 18555, basePort: 18556, payerUsdc: 10_000_000_000n, baseUsdc: 1_000_000_000n })
const dir = mkdtempSync(join(process.cwd(), 'output', 'gate-challenge-'))
const base = createTestClient({ mode: 'anvil', transport: http(env.base.url) }).extend(publicActions)
const arc = createTestClient({ mode: 'anvil', transport: http(env.arc.url) }).extend(publicActions)
const proxy = Bun.serve({ port: 18557, async fetch(req) {
  const body = await req.text()
  const upstream = await (await fetch(env.base.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).json() as unknown
  const parsed = JSON.parse(body) as { method: string } | { method: string }[]
  const patch = (m: { result?: Record<string, unknown> | null }, q: { method: string }) => (q.method === 'eth_getTransactionReceipt' && m.result ? { ...m, result: { ...m.result, l1Fee: '0x10' } } : m)
  return Response.json(Array.isArray(upstream) ? upstream.map((m, i) => patch(m as never, (parsed as { method: string }[])[i])) : patch(upstream as never, parsed as { method: string }))
} })
const oracle = async (wei: bigint) => base.setStorageAt({ address: ORACLE, index: pad('0x0', { size: 32 }), value: pad(toHex(wei), { size: 32 }) })
const executions = async (chain: 'arc' | 'base', operation: Hex) => (await (chain === 'arc' ? arc : base).getLogs({ address: env.config[chain].executor,
  event: executorAbi.find((x) => x.type === 'event' && x.name === 'Executed')!, args: { operation }, fromBlock: PINNED[chain].block + 1n })).length
const receiptOf = async (chain: 'arc' | 'base', operation: Hex) => {
  const client = chain === 'arc' ? arc : base
  const [log] = await client.getLogs({ address: env.config[chain].executor, event: executorAbi.find((x) => x.type === 'event' && x.name === 'Executed')!, args: { operation }, fromBlock: PINNED[chain].block + 1n })
  return client.getTransactionReceipt({ hash: log.transactionHash })
}
/** Base gas priced at 1 atom per ETH, so only the approved gas cap, not a step budget, can refuse. */
function scoped(requestId: string, launches: number, baseCap: bigint): EvmAdapterConfig {
  const r = request(requestId, now())
  return { ...env.config, base: { ...env.config.base, rpc: 'http://127.0.0.1:18557', usdcAtomsPerNative: 1n },
    budgets: { payment: '1000000', canonical: '2000000', manager: '5000000', debit: '1000000', credit: '1000000', pool: '2000000' },
    scope: { launches, payer: r.payer, recipient: r.canonical.recipient, issuance: r.canonical.issuance, maxTotal: '39000000',
      destinations: r.destinations.map(({ chain, amount, poolTokens, poolQuote }) => ({ chain: chain as 'arc' | 'base', amount, poolTokens, poolQuote })),
      operatorGas: { arc: (10n ** 20n).toString(), base: baseCap.toString() } } }
}
async function worker(config: EvmAdapterConfig, db: string, job: Job, mode: string) {
  const configPath = join(dir, `config-${job.id.slice(2, 10)}.json`); const paymentPath = join(dir, `${job.id}.json`)
  writeFileSync(configPath, JSON.stringify(toFile(config, 0))); writeFileSync(paymentPath, JSON.stringify(await signedPayment(job)))
  const child = Bun.spawn(['bun', 'run', 'server/equilibrium/evm/__tests__/crash-worker.ts', configPath, db, job.id, paymentPath, mode],
    { env: { ...process.env, EQUILIBRIUM_OPERATOR_KEY: DEV.operator, EQUILIBRIUM_FORK_GUARDIAN_KEY: DEV.guardian }, stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(child.stdout).text(); await child.exited
  return { signal: child.signalCode, report: out.trim() ? JSON.parse(out.trim().split('\n').pop()!) as { ok: boolean; code?: string; state?: string } : null }
}
const operator: Address = privateKeyToAccount(DEV.operator).address

try {
  await base.setCode({ address: ORACLE, bytecode: STUB_ORACLE })

  const receipt = { gasUsed: 21_000n, effectiveGasPrice: 1_000_000_000n, transactionHash: '0x01' }
  check('EXPR hex l1Fee is a number', weiOf({ ...receipt, l1Fee: '0x10' } as never) === 21_000_000_000_016n && l1FeeOf({ ...receipt, l1Fee: '0x0' } as never) === 0n,
    { wei: weiOf({ ...receipt, l1Fee: '0x10' } as never) })

  // PHASE_A: an L1 bound of 1e18 wei against a 1e17 cap: refused before any Base send.
  await oracle(10n ** 18n)
  const aStore = new JobStore(join(dir, 'a.sqlite'), { leaseMs: 1000 })
  const aConfig = scoped('challenge-a1', 1, 10n ** 17n)
  const aAdapter = evmAdapter(aConfig, aStore.db)
  const aJob = quote(aStore, aAdapter, request('challenge-a1', now()), now())
  const nonceBefore = await base.getTransactionCount({ address: operator })
  let aError = ''
  try { await runJob(aStore, aAdapter, aJob.id, await signedPayment(aJob)) } catch (cause) { aError = String(cause) }
  const baseBroadcasts = aStore.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM evm_broadcasts WHERE chain='base'").get()!.n
  check('PHASE_A gas_cap before any Base send', aError.includes('operator gas would exceed') && baseBroadcasts === 0 && await base.getTransactionCount({ address: operator }) === nonceBefore,
    { error: aError.slice(0, 120), baseBroadcasts, nonceDelta: (await base.getTransactionCount({ address: operator })) - nonceBefore })
  aStore.close()

  // PHASE_B: every Base receipt carries l1Fee "0x10". The launch completes; the ledger holds numbers.
  await oracle(1n)
  const bStore = new JobStore(join(dir, 'b.sqlite'), { leaseMs: 1000 })
  const bAdapter = evmAdapter(scoped('challenge-b1', 1, 10n ** 18n), bStore.db)
  const bJob = quote(bStore, bAdapter, request('challenge-b1', now()), now())
  const bResult = await runJob(bStore, bAdapter, bJob.id, await signedPayment(bJob))
  await bAdapter.settleGas('base')
  const ledger = bStore.db.query<{ actual: string | null }, []>("SELECT actual FROM evm_gas WHERE chain='base'").all()
  let expected = 0n
  for (const s of bResult.steps.filter((x) => x.chain === 'base' && x.kind !== 'debit')) expected += weiOf(await receiptOf('base', hash([bJob.id, s.id]))) + 16n
  check('PHASE_B launch completes with hex l1Fee receipts', bResult.state === 'complete', { state: bResult.state, error: bResult.error })
  check('PHASE_B ledger is numeric and equals gas*price+16 per Base send', ledger.every((r) => r.actual !== null && /^[0-9]+$/.test(r.actual)) && bAdapter.committed('base') === expected,
    { committed: bAdapter.committed('base'), expected, rows: ledger.length })
  bStore.close()

  // PHASE_C: SIGKILL right after sending manager:base, before any receipt accounting.
  const cDb = join(dir, 'c.sqlite')
  const cStore = new JobStore(cDb, { leaseMs: 1000 })
  const cConfig = scoped('challenge-c1', 1, 10n ** 18n)
  const cJob = quote(cStore, evmAdapter(cConfig, cStore.db), request('challenge-c1', now()), now())
  const killed = await worker(cConfig, cDb, cJob, 'kill-after-send:manager:base')
  const op = hash([cJob.id, 'manager:base'])
  for (let i = 0; i < 100 && (await executions('base', op)) === 0; i++) await new Promise((r) => setTimeout(r, 100))
  const orphan = cStore.db.query<{ worst: string; tx: string | null; actual: string | null }, [string]>('SELECT worst, tx, actual FROM evm_gas WHERE operation=?').get(op)
  const mined = weiOf(await receiptOf('base', op)) + 16n
  check('PHASE_C killed worker left its reservation at worst case', killed.signal === 'SIGKILL' && !!orphan && orphan.tx === null && orphan.actual === null && BigInt(orphan.worst) >= mined,
    { signal: killed.signal, orphan, minedWithL1: mined })
  await new Promise((r) => setTimeout(r, 1500))
  const cAdapter = evmAdapter(cConfig, cStore.db)
  for (let i = 0; i < 10 && cStore.get(cJob.id)!.state !== 'complete'; i++) await reconcile(cStore, cAdapter)
  await cAdapter.settleGas('base')
  let real = 0n
  for (const s of cStore.get(cJob.id)!.steps.filter((x) => x.chain === 'base' && x.kind !== 'debit')) real += weiOf(await receiptOf('base', hash([cJob.id, s.id]))) + 16n
  check('PHASE_C reconcile finishes, each effect once, committed = real + over-count', cStore.get(cJob.id)!.state === 'complete' && (await executions('base', op)) === 1
    && cAdapter.committed('base') === real + BigInt(orphan!.worst) - mined, { state: cStore.get(cJob.id)!.state, committed: cAdapter.committed('base'), real })
  cStore.close()

  // PHASE_D: two processes race for a one-launch scope.
  const dDb = join(dir, 'd.sqlite')
  const dStore = new JobStore(dDb, { leaseMs: 1000 })
  const dConfig = scoped('challenge-d1', 1, 10n ** 18n)
  const d1 = quote(dStore, evmAdapter(dConfig, dStore.db), request('challenge-d1', now()), now())
  const d2 = quote(dStore, evmAdapter(dConfig, dStore.db), request('challenge-d2', now()), now())
  const runs = await Promise.all([worker(dConfig, dDb, d1, 'none'), worker(dConfig, dDb, d2, 'none')])
  const paid = (await executions('arc', hash([d1.id, 'payment:arc']))) + (await executions('arc', hash([d2.id, 'payment:arc'])))
  const slots = dStore.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM evm_payments').get()!.n
  check('PHASE_D exactly one payment executes across two processes', paid === 1 && slots === 1,
    { paid, slots, reports: runs.map((r) => r.report?.ok ? r.report.state : r.report?.code) })
  dStore.close()
} finally {
  void proxy.stop(true); env.stop(); rmSync(dir, { recursive: true, force: true })
}
console.log(failed ? `${failed} check(s) failed` : 'All challenge checks passed')
process.exit(failed ? 1 : 0)
