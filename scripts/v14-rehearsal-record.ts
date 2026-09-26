/**
 * Writes the deployment record of a launchpad v1.4 rehearsal (docs/launchpad/V14-REHEARSAL.md) from Foundry's broadcast
 * of contracts-v14/script/DeployLaunchpadV14.s.sol, so every address and transaction hash comes from what was sent:
 *
 *   bun run scripts/v14-rehearsal-record.ts deployments/arc-testnet-v14-rehearsal.json              # Run A, rUSDC
 *   bun run scripts/v14-rehearsal-record.ts deployments/arc-testnet-v14-realusdc.json --real-usdc   # Run B, Arc's USDC
 *
 * It reads broadcast/DeployLaunchpadV14.s.sol/<chainId>/run-latest.json (FOUNDRY_BROADCAST moves the broadcast
 * directory), so run it right after the deploy: the next deploy replaces run-latest.json. It checks that every receipt
 * succeeded, that each contract has code, that the hook sits at the CREATE2 address its salt and init code give through
 * the deterministic deployer, and that the launchpad, hook, router and plugins point at each other. Then it writes the
 * JSON scripts/v14-rehearsal.ts reads. It reads the chain only; it never sends anything.
 *
 * Testnet only: it refuses any chain but Arc Testnet (5042002), or a local node (31337) at a localhost RPC (a fork of
 * Arc Testnet run with --chain-id 31337, for dry runs). RPC_URL (or ARC_TESTNET_RPC) sets the node.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  encodeAbiParameters,
  getAddress,
  getContractAddress,
  http,
  keccak256,
  slice,
  type Abi,
  type Address,
  type Hex,
} from 'viem'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ARC_TESTNET = 5042002
const ARC_MAINNET = 5042
const ARC_USDC = getAddress('0x3600000000000000000000000000000000000000')
const POOL_MANAGER = getAddress('0x8366a39CC670B4001A1121B8F6A443A643e40951')
const CREATE2_DEPLOYER = getAddress('0x4e59b44847b379578588920cA78FbF26c0B4956C')
const HOOK_FLAGS = 0x28ecn

const [outArg, ...flags] = process.argv.slice(2)
if (!outArg) throw new Error('usage: bun run scripts/v14-rehearsal-record.ts <out.json> [--real-usdc]')
const realUsdc = flags.includes('--real-usdc')
const OUT = resolve(ROOT, outArg)
const BROADCAST = resolve(ROOT, process.env.FOUNDRY_BROADCAST ?? 'broadcast')
const ARTIFACTS = resolve(ROOT, process.env.ARTIFACTS ?? 'contracts-v14/out')

const rpc = process.env.RPC_URL ?? process.env.ARC_TESTNET_RPC ?? 'https://rpc.testnet.arc.io'
const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(rpc)
const pub = createPublicClient({ transport: http(rpc, { retryCount: 6, retryDelay: 500 }) })
const chainId = await pub.getChainId()
if (chainId === ARC_MAINNET || !(chainId === ARC_TESTNET || (local && chainId === 31337))) {
  throw new Error(`Refusing chain ${chainId}: the rehearsal runs on Arc Testnet (${ARC_TESTNET}) only, or a local fork of it (31337).`)
}

const artifact = (name: string) =>
  JSON.parse(readFileSync(resolve(ARTIFACTS, `${name}.sol`, `${name}.json`), 'utf8')) as { abi: Abi; bytecode: { object: Hex } }

interface BroadcastTx {
  hash: Hex
  transactionType: string
  contractName: string | null
  contractAddress: string | null
  function: string | null
  transaction: { from: string; to?: string | null; input: Hex }
}
interface BroadcastReceipt { transactionHash: Hex; status: string; blockNumber: string }
interface Broadcast { transactions: BroadcastTx[]; receipts: BroadcastReceipt[]; chain: number; commit?: string; timestamp: number }

const file = resolve(BROADCAST, 'DeployLaunchpadV14.s.sol', String(chainId), 'run-latest.json')
const b = JSON.parse(readFileSync(file, 'utf8')) as Broadcast
if (b.chain !== chainId) throw new Error(`${file} is for chain ${b.chain}, not ${chainId}`)
for (const tx of b.transactions) {
  const r = b.receipts.find((x) => x.transactionHash === tx.hash)
  if (!r) throw new Error(`no receipt for ${tx.hash} (was it broadcast?)`)
  if (r.status !== '0x1') throw new Error(`${tx.hash} reverted`)
}

function created(contractName: string, type: 'CREATE' | 'CREATE2' = 'CREATE') {
  const found = b.transactions.filter((t) => t.transactionType === type && t.contractName === contractName)
  if (found.length !== 1) throw new Error(`expected one ${type} of ${contractName}, found ${found.length}`)
  const t = found[0]
  if (!t.contractAddress) throw new Error(`${contractName}: no address in the broadcast`)
  return { address: getAddress(t.contractAddress), hash: t.hash, from: getAddress(t.transaction.from), tx: t }
}

const launchpad = created('ArchitexLaunchpadV14')
const hook = created('ArchitexLaunchHook', 'CREATE2')
const router = created('ArchitexV4Router')
const split = created('SplitPlugin')
const holders = created('HolderDistributionPlugin')
const combo = created('ComboPlugin')
const init = b.transactions.filter((t) => t.transactionType === 'CALL' && t.function?.startsWith('initialize('))
if (init.length !== 1) throw new Error(`expected one initialize call, found ${init.length}`)
const deployer = launchpad.from
for (const t of b.transactions) if (getAddress(t.transaction.from) !== deployer) throw new Error(`${t.hash} was sent by ${t.transaction.from}, not the deployer ${deployer}`)

// The hook went through the deterministic deployer: its input is the salt followed by the init code, and its address is
// CREATE2(deployer, salt, keccak256(init code)), whose low 14 bits must be exactly the hook's permissions.
if (getAddress(hook.tx.transaction.to ?? '0x0000000000000000000000000000000000000000') !== CREATE2_DEPLOYER) {
  throw new Error(`the hook was not deployed through ${CREATE2_DEPLOYER}`)
}
const salt = slice(hook.tx.transaction.input, 0, 32)
const initCode = slice(hook.tx.transaction.input, 32)
const predicted = getContractAddress({ opcode: 'CREATE2', from: CREATE2_DEPLOYER, salt, bytecodeHash: keccak256(initCode) })
if (predicted !== hook.address) throw new Error(`hook ${hook.address} is not CREATE2(${salt}): ${predicted}`)
if ((BigInt(hook.address) & 0x3fffn) !== HOOK_FLAGS) throw new Error(`hook ${hook.address}: low 14 bits are not 0x28EC`)

async function read<T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
  return (await pub.readContract({ address, abi, functionName, args })) as T
}
async function requireCode(label: string, address: Address) {
  const code = await pub.getCode({ address })
  if (!code || code === '0x') throw new Error(`${label} ${address} has no code on chain ${chainId}`)
}
for (const [label, c] of Object.entries({ launchpad, hook, router, split, holders, combo })) await requireCode(label, c.address)
await requireCode('PoolManager', POOL_MANAGER)

const padAbi = artifact('ArchitexLaunchpadV14').abi
const hookAbi = artifact('ArchitexLaunchHook').abi
const routerAbi = artifact('ArchitexV4Router').abi
const pluginAbi = artifact('SplitPlugin').abi
const usdc = getAddress(await read<string>(launchpad.address, padAbi, 'usdc'))
if (realUsdc !== (usdc === ARC_USDC)) {
  throw new Error(realUsdc ? `--real-usdc, but the launchpad's USDC is ${usdc}` : `the launchpad runs on Arc's USDC: pass --real-usdc`)
}
if (usdc !== ARC_USDC) await requireCode('usdc', usdc)
// The init code carries the constructor arguments at its end: the PoolManager, the launchpad and USDC.
const args = encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [POOL_MANAGER, launchpad.address, usdc])
if (!initCode.toLowerCase().endsWith(args.slice(2).toLowerCase())) throw new Error('the hook init code does not end with (PoolManager, launchpad, USDC)')

const wiring: [string, unknown, unknown][] = [
  ['launchpad.hook', getAddress(await read<string>(launchpad.address, padAbi, 'hook')), hook.address],
  ['launchpad.router', getAddress(await read<string>(launchpad.address, padAbi, 'router')), router.address],
  ['launchpad.poolManager', getAddress(await read<string>(launchpad.address, padAbi, 'poolManager')), POOL_MANAGER],
  ['hook.launchpad', getAddress(await read<string>(hook.address, hookAbi, 'launchpad')), launchpad.address],
  ['hook.usdc', getAddress(await read<string>(hook.address, hookAbi, 'usdc')), usdc],
  ['hook.poolManager', getAddress(await read<string>(hook.address, hookAbi, 'poolManager')), POOL_MANAGER],
  ['router.launchpad', getAddress(await read<string>(router.address, routerAbi, 'launchpad')), launchpad.address],
  ['router.usdc', getAddress(await read<string>(router.address, routerAbi, 'usdc')), usdc],
  ['router.poolManager', getAddress(await read<string>(router.address, routerAbi, 'poolManager')), POOL_MANAGER],
]
for (const [label, c] of Object.entries({ split, holders, combo })) {
  wiring.push([`${label}.launchpad`, getAddress(await read<string>(c.address, pluginAbi, 'launchpad')), launchpad.address])
}
for (const [label, got, want] of wiring) if (got !== want) throw new Error(`${label} is ${String(got)}, expected ${String(want)}`)

const lastBlock = BigInt(b.receipts[b.receipts.length - 1].blockNumber)
const deployedAt = new Date(Number((await pub.getBlock({ blockNumber: lastBlock })).timestamp) * 1000).toISOString()

const record = {
  chainId,
  network: chainId === ARC_TESTNET ? 'Arc Testnet' : 'local fork of Arc Testnet',
  mode: realUsdc ? 'real-usdc' : 'rehearsal-usdc',
  deployer,
  commit: b.commit ?? null,
  usdc,
  poolManager: POOL_MANAGER,
  create2Deployer: CREATE2_DEPLOYER,
  launchpad: launchpad.address,
  hook: hook.address,
  hookSalt: salt,
  router: router.address,
  plugins: { split: split.address, holders: holders.address, combo: combo.address },
  launchFee: String(await read<bigint>(launchpad.address, padAbi, 'launchFee')),
  feeTo: getAddress(await read<string>(launchpad.address, padAbi, 'feeTo')),
  feeToSetter: getAddress(await read<string>(launchpad.address, padAbi, 'feeToSetter')),
  deployedAt,
  txs: {
    launchpad: launchpad.hash,
    hook: hook.hash,
    router: router.hash,
    initialize: init[0].hash,
    split: split.hash,
    holders: holders.hash,
    combo: combo.hash,
  },
}
writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`)
console.log(`wrote ${outArg}: launchpad ${launchpad.address}, hook ${hook.address} (salt ${salt}), usdc ${usdc}, 7 transactions`)
