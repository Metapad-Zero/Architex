/** Foreground fork-only process. Exit 86 is an actual process crash at the named durable boundary. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JobStore } from '../../store'
import type { Transfer } from '../../evm/transfers/types'
import { createMaintenance, type MaintenanceRequest } from '../maintenance'
import { KeeperStore } from '../store'

const [dir, db, point, step, requestText] = process.argv.slice(2)
const jobs = new JobStore(db)
const store = new KeeperStore(db)
const maintenance = createMaintenance({
  keeperConfigText: readFileSync(join(dir, 'keeper.json'), 'utf8'), keeperPreview: readFileSync(join(dir, 'keeper-preview.md'), 'utf8'),
  adapterConfigText: readFileSync(join(dir, 'adapter.json'), 'utf8'), transferSettingsText: readFileSync(join(dir, 'settings.json'), 'utf8'),
}, store, (id) => jobs.get(id), { transferLeaseMs: 200, checkpoint(at, operation) {
  const transfer = store.db.query<{ data: string }, []>('SELECT data FROM evm_transfers').all()
    .map((row) => JSON.parse(row.data) as Transfer).find((t) => t.steps.some((s) => s.id === step && s.prepared?.operation === operation))
  if (at === point && transfer) { console.log(JSON.stringify({ point, step, operation, transfer: transfer.id })); process.exit(86) }
} })
try {
  console.log(JSON.stringify(await maintenance.run(JSON.parse(requestText) as MaintenanceRequest)))
} finally { store.close(); jobs.close() }
