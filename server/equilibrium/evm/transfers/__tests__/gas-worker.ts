/**
 * One transfer sender in its own process, for the gas-ledger regressions: competing processes on
 * one store, and a real process kill on either side of the irreversible send.
 *   bun run gas-worker.ts <config.json> <db> <operationSeed> <send|kill-before-send|kill-after-send>
 * Exit 0 sent (or nothing to send), 3 refused by the gas cap, 77 killed after send, 78 killed before send.
 */
import { readFileSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { hash } from '../../../request'
import { LaunchError } from '../../../types'
import { executorSender, prepared, type ExecutorPlan, type SenderConfig } from '../executor'

const [configPath, dbPath, seed, mode] = process.argv.slice(2)
const raw = JSON.parse(readFileSync(configPath, 'utf8'), (_, v: unknown) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)) as SenderConfig
// Opened directly with busy_timeout FIRST: JobStore sets journal_mode before busy_timeout, so three
// processes opening one store at the same instant can fail at startup with SQLITE_BUSY (reported to 49TH-25).
const db = new Database(dbPath, { strict: true })
db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
const sender = executorSender(raw, db, {
  beforeSend: () => { if (mode === 'kill-before-send') process.exit(78) },
  afterSend: () => { if (mode === 'kill-after-send') process.exit(77) },
})
const plan: ExecutorPlan = { chain: 'base', chainId: raw.base.chainId, executor: raw.base.executor, operation: hash([seed]), calls: [], value: '0', fromBlock: '0', expect: {} }
try {
  await sender.broadcast(plan, prepared(plan).digest)
  process.exit(0)
} catch (cause) {
  console.log(String(cause instanceof Error ? cause.message : cause))
  process.exit(cause instanceof LaunchError && cause.code === 'gas_cap' ? 3 : 1)
}
