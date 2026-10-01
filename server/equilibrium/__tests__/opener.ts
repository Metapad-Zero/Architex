/**
 * One process opening a shared launch journal the way every service and worker does at startup:
 * the job store, then the Robinhood fulfillment and Arc–Base–Robinhood composition journals on the
 * same database. Configurations are loopback-only and nothing touches a chain.
 *   bun run opener.ts <jobs.sqlite> <barrier> [crash-before-backfill]
 * Waits for <barrier> to exist so every opener starts together. Prints one JSON line { ok, error? }.
 * crash-before-backfill: SIGKILL once the job columns are added, before their values are backfilled.
 */
import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import type { Address } from 'viem'
import { JobStore } from '../store'
import { FULFILLMENT_LABELS, robinhoodFulfillment } from '../robinhood/fulfillment'
import { MULTISPOKE_LABELS, multispokeAdapter } from '../multispoke/adapter'

const [path, barrier, mode] = process.argv.slice(2)
if (mode === 'crash-before-backfill') {
  const original = Object.getOwnPropertyDescriptor(Database.prototype, 'query')!.value as (this: Database, sql: string) => unknown
  Object.defineProperty(Database.prototype, 'query', { value(this: Database, sql: string) {
    if (sql.startsWith('UPDATE jobs SET state=?, payable=?, sweep=?')) process.kill(process.pid, 'SIGKILL')
    return original.call(this, sql)
  } })
}
const a = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`
const vaa = { kind: 'local-guardian' as const, signed: () => Promise.resolve(null) }
const budgets = { payment: '1000000', canonical: '5000000', manager: '10000000', debit: '2000000', credit: '2000000', pool: '5000000' }
while (!existsSync(barrier)) Bun.sleepSync(1)
try {
  const store = new JobStore(path)
  robinhoodFulfillment({
    route: {
      mode: 'fork', environment: 'mixed:arc-testnet-fork+robinhood-mainnet-fork', operatorKey: `0x${'11'.repeat(32)}`,
      arc: { side: 'arc', rpc: 'http://127.0.0.1:1', chainId: 5042002, wormholeChainId: 71, core: a(1), executor: a(2), transceiverStructs: a(3), confirmations: 0, fromBlock: 1n },
      robinhood: { side: 'robinhood', rpc: 'http://127.0.0.1:2', chainId: 4663, wormholeChainId: 72, core: a(4), executor: a(5), transceiverStructs: a(6), confirmations: 0, fromBlock: 1n,
        venue: { factory: a(7), quoterV2: a(8), fee: 3000, tickSpacing: 60 }, quote: a(9) },
      vaa: { arc: vaa, robinhood: vaa }, limits: { outbound: 1n, inbound: 1n },
      asset: { id: 'unit-asset', name: 'Equilibrium', symbol: 'EQL', issuance: 1_000_000_000_000n },
    },
    arc: { usdc: a(10), factory: a(11) }, pricing: { arc: 1n, robinhood: 1n }, budgets, labels: FULFILLMENT_LABELS,
  }, store.db)
  const spoke = (rpc: string, chainId: number) => ({ rpc, chainId, wormholeChainId: chainId, core: a(20), executor: a(21), transceiverStructs: a(22), quote: a(23),
    venue: { factory: a(24), fee: 3000, tickSpacing: 60 }, confirmations: 0, fromBlock: 1n, usdcAtomsPerNative: 1n, vaa })
  multispokeAdapter({
    mode: 'fork', labels: MULTISPOKE_LABELS, operatorKey: `0x${'11'.repeat(32)}`,
    arc: { rpc: 'http://127.0.0.1:3', chainId: 5042002, wormholeChainId: 71, core: a(30), executor: a(31), transceiverStructs: a(32), usdc: a(33), factory: a(34), confirmations: 0, fromBlock: 1n, usdcAtomsPerNative: 1n },
    spokes: { base: spoke('http://127.0.0.1:4', 84532), robinhood: spoke('http://127.0.0.1:5', 4663) },
    limits: { outbound: 1n, inbound: 1n }, budgets,
  }, store.db)
  store.close()
  console.log(JSON.stringify({ ok: true }))
} catch (cause) {
  console.log(JSON.stringify({ ok: false, error: String(cause).slice(0, 400) }))
  process.exit(3)
}
