/**
 * A transfer worker that dies mid-transfer, so the fork suite proves restart recovery with a real
 * process exit.
 *   bun run crash-worker.ts <config.json> <jobs.sqlite> <return|refill> <transferId> <after|before>:<stepId>
 */
import { readFileSync } from 'node:fs'
import type { Hex } from 'viem'
import { JobStore } from '../../../store'
import { fromFile, type EvmFileConfig } from '../../config'
import { transferRoutes, type TransferSettings } from '../config'
import { runTransfer } from '../runner'
import { TransferStore } from '../store'
import type { TransferRoute } from '../types'

const [configPath, dbPath, kind, id, crash] = process.argv.slice(2)
const [when, step] = [crash.slice(0, crash.indexOf(':')), crash.slice(crash.indexOf(':') + 1)]
const file = JSON.parse(readFileSync(configPath, 'utf8')) as { adapter: EvmFileConfig; settings: TransferSettings }
const jobs = new JobStore(dbPath, { leaseMs: 1000 })
const routes = transferRoutes(fromFile(file.adapter), file.settings, jobs.db, (launch) => jobs.get(launch))
const inner = (routes as unknown as Record<string, TransferRoute<unknown>>)[kind === 'return' ? 'returns' : kind]
const route: TransferRoute<unknown> = { ...inner, broadcast: async (t, s, prepared) => {
  // Prepared bytes are durable here; dying now leaves an effect that was never sent.
  if (when === 'before' && s.id === step) process.exit(78)
  return inner.broadcast(t, s, prepared)
} }
await runTransfer(new TransferStore(jobs.db, 1000), route, id as Hex, Date.now, (s) => { if (when === 'after' && s === step) process.exit(77) })
process.exit(0)
