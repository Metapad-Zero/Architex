/**
 * The Arc half of the Arc–Solana integration rehearsal: an Anvil fork of Arc testnet carrying the
 * real deployed Wormhole core bridge, with the actual pinned NTT locking manager and Wormhole
 * transceiver (`lib/ntt`, commit c636cc15b07969e4b44de7e466c999c07e7387a9) deployed onto it.
 *
 * Why a live node instead of `NttRehearsal.t.sol`: a forge test's chain exists only inside the test
 * process, so it cannot exchange messages with a Solana validator running beside it. Everything
 * here is the same contracts the forge test uses; the difference is that the chain is reachable
 * over RPC for as long as the Solana side needs it.
 *
 * The guardian substitution is the same one the forge test makes, written over `anvil_setStorageAt`
 * instead of a cheatcode so that the Arc fork and the local validator share one guardian key. That
 * shared key is what lets real published bytes cross in both directions — and it is also why a
 * passing run is local evidence and never a public route.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  createPublicClient, createWalletClient, defineChain, http, parseEventLogs,
  type Abi, type Address, type Hex, type PublicClient, type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { guardianSetSlots, LOG_MESSAGE_PUBLISHED_TOPIC, parseLogMessagePublished, type EvmPublishedMessage } from '../../src/lib/equilibriumArcSolana'

const ROOT = resolve(import.meta.dirname, '../..')
const OUT = join(ROOT, 'contracts-equilibrium/out')

/** Arc testnet as `src/lib/equilibriumNetwork.ts` records it. The core bridge is read, never deployed. */
export const ARC_TESTNET = {
  evmChainId: 5042002,
  wormholeId: 71,
  coreBridge: '0xBB73cB66C26740F31d1FabDC6b7A46a038A300dd' as Address,
  rpc: 'https://rpc.testnet.arc.io',
} as const

/** Anvil's first default account. A funded key on a fork of a testnet; it holds nothing public. */
const FORK_ACCOUNT = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')

export const arcFork = defineChain({
  id: ARC_TESTNET.evmChainId,
  name: 'Arc testnet fork',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [] } },
})

/* ------------------------------------------------------------------ artifacts */

type LinkReferences = Record<string, Record<string, { start: number; length: number }[]>>
interface Artifact { abi: Abi; bytecode: Hex; linkReferences: LinkReferences }

/**
 * Reads what `FOUNDRY_PROFILE=equilibrium forge build` produced, so the deployed code is the same
 * compiler output the Solidity fork test runs against rather than a second build of the same
 * source under different settings.
 */
export function artifact(file: string, contract = file): Artifact {
  const path = join(OUT, `${file}.sol`, `${contract}.json`)
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    abi: Abi; bytecode: { object: Hex; linkReferences?: LinkReferences }
  }
  if (!parsed.bytecode.object || parsed.bytecode.object === '0x') {
    throw new Error(`${contract} has no deployable bytecode. Run: FOUNDRY_PROFILE=equilibrium forge build`)
  }
  return { abi: parsed.abi, bytecode: parsed.bytecode.object, linkReferences: parsed.bytecode.linkReferences ?? {} }
}

/**
 * Splices deployed library addresses into the `__$…$__` placeholders solc left behind.
 *
 * The manager and the transceiver both call `TransceiverStructs` as an external library, so
 * neither is deployable until it is linked. A forge test never shows this because forge links
 * automatically; deploying the same artifact over RPC does not.
 */
export function linkLibraries(built: Artifact, libraries: Record<string, Address>): Artifact {
  let code = built.bytecode.slice(2)
  for (const [file, byName] of Object.entries(built.linkReferences)) {
    for (const [name, places] of Object.entries(byName)) {
      const address = libraries[name]
      if (!address) throw new Error(`${file}:${name} is unlinked and no address was supplied.`)
      for (const { start, length } of places) {
        if (length !== 20) throw new Error(`Unexpected ${length}-byte link reference for ${name}.`)
        code = code.slice(0, start * 2) + address.slice(2).toLowerCase() + code.slice((start + length) * 2)
      }
    }
  }
  if (code.includes('__$')) throw new Error('Bytecode still carries an unlinked library placeholder.')
  return { ...built, bytecode: `0x${code}`, linkReferences: {} }
}

/* ------------------------------------------------------------------ node lifecycle */

export interface ArcNode {
  process: ChildProcess
  url: string
  publicClient: PublicClient
  wallet: WalletClient
  account: Address
}

export function startAnvil(port: number, forkBlock?: number): ChildProcess {
  const args = [
    '--fork-url', ARC_TESTNET.rpc, '--port', String(port), '--silent',
    // Deterministic within a run: the rehearsal drives time itself for the rate-limit case.
    '--no-rate-limit',
    ...(forkBlock === undefined ? [] : ['--fork-block-number', String(forkBlock)]),
  ]
  const child = spawn('anvil', args, { stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr?.on('data', (chunk: Buffer) => { process.stderr.write(`    [anvil] ${chunk.toString()}`) })
  return child
}

/** Cancels only the process this run started, by its own pid. */
export function stopAnvil(child: ChildProcess | null, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!child?.pid) return
  try { process.kill(child.pid, signal) } catch { /* already gone */ }
}

export function connect(port: number): { url: string; publicClient: PublicClient; wallet: WalletClient; account: Address } {
  const url = `http://127.0.0.1:${port}`
  return {
    url,
    publicClient: createPublicClient({ chain: arcFork, transport: http(url) }),
    wallet: createWalletClient({ chain: arcFork, account: FORK_ACCOUNT, transport: http(url) }),
    account: FORK_ACCOUNT.address,
  }
}

export async function waitForAnvil(client: PublicClient, seconds = 120): Promise<void> {
  const deadline = Date.now() + seconds * 1000
  for (;;) {
    try {
      if (await client.getBlockNumber() > 0n) return
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error('The Arc fork did not become reachable.')
    await new Promise((done) => setTimeout(done, 500))
  }
}

/* ------------------------------------------------------------------ node control */

type Rpc = { request: (args: { method: string; params?: unknown }) => Promise<unknown> }

export async function setStorage(client: PublicClient, address: Address, slot: Hex, value: Hex): Promise<void> {
  await (client as unknown as Rpc).request({ method: 'anvil_setStorageAt', params: [address, slot, value] })
}
/**
 * An explicitly labelled CLOCK FIXTURE. The pinned manager's inbound queue releases on
 * `block.timestamp`, so proving the release means moving the clock; nothing about the delay itself
 * is simulated, and the record names every place this is used.
 */
export async function increaseTime(client: PublicClient, seconds: number): Promise<void> {
  await (client as unknown as Rpc).request({ method: 'evm_increaseTime', params: [seconds] })
  await (client as unknown as Rpc).request({ method: 'evm_mine', params: [] })
}
/**
 * The whole fork as one blob, and back again. Anvil's dump is a gzipped hex string rather than a
 * file, so it is written out and read back explicitly: the point of the restart is that the state
 * outlived the process, and a value still held in this script's memory would not show that.
 */
export async function dumpState(client: PublicClient): Promise<Hex> {
  return (await (client as unknown as Rpc).request({ method: 'anvil_dumpState' })) as Hex
}
export async function loadState(client: PublicClient, state: Hex): Promise<void> {
  const loaded = await (client as unknown as Rpc).request({ method: 'anvil_loadState', params: [state] })
  if (loaded !== true) throw new Error('The Arc fork refused the state snapshot.')
}

/**
 * Substitutes the single development guardian key into the current guardian set, and checks the
 * substitution took by reading the set back through the contract's own getter rather than trusting
 * the slot arithmetic.
 */
export async function overrideGuardianSet(
  client: PublicClient, core: Address, guardian: Address,
): Promise<{ index: number; replaced: readonly Address[] }> {
  const coreAbi = [
    { type: 'function', name: 'getCurrentGuardianSetIndex', inputs: [], outputs: [{ type: 'uint32' }], stateMutability: 'view' },
    {
      type: 'function', name: 'getGuardianSet', inputs: [{ type: 'uint32' }], stateMutability: 'view',
      outputs: [{ type: 'tuple', components: [{ type: 'address[]', name: 'keys' }, { type: 'uint32', name: 'expirationTime' }] }],
    },
  ] as const
  const index = await client.readContract({ address: core, abi: coreAbi, functionName: 'getCurrentGuardianSetIndex' })
  const before = await client.readContract({ address: core, abi: coreAbi, functionName: 'getGuardianSet', args: [index] })
  const slots = guardianSetSlots(index)
  // Zero the rest first: they are unreachable once the length is one, but leaving live keys behind
  // in storage would make a later read of this fork ambiguous about what was substituted.
  for (let position = 1; position < before.keys.length; position++) {
    await setStorage(client, core, slots.keySlot(position), `0x${'0'.repeat(64)}`)
  }
  await setStorage(client, core, slots.keySlot(0), `0x${guardian.slice(2).toLowerCase().padStart(64, '0')}`)
  await setStorage(client, core, slots.lengthSlot, `0x${(1).toString(16).padStart(64, '0')}`)
  const after = await client.readContract({ address: core, abi: coreAbi, functionName: 'getGuardianSet', args: [index] })
  if (after.keys.length !== 1 || after.keys[0].toLowerCase() !== guardian.toLowerCase()) {
    throw new Error('The guardian set substitution did not take.')
  }
  return { index, replaced: before.keys }
}

/* ------------------------------------------------------------------ deployment */

export async function deploy(
  node: { publicClient: PublicClient; wallet: WalletClient }, built: Artifact, args: readonly unknown[] = [],
): Promise<Address> {
  const hash = await node.wallet.deployContract({
    abi: built.abi, bytecode: built.bytecode, args,
    account: node.wallet.account!, chain: arcFork,
  })
  const receipt = await node.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Deployment reverted on the Arc fork.')
  return receipt.contractAddress
}

export async function call(
  node: { publicClient: PublicClient; wallet: WalletClient },
  address: Address, abi: Abi, functionName: string, args: readonly unknown[] = [],
): Promise<{ hash: Hex; logs: { topics: readonly Hex[]; data: Hex; address: Address }[] }> {
  // Simulate first, for the same reason the Solana side preflights: a refusal then arrives as the
  // contract's own custom error rather than as a receipt with status 0 and nothing to read.
  const { request } = await node.publicClient.simulateContract({
    address, abi, functionName, args, account: node.wallet.account!,
  })
  /**
   * Send with headroom over the estimate instead of exactly the estimate.
   *
   * `eth_estimateGas` prices the call against the state of the block it is asked about; the
   * transaction then executes in the next one, where a storage slot the estimate touched warm can be
   * cold again. The difference is thousands of gas, and the failure it produces is the worst kind to
   * read: a receipt with status 0 and no revert data, which looks exactly like a contract refusing.
   * Twenty-five percent is the same headroom the launchpad's own window buys use, and these are a
   * handful of calls on a local fork, so an over-estimate costs nothing but a gas figure.
   */
  const estimate = await node.publicClient.estimateContractGas({
    address, abi, functionName, args, account: node.wallet.account!,
  })
  const hash = await node.wallet.writeContract({ ...request, gas: (estimate * 125n) / 100n } as never)
  const receipt = await node.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') {
    // Re-run the transaction as a call against the block that rejected it, so the reason is the
    // contract's rather than "status 0".
    const sent = await node.publicClient.getTransaction({ hash })
    let reason = 'no revert data'
    try {
      await node.publicClient.call({ to: sent.to, data: sent.input, value: sent.value, gas: sent.gas, account: sent.from, blockNumber: receipt.blockNumber })
    } catch (error) { reason = revertReason(error) }
    throw new Error(`${functionName} reverted on the Arc fork after simulating cleanly: ${reason} (gas used ${receipt.gasUsed} of ${sent.gas})`)
  }
  return { hash, logs: receipt.logs }
}

/**
 * The revert reason, so a refusal is recorded as the constraint that held rather than "it failed".
 *
 * Viem names a custom error only when the ABI it was given declares it, which is why the calls
 * here are made with the full artifact ABI rather than a hand-written fragment. When the error is
 * still undecodable the four-byte signature is at least reported rather than swallowed.
 */
export function revertReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const lines = message.split('\n').map((line) => line.trim()).filter(Boolean)
  const named = lines.find((line) => /^Error: \w+\(/.test(line))
  const printedAt = lines.findIndex((line) => /reverted with the following (reason|signature)/i.test(line))
  const printed = printedAt >= 0 ? lines[printedAt + 1] : undefined
  return (named ?? printed ?? lines[0] ?? 'unknown').slice(0, 200)
}

/** Exactly one core bridge message, taken from the receipt the transaction actually produced. */
export function publishedMessage(
  logs: { topics: readonly Hex[]; data: Hex; address: Address }[],
): EvmPublishedMessage {
  const published = logs.filter(
    (log) => log.address.toLowerCase() === ARC_TESTNET.coreBridge.toLowerCase()
      && log.topics[0] === LOG_MESSAGE_PUBLISHED_TOPIC,
  )
  if (published.length !== 1) throw new Error(`Expected one published Wormhole message, saw ${published.length}.`)
  return parseLogMessagePublished(published[0])
}

export { parseEventLogs }
