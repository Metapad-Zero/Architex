/**
 * A separate process that moves Arc executor USDC through the Robinhood route on a shared journal:
 * the cross-process race the residual claims must survive. Fork-only test seam.
 *   bun run usdc-spend-worker.ts <fulfillment.json> <jobs.sqlite> <operationName> <to> <atoms>
 * Prints one JSON line { ok, tx?, code?, error? }. Exit 0 when executed, 3 when refused or uncertain.
 */
import { readFileSync } from 'node:fs'
import { encodeFunctionData, type Address } from 'viem'
import { erc20Abi } from '../../evm/contracts'
import { JobStore } from '../../store'
import { LaunchError } from '../../types'
import { robinhoodFulfillment } from '../fulfillment'
import { fulfillmentFromJson } from '../fulfillment-fork'

const [configPath, dbPath, name, to, atoms] = process.argv.slice(2)
const config = fulfillmentFromJson(readFileSync(configPath, 'utf8'))
const store = new JobStore(dbPath, { leaseMs: 2000 })
const adapter = robinhoodFulfillment(config, store.db)
try {
  const receipt = await adapter.route.execute(name, 'arc', () => [{ target: config.arc.usdc, value: '0', data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to as Address, BigInt(atoms)] }) }])
  console.log(JSON.stringify({ ok: true, tx: receipt.transactionHash }))
  process.exit(0)
} catch (cause) {
  console.log(JSON.stringify({ ok: false, code: cause instanceof LaunchError ? cause.code : 'error', error: String(cause).slice(0, 400) }))
  process.exit(3)
}
