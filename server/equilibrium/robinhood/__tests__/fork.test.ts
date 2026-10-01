/**
 * MIXED-ENVIRONMENT FORK REHEARSAL of the Robinhood spoke: Arc testnet fork (hub) + Robinhood
 * mainnet fork (spoke, real Wormhole core, real Uniswap v3 factory/QuoterV2/SwapRouter02, USDG as
 * a provisional quote fixture). Opt-in because it starts two anvil forks from public RPCs:
 *
 *   EQUILIBRIUM_ROBINHOOD_FORK=1 bun test server/equilibrium/robinhood/__tests__/fork.test.ts
 *
 * Evidence is written to output/robinhood-fork-evidence.json. See ../fork.ts for substitutions.
 */
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestClient, createWalletClient, encodeFunctionData, http, parseAbi, publicActions, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { DEV } from '../../evm/fork'
import { erc20Abi, executorAbi, spokeAbi, transceiverAbi } from '../../evm/contracts'
import { localGuardian, publishedFrom } from '../../evm/vaa'
import { probeStateAccess } from '../access'
import { ROBINHOOD_MAINNET } from '../pins'
import { configToJson, creditUsdg, robinhoodForkEnvironment, TRADER, type RobinhoodForkEnvironment } from '../fork'
import { robinhoodRoute, type RobinhoodRoute, type Side } from '../route'

const enabled = process.env.EQUILIBRIUM_ROBINHOOD_FORK === '1'
const suite = enabled ? describe : describe.skip
const test_ = (name: string, fn: () => Promise<void>) => test(name, fn, 600_000)
const E6 = 1_000_000n
const operator = privateKeyToAccount(DEV.operator)
const trader = privateKeyToAccount(TRADER)
const routerAbi = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
])
let env: RobinhoodForkEnvironment
let dir: string
let dbPath: string
let db: Database
let route: RobinhoodRoute
const evidence: Record<string, unknown> = {}
const json = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_, x: unknown) => (typeof x === 'bigint' ? x.toString() : x)))
const lastLine = (out: string) => JSON.parse(out.split('\n').pop()!) as { ok: boolean; progress?: string; error?: string }

const client = (side: Side) => createTestClient({ mode: 'anvil', transport: http(env.config[side].rpc) }).extend(publicActions)
const wallet = (side: Side, key: Hex = DEV.operator) => createWalletClient({ account: privateKeyToAccount(key), transport: http(env.config[side].rpc) })
const balance = (side: Side, token: Address, owner: Address) => client(side).readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
const spokeSupply = () => client('robinhood').readContract({ address: route.layout.spoke, abi: erc20Abi, functionName: 'totalSupply' })
async function executions(side: Side, name: string) {
  return (await client(side).getLogs({ address: env.config[side].executor, event: executorAbi.find((x) => x.type === 'event' && x.name === 'Executed')!, args: { operation: route.layout.op(name) }, fromBlock: env.config[side].fromBlock })).length
}
/** Send from an EOA and report whether it reverted, without throwing. */
async function reverts(side: Side, to: Address, data: Hex, key: Hex = DEV.operator): Promise<boolean> {
  try { await client(side).call({ account: privateKeyToAccount(key), to, data }); return false } catch { return true }
}
async function reconciled(label: string) {
  const s = await route.supply()
  evidence[`supply:${label}`] = json(s)
  expect(s.reconciled).toBe(true)
  return s
}
function worker(transferId: string, mode: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('bun', ['run', join(import.meta.dir, 'worker.ts'), join(dir, 'config.json'), dbPath, transferId, mode], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('exit', (code, signal) => resolve({ code, signal, out: out.trim() }))
  })
}

suite('EQUILIBRIUM Robinhood spoke: mixed Arc-testnet/Robinhood-mainnet fork rehearsal', () => {
  beforeAll(async () => {
    const started = Date.now()
    env = await robinhoodForkEnvironment({ confirmations: { arc: 5, robinhood: 3 } })
    mkdirSync(join(process.cwd(), 'output'), { recursive: true })
    dir = mkdtempSync(join(process.cwd(), 'output', 'robinhood-fork-'))
    dbPath = join(dir, 'route.sqlite')
    db = new Database(dbPath)
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000')
    route = robinhoodRoute(env.config, db)
    writeFileSync(join(dir, 'config.json'), configToJson(env.config, env.guardianSets))
    Object.assign(evidence, {
      environment: env.config.environment, label: 'mixed-environment compatibility evidence; not a public route',
      arc: { chainId: env.config.arc.chainId, wormholeChainId: env.config.arc.wormholeChainId, forkBlock: (env.config.arc.fromBlock - 1n).toString(), guardianSetIndex: env.guardianSets.arc, executor: env.config.arc.executor },
      robinhood: { chainId: env.config.robinhood.chainId, wormholeChainId: env.config.robinhood.wormholeChainId, forkBlock: env.robinhood.block.toString(), guardianSetIndex: env.guardianSets.robinhood, executor: env.config.robinhood.executor,
        stateAccess: json(env.robinhood.access), pins: env.robinhood.pins },
      startedAt: new Date(started).toISOString(),
    })
  }, 600_000)
  afterAll(() => {
    if (dir) writeFileSync(join(process.cwd(), 'output', 'robinhood-fork-evidence.json'), JSON.stringify({ ...evidence, finishedAt: new Date().toISOString() }, null, 2))
    db?.close(); env?.stop(); if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test_('pinned state: the fork runs the exact pinned Robinhood bytecode; the public RPC cannot serve finalized state', async () => {
    expect(env.robinhood.pins.every((p) => p.ok)).toBe(true)
    expect(env.robinhood.pins.length).toBe(Object.keys(ROBINHOOD_MAINNET.codeHashes).length + Object.keys(ROBINHOOD_MAINNET.implementations).length)
    const access = await probeStateAccess()
    evidence.publicRpcAccess = json(access)
    expect(access.chainId).toBe(4663)
    expect(access.available).toBe(true)
    expect(access.finalized! < access.latest).toBe(true)
    // An old pin fails closed instead of forking other state.
    const old = await probeStateAccess(ROBINHOOD_MAINNET.rpc, ROBINHOOD_MAINNET.observedBlock - 1_000_000n, [])
    evidence.oldPin = json(old)
    expect(old.available).toBe(false)
    expect(old.error).toContain('not served')
  })

  test_('deploys the Arc hub and the Robinhood spoke through the executors; the spoke mint is bound to its manager only', async () => {
    await route.deployHub(); await route.deploySpoke()
    const L = route.layout
    expect(await client('robinhood').readContract({ address: L.spoke, abi: spokeAbi, functionName: 'minter' })).toBe(L.spokeManager.proxy)
    expect(await balance('arc', L.canonical, env.config.arc.executor)).toBe(env.config.asset.issuance)
    // Re-running a deployment is a no-op: the executor refuses a second execution.
    await route.deployHub(); await route.deploySpoke()
    for (const [side, name] of [['arc', 'canonical:arc'], ['arc', 'manager:arc'], ['robinhood', 'manager:robinhood']] as const) expect(await executions(side, name)).toBe(1)
    await reconciled('deployed')
    evidence.addresses = { canonical: L.canonical, hub: L.hub.proxy, hubTransceiver: L.hub.transceiver, spoke: L.spoke, spokeManager: L.spokeManager.proxy, spokeTransceiver: L.spokeManager.transceiver }
  })

  test_('outbound Arc -> Robinhood waits for source finality, then credits exactly once; supply is conserved throughout', async () => {
    const X = env.config.robinhood.executor
    route.transfer('out-1', 'outbound', 20_000n * E6, X)
    expect(await route.advance('out-1')).toBe('awaiting_finality')
    expect(await route.advance('out-1')).toBe('awaiting_finality')
    expect(await spokeSupply()).toBe(0n)
    const pending = await reconciled('out-1:awaiting-finality')
    expect(pending.pending).toBe(20_000n * E6); expect(pending.custody).toBe(20_000n * E6)
    await client('arc').mine({ blocks: 4 })
    expect(await route.advance('out-1')).toBe('awaiting_finality')
    await client('arc').mine({ blocks: 1 })
    expect(await route.advance('out-1')).toBe('credited')
    expect(await balance('robinhood', route.layout.spoke, X)).toBe(20_000n * E6)
    expect(await executions('arc', 'transfer:out-1:debit')).toBe(1)
    expect(await executions('robinhood', 'transfer:out-1:credit')).toBe(1)
    const s = await reconciled('out-1:credited')
    expect(s.pending).toBe(0n); expect(s.spokeSupply).toBe(20_000n * E6)
    evidence.delayedFinality = { confirmationsRequired: 5, advancesBeforeFinal: 3, credited: route.get('out-1')!.creditTx }
  })

  test_('replay: the same VAA is rejected by the real transceiver, and the executor refuses the credit operation twice', async () => {
    const t = route.get('out-1')!
    const receive = encodeFunctionData({ abi: transceiverAbi, functionName: 'receiveMessage', args: [t.vaa!] })
    expect(await reverts('robinhood', route.layout.spokeManager.transceiver, receive)).toBe(true)
    expect(await route.advance('out-1')).toBe('credited')
    const row = db.query<{ digest: Hex; bytes: string }, [Hex]>('SELECT digest, bytes FROM robinhood_ops WHERE operation=?').get(route.layout.op('transfer:out-1:credit'))!
    const calls = (JSON.parse(row.bytes) as { calls: { target: Address; value: string; data: Hex }[] }).calls.map((c) => ({ ...c, value: BigInt(c.value) }))
    const again = encodeFunctionData({ abi: executorAbi, functionName: 'execute', args: [route.layout.op('transfer:out-1:credit'), row.digest, calls] })
    expect(await reverts('robinhood', env.config.robinhood.executor, again)).toBe(true)
    expect(await spokeSupply()).toBe(20_000n * E6)
    await reconciled('replay')
  })

  test_('authenticated credit: tampered signature, wrong emitter, wrong guardian, direct manager attestation and direct mint are all refused', async () => {
    const X = env.config.robinhood.executor
    // A fresh debit whose message is authentic, so every forgery below is derived from a real one.
    route.transfer('out-forge', 'outbound', 7n * E6, X)
    expect(await route.advance('out-forge')).toBe('awaiting_finality')
    await client('arc').mine({ blocks: 5 })
    const debit = await client('arc').getTransactionReceipt({ hash: route.get('out-forge')!.debitTx! })
    const block = await client('arc').getBlock({ blockNumber: debit.blockNumber })
    const [message] = publishedFrom(debit.logs, env.config.arc.core, env.config.arc.wormholeChainId, Number(block.timestamp))
    const T = route.layout.spokeManager.transceiver
    const receive = (vaa: Hex) => encodeFunctionData({ abi: transceiverAbi, functionName: 'receiveMessage', args: [vaa] })
    const genuine = (await localGuardian(DEV.guardian, env.guardianSets.robinhood).signed(message))!
    const tampered = `${genuine.slice(0, 30)}${genuine[30] === '0' ? '1' : '0'}${genuine.slice(31)}` as Hex
    const wrongEmitter = (await localGuardian(DEV.guardian, env.guardianSets.robinhood).signed({ ...message, emitter: `0x${'0'.repeat(61)}bad` }))!
    const wrongGuardian = (await localGuardian(DEV.payer, env.guardianSets.robinhood).signed(message))!
    const wrongChain = (await localGuardian(DEV.guardian, env.guardianSets.robinhood).signed({ ...message, emitterChain: 10004 }))!
    const refused = {
      tamperedSignature: await reverts('robinhood', T, receive(tampered)),
      wrongEmitter: await reverts('robinhood', T, receive(wrongEmitter)),
      wrongGuardian: await reverts('robinhood', T, receive(wrongGuardian)),
      unpeeredChain: await reverts('robinhood', T, receive(wrongChain)),
      directMint: await reverts('robinhood', route.layout.spoke, encodeFunctionData({ abi: parseAbi(['function mint(address,uint256)']), functionName: 'mint', args: [operator.address, 1n] })),
      rebindMinter: await reverts('robinhood', route.layout.spoke, encodeFunctionData({ abi: spokeAbi, functionName: 'setMinter', args: [route.layout.spokeManager.proxy] })),
    }
    evidence.forgeries = refused
    expect(Object.values(refused).every(Boolean)).toBe(true)
    // The genuine VAA still credits through the route after all forgeries failed.
    expect(await route.advance('out-forge')).toBe('credited')
    expect(await spokeSupply()).toBe(20_007n * E6)
    await reconciled('forgeries')
  })

  test_('pool and executable quote: the real v3 factory accepts the spoke, and QuoterV2 matches a real SwapRouter02 fill exactly', async () => {
    await route.seedPool(5_000n * E6, 10n * E6)
    const pool = await route.pool()
    expect(pool).not.toBe('0x0000000000000000000000000000000000000000')
    expect(await balance('robinhood', route.layout.spoke, pool)).toBe(5_000n * E6)
    expect(await balance('robinhood', ROBINHOOD_MAINNET.usdgFixture, pool)).toBe(10n * E6)
    await creditUsdg(env.config.robinhood.rpc, trader.address, 1_000n * E6)
    const q = await route.quote(1n * E6, 'quote')
    expect(q.amountOut > 0n).toBe(true)
    const w = wallet('robinhood', TRADER)
    const router = ROBINHOOD_MAINNET.venue.swapRouter02
    await client('robinhood').waitForTransactionReceipt({ hash: await w.writeContract({ account: trader, chain: null, address: ROBINHOOD_MAINNET.usdgFixture, abi: erc20Abi, functionName: 'approve', args: [router, 1n * E6] }) })
    const hash = await w.writeContract({ account: trader, chain: null, address: router, abi: routerAbi, functionName: 'exactInputSingle',
      args: [{ tokenIn: ROBINHOOD_MAINNET.usdgFixture, tokenOut: route.layout.spoke, fee: 3000, recipient: trader.address, amountIn: 1n * E6, amountOutMinimum: q.amountOut, sqrtPriceLimitX96: 0n }] })
    expect((await client('robinhood').waitForTransactionReceipt({ hash })).status).toBe('success')
    const filled = await balance('robinhood', route.layout.spoke, trader.address)
    expect(filled).toBe(q.amountOut)
    // A swap moves existing representation; it never issues supply.
    expect(await spokeSupply()).toBe(20_007n * E6)
    evidence.market = { pool, seeded: { spoke: (5_000n * E6).toString(), usdgFixture: (10n * E6).toString() }, quote: json(q), filled: filled.toString(), swapTx: hash }
    await reconciled('pool-and-swap')
  })

  test_('return Robinhood -> Arc: a worker SIGKILLed right after sending the debit is recovered by a restart without a second debit', async () => {
    const arcX = env.config.arc.executor
    route.transfer('ret-1', 'return', 1_000n * E6, arcX)
    const before = { arc: await balance('arc', route.layout.canonical, arcX), spoke: await spokeSupply() }
    const crashed = await worker('ret-1', 'kill-after-send:transfer:ret-1:debit')
    expect(crashed.signal).toBe('SIGKILL')
    // The debit reached the node, but the journal never learned it: state is still planned, no tx recorded.
    expect(route.get('ret-1')!.state).toBe('planned')
    expect(db.query<{ tx: string | null }, [Hex]>('SELECT tx FROM robinhood_ops WHERE operation=?').get(route.layout.op('transfer:ret-1:debit'))!.tx).toBeNull()
    const inFlight = { latest: await route.digestOf('robinhood', route.layout.op('transfer:ret-1:debit')), pending: await route.digestOf('robinhood', route.layout.op('transfer:ret-1:debit'), 'pending') }
    expect(inFlight.pending).not.toBe(`0x${'0'.repeat(64)}`)
    const nonceAfterCrash = await client('robinhood').getTransactionCount({ address: operator.address, blockTag: 'pending' })
    // Restart: a new process over the same journal, possibly while the orphaned debit is still pending.
    const restarted = await worker('ret-1', 'none')
    expect(await spokeSupply()).toBe(before.spoke - 1_000n * E6)
    expect(lastLine(restarted.out).progress).toBe('awaiting_finality')
    await client('robinhood').mine({ blocks: 3 })
    const finished = await worker('ret-1', 'none')
    expect(lastLine(finished.out)).toEqual({ ok: true, progress: 'credited' })
    expect(await executions('robinhood', 'transfer:ret-1:debit')).toBe(1)
    expect(await executions('arc', 'transfer:ret-1:credit')).toBe(1)
    // One debit transaction in total: the restart waited for the orphan instead of sending its own.
    expect(await client('robinhood').getTransactionCount({ address: operator.address, blockTag: 'latest' })).toBe(nonceAfterCrash)
    expect(await balance('arc', route.layout.canonical, arcX)).toBe(before.arc + 1_000n * E6)
    evidence.crashRecovery = { killedWith: crashed.signal, orphanedDebitAtRestart: inFlight, operatorRobinhoodNonce: nonceAfterCrash, debitExecutions: 1, creditExecutions: 1, restarted: restarted.out, finished: finished.out }
    await reconciled('return-after-crash')
  })

  test_('stale and concurrent workers: a stale journal copy and a racing process cannot credit twice', async () => {
    const X = env.config.robinhood.executor
    route.transfer('out-2', 'outbound', 3n * E6, X)
    expect(await route.advance('out-2')).toBe('awaiting_finality')
    // A stale worker keeps a snapshot of the journal from before the credit.
    const stalePath = join(dir, 'stale.sqlite')
    db.exec(`VACUUM INTO '${stalePath}'`)
    await client('arc').mine({ blocks: 5 })
    // Two workers race the same transfer: this process and a separate one.
    const [here, there] = await Promise.all([route.advance('out-2'), worker('out-2', 'none')])
    expect(here).toBe('credited')
    expect(lastLine(there.out).ok).toBe(true)
    // The stale worker resumes from its old view and must find the credit already executed.
    const stale = robinhoodRoute(env.config, new Database(stalePath))
    expect(stale.get('out-2')!.state).toBe('debited')
    expect(await stale.advance('out-2')).toBe('credited')
    expect(await executions('arc', 'transfer:out-2:debit')).toBe(1)
    expect(await executions('robinhood', 'transfer:out-2:credit')).toBe(1)
    expect(await balance('robinhood', route.layout.spoke, X)).toBe((20_007n - 5_000n - 1_000n + 3n) * E6)
    evidence.staleWorkers = { racing: [here, there.out], stale: 'credited without a second execution', creditExecutions: 1 }
    await reconciled('stale-workers')
  })

  test_('round trip closes: everything returned to Arc leaves custody exactly equal to remaining spoke supply', async () => {
    const X = env.config.robinhood.executor
    const held = await balance('robinhood', route.layout.spoke, X)
    route.transfer('ret-all', 'return', held, env.config.arc.executor)
    expect(await route.advance('ret-all')).toBe('awaiting_finality')
    await client('robinhood').mine({ blocks: 3 })
    expect(await route.advance('ret-all')).toBe('credited')
    const s = await reconciled('final')
    // What remains on Robinhood is exactly the pool's and the trader's tokens, all backed by custody.
    expect(s.spokeSupply).toBe(await balance('robinhood', route.layout.spoke, await route.pool()) + await balance('robinhood', route.layout.spoke, trader.address))
    expect(s.custody).toBe(s.spokeSupply)
    evidence.transfers = ['out-1', 'out-forge', 'ret-1', 'out-2', 'ret-all'].map((id) => json(route.get(id)))
  })
})
