/**
 * Bundle the fork-only creation code the transfer rehearsals need, apart from the launch bundle
 * (server/equilibrium/evm/bytecode.json), which the launch approval binds and this must not touch.
 *
 *   FOUNDRY_PROFILE=equilibrium forge build
 *   bun run scripts/equilibrium-transfer-bytecode.ts [--check]
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const OUT = 'server/equilibrium/evm/transfers/fork-bytecode.json'
const artifact = JSON.parse(readFileSync('contracts-equilibrium/out/ForkUsdcCctp.sol/ForkUsdcCctp.json', 'utf8')) as { bytecode: { object: string }; deployedBytecode: { object: string }; metadata: { compiler: { version: string } } }
const bundle = { profile: 'equilibrium', note: 'FORK ONLY', ForkUsdcCctp: { bytecode: artifact.bytecode.object, compiler: artifact.metadata.compiler.version, links: [], sha256: createHash('sha256').update(artifact.bytecode.object).digest('hex') } }
const text = JSON.stringify(bundle, null, 1) + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) { console.error(`${OUT} differs from a fresh build. Rebuild and regenerate.`); process.exit(1) }
  console.log(`${OUT} matches the fresh build.`)
} else { writeFileSync(OUT, text); console.log(`Wrote ${OUT}`) }
