/**
 * A separate worker process for the Robinhood fork suite: real process death and real concurrency.
 *   bun run worker.ts <config.json> <route.sqlite> <transferId> <mode>
 * mode: none | kill-after-send:<operation name>
 * Prints one JSON line { ok, progress?, error? }.
 */
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { configFromJson } from '../fork'
import { robinhoodRoute } from '../route'

const [configPath, dbPath, transferId, mode] = process.argv.slice(2)
const kill = mode.startsWith('kill-after-send:') ? mode.slice('kill-after-send:'.length) : null
const db = new Database(dbPath)
db.exec('PRAGMA busy_timeout = 10000')
const route = robinhoodRoute(configFromJson(readFileSync(configPath, 'utf8')), db, {
  // SIGKILL: the transaction is on the wire and nothing about it is recorded yet.
  afterSend: (name) => { if (name === kill) process.kill(process.pid, 'SIGKILL') },
})
try {
  console.log(JSON.stringify({ ok: true, progress: await route.advance(transferId) }))
  process.exit(0)
} catch (cause) {
  console.log(JSON.stringify({ ok: false, error: String(cause).slice(0, 400) }))
  process.exit(3)
}
