/**
 * MIXED-ENVIRONMENT FORK HARNESS. An anvil fork of Arc TESTNET (pinned block, as in evm/fork.ts)
 * paired with an anvil fork of Robinhood MAINNET. No Robinhood testnet has a Wormhole core or a
 * Uniswap venue, so this pairing is the only way to run the real Robinhood core, Uniswap v3 and
 * USDG bytecode against an Arc hub. It proves compatibility of the adapter with that bytecode;
 * it is not a route, and nothing here touches a public chain. Substitutions, all fork-local:
 *
 * 1. Each Wormhole core's current Guardian set is overwritten with one local key so the harness can
 *    sign VAAs. Destination VAA verification, NTT peer checks and replay protection are the real code.
 * 2. USDG (a provisional quote fixture, not USDC) is credited to the Robinhood executor and a trader
 *    by storage write: pre-positioned inventory standing in for a refill path that does not exist.
 * 3. The Robinhood fork runs with anvil's shanghai rules: Arbitrum Orbit block headers carry no
 *    blob-gas fields, which later anvil hardforks require. None of the pinned bytecode uses Cancun opcodes.
 * 4. Arbitrum gas (including its L1 component) is not modelled; costs here are not Robinhood costs.
 *
 * The public Robinhood RPC serves only minutes of historical state, so the fork block defaults to
 * a recent one and the pinned bytecode is verified by code hash at that block. Set
 * EQUILIBRIUM_ROBINHOOD_FORK_RPC (archive) and EQUILIBRIUM_ROBINHOOD_FORK_BLOCK to pin a block.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createPublicClient, createTestClient, encodeAbiParameters, http, keccak256, numberToHex, pad, publicActions, type Address, type Hex, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { coreAbi } from '../evm/contracts'
import { DEV, PINNED, deployInfrastructure, startFork } from '../evm/fork'
import { localGuardian } from '../evm/vaa'
import { assertPins, probeStateAccess, verifyPins, type PinCheck, type StateAccess } from './access'
import { ROBINHOOD_MAINNET } from './pins'
import type { RobinhoodRouteConfig } from './route'

/** USDG keeps balances in mapping slot 1 (found by probing the fork; fixture setup only). */
const USDG_BALANCE_SLOT = 1n
/** anvil development key #3: a public test value, never funded anywhere real. */
export const TRADER = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as Hex

export interface RobinhoodFork { url: string; block: bigint; process: ChildProcess; access: StateAccess; pins: PinCheck[] }

export async function startRobinhoodFork(port: number, rpc = process.env.EQUILIBRIUM_ROBINHOOD_FORK_RPC ?? ROBINHOOD_MAINNET.rpc,
  requested = process.env.EQUILIBRIUM_ROBINHOOD_FORK_BLOCK ? BigInt(process.env.EQUILIBRIUM_ROBINHOOD_FORK_BLOCK) : null): Promise<RobinhoodFork> {
  const probe = await probeStateAccess(rpc, requested, [])
  if (probe.chainId !== ROBINHOOD_MAINNET.chainId) throw new Error(`${rpc} is chain ${probe.chainId}, not Robinhood mainnet`)
  // Without a requested block, stay well inside the retained window so lazy reads keep working during the run.
  const block = requested ?? probe.latest - 32n
  const access = requested === null ? await probeStateAccess(rpc, block, []) : probe
  if (!access.available) throw new Error(access.error)
  const child = spawn('anvil', ['--fork-url', rpc, '--fork-block-number', block.toString(), '--chain-id', String(ROBINHOOD_MAINNET.chainId), '--hardfork', 'shanghai',
    '--port', String(port), '--silent'], { stdio: 'ignore' })
  const url = `http://127.0.0.1:${port}`
  const client = createPublicClient({ transport: http(url) }) as PublicClient
  for (let i = 0; i < 120; i++) {
    try {
      if (await client.getChainId() === ROBINHOOD_MAINNET.chainId) {
        const pins = await verifyPins(client)
        try { assertPins(pins) } catch (cause) { child.kill(); throw cause }
        return { url, block, process: child, access, pins }
      }
    } catch (cause) { if (String(cause).includes('differs from the pins')) throw cause }
    await new Promise((r) => setTimeout(r, 250))
  }
  child.kill()
  throw new Error(`anvil Robinhood fork did not start on ${port}`)
}

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

export async function creditUsdg(url: string, owner: Address, amount: bigint) {
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [owner, USDG_BALANCE_SLOT]))
  await tester(url).setStorageAt({ address: ROBINHOOD_MAINNET.usdgFixture, index: slot, value: pad(numberToHex(amount), { size: 32 }) })
}

export interface RobinhoodForkEnvironment {
  arc: { url: string; process: ChildProcess }
  robinhood: RobinhoodFork
  config: RobinhoodRouteConfig
  guardianSets: { arc: number; robinhood: number }
  stop(): void
}

export async function robinhoodForkEnvironment(options: { arcPort?: number; robinhoodPort?: number; confirmations?: { arc: number; robinhood: number }; usdg?: bigint; assetId?: string } = {}): Promise<RobinhoodForkEnvironment> {
  const arc = await startFork('arc', options.arcPort ?? 18555)
  const robinhood = await startRobinhoodFork(options.robinhoodPort ?? 18556).catch((cause) => { arc.process.kill(); throw cause })
  const stop = () => { arc.process.kill(); robinhood.process.kill() }
  try {
    const operator = privateKeyToAccount(DEV.operator).address
    const guardian = privateKeyToAccount(DEV.guardian).address
    for (const url of [arc.url, robinhood.url]) await tester(url).setBalance({ address: operator, value: 10n ** 22n })
    await tester(robinhood.url).setBalance({ address: privateKeyToAccount(TRADER).address, value: 10n ** 20n })
    const guardianSets = { arc: await localGuardianSet(arc.url, PINNED.arc.core, guardian), robinhood: await localGuardianSet(robinhood.url, ROBINHOOD_MAINNET.core, guardian) }
    const arcInfra = await deployInfrastructure(arc.url, DEV.operator, null)
    const rhInfra = await deployInfrastructure(robinhood.url, DEV.operator, ROBINHOOD_MAINNET.venue.factory)
    await creditUsdg(robinhood.url, rhInfra.executor, options.usdg ?? 100_000_000n)
    const config: RobinhoodRouteConfig = {
      mode: 'fork', environment: 'mixed:arc-testnet-fork+robinhood-mainnet-fork', operatorKey: DEV.operator,
      arc: { side: 'arc', rpc: arc.url, chainId: PINNED.arc.chainId, wormholeChainId: PINNED.arc.wormholeChainId, core: PINNED.arc.core, ...arcInfra,
        confirmations: options.confirmations?.arc ?? 0, fromBlock: PINNED.arc.block + 1n },
      robinhood: { side: 'robinhood', rpc: robinhood.url, chainId: ROBINHOOD_MAINNET.chainId, wormholeChainId: ROBINHOOD_MAINNET.wormholeChainId, core: ROBINHOOD_MAINNET.core, ...rhInfra,
        confirmations: options.confirmations?.robinhood ?? 0, fromBlock: robinhood.block + 1n,
        venue: { factory: ROBINHOOD_MAINNET.venue.factory, quoterV2: ROBINHOOD_MAINNET.venue.quoterV2, fee: ROBINHOOD_MAINNET.venue.fee, tickSpacing: ROBINHOOD_MAINNET.venue.tickSpacing },
        quote: ROBINHOOD_MAINNET.usdgFixture },
      // A VAA is verified by the destination core, so it is signed under the destination's Guardian set index.
      vaa: { arc: localGuardian(DEV.guardian, guardianSets.arc), robinhood: localGuardian(DEV.guardian, guardianSets.robinhood) },
      limits: { outbound: 10_000_000_000_000n, inbound: 10_000_000_000_000n },
      asset: { id: options.assetId ?? 'equilibrium-robinhood-rehearsal-1', name: 'Equilibrium', symbol: 'EQL', issuance: 1_000_000_000_000n },
    }
    return { arc, robinhood, config, guardianSets, stop }
  } catch (cause) { stop(); throw cause }
}

/** The on-disk form a separate worker process loads: bigints as strings, the guardian as set indexes. Keys stay fork dev keys. */
export function configToJson(config: RobinhoodRouteConfig, guardianSets: { arc: number; robinhood: number }): string {
  return JSON.stringify({ ...config, vaa: guardianSets }, (_, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v))
}
export function configFromJson(json: string): RobinhoodRouteConfig {
  const raw = JSON.parse(json, (_, v: unknown) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)) as Omit<RobinhoodRouteConfig, 'vaa'> & { vaa: { arc: number; robinhood: number } }
  return { ...raw, vaa: { arc: localGuardian(DEV.guardian, raw.vaa.arc), robinhood: localGuardian(DEV.guardian, raw.vaa.robinhood) } }
}
