/**
 * FORK REHEARSAL HARNESS. Two anvil forks of the real public testnets at pinned blocks: Arc testnet
 * (5042002) and Base Sepolia (84532). Real Wormhole cores, the real Architex factory on Arc and the
 * real Uniswap v3 factory and Base Sepolia USDC run as deployed. Three substitutions, all fork-only:
 *
 * 1. Each Wormhole core's current Guardian set is overwritten with one local key, so the harness can
 *    sign VAAs. Destination verification, peer checks and replay protection are the real contracts'.
 * 2. Arc's native USDC reads balances through Arc precompiles anvil does not implement, so the Arc
 *    fork runs an EIP-3009 token (ForkUsdc) at 0x3600… with the same name, version and decimals.
 * 3. Base Sepolia USDC is credited to the Base executor by storage write: pre-positioned quote
 *    inventory standing in for a CCTP refill that is not implemented.
 *
 * Nothing here touches a public chain. Every signer is an anvil development key.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import {
  createPublicClient, createTestClient, createWalletClient, encodeAbiParameters, http, keccak256, numberToHex, pad, parseAbi, publicActions,
  type Address, type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { CODE, coreAbi, linked, withArgs } from './contracts'
import type { ChainConfig, EvmAdapterConfig } from './types'
import { localGuardian } from './vaa'

export const PINNED = {
  arc: { rpc: 'https://rpc.testnet.arc.io', block: 64824600n, chainId: 5042002, wormholeChainId: 71, core: '0xBB73cB66C26740F31d1FabDC6b7A46a038A300dd' as Address,
    usdc: '0x3600000000000000000000000000000000000000' as Address, factory: '0x6362f5a0fc007ab7d1e61f99d3f4eb04360d060a' as Address },
  base: { rpc: 'https://sepolia.base.org', block: 47513000n, chainId: 84532, wormholeChainId: 10004, core: '0x79A1027a6A159502049F10906D333EC57E95F083' as Address,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address, factory: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24' as Address },
} as const
/** anvil development keys: public test values, never funded anywhere real. */
export const DEV = {
  operator: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcaf784d7bf4f2ff80' as Hex,
  payer: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex,
  guardian: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hex,
}
/** FiatToken v2 keeps balances in mapping slot 9. */
const FIAT_TOKEN_BALANCE_SLOT = 9n

export interface Fork { chain: 'arc' | 'base'; url: string; process: ChildProcess }

export async function startFork(chain: 'arc' | 'base', port: number, rpc = process.env[`EQUILIBRIUM_${chain.toUpperCase()}_FORK_RPC`] ?? PINNED[chain].rpc): Promise<Fork> {
  const pin = PINNED[chain]
  const child = spawn('anvil', ['--fork-url', rpc, '--fork-block-number', pin.block.toString(), '--chain-id', String(pin.chainId), '--port', String(port), '--silent'], { stdio: 'ignore' })
  const url = `http://127.0.0.1:${port}`
  const client = createPublicClient({ transport: http(url) })
  for (let i = 0; i < 120; i++) {
    try { if (await client.getChainId() === pin.chainId) return { chain, url, process: child } } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  child.kill()
  throw new Error(`anvil ${chain} fork did not start on ${port}`)
}

function clients(url: string, key: Hex) {
  const account = privateKeyToAccount(key)
  return {
    test: createTestClient({ mode: 'anvil', transport: http(url) }).extend(publicActions),
    wallet: createWalletClient({ account, transport: http(url) }),
    account,
  }
}

/** Overwrite the core's current Guardian set with one local key, exactly as WormholeSimulator does. */
async function localGuardianSet(url: string, core: Address, guardian: Address): Promise<number> {
  const { test } = clients(url, DEV.operator)
  const index = await test.readContract({ address: core, abi: coreAbi, functionName: 'getCurrentGuardianSetIndex' })
  const setSlot = keccak256(encodeAbiParameters([{ type: 'uint32' }, { type: 'uint256' }], [index, 2n]))
  const keys = BigInt(keccak256(setSlot))
  await test.setStorageAt({ address: core, index: setSlot, value: pad(numberToHex(1n), { size: 32 }) })
  await test.setStorageAt({ address: core, index: numberToHex(keys, { size: 32 }), value: pad(guardian, { size: 32 }) })
  return index
}

async function deploy(url: string, key: Hex, init: Hex): Promise<Address> {
  const { wallet, test, account } = clients(url, key)
  const hash = await wallet.sendTransaction({ account, chain: null, data: init })
  const receipt = await test.waitForTransactionReceipt({ hash })
  if (!receipt.contractAddress || receipt.status !== 'success') throw new Error('Deployment failed')
  return receipt.contractAddress
}

/**
 * Infrastructure the operator deploys once per chain: the NTT TransceiverStructs library and the
 * EquilibriumExecutor it owns. The same two deployments are what the public release needs.
 */
export async function deployInfrastructure(url: string, operatorKey: Hex, v3Factory: Address | null) {
  const operator = privateKeyToAccount(operatorKey).address
  const transceiverStructs = await deploy(url, operatorKey, linked(CODE.TransceiverStructs))
  const executor = await deploy(url, operatorKey, withArgs(linked(CODE.EquilibriumExecutor), [{ type: 'address' }, { type: 'address' }], [operator, v3Factory ?? '0x0000000000000000000000000000000000000000']))
  return { transceiverStructs, executor }
}

export interface ForkEnvironment { arc: Fork; base: Fork; config: EvmAdapterConfig; payer: Address; stop(): void }

export async function forkEnvironment(options: { arcPort?: number; basePort?: number; baseFinality?: number; baseUsdc?: bigint; payerUsdc?: bigint } = {}): Promise<ForkEnvironment> {
  const arc = await startFork('arc', options.arcPort ?? 18545)
  const base = await startFork('base', options.basePort ?? 18546).catch((cause) => { arc.process.kill(); throw cause })
  const stop = () => { arc.process.kill(); base.process.kill() }
  try {
    const guardian = privateKeyToAccount(DEV.guardian).address
    // Gas for the operator on both forks. On Arc this is native USDC; it is fork balance, not funding.
    for (const fork of [arc, base]) await clients(fork.url, DEV.operator).test.setBalance({ address: privateKeyToAccount(DEV.operator).address, value: 10n ** 22n })
    const arcIndex = await localGuardianSet(arc.url, PINNED.arc.core, guardian)
    const baseIndex = await localGuardianSet(base.url, PINNED.base.core, guardian)
    if (arcIndex !== baseIndex) throw new Error('Guardian set indexes differ; sign per chain')
    // Arc: ForkUsdc runtime at the native USDC address (see header), then fund the payer.
    const substitute = await deploy(arc.url, DEV.operator, linked(CODE.ForkUsdc))
    const arcTest = clients(arc.url, DEV.operator).test
    await arcTest.setCode({ address: PINNED.arc.usdc, bytecode: (await arcTest.getCode({ address: substitute }))! })
    const payer = privateKeyToAccount(DEV.payer).address
    const { wallet: arcWallet, account } = clients(arc.url, DEV.operator)
    await arcTest.waitForTransactionReceipt({ hash: await arcWallet.writeContract({ account, chain: null, address: PINNED.arc.usdc, abi: parseAbi(['function mint(address,uint256)']), functionName: 'mint', args: [payer, options.payerUsdc ?? 1_000_000_000n] }) })
    const arcInfra = await deployInfrastructure(arc.url, DEV.operator, null)
    const baseInfra = await deployInfrastructure(base.url, DEV.operator, PINNED.base.factory)
    // Base: pre-positioned quote inventory in the executor.
    const baseTest = clients(base.url, DEV.operator).test
    const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [baseInfra.executor, FIAT_TOKEN_BALANCE_SLOT]))
    await baseTest.setStorageAt({ address: PINNED.base.usdc, index: slot, value: pad(numberToHex(options.baseUsdc ?? 100_000_000n), { size: 32 }) })
    const chain = (name: 'arc' | 'base', url: string, infra: { executor: Address; transceiverStructs: Address }, finality: number): ChainConfig => ({
      chain: name, rpc: url, chainId: PINNED[name].chainId, wormholeChainId: PINNED[name].wormholeChainId, core: PINNED[name].core, usdc: PINNED[name].usdc,
      executor: infra.executor, transceiverStructs: infra.transceiverStructs, finality, fromBlock: PINNED[name].block,
      // Arc gas is native USDC (18 decimals). Base gas is ETH, priced conservatively at 5,000 USDC.
      usdcAtomsPerNative: name === 'arc' ? 1_000_000n : 5_000_000_000n,
      // Base's real priority fee is around 0.001 gwei; anvil suggests 1 gwei, which would misstate cost.
      priorityFeeWei: name === 'base' ? 1_000_000n : undefined,
      venue: name === 'arc' ? { kind: 'architex', factory: PINNED.arc.factory } : { kind: 'uniswap-v3', factory: PINNED.base.factory, fee: 3000, tickSpacing: 60 },
    })
    const config: EvmAdapterConfig = {
      mode: 'fork', operatorKey: DEV.operator,
      arc: chain('arc', arc.url, arcInfra, 0), base: chain('base', base.url, baseInfra, options.baseFinality ?? 0),
      vaa: localGuardian(DEV.guardian, arcIndex),
      limits: { outbound: 10_000_000_000_000n, inbound: 10_000_000_000_000n },
      budgets: { payment: '1000000', canonical: '2000000', manager: '5000000', debit: '1000000', credit: '1000000', pool: '2000000' },
    }
    return { arc, base, config, payer, stop }
  } catch (cause) { stop(); throw cause }
}
