/**
 * Operator CLI for EQUILIBRIUM transfers: the Base→Arc return and the USDC quote refill.
 *
 *   bun run equilibrium:transfer digest                                   read-only; prints EQUILIBRIUM_TRANSFER_APPROVAL
 *   bun run equilibrium:transfer return --launch <jobId> --request-id <id> --amount <atoms> --recipient <0x>
 *   bun run equilibrium:transfer return --launch <jobId> --transaction <baseTx>     relay a holder's own burn
 *   bun run equilibrium:transfer refill --request-id <id> --from arc --to base --amount <atoms>
 *   bun run equilibrium:transfer run <transferId> | sweep | status [transferId] | supply --launch <jobId>
 *
 * Environment: EQUILIBRIUM_EVM_CONFIG (the launch adapter configuration), EQUILIBRIUM_TRANSFER_SETTINGS
 * (transfer caps, attestation source, operator gas caps), EQUILIBRIUM_OPERATOR_KEY and EQUILIBRIUM_DB (the
 * launch store holding the launch). Outside forks, anything that can send requires
 * EQUILIBRIUM_TRANSFER_APPROVAL to equal `digest`. There is no live mode.
 */
import { readFileSync } from 'node:fs'
import { JobStore, assertDurableStore } from '../../store'
import { fromFile, type EvmFileConfig } from '../config'
import { assertTransfersApproved, transferApprovalDigest, transferRoutes, type TransferSettings } from './config'
import { conservation } from './returns'
import { createTransfer, publicTransfer, reconcileTransfers, runTransfer } from './runner'
import { TransferStore } from './store'
import type { TransferRoute } from './types'

const [command, ...rest] = process.argv.slice(2)
const flag = (name: string) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined)
const need = (name: string) => flag(name) ?? (() => { throw new Error(`${name} is required`) })()
const configPath = process.env.EQUILIBRIUM_EVM_CONFIG
const settingsPath = process.env.EQUILIBRIUM_TRANSFER_SETTINGS
if (!configPath || !settingsPath) throw new Error('EQUILIBRIUM_EVM_CONFIG and EQUILIBRIUM_TRANSFER_SETTINGS must name the launch configuration and the transfer settings.')
const configText = readFileSync(configPath, 'utf8')
const settingsText = readFileSync(settingsPath, 'utf8')
const file = JSON.parse(configText) as EvmFileConfig
if (command === 'digest') {
  console.log(JSON.stringify({ EQUILIBRIUM_TRANSFER_APPROVAL: transferApprovalDigest(configText, settingsText), binds: [configPath, settingsPath, 'transfer code manifest (config.ts TRANSFER_FILES)'] }, null, 2))
  process.exit(0)
}
assertTransfersApproved(file.mode, configText, settingsText, process.env.EQUILIBRIUM_TRANSFER_APPROVAL, [file.arc.rpc, file.base.rpc])
const jobs = new JobStore(assertDurableStore(process.env.EQUILIBRIUM_DB ?? './output/equilibrium/evm.sqlite'))
const store = new TransferStore(jobs.db, 60_000)
const routes = transferRoutes(fromFile(file), JSON.parse(settingsText) as TransferSettings, jobs.db, (id) => jobs.get(id))
const routeOf = (kind: string): TransferRoute<unknown> => {
  const route = kind === 'return' ? routes.returns : routes.refill
  if (!route) throw new Error('The refill rail is closed: the transfer settings carry no refill section.')
  return route
}
const now = () => Math.floor(Date.now() / 1000)
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2))

if (command === 'return' || command === 'refill') {
  const raw = command === 'refill'
    ? { kind: 'refill', requestId: need('--request-id'), from: need('--from'), to: need('--to'), amount: need('--amount'), maxFee: '0' }
    : flag('--transaction')
      ? { kind: 'return', source: 'holder', launch: need('--launch'), transaction: need('--transaction') }
      : { kind: 'return', source: 'executor', requestId: need('--request-id'), launch: need('--launch'), amount: need('--amount'), recipient: need('--recipient') }
  const route = routeOf(command)
  const t = await createTransfer(store, route, raw, now())
  print(publicTransfer(await runTransfer(store, route, t.id)))
} else if (command === 'run') {
  const t = store.get(rest[0])
  if (!t) throw new Error('Unknown transfer')
  print(publicTransfer(await runTransfer(store, routeOf(t.kind), t.id)))
} else if (command === 'sweep') {
  print({ returns: await reconcileTransfers(store, routes.returns), refill: routes.refill ? await reconcileTransfers(store, routes.refill) : 'closed' })
} else if (command === 'status') {
  print(rest[0] ? publicTransfer(store.get(rest[0]) ?? (() => { throw new Error('Unknown transfer') })()) : store.list().map(publicTransfer))
} else if (command === 'supply') {
  const job = jobs.get(need('--launch'))
  if (!job) throw new Error('Unknown launch')
  print(await conservation(routes.sender, fromFile(file), job))
} else {
  throw new Error('Commands: digest | return | refill | run <id> | sweep | status [id] | supply --launch <id>')
}
jobs.close()
