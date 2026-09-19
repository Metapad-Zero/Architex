/**
 * Proves that the code at an address is the local build of a contract.
 *
 *   bun run scripts/verify-bytecode.ts <address> <ContractName> [rpc-url]
 *   bun run scripts/verify-bytecode.ts 0x… ArchitexLaunchpad
 *
 * Compares the on-chain runtime code with `contracts/out/<Name>.sol/<Name>.json` (run `forge build`
 * first). Two things legitimately differ between identical sources and are masked on both sides:
 * immutables (constructor arguments written into the code) and Solidity's metadata hashes, which
 * change with the build directory. Everything else must match byte for byte.
 */
import { readFileSync } from 'node:fs'
import { createPublicClient, getAddress, http } from 'viem'

const [addressArg, name, rpcArg] = process.argv.slice(2)
if (!addressArg || !name) throw new Error('usage: bun run scripts/verify-bytecode.ts <address> <ContractName> [rpc-url]')
const rpc = rpcArg ?? process.env.ARC_TESTNET_RPC ?? 'https://rpc.testnet.arc.io'

interface Artifact {
  deployedBytecode: { object: string; immutableReferences?: Record<string, { start: number; length: number }[]> }
}
const artifact = JSON.parse(readFileSync(`contracts/out/${name}.sol/${name}.json`, 'utf8')) as Artifact

const client = createPublicClient({ transport: http(rpc) })
const onchain = await client.getCode({ address: getAddress(addressArg) })
if (!onchain || onchain === '0x') throw new Error(`No code at ${addressArg} on ${rpc}`)

const strip = (hex: string) => hex.replace(/^0x/, '').toLowerCase()
let local = strip(artifact.deployedBytecode.object)
let remote = strip(onchain)

if (local.length !== remote.length) {
  console.log(`MISMATCH: local runtime is ${local.length / 2} bytes, on-chain is ${remote.length / 2} bytes`)
  process.exit(1)
}

function mask(hex: string, startByte: number, lengthBytes: number): string {
  return hex.slice(0, startByte * 2) + '0'.repeat(lengthBytes * 2) + hex.slice((startByte + lengthBytes) * 2)
}

let immutables = 0
for (const refs of Object.values(artifact.deployedBytecode.immutableReferences ?? {})) {
  for (const { start, length } of refs) {
    local = mask(local, start, length)
    remote = mask(remote, start, length)
    immutables++
  }
}

// CBOR metadata: a2 64 "ipfs" 58 22 <34-byte hash> 64 "solc" 43 <3-byte version> 00 33.
// It closes the contract and also sits inside any creation code the contract embeds.
const METADATA = /a264697066735822[0-9a-f]{68}64736f6c6343[0-9a-f]{6}0033/g
const blank = (hex: string) => hex.replace(METADATA, (m) => m.slice(0, 16) + '0'.repeat(68) + m.slice(84))
const metadataSections = (local.match(METADATA) ?? []).length
local = blank(local)
remote = blank(remote)

if (local === remote) {
  console.log(`MATCH: ${name} at ${getAddress(addressArg)} is the local build (${local.length / 2} bytes; masked ${immutables} immutable slots and ${metadataSections} metadata hashes)`)
  process.exit(0)
}

let first = 0
while (local[first] === remote[first]) first++
let differing = 0
for (let i = 0; i < local.length; i += 2) if (local.slice(i, i + 2) !== remote.slice(i, i + 2)) differing++
console.log(`MISMATCH: ${differing} of ${local.length / 2} bytes differ; first difference at byte ${Math.floor(first / 2)}`)
console.log(`  local  …${local.slice(Math.max(0, first - 16), first + 48)}…`)
console.log(`  remote …${remote.slice(Math.max(0, first - 16), first + 48)}…`)
process.exit(1)
