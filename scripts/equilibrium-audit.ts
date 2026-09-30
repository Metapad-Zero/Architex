import { readFileSync } from 'node:fs'
import { auditSupply } from '../server/equilibrium/audit'

const path = process.argv[2]
try {
  if (!path || process.argv.length !== 3) throw new Error('Usage: bun run equilibrium:audit <approved-deployment-manifest.json>')
  const result = await auditSupply(JSON.parse(readFileSync(path, 'utf8')) as unknown)
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.verified ? 0 : 1
} catch (cause) {
  console.log(JSON.stringify({ verified: false, paidLaunchOpen: false, routeTested: false, error: cause instanceof Error ? cause.message : 'Audit could not verify evidence' }, null, 2))
  process.exitCode = 1
}
