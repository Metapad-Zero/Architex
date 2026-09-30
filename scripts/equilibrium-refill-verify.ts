/**
 * Read-only check that Circle's CCTP V2 testnet deployment is still what the refill route pins
 * (server/equilibrium/evm/transfers/cctp.ts). Sends nothing and signs nothing.
 *
 *   bun run equilibrium:refill-verify [--block-arc <n> --block-base <n>]
 *
 * Exits non-zero when any pinned fact differs, so a changed deployment closes the rail by review
 * rather than by surprise.
 */
import { createPublicClient, http, type Address } from 'viem'
import { CCTP_TESTNET, TESTNET_ATTESTERS, bytes32, messageTransmitterAbi, tokenMessengerAbi, tokenMinterAbi } from '../server/equilibrium/evm/transfers/cctp'

const RPC = { arc: process.env.EQUILIBRIUM_ARC_RPC ?? 'https://rpc.testnet.arc.io', base: process.env.EQUILIBRIUM_BASE_RPC ?? 'https://sepolia.base.org' }
const IRIS = process.env.EQUILIBRIUM_IRIS ?? 'https://iris-api-sandbox.circle.com'
const flags = process.argv.slice(2)
const block = (name: string) => (flags.includes(name) ? BigInt(flags[flags.indexOf(name) + 1]) : undefined)
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

const report: Record<string, unknown> = {}
const failures: string[] = []
const check = (label: string, ok: boolean) => { if (!ok) failures.push(label) }
for (const name of ['arc', 'base'] as const) {
  const c = CCTP_TESTNET[name]; const other = CCTP_TESTNET[name === 'arc' ? 'base' : 'arc']
  const client = createPublicClient({ transport: http(RPC[name]) })
  const blockNumber = block(`--block-${name}`) ?? await client.getBlockNumber()
  // One untyped reader for several ABIs; each call site states the type it expects.
  const readAny = client.readContract as unknown as (request: { address: Address; abi: readonly unknown[]; functionName: string; args: unknown[]; blockNumber: bigint }) => Promise<unknown>
  const read = async <T>(address: Address, abi: readonly unknown[], functionName: string, args: unknown[] = []) => (await readAny({ address, abi, functionName, args, blockNumber })) as T
  const codes: Record<string, boolean> = {}
  for (const k of ['tokenMessenger', 'messageTransmitter', 'tokenMinter', 'usdc'] as const) codes[k] = ((await client.getCode({ address: c[k], blockNumber })) ?? '0x').length > 2
  const count = await read<bigint>(c.messageTransmitter, messageTransmitterAbi, 'getNumEnabledAttesters')
  const facts = {
    chainId: await client.getChainId(), block: blockNumber.toString(), code: codes,
    localDomain: await read<number>(c.messageTransmitter, messageTransmitterAbi, 'localDomain'),
    version: await read<number>(c.messageTransmitter, messageTransmitterAbi, 'version'),
    paused: await read<boolean>(c.messageTransmitter, messageTransmitterAbi, 'paused'),
    threshold: (await read<bigint>(c.messageTransmitter, messageTransmitterAbi, 'signatureThreshold')).toString(),
    attesters: await Promise.all(Array.from({ length: Number(count) }, (_, i) => read<Address>(c.messageTransmitter, messageTransmitterAbi, 'getEnabledAttester', [BigInt(i)]))),
    localMessageTransmitter: await read<Address>(c.tokenMessenger, tokenMessengerAbi, 'localMessageTransmitter'),
    localMinter: await read<Address>(c.tokenMessenger, tokenMessengerAbi, 'localMinter'),
    remoteTokenMessenger: await read<string>(c.tokenMessenger, tokenMessengerAbi, 'remoteTokenMessengers', [other.domain]),
    remoteUsdcMapsTo: await read<Address>(c.tokenMinter, tokenMinterAbi, 'getLocalToken', [other.domain, bytes32(other.usdc)]),
    burnLimitPerMessage: (await read<bigint>(c.tokenMinter, tokenMinterAbi, 'burnLimitsPerMessage', [c.usdc])).toString(),
  }
  report[name] = facts
  check(`${name}: code present`, Object.values(codes).every(Boolean))
  check(`${name}: local domain ${c.domain}`, facts.localDomain === c.domain)
  check(`${name}: message version 1`, facts.version === 1)
  check(`${name}: not paused`, !facts.paused)
  check(`${name}: transmitter wiring`, same(facts.localMessageTransmitter, c.messageTransmitter) && same(facts.localMinter, c.tokenMinter))
  check(`${name}: remote messenger`, same(facts.remoteTokenMessenger, bytes32(other.tokenMessenger)))
  check(`${name}: remote USDC maps to local USDC`, same(facts.remoteUsdcMapsTo, c.usdc))
  check(`${name}: attesters are Circle's published V2 keys`, facts.attesters.length === TESTNET_ATTESTERS.length && facts.attesters.every((a) => TESTNET_ATTESTERS.some((b) => same(a, b))) && facts.threshold === '2')
}
try {
  const keys = await (await fetch(`${IRIS}/v2/publicKeys`)).json() as { publicKeys?: { publicKey: string; cctpVersion?: number }[] }
  report.iris = { api: IRIS, v2Keys: (keys.publicKeys ?? []).filter((k) => k.cctpVersion === 2).length }
} catch (cause) { report.iris = { api: IRIS, error: String(cause) } }
report.closed = { solana: 'owned by 49TH-26; not a route here', robinhood: 'no pinned CCTP deployment for this route' }
report.ok = failures.length === 0
report.failures = failures
console.log(JSON.stringify(report, null, 2))
process.exit(failures.length ? 1 : 0)
