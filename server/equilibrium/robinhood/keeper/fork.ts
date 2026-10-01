import { createTestClient, createWalletClient, encodeFunctionData, http, parseAbi, publicActions, zeroAddress, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { once } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { CODE, linked, architexFactoryAbi, architexPairAbi, erc20Abi } from '../../evm/contracts'
import { DEV, PINNED } from '../../evm/fork'
import { robinhoodForkEnvironment, configFromJson, configToJson } from '../fork'
import { robinhoodRoute } from '../route'
import { keeperInit } from './contracts'
import { FORK_POLICY } from '../../keeper/fork'
import { KeeperStore } from './store'
import type { KeeperChain, KeeperConfig } from './types'

export const LABELS = [
  'mixed:arc-testnet-fork+robinhood-mainnet-fork; not a public route',
  'local Guardian threshold 1; public attestation unproven',
  'Arc ForkUsdc replaces native precompile settlement',
  'USDG provisional; pre-positioned by fork storage write; no quote refill',
  'USDG valuation fixture: 0.98 USDC per USDG, not parity or an FX execution proof',
  'native gas fixture: 5000 USDC/ETH; Robinhood L1 allowance synthetic, not measured',
  'development-key native balances; no public signing, funding or deployments',
  'finality: two locally mined confirmations, not public Guardian latency',
] as const
export const SCOPE = { maxPerTransfer: '4000000000', maxTotal: '16000000000' }
export const stringify = (value: unknown) => JSON.stringify(value, (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v, 2)
export function keeperFromJson(text: string): KeeperConfig {
  const c = JSON.parse(text) as KeeperConfig
  for (const side of ['arc', 'robinhood'] as const) {
    c[side].fromBlock = BigInt(c[side].fromBlock)
    c[side].quoteAtomsPerNative = BigInt(c[side].quoteAtomsPerNative)
    if (c[side].priorityFeeWei !== undefined) c[side].priorityFeeWei = BigInt(c[side].priorityFeeWei)
  }
  return c
}
export { configFromJson, configToJson }

export async function keeperFork(path: string) {
  const env = await robinhoodForkEnvironment({ arcPort: 18945, robinhoodPort: 18946, usdg: 400_000_000_000n, assetId: '49th-40-robinhood-keeper' })
  const children = [env.arc.process, env.robinhood.process]
  const stop = async () => {
    await Promise.all(children.map(async (child: ChildProcess) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited
    }))
  }
  const store = new KeeperStore(path)
  try {
    const config = env.config
    config.arc.priorityFeeWei = 0n; config.robinhood.priorityFeeWei = 0n
    const account = privateKeyToAccount(DEV.operator)
    const tests = {
      arc: createTestClient({ mode: 'anvil', transport: http(env.arc.url) }).extend(publicActions),
      robinhood: createTestClient({ mode: 'anvil', transport: http(env.robinhood.url) }).extend(publicActions),
    }
    const wallets = {
      arc: createWalletClient({ account, transport: http(env.arc.url) }),
      robinhood: createWalletClient({ account, transport: http(env.robinhood.url) }),
    }
    const deploy = async (side: KeeperChain, data: Hex) => {
      const tx = await wallets[side].sendTransaction({ account, chain: null, data })
      const r = await tests[side].waitForTransactionReceipt({ hash: tx })
      if (!r.contractAddress || r.status !== 'success') throw new Error('Fork deployment failed')
      return r.contractAddress
    }
    const send = async (side: KeeperChain, to: Address, data: Hex) => {
      const tx = await wallets[side].sendTransaction({ account, chain: null, to, data, maxPriorityFeePerGas: 0n })
      const r = await tests[side].waitForTransactionReceipt({ hash: tx })
      if (r.status !== 'success') throw new Error(`Fork setup reverted ${tx}`)
    }
    const substitute = await deploy('arc', linked(CODE.ForkUsdc))
    await tests.arc.setCode({ address: PINNED.arc.usdc, bytecode: (await tests.arc.getCode({ address: substitute }))! })
    await send('arc', PINNED.arc.usdc, encodeFunctionData({ abi: parseAbi(['function mint(address,uint256)']), functionName: 'mint', args: [config.arc.executor, 700_000_000_000n] }))
    const route = robinhoodRoute(config, store.db)
    await route.deployHub(); await route.deploySpoke()
    route.transfer('bootstrap-49th40', 'outbound', 350_000_000_000n, config.robinhood.executor)
    await route.advance('bootstrap-49th40')
    await route.seedPool(300_000_000_000n, 360_000_000_000n)
    const L = route.layout
    const call = (target: Address, data: Hex) => ({ target, data, value: '0' })
    await route.execute('pool:arc', 'arc', () => [call(PINNED.arc.factory, encodeFunctionData({ abi: architexFactoryAbi, functionName: 'createPair', args: [L.canonical, PINNED.arc.usdc] }))])
    const arcPool = await tests.arc.readContract({ address: PINNED.arc.factory, abi: architexFactoryAbi, functionName: 'getPair', args: [L.canonical, PINNED.arc.usdc] })
    if (arcPool === zeroAddress) throw new Error('Arc pair absent')
    await route.execute('seed:arc', 'arc', () => [
      call(L.canonical, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [arcPool, 300_000_000_000n] })),
      call(PINNED.arc.usdc, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [arcPool, 300_000_000_000n] })),
      call(arcPool, encodeFunctionData({ abi: architexPairAbi, functionName: 'mint', args: [config.arc.executor] })),
    ])
    const rhPool = await route.pool()
    const vaults = {} as Record<KeeperChain, Address>
    const expiresAt = Math.floor(Date.now() / 1000) + 86_400
    for (const side of ['arc', 'robinhood'] as const) {
      const ratioN = side === 'arc' ? 100n : 98n
      vaults[side] = await deploy(side, keeperInit({ owner: account.address, token: side === 'arc' ? L.canonical : L.spoke, quote: side === 'arc' ? PINNED.arc.usdc : config.robinhood.quote, pool: side === 'arc' ? arcPool : rhPool, venue: side === 'arc' ? 'architex-pair' : 'uniswap-v3-pool', maxTokensPerLeg: 2_000_000_000n, maxQuotePerLeg: 3_000_000_000n, spendCap: 5_000_000_000n * 100n / ratioN, recoveryReserve: (1_500_000_000n * 100n + ratioN - 1n) / ratioN, drainCap: 4_000_000_000n, maxOpenCycles: 1 }))
      await route.execute(`inventory:${side}`, side, () => [
        ...(side === 'arc' ? [call(L.canonical, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [vaults.arc, 4_000_000_000n] }))] : []),
        call(side === 'arc' ? PINNED.arc.usdc : config.robinhood.quote, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [vaults[side], 8_000_000_000n] })),
      ])
      await tests[side].setNextBlockTimestamp({ timestamp: BigInt(Math.floor(Date.now() / 1000)) })
      await tests[side].mine({ blocks: 3, interval: 1 })
    }
    config.arc.confirmations = 2; config.robinhood.confirmations = 2
    const chain = (side: KeeperChain) => ({ chain: side, rpc: config[side].rpc, chainId: config[side].chainId, keeper: vaults[side], token: side === 'arc' ? L.canonical : L.spoke, quote: side === 'arc' ? PINNED.arc.usdc : config.robinhood.quote, pool: side === 'arc' ? arcPool : rhPool, venue: side === 'arc' ? 'architex-pair' as const : 'uniswap-v3-pool' as const, finality: 2, fromBlock: config[side].fromBlock, quoteAtomsPerNative: side === 'arc' ? 1_000_000n : 5_000_000_000n, priorityFeeWei: 0n, valuation: { numerator: side === 'arc' ? '100' : '98', denominator: '100', source: '49TH-40 explicit valuation fixture', expiresAt }, feeInput: { kind: 'fork-fixture' as const, l1UpperWei: side === 'arc' ? '0' : '1000000000000', source: '49TH-40 synthetic L1 upper allowance; not a Robinhood fee model', expiresAt } })
    const keeperConfig: KeeperConfig = { mode: 'fork', operatorKey: DEV.operator, arc: chain('arc'), robinhood: chain('robinhood'), policy: { ...FORK_POLICY, operatingCap: '30000000', maxBlockLag: 40, lossCap: '200000000' }, receiptTimeoutMs: 10_000 }
    return { env, routeConfig: config, keeperConfig, store, tests, route, stop }
  } catch (cause) { store.close(); await stop(); throw cause }
}
