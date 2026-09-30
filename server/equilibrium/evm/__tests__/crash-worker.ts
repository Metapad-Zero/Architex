/**
 * A worker process for the fork suite: real process exits and real concurrency, not simulations.
 *   bun run crash-worker.ts <config.json> <jobs.sqlite> <jobId> <payment.json> <mode>
 * mode: none | after:<stepId> | before:<stepId> | kill-after-send:<stepId>
 * Prints one JSON line: { ok, state?, code?, error? }. Exit 0 when the run returned, 3 when refused.
 */
import { readFileSync } from 'node:fs'
import { JobStore } from '../../store'
import { runJob } from '../../runner'
import { evmAdapter } from '../adapter'
import { fromFile, type EvmFileConfig } from '../config'
import { LaunchError, type SignedPayment } from '../../types'
import type { Hex } from 'viem'

const [configPath, dbPath, jobId, paymentPath, mode] = process.argv.slice(2)
const split = mode.indexOf(':')
const [when, step] = split < 0 ? [mode, ''] : [mode.slice(0, split), mode.slice(split + 1)]
const store = new JobStore(dbPath, { leaseMs: 1000 })
const inner = evmAdapter(fromFile(JSON.parse(readFileSync(configPath, 'utf8')) as EvmFileConfig), store.db, {
  // SIGKILL: no finally blocks, no flush. The transaction is on the wire and nothing about it is recorded yet.
  afterSend: (s) => { if (when === 'kill-after-send' && s.id === step) process.kill(process.pid, 'SIGKILL') },
})
const adapter = { ...inner, broadcast: async (context: Parameters<typeof inner.broadcast>[0], prepared: Parameters<typeof inner.broadcast>[1]) => {
  // Prepared bytes are already durable here; dying now leaves an effect that was never sent.
  if (when === 'before' && context.step.id === step) process.exit(78)
  return inner.broadcast(context, prepared)
} }
try {
  const job = await runJob(store, adapter, jobId as Hex, JSON.parse(readFileSync(paymentPath, 'utf8')) as SignedPayment, Date.now, (id) => { if (when === 'after' && id === step) process.exit(77) }, { leaseMs: 1000 })
  console.log(JSON.stringify({ ok: true, state: job.state, error: job.error }))
  process.exit(0)
} catch (cause) {
  console.log(JSON.stringify({ ok: false, code: cause instanceof LaunchError ? cause.code : 'error', error: String(cause).slice(0, 300) }))
  process.exit(3)
}
