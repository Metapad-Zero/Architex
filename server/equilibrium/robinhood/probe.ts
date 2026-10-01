/**
 * Read-only probe of Robinhood pinned-state access and bytecode pins. Sends no transaction.
 *   bun run server/equilibrium/robinhood/probe.ts [rpc] [block]
 * Prints JSON; exits 1 when the requested state is not served or a pin differs.
 */
import { createPublicClient, http } from 'viem'
import { probeStateAccess, verifyPins } from './access'
import { ROBINHOOD_MAINNET } from './pins'

const [rpc = ROBINHOOD_MAINNET.rpc, block] = process.argv.slice(2)
const access = await probeStateAccess(rpc, block ? BigInt(block) : null)
const at = block ? BigInt(block) : access.latest
const pins = access.available ? await verifyPins(createPublicClient({ transport: http(rpc) }), at) : []
const ok = access.available && pins.length > 0 && pins.every((p) => p.ok)
console.log(JSON.stringify({ observedAt: new Date().toISOString(), block: at, access, pins, ok }, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2))
process.exit(ok ? 0 : 1)
