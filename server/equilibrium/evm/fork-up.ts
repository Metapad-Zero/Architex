/**
 * Start the pinned Arc and Base forks with infrastructure deployed, write the adapter configuration,
 * and keep them running until interrupted. Local only; see fork.ts for the substitutions.
 *   bun run equilibrium:fork-up [--out deployments/equilibrium-fork.json]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { toFile } from './config'
import { DEV, forkEnvironment } from './fork'

const flags = process.argv.slice(2)
const out = flags.includes('--out') ? flags[flags.indexOf('--out') + 1] : './output/equilibrium/fork-config.json'
const env = await forkEnvironment({ arcPort: 18545, basePort: 18546 })
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(toFile(env.config, 0), null, 2) + '\n')
console.log(JSON.stringify({ config: out, arc: env.arc.url, base: env.base.url, arcExecutor: env.config.arc.executor, baseExecutor: env.config.base.executor, payer: env.payer,
  env: { EQUILIBRIUM_OPERATOR_KEY: DEV.operator, EQUILIBRIUM_FORK_GUARDIAN_KEY: DEV.guardian, EQUILIBRIUM_PAYER_KEY: DEV.payer, note: 'anvil development keys, fork only' } }, null, 2))
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { env.stop(); process.exit(0) })
setInterval(() => undefined, 1 << 30)
