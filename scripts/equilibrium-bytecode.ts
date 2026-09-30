/**
 * Bundle the exact creation code the EVM adapter deploys, with its provenance.
 *
 * NTT is built by its own `prod` profile (solc 0.8.19, via-IR, London) at the pinned submodule
 * commit, which is how upstream ships it and what keeps NttManager under the EIP-170 limit.
 * EQUILIBRIUM contracts come from this repository's `equilibrium` profile.
 *
 *   (cd lib/ntt/evm && FOUNDRY_PROFILE=prod forge build src/NttManager/NttManager.sol \
 *      src/Transceiver/WormholeTransceiver/WormholeTransceiver.sol \
 *      lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol)
 *   FOUNDRY_PROFILE=equilibrium forge build
 *   bun run scripts/equilibrium-bytecode.ts [--check]
 */
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const OUT = 'server/equilibrium/evm/bytecode.json'
type Artifact = { bytecode: { object: string; linkReferences?: Record<string, Record<string, { start: number; length: number }[]>> }; metadata: { compiler: { version: string } } }
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Artifact
function entry(path: string) {
  const artifact = read(path)
  const links = Object.entries(artifact.bytecode.linkReferences ?? {}).flatMap(([, libs]) => Object.entries(libs).map(([name, refs]) => ({ name, starts: refs.map((r) => r.start) })))
  return { bytecode: artifact.bytecode.object, compiler: artifact.metadata.compiler.version, links, sha256: createHash('sha256').update(artifact.bytecode.object).digest('hex') }
}
const ntt = 'lib/ntt/evm/out'
const local = 'contracts-equilibrium/out'
const bundle = {
  ntt: {
    commit: execSync('git -C lib/ntt rev-parse HEAD').toString().trim(), profile: 'prod',
    NttManager: entry(`${ntt}/NttManager.sol/NttManager.json`),
    WormholeTransceiver: entry(`${ntt}/WormholeTransceiver.sol/WormholeTransceiver.json`),
    TransceiverStructs: entry(`${ntt}/TransceiverStructs.sol/TransceiverStructs.json`),
    ERC1967Proxy: entry(`${ntt}/ERC1967Proxy.sol/ERC1967Proxy.json`),
  },
  equilibrium: {
    profile: 'equilibrium',
    EquilibriumExecutor: entry(`${local}/EquilibriumExecutor.sol/EquilibriumExecutor.json`),
    EquilibriumCanonical: entry(`${local}/EquilibriumToken.sol/EquilibriumCanonical.json`),
    EquilibriumSpoke: entry(`${local}/EquilibriumToken.sol/EquilibriumSpoke.json`),
    ForkUsdc: entry(`${local}/ForkUsdc.sol/ForkUsdc.json`),
  },
}
const text = JSON.stringify(bundle, null, 1) + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) { console.error(`${OUT} differs from a fresh build. Rebuild and regenerate.`); process.exit(1) }
  console.log(`${OUT} matches the fresh build.`)
} else { writeFileSync(OUT, text); console.log(`Wrote ${OUT}`) }
