import { createPublicClient, getAddress, http, keccak256, type Address, type Hex, type PublicClient } from 'viem'
import { EIP1967_IMPLEMENTATION_SLOT, ROBINHOOD_MAINNET } from './pins'

/**
 * Pinned-state access. A reproducible fork needs the RPC to serve state at the fork block, and the
 * bytecode there must be the bytecode that was pinned. The public Robinhood RPC is not an archive
 * node, so both are checked explicitly and a missing block fails closed instead of silently
 * forking some other state.
 */
export interface StateAccess {
  rpc: string
  chainId: number
  latest: bigint
  finalized: bigint | null
  /** The block the probe was asked about, or null when it chose a recent one. */
  requested: bigint | null
  /** Whether `requested` (or latest when none was requested) served historical state. */
  available: boolean
  /** Whether the chain's finalized block served state. False means finality can only be observed, not forked. */
  finalizedAvailable: boolean
  /** Oldest depth below latest that served state, from the sampled depths. */
  retainedDepth: bigint | null
  error?: string
}

const pruned = (cause: unknown) => /historical state|missing trie node|header not found|state.*not available/i.test(String(cause))

async function served(client: PublicClient, block: bigint): Promise<boolean> {
  try { await client.getCode({ address: ROBINHOOD_MAINNET.core, blockNumber: block }); return true } catch (cause) {
    if (pruned(cause)) return false
    throw cause
  }
}

export async function probeStateAccess(rpc: string = ROBINHOOD_MAINNET.rpc, requested: bigint | null = null, depths: bigint[] = [100n, 1000n, 4000n, 6000n, 8000n, 12000n]): Promise<StateAccess> {
  const client = createPublicClient({ transport: http(rpc) }) as PublicClient
  const chainId = await client.getChainId()
  const latest = await client.getBlockNumber({ cacheTime: 0 })
  const finalized = await client.getBlock({ blockTag: 'finalized' }).then((b) => b.number, () => null)
  const available = await served(client, requested ?? latest)
  const finalizedAvailable = finalized === null ? false : await served(client, finalized)
  let retainedDepth: bigint | null = null
  for (const depth of depths) {
    if (depth > latest || !(await served(client, latest - depth))) break
    retainedDepth = depth
  }
  return { rpc, chainId, latest, finalized, requested, available, finalizedAvailable, retainedDepth,
    ...(available ? {} : { error: `State at block ${requested ?? latest} is not served by ${rpc}. Use an archive RPC or fork a block within the retained window.` }) }
}

export interface PinCheck { address: Address; expected: Hex; actual: Hex; ok: boolean }

/**
 * Compare runtime code hashes (and proxy implementation slots) at `block` with the pins. A fork
 * whose bytecode differs is not the rehearsed infrastructure and must not be used.
 */
export async function verifyPins(client: PublicClient, block?: bigint): Promise<PinCheck[]> {
  const at = block === undefined ? {} : { blockNumber: block }
  const checks: PinCheck[] = []
  for (const [address, expected] of Object.entries(ROBINHOOD_MAINNET.codeHashes) as [Address, Hex][]) {
    const code = await client.getCode({ address, ...at })
    const actual = code ? keccak256(code) : ('0x' as Hex)
    checks.push({ address, expected, actual, ok: actual === expected })
  }
  for (const [proxy, implementation] of Object.entries(ROBINHOOD_MAINNET.implementations) as [Address, Address][]) {
    const slot = await client.getStorageAt({ address: proxy, slot: EIP1967_IMPLEMENTATION_SLOT, ...at })
    const actual: Hex = slot ? getAddress(`0x${slot.slice(26)}`) : '0x'
    checks.push({ address: proxy, expected: getAddress(implementation), actual, ok: actual === getAddress(implementation) })
  }
  return checks
}

export function assertPins(checks: PinCheck[]) {
  const bad = checks.filter((c) => !c.ok)
  if (bad.length) throw new Error(`Robinhood bytecode differs from the pins: ${bad.map((c) => `${c.address} ${c.actual} != ${c.expected}`).join('; ')}`)
}
