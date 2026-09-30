/**
 * Bundle the exact creation code the EVM adapter deploys, with its provenance.
 *
 * NTT is built by its own `prod` profile (solc 0.8.19, via-IR, London) at the pinned submodule
 * commit, which is how upstream ships it and what keeps NttManager under the EIP-170 limit.
 * EQUILIBRIUM contracts come from this repository's `equilibrium` profile.
 *
 *   bun run equilibrium:bytecode-build [--check]
 *
 * All creation code (including CBOR metadata and link placeholders) is compared verbatim.
 * Metadata pins settings and every source hash; stale artifacts and absolute paths are refused.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { keccak256 } from 'viem'

const OUT = 'server/equilibrium/evm/bytecode.json'
type Artifact = {
  bytecode: { object: string; linkReferences?: Record<string, Record<string, { start: number; length: number }[]>> }
  rawMetadata: string
  metadata: { compiler: { version: string }; settings: { remappings: string[] }; sources: Record<string, { keccak256: string }> }
}
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Artifact
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function entry(path: string, root: string, compiler: string) {
  const artifact = read(path)
  if (artifact.metadata.compiler.version !== compiler) throw new Error(`Unexpected compiler for ${path}`)
  const absolute = (value: string) => isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)
  for (const mapping of artifact.metadata.settings.remappings) {
    if (mapping.split(/[=:]/).some(absolute)) throw new Error(`Checkout-absolute remapping in ${path}: ${mapping}`)
  }
  const sources = Object.entries(artifact.metadata.sources).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([file, source]) => {
    if (absolute(file) || keccak256(readFileSync(join(root, file))) !== source.keccak256) throw new Error(`Stale or absolute source in ${path}: ${file}`)
    return { file, keccak256: source.keccak256 }
  })
  const links = Object.entries(artifact.bytecode.linkReferences ?? {}).flatMap(([, libs]) => Object.entries(libs).map(([name, refs]) => ({ name, starts: refs.map((r) => r.start) })))
  return { bytecode: artifact.bytecode.object, compiler, links, sha256: sha256(artifact.bytecode.object), metadataSha256: sha256(artifact.rawMetadata), sources }
}
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trimEnd()
const submodules = git('submodule', 'status', '--recursive').split('\n').map((line) => {
  if (!/^ [0-9a-f]{40} /.test(line)) throw new Error(`Dependency does not match its pinned gitlink: ${line}`)
  const [, commit, path] = line.split(/\s+/)
  return { path, commit }
})
const ntt = 'lib/ntt/evm/out'
const local = 'contracts-equilibrium/out'
const nttEntry = (path: string) => entry(`${ntt}/${path}`, 'lib/ntt/evm', '0.8.19+commit.7dd6d404')
const localEntry = (path: string) => entry(`${local}/${path}`, '.', '0.8.28+commit.7893614a')
const openzeppelin = JSON.parse(readFileSync('node_modules/@openzeppelin/contracts/package.json', 'utf8')) as { version: string }
const bundle = {
  provenance: {
    submodules,
    lockfileSha256: sha256(readFileSync('bun.lock')),
    openzeppelin: openzeppelin.version,
    buildInputs: ['foundry.toml', 'remappings.txt', 'scripts/equilibrium-ntt-remappings.txt', 'scripts/equilibrium-build-bytecode.sh', 'lib/ntt/evm/foundry.toml']
      .map((file) => ({ file, sha256: sha256(readFileSync(file)) })),
  },
  ntt: {
    commit: git('-C', 'lib/ntt', 'rev-parse', 'HEAD'), profile: 'prod',
    NttManager: nttEntry('NttManager.sol/NttManager.json'),
    WormholeTransceiver: nttEntry('WormholeTransceiver.sol/WormholeTransceiver.json'),
    TransceiverStructs: nttEntry('TransceiverStructs.sol/TransceiverStructs.json'),
    ERC1967Proxy: nttEntry('ERC1967Proxy.sol/ERC1967Proxy.json'),
  },
  equilibrium: {
    profile: 'equilibrium',
    EquilibriumExecutor: localEntry('EquilibriumExecutor.sol/EquilibriumExecutor.json'),
    EquilibriumCanonical: localEntry('EquilibriumToken.sol/EquilibriumCanonical.json'),
    EquilibriumSpoke: localEntry('EquilibriumToken.sol/EquilibriumSpoke.json'),
    ForkUsdc: localEntry('ForkUsdc.sol/ForkUsdc.json'),
  },
}
const text = JSON.stringify(bundle, null, 1) + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) { console.error(`${OUT} differs from a fresh build. Rebuild and regenerate.`); process.exit(1) }
  console.log(`${OUT} matches the fresh build.`)
} else { writeFileSync(OUT, text); console.log(`Wrote ${OUT}`) }
