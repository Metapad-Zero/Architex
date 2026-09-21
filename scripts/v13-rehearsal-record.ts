/**
 * Writes the deployment record of a launchpad v1.3 rehearsal (docs/launchpad/V13-REHEARSAL.md) from Foundry's
 * broadcast files, so the addresses and transaction hashes come from what was actually sent:
 *
 *   bun run scripts/v13-rehearsal-record.ts deployments/arc-testnet-v13-rehearsal.json              # rUSDC + launchpad + plugins
 *   bun run scripts/v13-rehearsal-record.ts deployments/arc-testnet-v13-realusdc.json --real-usdc   # launchpad + plugins on Arc's USDC
 *
 * It reads broadcast/<Script>.s.sol/<chainId>/run-latest.json of DeployRehearsalUsdc (not with --real-usdc),
 * DeployLaunchpad and DeployLaunchPlugins, so run it right after those deploys (the next deploy of the same script
 * replaces run-latest.json). It checks that every receipt succeeded, that the contracts have code and that the
 * launchpad, pair factory, router and plugins point at each other, then writes the JSON scripts/v13-rehearsal.ts reads.
 * Testnet only: it refuses any chain but Arc Testnet (5042002), or a local node (31337) at a localhost RPC.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, getAddress, http, type Abi, type Address, type Hex } from 'viem'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ARC_TESTNET = 5042002
const ARC_MAINNET = 5042
const ARC_USDC = getAddress('0x3600000000000000000000000000000000000000')

const [outArg, ...flags] = process.argv.slice(2)
if (!outArg) throw new Error('usage: bun run scripts/v13-rehearsal-record.ts <out.json> [--real-usdc]')
const realUsdc = flags.includes('--real-usdc')
const OUT = resolve(ROOT, outArg)
const BROADCAST = resolve(ROOT, process.env.FOUNDRY_BROADCAST ?? 'broadcast')

const rpc = process.env.ARC_TESTNET_RPC ?? 'https://rpc.testnet.arc.io'
const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(rpc)
const pub = createPublicClient({ transport: http(rpc, { retryCount: 6, retryDelay: 500 }) })
const chainId = await pub.getChainId()
if (chainId === ARC_MAINNET || !(chainId === ARC_TESTNET || (local && chainId === 31337))) {
  throw new Error(`Refusing chain ${chainId}: the rehearsal runs on Arc Testnet (${ARC_TESTNET}) only.`)
}

const abiOf = (name: string): Abi =>
  (JSON.parse(readFileSync(resolve(ROOT, 'contracts/out', `${name}.sol`, `${name}.json`), 'utf8')) as { abi: Abi }).abi

interface BroadcastTx { hash: Hex; transactionType: string; contractName: string | null; contractAddress: string | null; function: string | null; transaction: { from: string } }
interface BroadcastReceipt { transactionHash: Hex; status: string; blockNumber: string }
interface Broadcast { transactions: BroadcastTx[]; receipts: BroadcastReceipt[]; chain: number; commit?: string; timestamp: number }

function broadcastOf(script: string): Broadcast {
  const file = resolve(BROADCAST, `${script}.s.sol`, String(chainId), 'run-latest.json')
  const b = JSON.parse(readFileSync(file, 'utf8')) as Broadcast
  if (b.chain !== chainId) throw new Error(`${file} is for chain ${b.chain}, not ${chainId}`)
  for (const tx of b.transactions) {
    const r = b.receipts.find((x) => x.transactionHash === tx.hash)
    if (!r) throw new Error(`${script}: no receipt for ${tx.hash} (was it broadcast?)`)
    if (r.status !== '0x1') throw new Error(`${script}: ${tx.hash} reverted`)
  }
  return b
}

function created(b: Broadcast, contractName: string): { address: Address; hash: Hex; from: Address } {
  const found = b.transactions.filter((t) => t.transactionType === 'CREATE' && t.contractName === contractName)
  if (found.length !== 1) throw new Error(`expected one CREATE of ${contractName}, found ${found.length}`)
  return { address: getAddress(found[0].contractAddress!), hash: found[0].hash, from: getAddress(found[0].transaction.from) }
}

async function read(address: Address, abi: Abi, functionName: string): Promise<unknown> {
  return pub.readContract({ address, abi, functionName })
}

async function requireCode(label: string, address: Address) {
  const code = await pub.getCode({ address })
  if (!code || code === '0x') throw new Error(`${label} ${address} has no code on chain ${chainId}`)
}

// ── Collect addresses and hashes from the broadcasts ──────────────────────────
const lp = broadcastOf('DeployLaunchpad')
const pl = broadcastOf('DeployLaunchPlugins')
const launchpad = created(lp, 'ArchitexLaunchpad')
const pairFactory = created(lp, 'LaunchPairFactory')
const router = created(lp, 'LaunchRouter')
const init = lp.transactions.filter((t) => t.transactionType === 'CALL' && t.function?.startsWith('initialize('))
if (init.length !== 1) throw new Error(`expected one initialize call in DeployLaunchpad, found ${init.length}`)
const split = created(pl, 'SplitPlugin')
const buybackBurn = created(pl, 'BuybackBurnPlugin')
const holders = created(pl, 'HolderDistributionPlugin')
const combo = created(pl, 'ComboPlugin')

let usdc: Address = ARC_USDC
const txs: Record<string, Hex> = {}
if (!realUsdc) {
  const rusdc = created(broadcastOf('DeployRehearsalUsdc'), 'TestToken')
  usdc = rusdc.address
  txs.rUSDC = rusdc.hash
}
Object.assign(txs, {
  launchpad: launchpad.hash,
  pairFactory: pairFactory.hash,
  router: router.hash,
  initialize: init[0].hash,
  split: split.hash,
  buybackBurn: buybackBurn.hash,
  holders: holders.hash,
  combo: combo.hash,
})

// ── Check them on chain ───────────────────────────────────────────────────────
const padAbi = abiOf('ArchitexLaunchpad')
for (const [label, c] of Object.entries({ launchpad, pairFactory, router, split, buybackBurn, holders, combo })) await requireCode(label, c.address)
await requireCode('usdc', usdc)
const wiring: [string, unknown, unknown][] = [
  ['launchpad.usdc', getAddress((await read(launchpad.address, padAbi, 'usdc')) as string), usdc],
  ['launchpad.pairFactory', getAddress((await read(launchpad.address, padAbi, 'pairFactory')) as string), pairFactory.address],
  ['launchpad.router', getAddress((await read(launchpad.address, padAbi, 'router')) as string), router.address],
  ['pairFactory.launchpad', getAddress((await read(pairFactory.address, abiOf('LaunchPairFactory'), 'launchpad')) as string), launchpad.address],
  ['router.launchpad', getAddress((await read(router.address, abiOf('LaunchRouter'), 'launchpad')) as string), launchpad.address],
]
for (const [label, c] of Object.entries({ split, buybackBurn, holders, combo })) {
  wiring.push([`${label}.launchpad`, getAddress((await read(c.address, abiOf('SplitPlugin'), 'launchpad')) as string), launchpad.address])
}
for (const [label, got, want] of wiring) if (got !== want) throw new Error(`${label} is ${String(got)}, expected ${String(want)}`)

const lastBlock = BigInt(pl.receipts[pl.receipts.length - 1].blockNumber)
const deployedAt = new Date(Number((await pub.getBlock({ blockNumber: lastBlock })).timestamp) * 1000).toISOString()

const record = {
  chainId,
  network: chainId === ARC_TESTNET ? 'Arc Testnet' : 'local',
  mode: realUsdc ? 'real-usdc' : 'rehearsal-usdc',
  deployer: launchpad.from,
  commit: lp.commit ?? null,
  usdc,
  launchpad: launchpad.address,
  pairFactory: pairFactory.address,
  router: router.address,
  plugins: { split: split.address, buybackBurn: buybackBurn.address, holders: holders.address, combo: combo.address },
  launchFee: String(await read(launchpad.address, padAbi, 'launchFee')),
  feeTo: getAddress((await read(launchpad.address, padAbi, 'feeTo')) as string),
  feeToSetter: getAddress((await read(launchpad.address, padAbi, 'feeToSetter')) as string),
  deployedAt,
  txs,
}
writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`)
console.log(`wrote ${outArg}: launchpad ${launchpad.address}, usdc ${usdc}, ${Object.keys(txs).length} transactions`)
