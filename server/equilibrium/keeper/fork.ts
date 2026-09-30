/**
 * KEEPER FORK REHEARSAL HARNESS. Two anvil forks of the real public testnets at the same pinned
 * blocks the launch rehearsal uses: Arc testnet and Base Sepolia. The venues are the deployed ones —
 * the real Architex factory and pair code on Arc, the real Uniswap v3 factory and pool code and the
 * real Base Sepolia USDC on Base — so every quote and every swap here is against the bytecode that
 * is actually live.
 *
 * Fork-only substitutions, all local, none of them touching a public chain:
 *
 * 1. Arc's native USDC reads balances through Arc precompiles anvil does not implement, so the Arc
 *    fork runs `ForkUsdc` at 0x3600… with the same name, version and six decimals (as in evm/fork.ts).
 * 2. Base Sepolia USDC is credited by storage write. That stands in for funding, not for a bridge
 *    credit or a CCTP refill: the keeper has no mint, bridge or refill power of any kind.
 * 3. The Base-side token is an `EquilibriumCanonical` standing in for the bridged representation.
 *    Supply conservation across the bridge is the launch adapter's scope, not the keeper's; the
 *    keeper never mints, burns, bridges or rebases, and trades only its own vault inventory.
 *
 * Pools are seeded through `EquilibriumExecutor` on Base, exactly the way a launch seeds them, so the
 * pool the keeper quotes is shaped like the one a launch produces.
 */
import {
  createPublicClient, createTestClient, createWalletClient, encodeAbiParameters, encodeFunctionData, http, keccak256,
  numberToHex, pad, parseAbi, publicActions, zeroAddress, type Address, type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { CODE, architexFactoryAbi, architexPairAbi, erc20Abi as evmErc20Abi, executorAbi, linked, v3FactoryAbi, v3PoolAbi, withArgs } from '../evm/contracts'
import { DEV, PINNED, startFork, type Fork } from '../evm/fork'
import { plan as v3Plan } from '../evm/v3'
import { keeperInit } from './contracts'
import type { KeeperChain, KeeperChainConfig, KeeperConfig, KeeperPolicy } from './types'

/** FiatToken v2 keeps balances in mapping slot 9. */
const FIAT_TOKEN_BALANCE_SLOT = 9n
const V3_FEE = 3000
const V3_TICK_SPACING = 60
const ISSUANCE = 1_000_000_000_000n

/** Vault bounds, in six-decimal atoms. The rehearsal's numbers, not live campaign parameters. */
export const FORK_BOUNDS = {
  maxTokensPerLeg: 2_000_000_000n,
  maxQuotePerLeg: 3_000_000_000n,
  spendCap: 4_000_000_000n,
  recoveryReserve: 1_500_000_000n,
  drainCap: 4_000_000_000n,
  maxOpenCycles: 1,
} as const

export const FORK_POLICY: KeeperPolicy = {
  maxTokens: FORK_BOUNDS.maxTokensPerLeg.toString(),
  minEdge: '1000000',
  buffer: '500000',
  spendCap: FORK_BOUNDS.spendCap.toString(),
  lossCap: '200000000',
  recoveryReserve: FORK_BOUNDS.recoveryReserve.toString(),
  recoveryCost: '2000000',
  maxLegCost: '1000000',
  maxQuoteAgeSeconds: 600,
  maxBlockLag: 20,
  maxHeadAgeSeconds: 3_600,
  legTtlSeconds: 600,
  slippageBps: 50,
  maxOpenCycles: FORK_BOUNDS.maxOpenCycles,
}

/** Pool inventory, chosen so Arc prices EQL near 1.00 USDC and Base near 1.20. */
export const FORK_POOLS = {
  arc: { tokens: 500_000_000_000n, quote: 500_000_000_000n },
  base: { tokens: 500_000_000_000n, quote: 600_000_000_000n },
} as const
/** Keeper vault inventory on each chain. */
export const FORK_INVENTORY = { tokens: 2_000_000_000n, quote: 5_000_000_000n } as const

function clients(url: string, key: Hex = DEV.operator) {
  const account = privateKeyToAccount(key)
  return {
    test: createTestClient({ mode: 'anvil', transport: http(url) }).extend(publicActions),
    wallet: createWalletClient({ account, transport: http(url) }),
    account,
  }
}

async function send(url: string, to: Address, data: Hex, value = 0n): Promise<Hex> {
  const { wallet, test, account } = clients(url)
  // Call first, so a setup failure reports the venue's own revert instead of a bare status 0.
  await test.call({ account, to, data, value })
  const hash = await wallet.sendTransaction({ account, chain: null, to, data, value })
  const receipt = await test.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`Fork setup call to ${to} reverted in ${hash}`)
  return hash
}

async function deploy(url: string, init: Hex): Promise<Address> {
  const { wallet, test, account } = clients(url)
  const hash = await wallet.sendTransaction({ account, chain: null, data: init })
  const receipt = await test.waitForTransactionReceipt({ hash })
  if (!receipt.contractAddress || receipt.status !== 'success') throw new Error('Fork setup deployment failed')
  return receipt.contractAddress
}

const tokenInit = (recipient: Address) =>
  withArgs(linked(CODE.EquilibriumCanonical), [{ type: 'string' }, { type: 'string' }, { type: 'address' }, { type: 'uint64' }], ['Equilibrium', 'EQL', recipient, ISSUANCE])

async function seedArcPool(url: string, token: Address, usdc: Address): Promise<Address> {
  const { test, account } = clients(url)
  await send(url, PINNED.arc.factory, encodeFunctionData({ abi: architexFactoryAbi, functionName: 'createPair', args: [token, usdc] }))
  const pair = await test.readContract({ address: PINNED.arc.factory, abi: architexFactoryAbi, functionName: 'getPair', args: [token, usdc] })
  if (pair === zeroAddress) throw new Error('Arc pair was not created')
  await send(url, token, encodeFunctionData({ abi: evmErc20Abi, functionName: 'transfer', args: [pair, FORK_POOLS.arc.tokens] }))
  await send(url, usdc, encodeFunctionData({ abi: evmErc20Abi, functionName: 'transfer', args: [pair, FORK_POOLS.arc.quote] }))
  await send(url, pair, encodeFunctionData({ abi: architexPairAbi, functionName: 'mint', args: [account.address] }))
  return pair
}

/** Seeded through the executor's v3 mint callback, the same path a launch's `pool:base` step uses. */
async function seedBasePool(url: string, executor: Address, token: Address, usdc: Address): Promise<Address> {
  const { test, account } = clients(url)
  const factory = PINNED.base.factory
  const existing = await test.readContract({ address: factory, abi: v3FactoryAbi, functionName: 'getPool', args: [token, usdc, V3_FEE] })
  let pool = existing
  if (pool === zeroAddress) {
    const { result } = await test.simulateContract({ account, address: factory, abi: v3FactoryAbi, functionName: 'createPool', args: [token, usdc, V3_FEE] })
    pool = result
    await send(url, factory, encodeFunctionData({ abi: v3FactoryAbi, functionName: 'createPool', args: [token, usdc, V3_FEE] }))
  }
  const tokenFirst = token.toLowerCase() < usdc.toLowerCase()
  const total0 = tokenFirst ? FORK_POOLS.base.tokens : FORK_POOLS.base.quote
  const total1 = tokenFirst ? FORK_POOLS.base.quote : FORK_POOLS.base.tokens
  const p = v3Plan(total0, total1, V3_TICK_SPACING)
  await send(url, pool, encodeFunctionData({ abi: v3PoolAbi, functionName: 'initialize', args: [p.sqrtPriceX96] }))
  await send(url, token, encodeFunctionData({ abi: evmErc20Abi, functionName: 'transfer', args: [executor, FORK_POOLS.base.tokens] }))
  await send(url, usdc, encodeFunctionData({ abi: evmErc20Abi, functionName: 'transfer', args: [executor, FORK_POOLS.base.quote] }))
  const operation = keccak256(new TextEncoder().encode('keeper-fork-seed-base-pool'))
  await send(url, executor, encodeFunctionData({
    abi: executorAbi, functionName: 'execute',
    args: [operation, operation, [{
      target: pool, value: 0n,
      data: encodeFunctionData({ abi: v3PoolAbi, functionName: 'mint', args: [executor, p.lower, p.upper, p.liquidity, encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [total0, total1])] }),
    }]],
  }))
  return pool
}

export interface KeeperFork {
  arc: Fork
  base: Fork
  config: KeeperConfig
  pools: Record<KeeperChain, Address>
  tokens: Record<KeeperChain, Address>
  quotes: Record<KeeperChain, Address>
  stop(): void
}

export async function keeperForkEnvironment(options: { arcPort?: number; basePort?: number } = {}): Promise<KeeperFork> {
  const arc = await startFork('arc', options.arcPort ?? 18645)
  const base = await startFork('base', options.basePort ?? 18646).catch((cause) => { arc.process.kill(); throw cause })
  const stop = () => { arc.process.kill(); base.process.kill() }
  try {
    const operator = privateKeyToAccount(DEV.operator).address
    for (const fork of [arc, base]) await clients(fork.url).test.setBalance({ address: operator, value: 10n ** 22n })

    // Arc: ForkUsdc runtime at the native USDC address, then fund the operator with quote asset.
    const substitute = await deploy(arc.url, linked(CODE.ForkUsdc))
    const arcTest = clients(arc.url).test
    await arcTest.setCode({ address: PINNED.arc.usdc, bytecode: (await arcTest.getCode({ address: substitute }))! })
    await send(arc.url, PINNED.arc.usdc, encodeFunctionData({ abi: parseAbi(['function mint(address,uint256)']), functionName: 'mint', args: [operator, 10_000_000_000_000n] }))

    // Base: pre-positioned USDC for the operator, by storage write. Funding, not a bridge credit.
    const baseTest = clients(base.url).test
    const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [operator, FIAT_TOKEN_BALANCE_SLOT]))
    await baseTest.setStorageAt({ address: PINNED.base.usdc, index: slot, value: pad(numberToHex(10_000_000_000_000n), { size: 32 }) })

    const arcToken = await deploy(arc.url, tokenInit(operator))
    const baseToken = await deploy(base.url, tokenInit(operator))
    const baseExecutor = await deploy(base.url, withArgs(linked(CODE.EquilibriumExecutor), [{ type: 'address' }, { type: 'address' }], [operator, PINNED.base.factory]))
    const arcPool = await seedArcPool(arc.url, arcToken, PINNED.arc.usdc)
    const basePool = await seedBasePool(base.url, baseExecutor, baseToken, PINNED.base.usdc)

    const vaults = {} as Record<KeeperChain, Address>
    const spec = {
      arc: { url: arc.url, token: arcToken, quote: PINNED.arc.usdc, pool: arcPool, venue: 'architex-pair' as const },
      base: { url: base.url, token: baseToken, quote: PINNED.base.usdc, pool: basePool, venue: 'uniswap-v3-pool' as const },
    }
    for (const chain of ['arc', 'base'] as const) {
      const s = spec[chain]
      vaults[chain] = await deploy(s.url, keeperInit({ owner: operator, token: s.token, quote: s.quote, pool: s.pool, venue: s.venue, ...FORK_BOUNDS }))
      await send(s.url, s.token, encodeFunctionData({ abi: evmErc20Abi, functionName: 'transfer', args: [vaults[chain], FORK_INVENTORY.tokens] }))
      await send(s.url, s.quote, encodeFunctionData({ abi: evmErc20Abi, functionName: 'transfer', args: [vaults[chain], FORK_INVENTORY.quote] }))
    }

    const chainConfig = (chain: KeeperChain): KeeperChainConfig => ({
      chain, rpc: spec[chain].url, chainId: PINNED[chain].chainId, keeper: vaults[chain],
      token: spec[chain].token, quote: spec[chain].quote, pool: spec[chain].pool, venue: spec[chain].venue,
      finality: 0, fromBlock: PINNED[chain].block,
      // Arc gas is native USDC (18 decimals). Base gas is ETH, priced conservatively at 5,000 USDC.
      quoteAtomsPerNative: chain === 'arc' ? 1_000_000n : 5_000_000_000n,
      // Base's real priority fee is around 0.001 gwei; anvil suggests 1 gwei, which would misstate cost.
      priorityFeeWei: chain === 'base' ? 1_000_000n : undefined,
      opStackL1Fee: chain === 'base',
    })
    const config: KeeperConfig = { mode: 'fork', operatorKey: DEV.operator, arc: chainConfig('arc'), base: chainConfig('base'), policy: FORK_POLICY }
    return {
      arc, base, config, stop,
      pools: { arc: arcPool, base: basePool },
      tokens: { arc: arcToken, base: baseToken },
      quotes: { arc: PINNED.arc.usdc, base: PINNED.base.usdc },
    }
  } catch (cause) { stop(); throw cause }
}

/** Read helpers the rehearsal asserts against, straight from the chains. */
export function forkReader(fork: KeeperFork) {
  const client = (chain: KeeperChain) => createPublicClient({ transport: http(fork[chain].url) })
  return {
    balance: (chain: KeeperChain, token: Address, owner: Address) => client(chain).readContract({ address: token, abi: evmErc20Abi, functionName: 'balanceOf', args: [owner] }),
    reserves: (chain: KeeperChain) => client(chain).readContract({ address: fork.pools[chain], abi: architexPairAbi, functionName: 'getReserves' }),
    mine: async (chain: KeeperChain, blocks = 1, intervalSeconds = 2) => {
      await createTestClient({ mode: 'anvil', transport: http(fork[chain].url) }).mine({ blocks, interval: intervalSeconds })
    },
  }
}
