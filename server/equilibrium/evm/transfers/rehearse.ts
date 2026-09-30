/**
 * FORK REHEARSAL evidence pack for transfers. Starts the pinned forks, runs one launch whose Base
 * pool is funded ONLY by a CCTP refill, returns EQUILIBRIUM from Base to Arc from both sources, and
 * writes what happened: finalized supply snapshots, every operation's transaction and gas, and the
 * fork substitutions in force. Nothing touches a public chain; every key is an anvil development key.
 *
 *   bun run equilibrium:transfers-rehearse [--out output/equilibrium/transfers-evidence.json]
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { JobStore } from '../../store'
import { quote, runJob } from '../../runner'
import { erc20Abi, nttAbi, universal } from '../contracts'
import { DEV, PINNED, forkEnvironment } from '../fork'
import { evmAdapter, layout } from '../adapter'
import { request, signedPayment } from '../__tests__/harness'
import { transferRoutes } from './config'
import { FORK_ATTESTER_KEY, forkCctp } from './fork'
import { conservation } from './returns'
import { createTransfer, publicTransfer, runTransfer } from './runner'
import { TransferStore } from './store'
import type { Transfer } from './types'

const flags = process.argv.slice(2)
const out = flags.includes('--out') ? flags[flags.indexOf('--out') + 1] : './output/equilibrium/transfers-evidence.json'
const HOLDER_KEY = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as Hex
const holder = privateKeyToAccount(HOLDER_KEY)
const now = () => Math.floor(Date.now() / 1000)
const env = await forkEnvironment({ arcPort: 18585, basePort: 18586, baseUsdc: 0n })
mkdirSync(join(process.cwd(), 'output'), { recursive: true })
const dir = mkdtempSync(join(process.cwd(), 'output', 'rehearse-'))
try {
  await forkCctp(env.arc.url, env.base.url)
  const clients = { arc: createPublicClient({ transport: http(env.arc.url) }), base: createPublicClient({ transport: http(env.base.url) }) }
  const gas = async (chain: 'arc' | 'base', tx: string) => (await clients[chain].getTransactionReceipt({ hash: tx as Hex })).gasUsed.toString()
  const jobs = new JobStore(join(dir, 'jobs.sqlite'))
  const transfers = new TransferStore(jobs.db)
  const routes = transferRoutes(env.config, { returns: { maxPerTransfer: '5000000000' }, refill: { attestation: { kind: 'local-attester' }, maxPerTransfer: '20000000', maxTotal: '20000000' } },
    jobs.db, (id) => jobs.get(id), { EQUILIBRIUM_FORK_ATTESTER_KEY: FORK_ATTESTER_KEY })
  const adapter = evmAdapter(env.config, jobs.db)
  const steps = async (t: Transfer) => Promise.all(t.steps.map(async (s) => ({ ...s.result!, id: s.id, gasUsed: s.result!.by === 'executor' ? await gas(s.chain, s.result!.transaction) : null })))

  // 1. Launch until the Base pool needs quote inventory the Base executor does not have.
  const job = quote(jobs, adapter, request('rehearse-launch-01', now(), holder.address.toLowerCase() as Address), now())
  const stalled = await runJob(jobs, adapter, job.id, await signedPayment(job)).catch(() => jobs.get(job.id)!)
  // 2. Refill that inventory from the payment USDC held on Arc, over CCTP.
  const refill = await runTransfer(transfers, routes.refill!, (await createTransfer(transfers, routes.refill!, { kind: 'refill', requestId: 'rehearse-refill-01', from: 'arc', to: 'base', amount: job.request.destinations[1].poolQuote, maxFee: '0' }, now())).id)
  // 3. The launch resumes and completes.
  const launch = await runJob(jobs, adapter, job.id)
  const afterLaunch = await conservation(routes.sender, env.config, launch)
  // 4. Return from operator inventory and from a holder's own burn.
  const L = layout(launch, env.config)
  const holderWallet = createWalletClient({ account: holder, transport: http(env.base.url) })
  const testBase = createPublicClient({ transport: http(env.base.url) })
  await fetch(env.base.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_setBalance', params: [holder.address, '0xde0b6b3a7640000'] }) })
  const send = async (hash: Promise<Hex>) => testBase.waitForTransactionReceipt({ hash: await hash })
  await send(holderWallet.writeContract({ chain: null, address: L.spoke, abi: erc20Abi, functionName: 'transfer', args: [env.config.base.executor, 1_000_000_000n] }))
  const fromExecutor = await runTransfer(transfers, routes.returns, (await createTransfer(transfers, routes.returns, { kind: 'return', source: 'executor', requestId: 'rehearse-return-01', launch: launch.id, amount: '1000000000', recipient: holder.address }, now())).id)
  await send(holderWallet.writeContract({ chain: null, address: L.spoke, abi: erc20Abi, functionName: 'approve', args: [L.spokeManager.proxy, 500_000_000n] }))
  const burn = await send(holderWallet.writeContract({ chain: null, address: L.spokeManager.proxy, abi: nttAbi, functionName: 'transfer', args: [500_000_000n, PINNED.arc.wormholeChainId, universal(holder.address)] }))
  const fromHolder = await runTransfer(transfers, routes.returns, (await createTransfer(transfers, routes.returns, { kind: 'return', source: 'holder', launch: launch.id, transaction: burn.transactionHash }, now())).id)
  const afterReturns = await conservation(routes.sender, env.config, launch)

  const evidence = {
    label: 'FORK REHEARSAL — not testnet or live evidence',
    generatedAt: new Date().toISOString(),
    forks: { arc: { chainId: PINNED.arc.chainId, block: PINNED.arc.block.toString() }, base: { chainId: PINNED.base.chainId, block: PINNED.base.block.toString() } },
    substitutions: [
      'Wormhole Guardian set on both cores replaced by one local key (fork.ts)',
      'Arc USDC at 0x3600… replaced by an EIP-3009 stand-in with CCTP mint/burn (ForkUsdc → ForkUsdcCctp)',
      'Circle CCTP V2 attester set on both MessageTransmitterV2 contracts replaced by one local key, threshold 1 (transfers/fork.ts)',
      'Base executor starts with ZERO USDC: no storage-funded inventory in this rehearsal',
    ],
    operator: privateKeyToAccount(DEV.operator).address, executors: { arc: env.config.arc.executor, base: env.config.base.executor },
    launch: { id: launch.id, state: launch.state, stalledAt: stalled.steps.filter((s) => s.state !== 'complete').map((s) => s.id), steps: launch.steps.map((s) => ({ id: s.id, transaction: s.result?.transaction, cost: s.result?.cost })) },
    refill: { ...publicTransfer(refill), steps: await steps(refill) },
    returns: [fromExecutor, fromHolder].map((t) => ({ source: (t.request as { source: string }).source, state: t.state })),
    returnSteps: { executor: await steps(fromExecutor), holder: await steps(fromHolder) },
    supply: { afterLaunch, afterReturns },
    checks: {
      launchComplete: launch.state === 'complete',
      refillFundedBasePool: refill.state === 'complete' && stalled.steps.some((s) => s.id === 'pool:base' && s.state !== 'complete'),
      returnsComplete: fromExecutor.state === 'complete' && fromHolder.state === 'complete',
      conservedAfterLaunch: afterLaunch.conserved && afterLaunch.inFlight === '0',
      conservedAfterReturns: afterReturns.conserved && afterReturns.inFlight === '0' && BigInt(afterLaunch.custody) - BigInt(afterReturns.custody) === 1_500_000_000n,
    },
  }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify({ out, checks: evidence.checks }, null, 2))
  jobs.close()
  if (!Object.values(evidence.checks).every(Boolean)) process.exitCode = 1
} finally { env.stop(); rmSync(dir, { recursive: true, force: true }) }
