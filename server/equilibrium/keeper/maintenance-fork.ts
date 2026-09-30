/** Fork-only combined fixture: the keeper trades the launch's real NTT canonical/spoke assets. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createPublicClient, createWalletClient, getAddress, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { JobStore } from '../store'
import { quote, runJob } from '../runner'
import { evmAdapter, layout } from '../evm/adapter'
import { toFile as adapterToFile } from '../evm/config'
import { coreAbi, erc20Abi } from '../evm/contracts'
import { DEV, forkEnvironment } from '../evm/fork'
import { request, signedPayment } from '../evm/__tests__/harness'
import { transferRoutes, type TransferSettings } from '../evm/transfers/config'
import { FORK_ATTESTER_KEY, forkCctp } from '../evm/transfers/fork'
import { createTransfer, runTransfer } from '../evm/transfers/runner'
import { TransferStore } from '../evm/transfers/store'
import { keeperInit } from './contracts'
import { toFile } from './config'
import type { KeeperChain, KeeperConfig } from './types'

export const MAINTENANCE_TOKENS = 100_000_000n
export const MAINTENANCE_REQUEST = { requestId: 'keeper-refill-001', tokens: '500000000', quote: '3000000' }

export async function maintenanceForkEnvironment() {
  const env = await forkEnvironment({ arcPort: 18765, basePort: 18766, baseUsdc: 0n })
  mkdirSync('output', { recursive: true })
  const dir = mkdtempSync(join(process.cwd(), 'output', 'keeper-maintenance-'))
  const path = join(dir, 'combined.sqlite')
  const jobs = new JobStore(path)
  try {
    await forkCctp(env.arc.url, env.base.url)
    const operator = privateKeyToAccount(DEV.operator)
    const clients = {
      arc: createPublicClient({ transport: http(env.arc.url) }),
      base: createPublicClient({ transport: http(env.base.url) }),
    }
    const wallets = {
      arc: createWalletClient({ account: operator, transport: http(env.arc.url) }),
      base: createWalletClient({ account: operator, transport: http(env.base.url) }),
    }
    const settings: TransferSettings = {
      returns: { maxPerTransfer: '500000000' },
      refill: { attestation: { kind: 'local-attester' }, maxPerTransfer: '6000000', maxTotal: '12000000' },
      operatorGas: { arc: '100000000000000000', base: '1000000000000000' },
    }
    const routes = transferRoutes(env.config, settings, jobs.db, (id) => jobs.get(id), { EQUILIBRIUM_FORK_ATTESTER_KEY: FORK_ATTESTER_KEY })
    const adapter = evmAdapter(env.config, jobs.db)
    const raw = request('keeper-maint-launch', Math.floor(Date.now() / 1000), operator.address)
    // Controlled gap: Base is cheaper, so token return restores Arc sale inventory and CCTP restores Base buy cash.
    raw.destinations[1].poolQuote = '5000000'
    const job = quote(jobs, adapter, raw, Math.floor(Date.now() / 1000))
    await runJob(jobs, adapter, job.id, await signedPayment(job)).catch(() => jobs.get(job.id)!)
    const funding = await createTransfer(new TransferStore(jobs.db), routes.refill!, {
      kind: 'refill', requestId: 'keeper-pool-setup', from: 'arc', to: 'base', amount: '5000000', maxFee: '0',
    }, Math.floor(Date.now() / 1000))
    await runTransfer(new TransferStore(jobs.db), routes.refill!, funding.id)
    const launch = await runJob(jobs, adapter, job.id)
    if (launch.state !== 'complete') throw new Error('The fork launch did not complete after authenticated pool funding.')
    const L = layout(launch, env.config)
    const tokens = { arc: L.canonical, base: L.spoke }
    const vaults = {} as Record<KeeperChain, `0x${string}`>
    for (const chain of ['arc', 'base'] as const) {
      const pool = getAddress(launch.steps.find((step) => step.id === `pool:${chain}`)!.result!.address!)
      const tx = await wallets[chain].sendTransaction({ account: operator, chain: null, data: keeperInit({
        owner: operator.address, token: tokens[chain], quote: env.config[chain].usdc, pool,
        venue: chain === 'arc' ? 'architex-pair' : 'uniswap-v3-pool',
        maxTokensPerLeg: 200_000_000n, maxQuotePerLeg: 1_000_000n, spendCap: 5_000_000n,
        recoveryReserve: 1_000_000n, drainCap: 5_000_000n, maxOpenCycles: 1,
      }) })
      const receipt = await clients[chain].waitForTransactionReceipt({ hash: tx })
      if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Keeper vault deployment failed.')
      vaults[chain] = receipt.contractAddress
    }
    // Existing operator-owned, already-issued spoke inventory goes to its own executor before the experiment.
    // Neither keeper vault receives a direct setup deposit; the maintenance must restore both from zero.
    const stock = await wallets.base.writeContract({ account: operator, chain: null, address: L.spoke, abi: erc20Abi,
      functionName: 'transfer', args: [env.config.base.executor, 500_000_000n] })
    await clients.base.waitForTransactionReceipt({ hash: stock })
    const chainConfig = (chain: KeeperChain) => ({
      chain, rpc: env[chain].url, chainId: env.config[chain].chainId, keeper: vaults[chain], token: tokens[chain], quote: env.config[chain].usdc,
      pool: getAddress(launch.steps.find((step) => step.id === `pool:${chain}`)!.result!.address!),
      venue: chain === 'arc' ? 'architex-pair' as const : 'uniswap-v3-pool' as const,
      finality: 0, fromBlock: env.config[chain].fromBlock, quoteAtomsPerNative: env.config[chain].usdcAtomsPerNative,
      priorityFeeWei: env.config[chain].priorityFeeWei, opStackL1Fee: env.config[chain].opStackL1Fee,
    })
    const config: KeeperConfig = {
      mode: 'fork', operatorKey: DEV.operator, arc: chainConfig('arc'), base: chainConfig('base'),
      policy: { maxTokens: '200000000', minEdge: '1000', buffer: '1000', spendCap: '5000000', lossCap: '2000000',
        recoveryReserve: '1000000', recoveryCost: '10000', maxLegCost: '100000', maxQuoteAgeSeconds: 600,
        maxBlockLag: 20, maxHeadAgeSeconds: 3600, legTtlSeconds: 600, slippageBps: 50, maxOpenCycles: 1 },
      maintenance: { launch: launch.id, executors: { arc: env.config.arc.executor, base: env.config.base.executor },
        maxTokenPerTransfer: MAINTENANCE_REQUEST.tokens, maxTokenTotal: MAINTENANCE_REQUEST.tokens,
        maxQuotePerTransfer: MAINTENANCE_REQUEST.quote, maxQuoteTotal: MAINTENANCE_REQUEST.quote },
    }
    const index = Number(await clients.arc.readContract({ address: env.config.arc.core, abi: coreAbi, functionName: 'getCurrentGuardianSetIndex' }))
    return {
      env, jobs, dir, path, config, launch, clients, operator, settings,
      texts: { keeperConfigText: JSON.stringify(toFile(config), null, 2) + '\n', adapterConfigText: JSON.stringify(adapterToFile(env.config, index), null, 2) + '\n', transferSettingsText: JSON.stringify(settings, null, 2) + '\n' },
      keys: { EQUILIBRIUM_OPERATOR_KEY: DEV.operator, EQUILIBRIUM_FORK_GUARDIAN_KEY: DEV.guardian, EQUILIBRIUM_FORK_ATTESTER_KEY: FORK_ATTESTER_KEY },
      async nonces() { return { arc: await clients.arc.getTransactionCount({ address: operator.address, blockTag: 'pending' }), base: await clients.base.getTransactionCount({ address: operator.address, blockTag: 'pending' }) } },
      async balance(chain: KeeperChain, asset: 'token' | 'quote') { return clients[chain].readContract({ address: config[chain][asset], abi: erc20Abi, functionName: 'balanceOf', args: [config[chain].keeper] }) },
      stop() { jobs.close(); env.stop(); rmSync(dir, { recursive: true, force: true }) },
    }
  } catch (cause) { jobs.close(); env.stop(); rmSync(dir, { recursive: true, force: true }); throw cause }
}
