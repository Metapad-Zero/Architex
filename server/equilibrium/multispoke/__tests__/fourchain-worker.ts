/**
 * A separate process for the four-chain suite, so a restart is real process death against the
 * shared journal.
 *   bun run fourchain-worker.ts <fourchain.json> <jobs.sqlite> <jobId> [kill-after-send:<label>]
 * Prints one JSON line { ok, state?, code?, error? }. Exit 0 when it returned, 3 when refused.
 */
import { readFileSync } from 'node:fs'
import type { Hex } from 'viem'
import { JobStore } from '../../store'
import { runJob } from '../../runner'
import { LaunchError } from '../../types'
import { multispokeAdapter } from '../adapter'
import { configFromJson } from '../fourchain'

const [configPath, dbPath, jobId, killArg] = process.argv.slice(2)
const kill = killArg?.startsWith('kill-after-send:') ? killArg.slice('kill-after-send:'.length) : null
const store = new JobStore(dbPath, { leaseMs: 2000 })
// SIGKILL: no finally blocks, no flush. The transaction is on the wire and nothing about it is recorded yet.
const adapter = multispokeAdapter(configFromJson(readFileSync(configPath, 'utf8')), store.db, { afterSend: (label) => { if (label === kill) process.kill(process.pid, 'SIGKILL') } })
try {
  const job = await runJob(store, adapter, jobId as Hex, undefined, Date.now, undefined, { leaseMs: 2000, heartbeatMs: 500 })
  console.log(JSON.stringify({ ok: true, state: job.state, error: job.error }))
  process.exit(0)
} catch (cause) {
  console.log(JSON.stringify({ ok: false, code: cause instanceof LaunchError ? cause.code : 'error', error: String(cause).slice(0, 400) }))
  process.exit(3)
}
