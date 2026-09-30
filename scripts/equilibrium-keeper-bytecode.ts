/**
 * Bundle the creation code of the keeper contracts, with its provenance.
 *
 * Deliberately a separate bundle from `server/equilibrium/evm/bytecode.json`: the launch adapter
 * hashes that bundle into the version its release approval is bound to, so adding the keeper there
 * would invalidate the approved launch configuration. The keeper carries its own manifest and its
 * own approval preview.
 *
 *   FOUNDRY_PROFILE=equilibrium forge build
 *   bun run scripts/equilibrium-keeper-bytecode.ts [--check]
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const OUT = 'server/equilibrium/keeper/bytecode.json'
type Artifact = { bytecode: { object: string; linkReferences?: Record<string, Record<string, { start: number; length: number }[]>> }; metadata: { compiler: { version: string } } }
function entry(path: string) {
  const artifact = JSON.parse(readFileSync(path, 'utf8')) as Artifact
  const links = Object.entries(artifact.bytecode.linkReferences ?? {}).flatMap(([, libs]) => Object.entries(libs).map(([name, refs]) => ({ name, starts: refs.map((r) => r.start) })))
  if (links.length) throw new Error(`${path} needs libraries linked; the keeper bundle expects none`)
  return { bytecode: artifact.bytecode.object, compiler: artifact.metadata.compiler.version, sha256: createHash('sha256').update(artifact.bytecode.object).digest('hex') }
}
const bundle = { profile: 'equilibrium', EquilibriumKeeper: entry('contracts-equilibrium/out/EquilibriumKeeper.sol/EquilibriumKeeper.json') }
const text = JSON.stringify(bundle, null, 1) + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) { console.error(`${OUT} differs from a fresh build. Rebuild and regenerate.`); process.exit(1) }
  console.log(`${OUT} matches the fresh build.`)
} else { writeFileSync(OUT, text); console.log(`Wrote ${OUT}`) }
