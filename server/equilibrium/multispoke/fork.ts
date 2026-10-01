/**
 * MIXED-ENVIRONMENT FORK HARNESS for the composed Arc–Base–Robinhood launch job. Three anvil forks:
 * Arc TESTNET and Base SEPOLIA at the blocks pinned in evm/fork.ts (PR #12), and Robinhood MAINNET
 * at a recent block verified against the code-hash pins in robinhood/pins.ts (PR #18). It uses its
 * own ports (Arc 18755, Base 18756, Robinhood 18757; service 4048) so it never collides with the
 * Arc–Base suite, the Robinhood suites or the keeper/refill suites. Nothing here touches a public
 * chain; every signer is an anvil development key. Substitutions, all fork-local:
 *
 * 1. Each Wormhole core's current Guardian set is overwritten with one local key so the harness can
 *    sign VAAs. Destination verification, NTT peer checks and replay protection are the real code.
 * 2. Arc's native USDC reads balances through precompiles anvil lacks, so an EIP-3009 ForkUsdc runs
 *    at 0x3600… and the anvil payer is minted a balance. x402 payments here are PAYMENT FIXTURES.
 * 3. Base Sepolia USDC and Robinhood USDG are credited to the spoke executors by storage write:
 *    pre-positioned quote inventory standing in for refill paths that are not part of this job.
 * 4. The Robinhood fork runs anvil's shanghai rules (Arbitrum Orbit headers carry no blob-gas
 *    fields) and its Arbitrum gas, including the L1 component, is not modelled.
 */
import { createTestClient, createWalletClient, encodeAbiParameters, http, keccak256, numberToHex, pad, parseAbi, publicActions, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { CODE, coreAbi, linked } from '../evm/contracts'
import { DEV, PINNED, deployInfrastructure, startFork, type Fork } from '../evm/fork'
import { localGuardian } from '../evm/vaa'
import { creditUsdg, startRobinhoodFork, type RobinhoodFork } from '../robinhood/fork'
import { ROBINHOOD_MAINNET } from '../robinhood/pins'
import { MULTISPOKE_LABELS, type MultispokeConfig, type Side } from './adapter'

export const MULTISPOKE_PORTS = { arc: 18755, base: 18756, robinhood: 18757, service: 4048 } as const
/** FiatToken v2 keeps balances in mapping slot 9. */
const FIAT_TOKEN_BALANCE_SLOT = 9n
/** Conservative fixed rate for ETH gas on both spokes: 5,000 USDC per ETH, in USDC atoms per 1e18 wei. */
const ETH_USDC_ATOMS = 5_000_000_000n

const tester = (url: string) => createTestClient({ mode: 'anvil', transport: http(url) }).extend(publicActions)

/** Overwrite the core's current Guardian set with one local key, as WormholeSimulator does. */
async function localGuardianSet(url: string, core: Address, guardian: Address): Promise<number> {
  const test = tester(url)
  const index = await test.readContract({ address: core, abi: coreAbi, functionName: 'getCurrentGuardianSetIndex' })
  const setSlot = keccak256(encodeAbiParameters([{ type: 'uint32' }, { type: 'uint256' }], [index, 2n]))
  await test.setStorageAt({ address: core, index: setSlot, value: pad(numberToHex(1n), { size: 32 }) })
  await test.setStorageAt({ address: core, index: numberToHex(BigInt(keccak256(setSlot)), { size: 32 }), value: pad(guardian, { size: 32 }) })
  return index
}

export interface MultispokeForkEnvironment {
  arc: Fork
  base: Fork
  robinhood: RobinhoodFork
  config: MultispokeConfig
  guardianSets: Record<Side, number>
  payer: Address
  urls: Record<Side, string>
  stop(): void
}

export async function multispokeForkEnvironment(options: { ports?: Partial<Record<Side, number>>; confirmations?: Partial<Record<Side, number>>; payerUsdc?: bigint } = {}): Promise<MultispokeForkEnvironment> {
  const ports = { ...MULTISPOKE_PORTS, ...options.ports }
  const arc = await startFork('arc', ports.arc)
  const base = await startFork('base', ports.base).catch((cause) => { arc.process.kill(); throw cause })
  const robinhood = await startRobinhoodFork(ports.robinhood).catch((cause) => { arc.process.kill(); base.process.kill(); throw cause })
  const stop = () => { arc.process.kill(); base.process.kill(); robinhood.process.kill() }
  try {
    const operator = privateKeyToAccount(DEV.operator)
    const guardian = privateKeyToAccount(DEV.guardian).address
    const urls: Record<Side, string> = { arc: arc.url, base: base.url, robinhood: robinhood.url }
    for (const url of Object.values(urls)) await tester(url).setBalance({ address: operator.address, value: 10n ** 22n })
    const guardianSets: Record<Side, number> = {
      arc: await localGuardianSet(arc.url, PINNED.arc.core, guardian),
      base: await localGuardianSet(base.url, PINNED.base.core, guardian),
      robinhood: await localGuardianSet(robinhood.url, ROBINHOOD_MAINNET.core, guardian),
    }
    // Arc: ForkUsdc runtime at the native USDC address, then the payer's fixture balance.
    const arcTest = tester(arc.url)
    const arcWallet = createWalletClient({ account: operator, transport: http(arc.url) })
    const substitute = await arcTest.waitForTransactionReceipt({ hash: await arcWallet.sendTransaction({ account: operator, chain: null, data: linked(CODE.ForkUsdc) }) })
    if (!substitute.contractAddress) throw new Error('ForkUsdc deployment failed')
    await arcTest.setCode({ address: PINNED.arc.usdc, bytecode: (await arcTest.getCode({ address: substitute.contractAddress }))! })
    const payer = privateKeyToAccount(DEV.payer).address
    await arcTest.waitForTransactionReceipt({ hash: await arcWallet.writeContract({ account: operator, chain: null, address: PINNED.arc.usdc, abi: parseAbi(['function mint(address,uint256)']), functionName: 'mint', args: [payer, options.payerUsdc ?? 1_000_000_000n] }) })
    const arcInfra = await deployInfrastructure(arc.url, DEV.operator, null)
    const baseInfra = await deployInfrastructure(base.url, DEV.operator, PINNED.base.factory)
    const rhInfra = await deployInfrastructure(robinhood.url, DEV.operator, ROBINHOOD_MAINNET.venue.factory)
    // Quote inventory in each spoke executor.
    const baseSlot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [baseInfra.executor, FIAT_TOKEN_BALANCE_SLOT]))
    await tester(base.url).setStorageAt({ address: PINNED.base.usdc, index: baseSlot, value: pad(numberToHex(100_000_000n), { size: 32 }) })
    await creditUsdg(robinhood.url, rhInfra.executor, 100_000_000n)
    const confirmations = (side: Side) => options.confirmations?.[side] ?? 0
    const config: MultispokeConfig = {
      mode: 'fork', labels: MULTISPOKE_LABELS, operatorKey: DEV.operator,
      arc: { rpc: arc.url, chainId: PINNED.arc.chainId, wormholeChainId: PINNED.arc.wormholeChainId, core: PINNED.arc.core, ...arcInfra, usdc: PINNED.arc.usdc, factory: PINNED.arc.factory,
        confirmations: confirmations('arc'), fromBlock: PINNED.arc.block + 1n, usdcAtomsPerNative: 1_000_000n,
        // A fixed Arc fee ceiling, as in the #12 fork and testnet plan, so worst-case checks do not drift with anvil's base fee.
        maxFeePerGasWei: 60_000_000_000n },
      spokes: {
        base: { rpc: base.url, chainId: PINNED.base.chainId, wormholeChainId: PINNED.base.wormholeChainId, core: PINNED.base.core, ...baseInfra, quote: PINNED.base.usdc,
          venue: { factory: PINNED.base.factory, fee: 3000, tickSpacing: 60 }, confirmations: confirmations('base'), fromBlock: PINNED.base.block + 1n, usdcAtomsPerNative: ETH_USDC_ATOMS,
          // Base's real priority fee is around 0.001 gwei; anvil suggests 1 gwei, which would misstate cost.
          priorityFeeWei: 1_000_000n, opStackL1Fee: true, vaa: localGuardian(DEV.guardian, guardianSets.base) },
        robinhood: { rpc: robinhood.url, chainId: ROBINHOOD_MAINNET.chainId, wormholeChainId: ROBINHOOD_MAINNET.wormholeChainId, core: ROBINHOOD_MAINNET.core, ...rhInfra, quote: ROBINHOOD_MAINNET.usdgFixture,
          venue: { factory: ROBINHOOD_MAINNET.venue.factory, fee: ROBINHOOD_MAINNET.venue.fee, tickSpacing: ROBINHOOD_MAINNET.venue.tickSpacing },
          confirmations: confirmations('robinhood'), fromBlock: robinhood.block + 1n, usdcAtomsPerNative: ETH_USDC_ATOMS,
          // Arbitrum ignores priority fees; anvil's 1 gwei suggestion would be ~50x the base fee.
          priorityFeeWei: 0n, vaa: localGuardian(DEV.guardian, guardianSets.robinhood) },
      },
      limits: { outbound: 10_000_000_000_000n, inbound: 10_000_000_000_000n },
      budgets: { payment: '1000000', canonical: '5000000', manager: '10000000', debit: '2000000', credit: '2000000', pool: '5000000' },
    }
    return { arc, base, robinhood, config, guardianSets, payer, urls, stop }
  } catch (cause) { stop(); throw cause }
}

/** The on-disk form a separate worker or service process loads: bigints as strings, guardians as set indexes. Keys stay fork dev keys. */
export function configToJson(config: MultispokeConfig, guardianSets: Record<Side, number>): string {
  const spokes = { base: { ...config.spokes.base, vaa: guardianSets.base }, robinhood: { ...config.spokes.robinhood, vaa: guardianSets.robinhood } }
  return JSON.stringify({ ...config, spokes }, (_, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v))
}
export function configFromJson(json: string): MultispokeConfig {
  type Raw = Omit<MultispokeConfig, 'spokes'> & { spokes: Record<'base' | 'robinhood', Omit<MultispokeConfig['spokes']['base'], 'vaa'> & { vaa: number }> }
  const raw = JSON.parse(json, (_, v: unknown) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)) as Raw
  const spoke = (s: 'base' | 'robinhood') => ({ ...raw.spokes[s], vaa: localGuardian(DEV.guardian, raw.spokes[s].vaa) })
  return { ...raw, spokes: { base: spoke('base'), robinhood: spoke('robinhood') } }
}
