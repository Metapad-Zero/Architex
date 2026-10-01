import { readFileSync } from 'node:fs'
import { createKeeper } from './keeper'
import { createMaintenance } from './maintenance'
import { KeeperStore } from './store'
import { keeperFromJson, configFromJson, SCOPE } from './fork'

const [journal, configPath, routePath, action, id, point, side] = process.argv.slice(2)
const config = keeperFromJson(readFileSync(configPath, 'utf8'))
const routeConfig = configFromJson(readFileSync(routePath, 'utf8'))
const store = new KeeperStore(journal)
const options = { checkpoint(stage: string, operation: string) {
  const row = store.db.query<{ side: string }, [string]>('SELECT side FROM rh_sends WHERE id=?').get(operation)
  if (stage === point && row?.side === side) {
    process.stdout.write(JSON.stringify({ killed: stage, side, operation }) + '\n')
    process.kill(process.pid, 'SIGKILL')
  }
} }
try {
  if (action === 'maintenance') {
    const maintenance = createMaintenance(config, routeConfig, SCOPE, store, options)
    for (let i = 0; i < 100; i++) {
      if ((await maintenance.run({ requestId: id, tokens: '100000000' })).state === 'complete') break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  else if (action === 'trade') await createKeeper(config, store, options).runCycle(100_000_000n, { id })
  else if (action === 'recover') await createKeeper(config, store, options).recover(id)
  else throw new Error('Unknown rehearsal action')
} finally { store.close() }
