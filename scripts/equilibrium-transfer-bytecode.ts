/**
 * Bundle the fork-only creation code the transfer rehearsals need, apart from the launch bundle
 * (server/equilibrium/evm/bytecode.json), which the launch approval binds and this must not touch.
 *
 *   bun run scripts/equilibrium-transfer-bytecode.ts [--check]
 *
 * It builds ForkUsdcCctp itself and compares the whole creation code, CBOR metadata included.
 * Foundry's auto-detected remappings for nested libraries carry the checkout's absolute path, and
 * the compiler metadata hashes them, so the same source built in two directories differs in its
 * metadata trailer. This build turns auto-detection off for this one contract (the project's
 * remappings.txt and the equilibrium profile's remappings are all relative), writes to its own
 * output directory and leaves foundry.toml and the launch artifacts untouched. The result is
 * identical in any checkout with the locked node_modules.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const OUT = 'server/equilibrium/evm/transfers/fork-bytecode.json'
const BUILD = 'output/forge-fork'
try {
  execFileSync('forge', ['build', 'contracts-equilibrium/test/ForkUsdcCctp.sol', '--out', `${BUILD}/out`, '--cache-path', `${BUILD}/cache`, '--force'], {
    stdio: 'pipe', env: { ...process.env, FOUNDRY_PROFILE: 'equilibrium', FOUNDRY_AUTO_DETECT_REMAPPINGS: 'false' },
  })
} catch (cause) { console.error(String((cause as { stderr?: Buffer }).stderr ?? cause)); process.exit(1) }
const artifact = JSON.parse(readFileSync(`${BUILD}/out/ForkUsdcCctp.sol/ForkUsdcCctp.json`, 'utf8')) as { bytecode: { object: string }; rawMetadata: string; metadata: { compiler: { version: string } } }
const remappings = (JSON.parse(artifact.rawMetadata) as { settings: { remappings: string[] } }).settings.remappings
if (remappings.some((r) => r.includes(process.cwd()))) throw new Error('An absolute remapping reached the metadata; the bundle would depend on the checkout path.')
const openzeppelin = (JSON.parse(readFileSync('node_modules/@openzeppelin/contracts/package.json', 'utf8')) as { version: string }).version
const bundle = { profile: 'equilibrium', note: 'FORK ONLY', build: { autoDetectRemappings: false, remappings, openzeppelin },
  ForkUsdcCctp: { bytecode: artifact.bytecode.object, compiler: artifact.metadata.compiler.version, links: [], sha256: createHash('sha256').update(artifact.bytecode.object).digest('hex') } }
const text = JSON.stringify(bundle, null, 1) + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) { console.error(`${OUT} differs from a fresh build (metadata included). Rebuild and regenerate.`); process.exit(1) }
  console.log(`${OUT} matches a fresh build, metadata included (sha256 ${bundle.ForkUsdcCctp.sha256}).`)
} else { writeFileSync(OUT, text); console.log(`Wrote ${OUT}`) }
