import { mkdirSync, writeFileSync } from 'node:fs'
import { JobStore } from './store'
import { localAdapter } from './localAdapter'
import { publicJob, quote, runJob } from './runner'
import { fixture, sign } from './__tests__/fixtures'

const flags = process.argv.slice(2)
const value = (name: string) => flags[flags.indexOf(name) + 1]
const db = flags.includes('--db') ? value('--db') : './output/equilibrium/rehearsal.sqlite'
const clock = flags.includes('--clock') ? Number(value('--clock')) : Date.now()
const store = new JobStore(db)
const adapter = localAdapter(store)
try {
  const existing = store.list(1)[0]
  const job = existing ?? quote(store, adapter, fixture(Math.floor(clock / 1000)), Math.floor(clock / 1000))
  const result = await runJob(store, adapter, job.id, job.payment ?? await sign(job), () => clock, (step) => {
    if (flags.includes('--crash-step') && step === value('--crash-step')) process.exit(77)
  })
  const report = { mode: 'local', note: 'Synthetic payment, deployment and supply records. NTT authentication is exercised separately in the fork contract suite.', job: publicJob(result),
    effects: store.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM local_effects').get()!.count }
  if (!flags.includes('--db')) { mkdirSync('./output/equilibrium', { recursive: true }); writeFileSync('./output/equilibrium/launch-rehearsal.json', JSON.stringify(report, null, 2) + '\n') }
  console.log(JSON.stringify(report))
} finally { store.close() }
