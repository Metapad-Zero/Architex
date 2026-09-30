/**
 * A worker process that dies mid-launch. Used by the fork suite to prove restart recovery with a
 * real process exit, not a simulated exception.
 *   bun run crash-worker.ts <config.json> <jobs.sqlite> <jobId> <payment.json> <after|before>:<stepId>
 */
import { readFileSync } from 'node:fs'
import { JobStore } from '../../store'
import { runJob } from '../../runner'
import { evmAdapter } from '../adapter'
import { fromFile, type EvmFileConfig } from '../config'
import type { SignedPayment } from '../../types'
import type { Hex } from 'viem'

const [configPath, dbPath, jobId, paymentPath, crash] = process.argv.slice(2)
const [when, step] = [crash.slice(0, crash.indexOf(':')), crash.slice(crash.indexOf(':') + 1)]
const store = new JobStore(dbPath, { leaseMs: 1000 })
const inner = evmAdapter(fromFile(JSON.parse(readFileSync(configPath, 'utf8')) as EvmFileConfig), store.db)
const adapter = { ...inner, broadcast: async (context: Parameters<typeof inner.broadcast>[0], prepared: Parameters<typeof inner.broadcast>[1]) => {
  // Prepared bytes are already durable here; dying now leaves an effect that was never sent.
  if (when === 'before' && context.step.id === step) process.exit(78)
  return inner.broadcast(context, prepared)
} }
await runJob(store, adapter, jobId as Hex, JSON.parse(readFileSync(paymentPath, 'utf8')) as SignedPayment, Date.now, (id) => { if (when === 'after' && id === step) process.exit(77) }, { leaseMs: 1000 })
process.exit(0)
