/**
 * A separate launch-job worker process for the Robinhood fulfillment suite: real process death and
 * real concurrency against the shared job journal.
 *   bun run fulfillment-worker.ts <fulfillment.json> <jobs.sqlite> <jobId> <mode> [leaseMs]
 * mode: none | kill-after-send:<stepId>
 * Prints one JSON line { ok, state?, code?, error? }. Exit 0 when the run returned, 3 when refused.
 */
import { readFileSync } from 'node:fs'
import type { Hex } from 'viem'
import { JobStore } from '../../store'
import { runJob } from '../../runner'
import { LaunchError } from '../../types'
import { robinhoodFulfillment } from '../fulfillment'
import { fulfillmentFromJson } from '../fulfillment-fork'

const [configPath, dbPath, jobId, mode, lease] = process.argv.slice(2)
const kill = mode.startsWith('kill-after-send:') ? mode.slice('kill-after-send:'.length) : null
const leaseMs = Number(lease ?? '2000')
const store = new JobStore(dbPath, { leaseMs })
// SIGKILL: no finally blocks, no flush. The transaction is on the wire and nothing about it is recorded yet.
const adapter = robinhoodFulfillment(fulfillmentFromJson(readFileSync(configPath, 'utf8')), store.db, { afterSend: (step) => { if (step === kill) process.kill(process.pid, 'SIGKILL') } })
try {
  const job = await runJob(store, adapter, jobId as Hex, undefined, Date.now, undefined, { leaseMs, heartbeatMs: Math.floor(leaseMs / 4) })
  console.log(JSON.stringify({ ok: true, state: job.state, error: job.error }))
  process.exit(0)
} catch (cause) {
  console.log(JSON.stringify({ ok: false, code: cause instanceof LaunchError ? cause.code : 'error', error: String(cause).slice(0, 400) }))
  process.exit(3)
}
