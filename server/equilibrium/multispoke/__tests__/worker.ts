/**
 * A separate process for the multispoke fork suite: real process death and real concurrency against
 * the shared journal.
 *   bun run worker.ts <multispoke.json> <jobs.sqlite> <jobId|-> <mode> [leaseMs] [kill-after-send:<label>]
 * mode: none | kill-after-send:<stepId> | refund | operator:<name>:<to>:<amount>
 * Prints one JSON line { ok, state?, code?, error?, refund?, transaction? }. Exit 0 when it returned, 3 when refused.
 */
import { readFileSync } from 'node:fs'
import type { Address, Hex } from 'viem'
import { JobStore } from '../../store'
import { runJob } from '../../runner'
import { LaunchError } from '../../types'
import { multispokeAdapter } from '../adapter'
import { configFromJson } from '../fork'

const [configPath, dbPath, jobId, mode, lease, killArg] = process.argv.slice(2)
const kill = mode.startsWith('kill-after-send:') ? mode.slice('kill-after-send:'.length) : killArg?.startsWith('kill-after-send:') ? killArg.slice('kill-after-send:'.length) : null
const leaseMs = Number(lease ?? '2000')
const store = new JobStore(dbPath, { leaseMs })
// SIGKILL: no finally blocks, no flush. The transaction is on the wire and nothing about it is recorded yet.
const adapter = multispokeAdapter(configFromJson(readFileSync(configPath, 'utf8')), store.db, { afterSend: (label) => { if (label === kill) process.kill(process.pid, 'SIGKILL') } })
try {
  if (mode === 'refund') {
    const l = await adapter.refund(jobId)
    console.log(JSON.stringify({ ok: true, refund: l.refund, transaction: l.refund_tx }))
  } else if (mode.startsWith('operator:')) {
    const [, name, to, amount] = mode.split(':')
    const r = await adapter.operatorSend(name, to as Address, BigInt(amount))
    console.log(JSON.stringify({ ok: true, transaction: r.transaction }))
  } else {
    const job = await runJob(store, adapter, jobId as Hex, undefined, Date.now, undefined, { leaseMs, heartbeatMs: Math.floor(leaseMs / 4) })
    console.log(JSON.stringify({ ok: true, state: job.state, error: job.error }))
  }
  process.exit(0)
} catch (cause) {
  console.log(JSON.stringify({ ok: false, code: cause instanceof LaunchError ? cause.code : 'error', error: String(cause).slice(0, 400) }))
  process.exit(3)
}
