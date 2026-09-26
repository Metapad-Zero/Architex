/**
 * Arc Testnet rehearsal of the Architex launchpad v1.4 (docs/launchpad/V14-REHEARSAL.md; V14-SPEC §11).
 *
 *   bun run scripts/v14-rehearsal.ts                                  # read-only: deployment checks and progress so far
 *   SIGNER=key bun run scripts/v14-rehearsal.ts                       # live: signs with REHEARSAL_KEY; resumable
 *   SIGNER=anvil RPC_URL=http://127.0.0.1:<port> bun run scripts/v14-rehearsal.ts   # a local anvil fork, no key
 *   DEPLOYMENT=deployments/arc-testnet-v14-realusdc.json SIGNER=key bun run scripts/v14-rehearsal.ts   # Run B
 *   bun run scripts/v14-rehearsal.ts --preview                        # which launch tokens would sort below USDC
 *
 * It drives the suite deployed by contracts-v14/script/DeployLaunchpadV14.s.sol and recorded by
 * scripts/v14-rehearsal-record.ts, against Uniswap's own v4 PoolManager on Arc Testnet (0x8366…0951).
 *
 * Run A (a deployment on the mintable rehearsal USDC, rUSDC): verifies the deployment (wiring, the hook's permission
 * bits and CREATE2 salt, every contract byte for byte against the local build); deploys the test RawSwapper; launches
 * five tokens covering closed and open pools, creator fees of 0, 1% and 10%, a plain wallet, Split, Distribute to
 * holders and Combo, with and without the creator's first buy; buys on each curve inside its snipe window and after it;
 * graduates all five into Uniswap v4 (the curve's surcharge becoming the first bid, from half the graduation price);
 * trades each pool through the Architex router inside and after the pool's snipe window, where every buy places its own
 * surcharge as a bid from half the price just before it, including a buy after the price was dumped under half the
 * graduation price, whose bid follows the price down; swaps exact-out through the RawSwapper; proves donations and outside
 * liquidity in a closed pool are refused and outside liquidity in an open pool is accepted; and syncs, collects and pays
 * out every fee.
 *
 * Run B (a deployment on Arc's own USDC, 0x36…00): the curve half with 1 USDC trades, one inside the snipe window. A
 * graduation would need about 25,000 USDC. Arc's USDC is a precompile that a local fork cannot execute, so Run B only
 * runs live.
 *
 * Every transaction is simulated first (a revert costs nothing) and checked at its receipt's block B against B-1:
 *   - the result against the contracts' own quotes and an independent model of the spec: the curve (V13-SPEC §5 with the
 *     snipe fee), the hook's fees (V14-SPEC §3), Uniswap v4's pool math (scripts/v14-v4-math.ts: every swap, add and bid
 *     to the unit, across ticks), the graduation, and the dividend stream fed from the token's own storage;
 *   - every event against the model;
 *   - a snapshot of every tracked balance and accrual (Multicall3, one call per block): each must move by exactly what
 *     the model says, and nothing else may move;
 *   - the invariants: launchpad USDC == pendingFees + Σ pendingCreatorFees + Σ pendingSnipe + Σ (virtualUsdc -
 *     VIRTUAL_USDC_0) over live curves; the hook holds no USDC and no launch token; the hook's ERC-6909 claims ==
 *     Σ (pendingPlatform + pendingCreator + lockHeld); snipe fees never wait (lockHeld ≤ 2 units per token); no token's
 *     supply grows, and every token's supply is held by the addresses tracked;
 *   - the actor's native balance moved by the gas alone (rUSDC), or by the USDC traded plus the gas (Arc's USDC).
 * The snipe windows are checked against the block each transaction actually landed in. The run stops at the first step
 * with a failed check.
 *
 * Signing (SIGNER):
 *   - key: signs locally with the key in REHEARSAL_KEY (never printed, logged or written). For Arc Testnet.
 *   - anvil: sends with eth_sendTransaction from ACTOR (default: the deployment's deployer) after
 *     anvil_impersonateAccount, topping its gas up with anvil_setBalance. Needs a local anvil; no key at all.
 *   - unset: read-only.
 * Chain guard: Arc Testnet (5042002), or a localhost node on chain 31337 (a fork run with --chain-id 31337). It refuses
 * Arc mainnet always, and key signing on a localhost node that reports 5042002 (those signatures would be valid live).
 *
 * Progress (token addresses, positions, mined transactions, finished steps) lives next to the deployment record in
 * *.progress.json (gitignored), or PROGRESS=<file>: a re-run skips finished steps, never re-sends a mined transaction,
 * and re-checks a step whose transaction was mined but not yet checked.
 *
 * Environment: DEPLOYMENT, PROGRESS, RPC_URL (or ARC_TESTNET_RPC), SIGNER, REHEARSAL_KEY, ACTOR (anvil only), ARTIFACTS
 * (default contracts-v14/out), GAS_CAP (USDC of gas this progress file may spend; default 2 for Run A, 1 for Run B),
 * FLOOR (Run B: the least native USDC the actor keeps, default 0.5), RUNB_WINDOW_USDC (Run B's in-window buy, default 1),
 * SAMPLE_SECONDS (default 20), MARKDOWN=1 (print the results as markdown tables).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BaseError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  decodeFunctionData,
  decodeFunctionResult,
  defineChain,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  formatUnits,
  getAddress,
  getContractAddress,
  hexToBigInt,
  http,
  keccak256,
  maxUint256,
  multicall3Abi,
  pad,
  parseAbi,
  parseEventLogs,
  slice,
  stringToHex,
  toFunctionSelector,
  toHex,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as V4 from './v14-v4-math.ts'

// ── Configuration ─────────────────────────────────────────────────────────────

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ARC_TESTNET = 5042002
const ARC_MAINNET = 5042
const ARC_USDC = getAddress('0x3600000000000000000000000000000000000000')
const RUSDC = getAddress('0x309297011592BA9a157204e57EB0AF2175D8ceed')
const BURNER = getAddress('0x7212fA4Fe663d063A7a83dA0467d592ed3A51D46')
const POOL_MANAGER = getAddress('0x8366a39CC670B4001A1121B8F6A443A643e40951')
const STATE_VIEW = getAddress('0xF3334192D15450CdD385c8B70e03f9A6bD9E673b')
const CREATE2_DEPLOYER = getAddress('0x4e59b44847b379578588920cA78FbF26c0B4956C')
const MULTICALL3 = getAddress('0xcA11bde05977b3631167028862bE2a173976CA11')
const DEAD = getAddress('0x000000000000000000000000000000000000dEaD')

const RPC = process.env.RPC_URL ?? process.env.ARC_TESTNET_RPC ?? 'https://rpc.testnet.arc.io'
const LOCAL_RPC = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(RPC)
const ARTIFACTS = resolve(ROOT, process.env.ARTIFACTS ?? 'contracts-v14/out')
const MARKDOWN = process.env.MARKDOWN === '1'
const SAMPLE_SECONDS = Number(process.env.SAMPLE_SECONDS ?? '20')

// Spec constants (V13-SPEC §1, §5; V14-SPEC §3, §5); the deploy step compares them with the contracts.
const E18 = 10n ** 18n
const BPS = 10_000n
const FEE_BPS = 50n
const TOTAL_SUPPLY = 1_000_000_000n * E18
const CURVE_SUPPLY = 800_000_000n * E18
const POOL_SUPPLY = 200_000_000n * E18
const VIRTUAL_USDC_0 = 8_333_333_333n
const VIRTUAL_TOKENS_0 = 1_066_666_667n * E18
const SNIPE_BLOCKS = 20n
const SNIPE_START_BPS = 9000n
const MAX_TOTAL_FEE_BPS = 9900n
const TICK_SPACING = 200
const BID_DISCOUNT_TICKS = 6932
const BID_SPAN_TICKS = 92_200
const HOOK_FLAGS = 0x28ecn
const MIN_T = V4.minUsableTick(TICK_SPACING)
const MAX_T = V4.maxUsableTick(TICK_SPACING)
/** LaunchTokenV14's dividend stream (V13-SPEC §3), and its storage (`forge inspect LaunchTokenV14 storageLayout`). */
const DRIP_PERIOD = 86_400n
const MAGNITUDE = 2n ** 128n
const SLOT = { perShare: 6n, corrections: 7n, rate: 10n, stream: 11n } as const
/** On Arc the native balance is USDC with 18 decimals: one 6-decimal unit is 1e12 wei. */
const WEI_PER_UNIT = 10n ** 12n
/** What Arc Testnet charges: a 20 gwei base fee and the node's suggested 5 gwei tip. */
const LIVE_GAS_PRICE = 25n * 10n ** 9n

const usd = (n: number) => BigInt(Math.round(n * 1e6))
const tokens = (n: number) => BigInt(n) * E18
const fmt = (units: bigint) => formatUnits(units, 6)
const fmt18 = (wei: bigint) => formatUnits(wei, 18)
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
const blocks = (n: bigint) => `${n} block${n === 1n ? '' : 's'}`

// ── RPC ───────────────────────────────────────────────────────────────────────

const pub = createPublicClient({ transport: http(RPC, { retryCount: 3, retryDelay: 400, timeout: 30_000 }) })

function errorText(e: unknown): string {
  if (e instanceof BaseError) return `${e.shortMessage} ${e.details ?? ''} ${e.message}`
  if (e instanceof Error) return e.message
  return typeof e === 'string' ? e : 'unknown error'
}
// Arc's public RPC answers bursts with "Request exceeds defined limit", and a block it has not reached yet with
// "Requested resource not found". Both are retried with backoff; a revert never is.
const TRANSIENT =
  /exceeds defined limit|resource not found|429|too many|rate.?limit|timeout|timed out|took too long|ECONNRESET|ECONNREFUSED|socket|fetch failed|network error|50[234]|header not found|unknown block|block not found|missing trie node|temporar|busy|HTTP request failed/i
const transient = (e: unknown) => {
  const text = errorText(e)
  return !/revert/i.test(text) && TRANSIENT.test(text)
}
let inflight = 0
const queue: (() => void)[] = []
let rpcRetries = 0
async function retry<T>(fn: () => Promise<T>): Promise<T> {
  let delay = 400
  for (let attempt = 1; ; attempt++) {
    while (inflight >= 3) await new Promise<void>((go) => queue.push(go))
    inflight++
    try {
      return await fn()
    } catch (e) {
      if (attempt >= 10 || !transient(e)) throw e
      rpcRetries++
    } finally {
      inflight--
      queue.shift()?.()
    }
    await sleep(delay + Math.floor(Math.random() * 250))
    delay = Math.min(delay * 2, 8000)
  }
}

// ── Preview (read-only, no deployment needed) ─────────────────────────────────

if (process.argv.includes('--preview')) {
  // The launchpad is the deployer's first CREATE in the deploy script and every launch token a CREATE from the launchpad
  // (nonce 1, 2, …), so the deployer's nonce at deploy time fixes which tokens sort below USDC (USDC is then currency1).
  const deployer = getAddress(process.env.DEPLOYER ?? BURNER)
  const usdc = getAddress(process.env.USDC ?? RUSDC)
  const nonce = await retry(() => pub.getTransactionCount({ address: deployer, blockTag: 'pending' }))
  console.log(`deployer ${deployer} (next nonce ${nonce}), USDC ${usdc}; tokens 1-5 in launch order, ↓ = sorts below USDC:`)
  for (let n = nonce; n < nonce + 6; n++) {
    const lp = getContractAddress({ from: deployer, nonce: BigInt(n) })
    const slots = [1, 2, 3, 4, 5].map((i) => (BigInt(getContractAddress({ from: lp, nonce: BigInt(i) })) < BigInt(usdc) ? '↓' : '·'))
    console.log(`  deploy at nonce ${n}: launchpad ${lp}  ${slots.join(' ')}`)
  }
  process.exit(0)
}

// ── Deployment, artifacts ─────────────────────────────────────────────────────

const DEPLOYMENT = resolve(ROOT, process.env.DEPLOYMENT ?? 'deployments/arc-testnet-v14-rehearsal.json')
const PROGRESS = resolve(ROOT, process.env.PROGRESS ?? DEPLOYMENT.replace(/\.json$/, '.progress.json'))

interface Deployment {
  chainId: number
  network: string
  mode: string
  deployer: string
  commit: string | null
  usdc: string
  poolManager: string
  launchpad: string
  hook: string
  hookSalt: Hex
  router: string
  plugins: { split: string; holders: string; combo: string }
  launchFee: string
  feeTo: string
  feeToSetter: string
  deployedAt: string
  txs: Record<string, Hex>
}
const dep = JSON.parse(readFileSync(DEPLOYMENT, 'utf8')) as Deployment
const USDC = getAddress(dep.usdc)
const LP = getAddress(dep.launchpad)
const HOOK = getAddress(dep.hook)
const ROUTER = getAddress(dep.router)
const SPLIT = getAddress(dep.plugins.split)
const HOLDERS = getAddress(dep.plugins.holders)
const COMBO = getAddress(dep.plugins.combo)
const FEE_TO = getAddress(dep.feeTo)
/** Run B: the launchpad runs on Arc's own USDC, which is also the gas token. */
const REAL = USDC === ARC_USDC
const U = REAL ? 'USDC' : 'rUSDC'
if (getAddress(dep.poolManager) !== POOL_MANAGER) throw new Error(`${DEPLOYMENT}: PoolManager ${dep.poolManager} is not Uniswap's ${POOL_MANAGER}`)

interface Artifact {
  abi: Abi
  bytecode: { object: Hex }
  deployedBytecode: { object: string; immutableReferences?: Record<string, { start: number; length: number }[]> }
}
const artifact = (file: string, name = file) => JSON.parse(readFileSync(resolve(ARTIFACTS, `${file}.sol`, `${name}.json`), 'utf8')) as Artifact
const ART = {
  pad: artifact('ArchitexLaunchpadV14'),
  hook: artifact('ArchitexLaunchHook'),
  router: artifact('ArchitexV4Router'),
  token: artifact('LaunchTokenV14'),
  split: artifact('SplitPlugin'),
  holders: artifact('HolderDistributionPlugin'),
  combo: artifact('ComboPlugin'),
  raw: artifact('V14Base', 'RawSwapper'),
  pm: artifact('IPoolManager'),
}
const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
  'function transfer(address, uint256) returns (bool)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function owner() view returns (address)',
  'function mint(address, uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])
const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
  'function getTickLiquidity(bytes32 poolId, int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet)',
  'function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)',
  'function getFeeGrowthGlobals(bytes32 poolId) view returns (uint256 feeGrowthGlobal0, uint256 feeGrowthGlobal1)',
])
const ABI = {
  pad: ART.pad.abi,
  hook: ART.hook.abi,
  router: ART.router.abi,
  token: ART.token.abi,
  split: ART.split.abi,
  holders: ART.holders.abi,
  combo: ART.combo.abi,
  raw: ART.raw.abi,
  pm: ART.pm.abi,
  erc20: ERC20 as Abi,
  stateView: STATE_VIEW_ABI as Abi,
}
/** Every custom error any of these contracts, Uniswap's PoolManager or OpenZeppelin can revert with. */
const ERRORS: Abi = (() => {
  const seen = new Set<string>()
  const out: Abi[number][] = []
  const extra = parseAbi([
    'error WrappedError(address target, bytes4 selector, bytes reason, bytes details)',
    'error HookCallFailed()',
    'error Error(string)',
    'error PoolAlreadyInitialized()',
    'error PriceLimitAlreadyExceeded(uint160 sqrtPriceCurrentX96, uint160 sqrtPriceLimitX96)',
    'error HookAddressNotValid(address hooks)',
  ])
  for (const abi of [...Object.values(ABI), extra as Abi]) {
    for (const item of abi) {
      if (item.type !== 'error') continue
      const sig = `${item.name}(${item.inputs.map((i) => i.type).join(',')})`
      if (seen.has(sig)) continue
      seen.add(sig)
      out.push(item)
    }
  }
  return out
})()

// ── Actors and tokens ─────────────────────────────────────────────────────────

/** Fixed addresses nobody holds a key for: the last 20 bytes of a hash of a label. They only ever receive fees. */
const fixedAddress = (label: string) => getAddress(`0x${keccak256(stringToHex(`architex/v14-rehearsal/${label}`)).slice(-40)}`)
const CREATOR_WALLET = fixedAddress('creator-wallet')
const ZERO_WALLET = fixedAddress('zero-fee-wallet')
const COMBO_WALLET = fixedAddress('combo-wallet')
const PAYEES = [fixedAddress('split-payee-1'), fixedAddress('split-payee-2'), fixedAddress('split-payee-3')]
const SHARES = [5n, 3n, 2n]
const COMBO_PAYEES = [fixedAddress('combo-split-payee-1'), fixedAddress('combo-split-payee-2')]
const COMBO_SHARES = [1n, 1n]
const COMBO_TARGETS = [HOLDERS, SPLIT, COMBO_WALLET]
const COMBO_BPS = [5000, 3000, 2000]

type Kind = 'wallet' | 'split' | 'holders' | 'combo' | 'zero'
interface Spec {
  name: string
  symbol: string
  feeBps: bigint
  plugin: Address
  data: Hex
  hooks: boolean
  open: boolean
  firstBuy: bigint
  /** Curve buys fired right after the launch, inside its snipe window. */
  windowBuys: number
}
const splitData = (payees: Address[], shares: bigint[]) => encodeAbiParameters([{ type: 'address[]' }, { type: 'uint256[]' }], [payees, shares])
const comboData = () =>
  encodeAbiParameters([{ type: 'address[]' }, { type: 'uint16[]' }, { type: 'bytes[]' }], [COMBO_TARGETS, COMBO_BPS, ['0x', splitData(COMBO_PAYEES, COMBO_SHARES), '0x']])

/** Run A: the matrix the rehearsal must cover (closed and open pools; creator fees 0, 1% and 10%; a wallet, Split,
 *  Distribute to holders and Combo; with and without the creator's first buy). Run B: one token on Arc's USDC whose
 *  creator fees come back to the actor. */
function specsFor(actor: Address): Partial<Record<Kind, Spec>> {
  if (REAL) {
    return { wallet: { name: 'Rehearsal Arc USDC', symbol: 'RARC', feeBps: 100n, plugin: actor, data: '0x', hooks: false, open: false, firstBuy: 0n, windowBuys: 1 } }
  }
  return {
    wallet: { name: 'Rehearsal Wallet', symbol: 'RWAL', feeBps: 100n, plugin: CREATOR_WALLET, data: '0x', hooks: false, open: false, firstBuy: usd(100), windowBuys: 1 },
    split: { name: 'Rehearsal Split', symbol: 'RSPL', feeBps: 1000n, plugin: SPLIT, data: splitData(PAYEES, SHARES), hooks: true, open: true, firstBuy: 0n, windowBuys: 1 },
    holders: { name: 'Rehearsal Holders', symbol: 'RHLD', feeBps: 1000n, plugin: HOLDERS, data: '0x', hooks: true, open: false, firstBuy: usd(100), windowBuys: 1 },
    combo: { name: 'Rehearsal Combo', symbol: 'RCMB', feeBps: 100n, plugin: COMBO, data: comboData(), hooks: true, open: true, firstBuy: 0n, windowBuys: 1 },
    zero: { name: 'Rehearsal Zero Fee', symbol: 'RZRO', feeBps: 0n, plugin: ZERO_WALLET, data: '0x', hooks: false, open: false, firstBuy: 0n, windowBuys: 3 },
  }
}
const usesSplit = (k: Kind) => k === 'split' || k === 'combo'
const usesHolders = (k: Kind) => k === 'holders' || k === 'combo'

/** USDC (6 decimals) and token amounts per action. rUSDC is minted freely, so Run A trades are large; Run B trades 1 USDC
 *  on the curve and nothing else. */
interface Amounts {
  windowBuy: bigint
  curveBuy: bigint
  graduateOffer: bigint
  /** the first buy in the pool's window: big enough to lift the price at least a tick spacing above graduation even
   *  at a 10% creator fee and the window's highest surcharge, so the next buy's bid shows the cap (V14-SPEC §5) */
  poolWindowLift: bigint
  poolWindowBuy: bigint
  poolWindowSell: bigint
  rawWindowOutBuy: bigint
  dump: bigint
  poolBuy: bigint
  poolSell: bigint
  rawOutBuy: bigint
  rawOutSellUsdc: bigint
  rawTokens: bigint
  rawUsdc: bigint
  lpUsdc: bigint
  lpTokens: bigint
  burnerMint: bigint
}
const A: Amounts = REAL
  ? {
      windowBuy: usd(Number(process.env.RUNB_WINDOW_USDC ?? '1')),
      curveBuy: usd(1),
      graduateOffer: 0n, poolWindowLift: 0n, poolWindowBuy: 0n, poolWindowSell: 0n, rawWindowOutBuy: 0n, dump: 0n, poolBuy: 0n, poolSell: 0n, rawOutBuy: 0n,
      rawOutSellUsdc: 0n, rawTokens: 0n, rawUsdc: 0n, lpUsdc: 0n, lpTokens: 0n, burnerMint: 0n,
    }
  : {
      windowBuy: usd(1000),
      curveBuy: usd(1000),
      graduateOffer: usd(60_000),
      poolWindowLift: usd(10_000),
      poolWindowBuy: usd(2000),
      poolWindowSell: tokens(1_000_000),
      rawWindowOutBuy: tokens(5_000_000),
      dump: tokens(150_000_000),
      poolBuy: usd(1000),
      poolSell: tokens(1_000_000),
      rawOutBuy: tokens(2_000_000),
      rawOutSellUsdc: usd(100),
      rawTokens: tokens(30_000_000),
      rawUsdc: usd(50_000),
      lpUsdc: usd(1000),
      lpTokens: tokens(10_000_000),
      burnerMint: usd(1_000_000),
    }
const GAS_CAP_WEI = BigInt(Math.round(Number(process.env.GAS_CAP ?? (REAL ? '1' : '2')) * 1e6)) * WEI_PER_UNIT
const FLOOR_WEI = BigInt(Math.round(Number(process.env.FLOOR ?? '0.5') * 1e6)) * WEI_PER_UNIT

// ── Checks ────────────────────────────────────────────────────────────────────

let failures = 0
let checks = 0
let stepFailed: string[] = []
const canon = (v: unknown): unknown => {
  if (typeof v === 'bigint') return v.toString()
  if (Array.isArray(v)) return v.map(canon)
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canon(o[k])]))
  }
  return v
}
const show = (v: unknown): string => (typeof v === 'bigint' ? v.toString() : (JSON.stringify(canon(v)) ?? 'undefined'))
function check(label: string, actual: unknown, expected: unknown): boolean {
  checks++
  const a = show(actual)
  const ok = a === show(expected)
  if (!ok) {
    failures++
    stepFailed.push(label)
  }
  console.log(ok ? `ok   ${label}: ${a.length > 100 ? `${a.slice(0, 97)}…` : a}` : `FAIL ${label}: got ${a}, expected ${show(expected)}`)
  return ok
}
function checkThat(label: string, ok: boolean, detail: string): boolean {
  checks++
  if (!ok) {
    failures++
    stepFailed.push(label)
  }
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`)
  return ok
}
const note = (text: string) => console.log(`     ${text}`)
const pick = <T extends object, K extends keyof T>(o: T, keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, o[k]]))

// ── Revert decoding ───────────────────────────────────────────────────────────

const LABELS = new Map<string, string>()
const label = (a: string) => LABELS.get(getAddress(a)) ?? a
/** The revert data inside a viem error, wherever the node put it. */
function revertData(e: unknown): Hex | undefined {
  let cur: unknown = e
  for (let i = 0; i < 12 && cur; i++) {
    const c = cur as { data?: unknown; cause?: unknown }
    if (typeof c.data === 'string' && c.data.startsWith('0x')) return c.data as Hex
    if (c.data && typeof (c.data as { data?: unknown }).data === 'string') return (c.data as { data: Hex }).data
    cur = c.cause
  }
  const m = /data: "?(0x[0-9a-fA-F]*)"?/.exec(errorText(e))
  return m ? (m[1] as Hex) : undefined
}
/** An error's name; a hook revert that the PoolManager wrapped reads `WrappedError(<target>: <inner error>)`. */
function decodeRevert(data: Hex | undefined): string {
  if (!data || data === '0x') return 'revert without data'
  try {
    const d = decodeErrorResult({ abi: ERRORS, data })
    if (d.errorName === 'WrappedError') {
      const [target, , reason] = d.args as readonly [Address, Hex, Hex, Hex]
      return `WrappedError(${label(target)}: ${decodeRevert(reason)})`
    }
    return d.errorName
  } catch {
    return `unknown error ${data.slice(0, 10)}`
  }
}
const revertName = (e: unknown) => decodeRevert(revertData(e)) + (revertData(e) ? '' : ` [${errorText(e).split('\n')[0].slice(0, 120)}]`)

/** A call that must revert with `expected` (an error name, or 'ok' for no revert), simulated for free at `block`. */
async function expectRevert(what: string, to: Address, abi: Abi, functionName: string, args: readonly unknown[], expected: string, block: bigint, from?: Address) {
  let got = 'ok'
  try {
    await retry(() => pub.call({ account: from ?? me, to, data: encodeFunctionData({ abi, functionName, args }), blockNumber: block }))
  } catch (e) {
    got = decodeRevert(revertData(e))
  }
  check(expected === 'ok' ? `${what} is accepted` : `${what} reverts`, got, expected)
}
/** The return value of a call simulated at `block`. */
async function simulate<T>(to: Address, abi: Abi, functionName: string, args: readonly unknown[], block: bigint, from?: Address): Promise<T> {
  const res = await retry(() => pub.call({ account: from ?? me, to, data: encodeFunctionData({ abi, functionName, args }), blockNumber: block }))
  return decodeFunctionResult({ abi, functionName, data: res.data ?? '0x' }) as T
}

// ── Model: the spec's formulas, written independently of the contracts ────────

const divCeil = (a: bigint, b: bigint) => (a === 0n ? 0n : (a - 1n) / b + 1n)
const minOf = (a: bigint, b: bigint) => (a < b ? a : b)
const maxOf = (a: bigint, b: bigint) => (a > b ? a : b)

/** V14-SPEC §5: the surcharge in `block` of a window opened in `openBlock` (90% falling to 0 over 20 blocks), capped so
 *  all fees together take at most 99%. */
function snipeBpsAt(openBlock: bigint, block: bigint, creatorBps: bigint): bigint {
  const end = openBlock + SNIPE_BLOCKS
  if (block >= end) return 0n
  const bps = (SNIPE_START_BPS * (end - block)) / SNIPE_BLOCKS
  const room = MAX_TOTAL_FEE_BPS - FEE_BPS - creatorBps
  return bps > room ? room : bps
}

interface CurveState {
  virtualUsdc: bigint
  virtualTokens: bigint
  tokensSold: bigint
}
const INITIAL_CURVE: CurveState = { virtualUsdc: VIRTUAL_USDC_0, virtualTokens: VIRTUAL_TOKENS_0, tokensSold: 0n }
interface BuyModel {
  tokensOut: bigint
  platformFee: bigint
  creatorFee: bigint
  snipeFee: bigint
  usdcSpent: bigint
  graduates: boolean
  net: bigint
}
/** V13-SPEC §5 buy math with the snipe fee as a third fee (V14-SPEC §5), including the sell-out buy's exact fill. */
function modelCurveBuy(c: CurveState, usdcIn: bigint, creatorBps: bigint, snipeBps: bigint): BuyModel {
  const k = c.virtualUsdc * c.virtualTokens
  const platformFee = divCeil(usdcIn * FEE_BPS, BPS)
  const creatorFee = divCeil(usdcIn * creatorBps, BPS)
  const snipeFee = divCeil(usdcIn * snipeBps, BPS)
  if (platformFee + creatorFee + snipeFee >= usdcIn) throw new Error('model: the fees eat the whole buy')
  const net = usdcIn - platformFee - creatorFee - snipeFee
  const out = c.virtualTokens - divCeil(k, c.virtualUsdc + net)
  const remaining = CURVE_SUPPLY - c.tokensSold
  if (out < remaining) return { tokensOut: out, platformFee, creatorFee, snipeFee, usdcSpent: usdcIn, graduates: false, net }
  const feeBps = FEE_BPS + creatorBps + snipeBps
  const fillNet = divCeil(k, c.virtualTokens - remaining) - c.virtualUsdc
  const gross = fillNet + divCeil(fillNet * feeBps, BPS - feeBps)
  const usdcSpent = minOf(gross, usdcIn)
  const totalFee = usdcSpent - fillNet
  const p = divCeil(totalFee * FEE_BPS, feeBps)
  const cr = minOf(divCeil(totalFee * creatorBps, feeBps), totalFee - p)
  return { tokensOut: remaining, platformFee: p, creatorFee: cr, snipeFee: totalFee - p - cr, usdcSpent, graduates: true, net: fillNet }
}
/** V13-SPEC §5 sell math: both fees on the gross USDC, rounded up. */
function modelCurveSell(c: CurveState, tokensIn: bigint, creatorBps: bigint) {
  const gross = c.virtualUsdc - divCeil(c.virtualUsdc * c.virtualTokens, c.virtualTokens + tokensIn)
  const platformFee = divCeil(gross * FEE_BPS, BPS)
  const creatorFee = divCeil(gross * creatorBps, BPS)
  return { gross, platformFee, creatorFee, usdcOut: gross - platformFee - creatorFee }
}

interface Fees {
  platform: bigint
  creator: bigint
  snipe: bigint
  total: bigint
}
/** V14-SPEC §3: fees on a known gross USDC amount, each rounded up. */
function feesOnGross(gross: bigint, creatorBps: bigint, snipeBps: bigint): Fees {
  const platform = divCeil(gross * FEE_BPS, BPS)
  const creator = divCeil(gross * creatorBps, BPS)
  const snipe = divCeil(gross * snipeBps, BPS)
  if (platform + creator + snipe >= gross) throw new Error('model: FeesExceedAmount')
  return { platform, creator, snipe, total: platform + creator + snipe }
}
/** V14-SPEC §3: fees on top of a net USDC amount: total = ceil(net·r/(1e4-r)), split platform first, then the creator,
 *  the surcharge last, each rounded up and capped by what is left (v1.3's exact-fill split). */
function feesOnNet(net: bigint, creatorBps: bigint, snipeBps: bigint): Fees {
  if (net === 0n) throw new Error('model: FeesExceedAmount')
  const r = FEE_BPS + creatorBps + snipeBps
  const total = divCeil(net * r, BPS - r)
  const platform = divCeil(total * FEE_BPS, r)
  const creator = minOf(divCeil(total * creatorBps, r), total - platform)
  return { platform, creator, snipe: total - platform - creator, total }
}

const ceilTick = (t: number) => {
  let c = Math.trunc(t / TICK_SPACING)
  if (t > 0 && t % TICK_SPACING !== 0) c++
  return c * TICK_SPACING
}
const floorTick = (t: number) => {
  let c = Math.trunc(t / TICK_SPACING)
  if (t < 0 && t % TICK_SPACING !== 0) c--
  return c * TICK_SPACING
}
/** V14-SPEC §5: a bid's range from the price it is placed from (`refTick`: the price just before the buy that paid it, or
 *  the graduation price): its top about half that price (6,932 ticks past it, rounded away from the price onto the
 *  200-tick spacing), running 92,200 ticks lower, clamped to the usable ticks. */
function bidRange(usdcIs0: boolean, refTick: number): { lower: number; upper: number } {
  if (usdcIs0) {
    const lower = ceilTick(refTick + BID_DISCOUNT_TICKS + 1)
    return { lower, upper: Math.min(lower + BID_SPAN_TICKS, MAX_T) }
  }
  const upper = floorTick(refTick - BID_DISCOUNT_TICKS)
  return { lower: Math.max(upper - BID_SPAN_TICKS, MIN_T), upper }
}
/** The cheaper token price of two ticks: with USDC as currency0 a higher tick is a cheaper token. V14-SPEC §5 (Claude
 *  review #9's L1 and its residual): a window buy's bid is placed from the cheaper of the pool's tick just before the
 *  buy and the pool's reference, `bidRefTick`, which then becomes the reference: it starts at the graduation tick and
 *  only ever moves down, so no bid starts above half the lowest price any window buy has started from. */
const cheaperOf = (usdcIs0: boolean, a: number, b: number) => (usdcIs0 ? Math.max(a, b) : Math.min(a, b))
/** Whether tick `a` is a dearer token price than tick `b`. */
const pricierTick = (usdcIs0: boolean, a: number, b: number) => (usdcIs0 ? a < b : a > b)
/** Whether a bid's top is at or below half the graduation price: past (or at) the graduation bid's top tick. */
const notAboveGraduationBid = (usdcIs0: boolean, graduationTick: number, r: { lower: number; upper: number }) => {
  const g = bidRange(usdcIs0, graduationTick)
  return usdcIs0 ? r.lower >= g.lower : r.upper <= g.upper
}
/** Whether a range is wholly on the USDC side of `tick`, in v4's own terms: a position takes currency0 alone while
 *  tick < lower, currency1 alone while tick >= upper. */
const usdcSide = (usdcIs0: boolean, r: { lower: number; upper: number }, tick: number) => (usdcIs0 ? tick < r.lower : tick >= r.upper)
/** Whether `tick` is under half the price at `refTick`, that is past the top of a bid placed from it. */
const pastBidTop = (usdcIs0: boolean, refTick: number, tick: number) => !usdcSide(usdcIs0, bidRange(usdcIs0, refTick), tick)
interface BidModel {
  lower: number
  upper: number
  liquidity: bigint
  used: bigint
}
/** The bid the hook places with all it holds, `amount`, from `refTick`, into `pool` (updated, at its current price): a
 *  USDC-only position of its own, or none if the range is empty or the amount buys no liquidity. Throws if the range is
 *  not wholly on the USDC side of the current price (the hook would revert BidNotOneSided). */
function modelBid(pool: V4.PoolModel, usdcIs0: boolean, refTick: number, amount: bigint): BidModel | undefined {
  const { lower, upper } = bidRange(usdcIs0, refTick)
  if (lower >= upper || amount === 0n) return undefined
  const a = V4.sqrtAtTick(lower)
  const b = V4.sqrtAtTick(upper)
  const liquidity = usdcIs0 ? V4.liquidityForAmount0(a, b, amount) : V4.liquidityForAmount1(a, b, amount)
  if (liquidity === 0n) return undefined
  const d = V4.modifyLiquidity(pool, lower, upper, liquidity)
  if ((usdcIs0 ? d.amount1 : d.amount0) !== 0n) throw new Error('model: bid not one-sided')
  return { lower, upper, liquidity, used: -(usdcIs0 ? d.amount0 : d.amount1) }
}

interface GraduationModel {
  sqrtPrice: bigint
  tick: number
  liquidity: bigint
  tokensUsed: bigint
  usdcUsed: bigint
  burned: bigint
  toLock: bigint
  bid?: BidModel
  pool: V4.PoolModel
}
/** V14-SPEC §4: open the pool at the price where one full-range position takes both amounts, add that position, burn the
 *  tokens it leaves, and bid the snipe fees plus the USDC it leaves, from half the graduation price down. */
function modelGraduation(usdcIs0: boolean, usdcSeeded: bigint, lockAmount: bigint): GraduationModel {
  const [amount0, amount1] = usdcIs0 ? [usdcSeeded, POOL_SUPPLY] : [POOL_SUPPLY, usdcSeeded]
  const sqrtPrice = V4.isqrt(V4.mulDiv(amount1, 1n << 192n, amount0))
  const tick = V4.tickAtSqrt(sqrtPrice)
  const pool: V4.PoolModel = { sqrtPrice, tick, liquidity: 0n, spacing: TICK_SPACING, ticks: new Map() }
  const liquidity = V4.liquidityForAmounts(sqrtPrice, V4.sqrtAtTick(MIN_T), V4.sqrtAtTick(MAX_T), amount0, amount1)
  const d = V4.modifyLiquidity(pool, MIN_T, MAX_T, liquidity)
  const [used0, used1] = [-d.amount0, -d.amount1]
  const [tokensUsed, usdcUsed] = usdcIs0 ? [used1, used0] : [used0, used1]
  const toLock = lockAmount + (usdcSeeded - usdcUsed)
  const bid = toLock !== 0n ? modelBid(pool, usdcIs0, tick, toLock) : undefined
  return { sqrtPrice, tick, liquidity, tokensUsed, usdcUsed, burned: POOL_SUPPLY - tokensUsed, toLock, bid, pool }
}

/** LaunchTokenV14's dividend stream (V13-SPEC §3), as held in the token's storage. */
interface TokenStream {
  perShare: bigint
  rate: bigint
  eligible: bigint
  lastAccrual: bigint
  end: bigint
}
const paused = (s: TokenStream) => s.eligible < E18
function perShareAt(s: TokenStream, t: bigint): bigint {
  if (s.lastAccrual >= s.end || paused(s)) return s.perShare
  return s.perShare + (s.rate * (minOf(t, s.end) - s.lastAccrual)) / s.eligible
}
const claimableAt = (s: TokenStream, t: bigint, balance: bigint, correction: bigint, claimed: bigint) => (perShareAt(s, t) * balance + correction) / MAGNITUDE - claimed
function undistributedAt(s: TokenStream, t: bigint): bigint {
  if (s.lastAccrual >= s.end) return 0n
  const from = paused(s) ? s.lastAccrual : minOf(t, s.end)
  return (s.rate * (s.end - from)) / MAGNITUDE
}
function accrueAt(s: TokenStream, t: bigint): TokenStream {
  if (s.lastAccrual >= s.end || s.lastAccrual === t) return s
  if (paused(s)) return { ...s, end: s.end + (t - s.lastAccrual), lastAccrual: t }
  const upTo = minOf(t, s.end)
  return { ...s, perShare: s.perShare + (s.rate * (upTo - s.lastAccrual)) / s.eligible, lastAccrual: upTo }
}
function distributeAt(s0: TokenStream, t: bigint, amount: bigint): TokenStream {
  const s = accrueAt(s0, t)
  const owed = s.end > t ? s.rate * (s.end - t) : 0n
  const added = amount * MAGNITUDE
  const from = maxOf(s.end, t)
  const end = maxOf(from + (added * (t + DRIP_PERIOD - from)) / (owed + added), t + 1n)
  return { ...s, rate: (owed + added) / (end - t), lastAccrual: t, end }
}

// ── Chain guard, signer, progress ─────────────────────────────────────────────

const chainId = await retry(() => pub.getChainId())
if (chainId === ARC_MAINNET || !(chainId === ARC_TESTNET || (LOCAL_RPC && chainId === 31337))) {
  throw new Error(`Refusing to run on chain ${chainId}: this rehearsal is for Arc Testnet (${ARC_TESTNET}) only, or a local fork of it on chain 31337.`)
}
if (dep.chainId !== chainId) throw new Error(`${DEPLOYMENT} is for chain ${dep.chainId}, the RPC is chain ${chainId}`)

type SignerMode = 'key' | 'anvil' | 'none'
const SIGNER: SignerMode = (process.env.SIGNER as SignerMode | undefined) ?? (process.env.REHEARSAL_KEY ? 'key' : 'none')
if (!['key', 'anvil', 'none'].includes(SIGNER)) throw new Error(`SIGNER must be key, anvil or unset, not "${SIGNER}"`)
let account: ReturnType<typeof privateKeyToAccount> | undefined
let me: Address = getAddress(process.env.ACTOR ?? dep.deployer)
if (SIGNER === 'key') {
  if (LOCAL_RPC && chainId === ARC_TESTNET) throw new Error('Refusing to sign for a local node that reports chain 5042002: those signatures would be valid on Arc Testnet. Run the fork with --chain-id 31337, or use SIGNER=anvil.')
  const raw = process.env.REHEARSAL_KEY?.trim()
  if (!raw) throw new Error('SIGNER=key needs REHEARSAL_KEY')
  const key = raw.startsWith('0x') ? raw : `0x${raw}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('REHEARSAL_KEY is not a 32-byte hex private key')
  account = privateKeyToAccount(key as Hex)
  me = account.address
}
/** A raw JSON-RPC call, for anvil's own methods. */
async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const body = (await res.json()) as { result?: unknown; error?: { message: string } }
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result
}
if (SIGNER === 'anvil') {
  if (!LOCAL_RPC) throw new Error('SIGNER=anvil needs a local anvil RPC (http://127.0.0.1:<port>)')
  const client = String(await rpc('web3_clientVersion', []))
  if (!/anvil/i.test(client)) throw new Error(`SIGNER=anvil needs anvil, the node is "${client}"`)
}
const DRIVING = SIGNER !== 'none'
const chain = defineChain({ id: chainId, name: 'arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } })
const wallet = createWalletClient({ chain, transport: http(RPC, { retryCount: 0, timeout: 30_000 }) })
/** Run A's mints come from rUSDC's owner: the actor itself, or (on anvil) the impersonated owner. */
const RUSDC_OWNER: Address = REAL ? me : getAddress(await retry(() => pub.readContract({ address: USDC, abi: ERC20, functionName: 'owner' })))

const SPECS = specsFor(me)
const KINDS = Object.keys(SPECS) as Kind[]
const spec = (k: Kind): Spec => {
  const s = SPECS[k]
  if (!s) throw new Error(`no spec for ${k}`)
  return s
}
const sym = (k: Kind) => spec(k).symbol

interface TxRecord {
  step: string
  what: string
  hash: Hex
  block: string
  gasUsed: string
  gasPrice: string
  status: string
  /** window transactions sent back to back: the gas estimate each was sent with (taken before the batch's earlier
   *  transactions landed) and its limit */
  gasEstimate?: string
  gasLimit?: string
}
interface StepResult {
  step: string
  ok: boolean
  checks: number
  failed: string[]
  at: string
}
interface PosChange {
  id: string
  owner: Address
  lower: number
  upper: number
  salt: Hex
  block: string
  delta: string
}
interface PoolRec {
  poolId: Hex
  usdcIs0: boolean
  open: boolean
  creatorBps: string
  openBlock: string
  graduationTick: number
  changes: PosChange[]
}
interface Progress {
  launchpad: Address
  actor?: Address
  raw?: Address
  rawBlock?: string
  tokens: Partial<Record<Kind, Address>>
  tokenBlocks: Partial<Record<Kind, string>>
  planned: Partial<Record<Kind, { address: Address; usdcIs0: boolean }>>
  features: Kind[]
  openLp?: Kind
  closedLp?: Kind
  pools: Partial<Record<Kind, PoolRec>>
  done: Record<string, string>
  txs: TxRecord[]
  results: StepResult[]
  notes: Record<string, string>
  pending?: { step: string; what: string; hash: Hex; nonce: number }
  /** a batch of window transactions sent back to back and not yet recorded */
  pendingBatch?: { step: string; what: string; hash: Hex; nonce: number; gasEstimate: string; gasLimit: string }[]
}
const progressExists = existsSync(PROGRESS)
const progress: Progress = progressExists
  ? (JSON.parse(readFileSync(PROGRESS, 'utf8')) as Progress)
  : { launchpad: LP, tokens: {}, tokenBlocks: {}, planned: {}, features: [], pools: {}, done: {}, txs: [], results: [], notes: {} }
if (getAddress(progress.launchpad) !== LP) throw new Error(`${PROGRESS} belongs to launchpad ${progress.launchpad}, not ${LP}`)
if (DRIVING && progress.actor && getAddress(progress.actor) !== me) throw new Error(`${PROGRESS} was driven by ${progress.actor}, not ${me}`)
function save() {
  if (!DRIVING) return // read-only runs never write
  const tmp = `${PROGRESS}.tmp`
  writeFileSync(tmp, `${JSON.stringify(progress, null, 2)}\n`)
  renameSync(tmp, PROGRESS)
}
const tokenOf = (k: Kind): Address => {
  const t = progress.tokens[k]
  if (!t) throw new Error(`no ${k} token yet`)
  return getAddress(t)
}
const RAW = () => {
  if (!progress.raw) throw new Error('no RawSwapper yet')
  return getAddress(progress.raw)
}
for (const [a, l] of [
  [LP, 'launchpad'], [HOOK, 'hook'], [ROUTER, 'router'], [POOL_MANAGER, 'PoolManager'], [USDC, U], [SPLIT, 'Split'],
  [HOLDERS, 'Holders'], [COMBO, 'Combo'], [me, 'actor'],
] as const) LABELS.set(getAddress(a), l)

/** The block every "current state" read uses: the latest receipt this run has seen (never behind our own writes). */
let head = await retry(() => pub.getBlockNumber({ cacheTime: 0 }))
const latest = () => retry(() => pub.getBlockNumber({ cacheTime: 0 }))
const timeOf = async (block: bigint) => (await retry(() => pub.getBlock({ blockNumber: block }))).timestamp
const deadline = async () => (await timeOf(head)) + 3600n
async function rd<T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], blockNumber?: bigint): Promise<T> {
  return (await retry(() => pub.readContract({ address, abi, functionName, args, blockNumber }))) as T
}
const nativeOf = (who: Address, block: bigint) => retry(() => pub.getBalance({ address: who, blockNumber: block }))
const nonceOf = (who: Address, block: bigint) => retry(() => pub.getTransactionCount({ address: who, blockNumber: block }))
/** Waits until the chain has mined `target` (interval-mined anvil and Arc both mine on their own). */
async function waitForBlock(target: bigint) {
  for (;;) {
    const b = await latest()
    if (b >= target) {
      if (b > head) head = b
      return
    }
    await sleep(250)
  }
}

// ── Sending ───────────────────────────────────────────────────────────────────

let nextNonce = 0
let tipCache: bigint | undefined
const spentWei = () => progress.txs.reduce((sum, t) => sum + BigInt(t.gasUsed) * BigInt(t.gasPrice), 0n)
function recordTx(step: string, what: string, r: TransactionReceipt, gas?: { gasEstimate: string; gasLimit: string }) {
  progress.txs.push({ step, what, hash: r.transactionHash, block: r.blockNumber.toString(), gasUsed: r.gasUsed.toString(), gasPrice: r.effectiveGasPrice.toString(), status: r.status, ...gas })
  if (r.blockNumber > head) head = r.blockNumber
}

/** Sends a signed transaction; 'taken' if its nonce went to another transaction. */
async function broadcast(serialized: Hex, hash: Hex): Promise<'sent' | 'taken'> {
  for (let attempt = 1; ; attempt++) {
    try {
      await pub.sendRawTransaction({ serializedTransaction: serialized })
      return 'sent'
    } catch (e) {
      const text = errorText(e)
      if (/already known|known transaction|already imported|already exists/i.test(text)) return 'sent'
      if (/nonce too low|nonce is too low|invalid nonce|replacement transaction underpriced/i.test(text)) {
        for (let i = 0; i < 10; i++) {
          if (await pub.getTransaction({ hash }).catch(() => undefined)) return 'sent'
          await sleep(1000)
        }
        return 'taken'
      }
      if (attempt >= 8 || !transient(e)) throw e
      await sleep(500 * 2 ** attempt)
    }
  }
}

/** Simulates, then signs (key) or asks anvil to send (anvil) one transaction; `to` undefined deploys `data`. Waits for
 *  the receipt and records it. `usdcOut` (Run B) is what the transaction takes from the actor, for the floor. `from` is
 *  the actor, except for rUSDC mints on anvil when the actor is not rUSDC's owner (the owner is impersonated then). */
async function sendRaw(step: string, what: string, to: Address | undefined, data: Hex, usdcOut = 0n, from: Address = me): Promise<TransactionReceipt> {
  if (!DRIVING) throw new Error('SIGNER is needed to send transactions')
  if (from !== me && SIGNER !== 'anvil') throw new Error(`${what}: only ${from} can send it, and REHEARSAL_KEY is ${me}'s`)
  try {
    await retry(() => pub.call({ account: from, to, data, blockNumber: head }))
  } catch (e) {
    throw new Error(`${what} would revert: ${revertName(e)}`)
  }
  const estimate = await retry(() => pub.estimateGas({ account: from, to, data, blockNumber: head }))
  const gas = estimate + estimate / 4n + 25_000n
  const block = await retry(() => pub.getBlock({ blockNumber: head }))
  tipCache ??= await retry(() => pub.estimateMaxPriorityFeePerGas())
  const tip = tipCache
  const maxFeePerGas = (block.baseFeePerGas ?? 0n) * 2n + tip
  const worst = gas * maxFeePerGas
  if (spentWei() + worst > GAS_CAP_WEI) {
    throw new Error(`${what}: gas cap reached (${fmt18(spentWei())} USDC spent, cap ${fmt18(GAS_CAP_WEI)}; raise GAS_CAP to go on)`)
  }
  if (REAL) {
    const native = await nativeOf(me, head)
    if (native - worst - usdcOut * WEI_PER_UNIT < FLOOR_WEI) {
      throw new Error(`${what}: would take the actor below ${fmt18(FLOOR_WEI)} USDC (it holds ${fmt18(native)})`)
    }
  }
  for (let attempt = 1; ; attempt++) {
    const pendingNonce = await retry(() => pub.getTransactionCount({ address: from, blockTag: 'pending' }))
    const nonce = from === me ? Math.max(pendingNonce, nextNonce) : pendingNonce
    let hash: Hex
    if (account) {
      const serialized = await account.signTransaction({ type: 'eip1559', chainId, to, data, gas, nonce, maxFeePerGas, maxPriorityFeePerGas: tip })
      hash = keccak256(serialized)
      progress.pending = { step, what, hash, nonce }
      save()
      if ((await broadcast(serialized, hash)) === 'taken') {
        if (attempt >= 3) throw new Error(`${what}: nonce ${nonce} keeps being taken by another transaction from the actor`)
        note(`nonce ${nonce} was taken by another transaction from the actor; re-signing`)
        continue
      }
    } else {
      hash = await wallet.sendTransaction({ account: from, to, data, gas, nonce, maxFeePerGas, maxPriorityFeePerGas: tip, chain })
      progress.pending = { step, what, hash, nonce }
      save()
    }
    if (from === me) nextNonce = nonce + 1
    // Every 250 ms: window buys must land within 20 blocks (about 10 s), and Arc's RPC answers in about 35 ms.
    const receipt = await retry(() => pub.waitForTransactionReceipt({ hash, pollingInterval: 250, timeout: 180_000 }))
    recordTx(step, what, receipt)
    progress.pending = undefined
    save()
    console.log(`     ${what}: ${hash} (block ${receipt.blockNumber}, gas ${receipt.gasUsed}, ${receipt.status})`)
    if (receipt.status !== 'success') throw new Error(`${what} reverted on chain: ${hash}`)
    return receipt
  }
}

const minedTx = (step: string, what: string) => progress.txs.find((t) => t.step === step && t.what === what && t.status === 'success')
interface Sent {
  receipt: TransactionReceipt
  args: readonly unknown[]
}
/** Sends a step's call once: a transaction this step already mined (an earlier run) is re-used, not re-sent. Returns the
 *  receipt and the arguments the mined transaction actually carried. */
async function tx(step: string, what: string, to: Address, abi: Abi, functionName: string, args: readonly unknown[] | (() => Promise<readonly unknown[]>), usdcOut = 0n, from: Address = me): Promise<Sent> {
  const mined = minedTx(step, what)
  if (!mined) {
    const a = typeof args === 'function' ? await args() : args
    return { receipt: await sendRaw(step, what, to, encodeFunctionData({ abi, functionName, args: a }), usdcOut, from), args: a }
  }
  const receipt = await retry(() => pub.getTransactionReceipt({ hash: mined.hash }))
  const sent = await retry(() => pub.getTransaction({ hash: mined.hash }))
  if (receipt.blockNumber > head) head = receipt.blockNumber
  console.log(`     ${what}: ${mined.hash} (mined in an earlier run; re-checking)`)
  return { receipt, args: decodeFunctionData({ abi, data: sent.input }).args ?? [] }
}
interface Planned {
  what: string
  to: Address
  abi: Abi
  fn: string
  args: readonly unknown[]
  /** the arguments its gas is estimated with, against the state before the batch's earlier transactions land (a
   *  minimum out of 0, so the estimate cannot revert on a price those transactions have not moved yet) */
  estimateArgs?: readonly unknown[]
}
/** V14-SPEC §5 (integration review #9b): a window transaction's gas depends on tick state other trades change, so its
 *  limit is a fresh estimate with 30% on top, or 200,000, whichever is more. */
const windowGasLimit = (estimate: bigint) => maxOf((estimate * 13n) / 10n, estimate + 200_000n)
/** Sends a step's window transactions back to back, in nonce order, without waiting for any receipt in between, then
 *  waits for them all, so they land inside the window whatever the receipts' latency. Each is estimated right before it
 *  is sent (the first one also simulated with its real arguments) and gets `windowGasLimit`. Transactions this step
 *  already mined (an earlier run) are re-used, never sent again; the rest are sent after them. */
async function sendBatch(step: string, items: Planned[]): Promise<Sent[]> {
  const out: (Sent | undefined)[] = []
  for (const it of items) {
    const mined = minedTx(step, it.what)
    if (!mined) {
      out.push(undefined)
      continue
    }
    if (out.includes(undefined)) throw new Error(`${it.what} was mined but an earlier transaction of its batch was not`)
    const receipt = await retry(() => pub.getTransactionReceipt({ hash: mined.hash }))
    const sent = await retry(() => pub.getTransaction({ hash: mined.hash }))
    if (receipt.blockNumber > head) head = receipt.blockNumber
    console.log(`     ${it.what}: ${mined.hash} (mined in an earlier run; re-checking)`)
    out.push({ receipt, args: decodeFunctionData({ abi: it.abi, data: sent.input }).args ?? [] })
  }
  const todo = items.flatMap((it, i) => (out[i] ? [] : [{ it, i }]))
  if (!todo.length) return out as Sent[]
  if (!DRIVING) throw new Error('SIGNER is needed to send transactions')
  const block = await retry(() => pub.getBlock({ blockTag: 'latest' }))
  tipCache ??= await retry(() => pub.estimateMaxPriorityFeePerGas())
  const tip = tipCache
  const maxFeePerGas = (block.baseFeePerGas ?? 0n) * 2n + tip
  const first = todo[0].it
  try {
    await retry(() => pub.call({ account: me, to: first.to, data: encodeFunctionData({ abi: first.abi, functionName: first.fn, args: first.args }), blockTag: 'latest' }))
  } catch (e) {
    throw new Error(`${first.what} would revert: ${revertName(e)}`)
  }
  const pendingNonce = await retry(() => pub.getTransactionCount({ address: me, blockTag: 'pending' }))
  let nonce = Math.max(pendingNonce, nextNonce)
  const sentOut: { i: number; it: Planned; hash: Hex; gasEstimate: bigint; gasLimit: bigint }[] = []
  let worst = 0n
  for (const { it, i } of todo) {
    const data = encodeFunctionData({ abi: it.abi, functionName: it.fn, args: it.args })
    let estimate: bigint
    try {
      estimate = await retry(() => pub.estimateGas({ account: me, to: it.to, data: encodeFunctionData({ abi: it.abi, functionName: it.fn, args: it.estimateArgs ?? it.args }), blockTag: 'latest' }))
    } catch (e) {
      throw new Error(`${it.what}: gas estimate failed: ${revertName(e)}`)
    }
    const gas = windowGasLimit(estimate)
    worst += gas * maxFeePerGas
    if (spentWei() + worst > GAS_CAP_WEI) throw new Error(`${it.what}: gas cap reached (${fmt18(spentWei())} USDC spent, cap ${fmt18(GAS_CAP_WEI)}; raise GAS_CAP to go on)`)
    let hash: Hex
    const pendingEntry = (h: Hex) => ({ step, what: it.what, hash: h, nonce, gasEstimate: estimate.toString(), gasLimit: gas.toString() })
    if (account) {
      const serialized = await account.signTransaction({ type: 'eip1559', chainId, to: it.to, data, gas, nonce, maxFeePerGas, maxPriorityFeePerGas: tip })
      hash = keccak256(serialized)
      progress.pendingBatch = [...(progress.pendingBatch ?? []), pendingEntry(hash)]
      save()
      if ((await broadcast(serialized, hash)) === 'taken') throw new Error(`${it.what}: nonce ${nonce} was taken by another transaction from the actor, in the middle of a batch`)
    } else {
      hash = await wallet.sendTransaction({ account: me, to: it.to, data, gas, nonce, maxFeePerGas, maxPriorityFeePerGas: tip, chain })
      progress.pendingBatch = [...(progress.pendingBatch ?? []), pendingEntry(hash)]
      save()
    }
    sentOut.push({ i, it, hash, gasEstimate: estimate, gasLimit: gas })
    nonce++
    nextNonce = nonce
  }
  const reverted: string[] = []
  for (const x of sentOut) {
    const receipt = await retry(() => pub.waitForTransactionReceipt({ hash: x.hash, pollingInterval: 250, timeout: 180_000 }))
    recordTx(step, x.it.what, receipt, { gasEstimate: x.gasEstimate.toString(), gasLimit: x.gasLimit.toString() })
    progress.pendingBatch = (progress.pendingBatch ?? []).filter((p) => p.hash !== x.hash)
    save()
    console.log(`     ${x.it.what}: ${x.hash} (block ${receipt.blockNumber}, gas ${receipt.gasUsed} of ${x.gasLimit}, estimated ${x.gasEstimate}, ${receipt.status})`)
    if (receipt.status !== 'success') reverted.push(`${x.it.what} (${x.hash})`)
    out[x.i] = { receipt, args: x.it.args }
  }
  if (progress.pendingBatch && !progress.pendingBatch.length) progress.pendingBatch = undefined
  save()
  if (reverted.length) throw new Error(`reverted on chain: ${reverted.join(', ')}`)
  return out as Sent[]
}

/** Transactions left in flight by an interrupted run: record those that were mined, so none is lost or repeated. */
async function recoverPending() {
  type Entry = { step: string; what: string; hash: Hex; gasEstimate?: string; gasLimit?: string }
  const list: Entry[] = [...(progress.pending ? [progress.pending] : []), ...(progress.pendingBatch ?? [])]
  for (const p of list) {
    note(`recovering ${p.what} (${p.hash}) from an interrupted run`)
    let receipt: TransactionReceipt | undefined
    for (let i = 0; i < 40 && !receipt; i++) {
      receipt = await pub.getTransactionReceipt({ hash: p.hash }).catch(() => undefined)
      if (!receipt) await sleep(3000)
    }
    const gas = p.gasLimit !== undefined && p.gasEstimate !== undefined ? { gasEstimate: p.gasEstimate, gasLimit: p.gasLimit } : undefined
    if (receipt) recordTx(p.step, p.what, receipt, gas)
    else note('it was never mined; the step will send it again')
  }
  progress.pending = undefined
  progress.pendingBatch = undefined
  save()
}

// ── Events ────────────────────────────────────────────────────────────────────

function logsOf<T>(receipt: TransactionReceipt, address: Address, abi: Abi, eventName: string): { args: T; logIndex: number }[] {
  const logs = receipt.logs.filter((l) => getAddress(l.address) === address)
  return parseEventLogs({ abi, logs, eventName }).map((l) => ({ args: (l as unknown as { args: T }).args, logIndex: l.logIndex }))
}
const eventsOf = <T>(receipt: TransactionReceipt, address: Address, abi: Abi, eventName: string): T[] => logsOf<T>(receipt, address, abi, eventName).map((l) => l.args)

interface CurveView extends CurveState {
  token: Address
  creator: Address
  createdAt: bigint
  createdBlock: bigint
  graduated: boolean
  openPool: boolean
  creatorFeeBps: number
  pluginHooks: boolean
  plugin: Address
  metadataURI: string
}
interface TradeEvent {
  token: Address
  trader: Address
  isBuy: boolean
  usdcAmount: bigint
  tokenAmount: bigint
  platformFee: bigint
  creatorFee: bigint
  snipeFee: bigint
  virtualUsdc: bigint
  virtualTokens: bigint
}
interface PoolTradeEvent {
  token: Address
  sender: Address
  isBuy: boolean
  usdcAmount: bigint
  tokenAmount: bigint
  platformFee: bigint
  creatorFee: bigint
  snipeFee: bigint
}
interface SwapEvent {
  id: Hex
  sender: Address
  amount0: bigint
  amount1: bigint
  sqrtPriceX96: bigint
  liquidity: bigint
  tick: number
  fee: number
}
interface ModifyEvent {
  id: Hex
  sender: Address
  tickLower: number
  tickUpper: number
  liquidityDelta: bigint
  salt: Hex
}
interface ClaimEvent {
  caller: Address
  from: Address
  to: Address
  id: bigint
  amount: bigint
}
const curveAt = (token: Address, block: bigint) => rd<CurveView>(LP, ABI.pad, 'curves', [token], block)
const USDC_ID = BigInt(USDC)
/** The hook's ERC-6909 claim mints (+) and burns (-) in a receipt, in order. */
const claimMoves = (r: TransactionReceipt) =>
  eventsOf<ClaimEvent>(r, POOL_MANAGER, ABI.pm, 'Transfer')
    .filter((e) => e.id === USDC_ID && (getAddress(e.to) === HOOK || getAddress(e.from) === HOOK))
    .map((e) => (getAddress(e.to) === HOOK ? e.amount : -e.amount))

// ── Snapshots: every tracked balance and accrual, one Multicall3 call per block ──

type Snap = Map<string, bigint>
const snapCache = new Map<bigint, Snap>()
const tokensAt = (b: bigint) => KINDS.filter((k) => progress.tokenBlocks[k] !== undefined && BigInt(progress.tokenBlocks[k]) <= b)
const graduatedAt = (k: Kind, b: bigint) => progress.pools[k] !== undefined && BigInt(progress.pools[k].openBlock) <= b
const rawAt = (b: bigint) => progress.rawBlock !== undefined && BigInt(progress.rawBlock) <= b

interface Read {
  key: string
  to: Address
  abi: Abi
  fn: string
  args?: readonly unknown[]
}
async function multiread(reads: Read[], block: bigint): Promise<unknown[]> {
  const out: unknown[] = []
  for (let i = 0; i < reads.length; i += 150) {
    const chunk = reads.slice(i, i + 150)
    const calls = chunk.map((r) => ({ target: r.to, allowFailure: true, callData: encodeFunctionData({ abi: r.abi, functionName: r.fn, args: r.args ?? [] }) }))
    const res = await retry(() => pub.call({ to: MULTICALL3, data: encodeFunctionData({ abi: multicall3Abi, functionName: 'aggregate3', args: [calls] }), blockNumber: block }))
    const decoded = decodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', data: res.data ?? '0x' }) as readonly { success: boolean; returnData: Hex }[]
    decoded.forEach((d, j) => {
      if (!d.success) throw new Error(`multicall: ${chunk[j].key} reverted at block ${block}: ${decodeRevert(d.returnData)}`)
      out.push(decodeFunctionResult({ abi: chunk[j].abi, functionName: chunk[j].fn, data: d.returnData }))
    })
  }
  return out
}

/** Addresses whose USDC is tracked, by label. In Run B two are left out: the actor's, which gas moves (checked apart), and
 *  the PoolManager's, which every Uniswap trade on Arc moves (Run B opens no pool). rUSDC, Run A's, exists only here. */
function usdcHoldersAt(b: bigint): [string, Address][] {
  const list: [string, Address][] = [['launchpad', LP], ['hook', HOOK], ['split', SPLIT], ['holders', HOLDERS], ['combo', COMBO]]
  if (!REAL) list.push(['poolManager', POOL_MANAGER], ['burner', me])
  if (FEE_TO !== me) list.push(['feeTo', FEE_TO])
  if (rawAt(b)) list.push(['raw', RAW()])
  if (!REAL) {
    list.push(['creatorWallet', CREATOR_WALLET], ['zeroWallet', ZERO_WALLET], ['comboWallet', COMBO_WALLET])
    PAYEES.forEach((p, i) => list.push([`payee${i + 1}`, p]))
    COMBO_PAYEES.forEach((p, i) => list.push([`comboPayee${i + 1}`, p]))
  }
  for (const k of tokensAt(b)) list.push([`tok:${sym(k)}`, tokenOf(k)])
  return list
}
/** Addresses whose launch tokens are tracked. Every token lives with one of them (checked as an invariant). */
function tokenHoldersAt(b: bigint): [string, Address][] {
  const list: [string, Address][] = [['launchpad', LP], ['burner', me], ['poolManager', POOL_MANAGER], ['hook', HOOK]]
  if (rawAt(b)) list.push(['raw', RAW()])
  return list
}

async function snapshot(b: bigint): Promise<Snap> {
  const hit = snapCache.get(b)
  if (hit) return hit
  const reads: Read[] = []
  const add = (key: string, to: Address, abi: Abi, fn: string, args: readonly unknown[] = []) => reads.push({ key, to, abi, fn, args })
  for (const [l, who] of usdcHoldersAt(b)) add(`usdc:${l}`, USDC, ABI.erc20, 'balanceOf', [who])
  add('lp.pendingFees', LP, ABI.pad, 'pendingFees')
  add('hook.claims', POOL_MANAGER, ABI.pm, 'balanceOf', [HOOK, USDC_ID])
  for (const k of tokensAt(b)) {
    const t = tokenOf(k)
    const s = sym(k)
    add(`lp.creator:${s}`, LP, ABI.pad, 'pendingCreatorFees', [t])
    add(`lp.snipe:${s}`, LP, ABI.pad, 'pendingSnipe', [t])
    add(`curve:${s}`, LP, ABI.pad, 'curves', [t])
    add(`tok.supply:${s}`, t, ABI.token, 'totalSupply')
    for (const [l, who] of tokenHoldersAt(b)) add(`tok.${l}:${s}`, t, ABI.token, 'balanceOf', [who])
    add(`tok.distributed:${s}`, t, ABI.token, 'totalDistributed')
    add(`tok.claimed.burner:${s}`, t, ABI.token, 'claimed', [me])
    if (rawAt(b)) add(`tok.claimed.raw:${s}`, t, ABI.token, 'claimed', [RAW()])
    if (usesSplit(k) && !REAL) {
      add(`split.received:${s}`, SPLIT, ABI.split, 'totalReceived', [t])
      add(`split.released:${s}`, SPLIT, ABI.split, 'totalReleased', [t])
    }
    if (usesHolders(k) && !REAL) add(`holders.distributed:${s}`, HOLDERS, ABI.holders, 'totalDistributed', [t])
    add(`hook.platform:${s}`, HOOK, ABI.hook, 'pendingPlatform', [t])
    add(`hook.creator:${s}`, HOOK, ABI.hook, 'pendingCreator', [t])
    add(`hook.lockHeld:${s}`, HOOK, ABI.hook, 'lockHeld', [t])
    add(`hook.bids:${s}`, HOOK, ABI.hook, 'bidCount', [t])
    if (graduatedAt(k, b)) {
      const id = (progress.pools[k] as PoolRec).poolId
      add(`pool.slot0:${s}`, STATE_VIEW, ABI.stateView, 'getSlot0', [id])
      add(`pool.liquidity:${s}`, STATE_VIEW, ABI.stateView, 'getLiquidity', [id])
      add(`hook.launch:${s}`, HOOK, ABI.hook, 'launchOf', [t])
    }
  }
  const results = await multiread(reads, b)
  const snap: Snap = new Map()
  reads.forEach((r, i) => {
    const v = results[i]
    const [kind, s] = r.key.split(':')
    if (kind === 'curve') {
      const c = v as CurveView
      snap.set(`curve.vU:${s}`, c.virtualUsdc)
      snap.set(`curve.vT:${s}`, c.virtualTokens)
      snap.set(`curve.sold:${s}`, c.tokensSold)
      snap.set(`curve.grad:${s}`, c.graduated ? 1n : 0n)
    } else if (kind === 'pool.slot0') {
      const [sqrtP, tick] = v as readonly [bigint, number, number, number]
      snap.set(`pool.sqrtP:${s}`, sqrtP)
      snap.set(`pool.tick:${s}`, BigInt(tick))
    } else if (kind === 'hook.launch') {
      const [, l] = v as readonly [Hex, { bidRefTick: number }]
      snap.set(`hook.bidRef:${s}`, BigInt(l.bidRefTick))
    } else {
      snap.set(r.key, BigInt(v as bigint | number))
    }
  })
  snapCache.set(b, snap)
  return snap
}
const symsIn = (s: Snap) => [...s.keys()].filter((k) => k.startsWith('tok.supply:')).map((k) => k.slice('tok.supply:'.length))

type Moves = Record<string, bigint>
/** Every tracked quantity must move by exactly `expected` (0 when listed as 0) and every other one must not move. */
function moves(what: string, s0: Snap, s1: Snap, expected: Moves) {
  const keys = new Set([...s0.keys(), ...s1.keys()])
  const delta = (k: string) => (s1.get(k) ?? 0n) - (s0.get(k) ?? 0n)
  const named = Object.entries(expected).filter(([, v]) => v !== 0n)
  if (named.length) {
    const missing = named.filter(([k]) => !keys.has(k)).map(([k]) => k)
    if (missing.length) check(`${what}: tracked quantities`, missing, [])
    check(`${what}: ${named.map(([k]) => k).join(', ')} moved by`, Object.fromEntries(named.map(([k]) => [k, delta(k)])), Object.fromEntries(named))
  }
  const others = [...keys].filter((k) => !(k in expected) || expected[k] === 0n).filter((k) => delta(k) !== 0n).map((k) => `${k} ${delta(k)}`)
  check(`${what}: nothing else moved (${keys.size - named.length} other tracked quantities)`, others, [])
}

/** The books to the unit (V14-SPEC §11 invariants), at one snapshot; `s0` is the block before, for the supply rule. */
function invariants(what: string, s: Snap, s0?: Snap) {
  const get = (k: string) => s.get(k) ?? 0n
  const syms = symsIn(s)
  let owed = get('lp.pendingFees')
  for (const x of syms) {
    owed += get(`lp.creator:${x}`) + get(`lp.snipe:${x}`)
    if (get(`curve.grad:${x}`) === 0n) owed += get(`curve.vU:${x}`) - VIRTUAL_USDC_0
  }
  check(`${what}: launchpad ${U} == pendingFees + Σ pendingCreatorFees + Σ pendingSnipe + Σ live curve floats`, get('usdc:launchpad'), owed)
  check(`${what}: the hook holds no ${U}`, get('usdc:hook'), 0n)
  const hookOwes = syms.reduce((sum, x) => sum + get(`hook.platform:${x}`) + get(`hook.creator:${x}`) + get(`hook.lockHeld:${x}`), 0n)
  check(`${what}: hook claims == Σ (pendingPlatform + pendingCreator + lockHeld)`, get('hook.claims'), hookOwes)
  check(`${what}: snipe fees never wait: lockHeld ≤ 2 units for every token`, syms.filter((x) => get(`hook.lockHeld:${x}`) > 2n).map((x) => `${x} ${get(`hook.lockHeld:${x}`)}`), [])
  check(`${what}: the hook holds no launch token`, syms.filter((x) => get(`tok.hook:${x}`) !== 0n), [])
  // V14-SPEC §5 and §11: every window bid starts from half the pool's reference, which starts at the graduation price
  // and only ever moves down.
  const refs = syms.flatMap((x) => {
    const k = KINDS.find((kk) => progress.tokens[kk] && sym(kk) === x)
    const rec = k ? progress.pools[k] : undefined
    return rec && s.has(`hook.bidRef:${x}`) ? [{ x, rec, ref: Number(get(`hook.bidRef:${x}`)) }] : []
  })
  check(`${what}: bidRefTick is at or under the graduation price`, refs.filter((r) => pricierTick(r.rec.usdcIs0, r.ref, r.rec.graduationTick)).map((r) => `${r.x} ${r.ref}`), [])
  if (s0) {
    const rose = refs.filter((r) => s0.has(`hook.bidRef:${r.x}`) && pricierTick(r.rec.usdcIs0, r.ref, Number(s0.get(`hook.bidRef:${r.x}`))))
    check(`${what}: bidRefTick never rises`, rose.map((r) => `${r.x} ${s0.get(`hook.bidRef:${r.x}`)} → ${r.ref}`), [])
  }
  if (s0) {
    const grew = syms.filter((x) => s0.has(`tok.supply:${x}`) && get(`tok.supply:${x}`) > (s0.get(`tok.supply:${x}`) ?? 0n))
    check(`${what}: no token's supply grew`, grew, [])
  }
  const holders = [...s.keys()].filter((k) => k.startsWith('tok.') && !k.startsWith('tok.supply') && !k.startsWith('tok.distributed') && !k.startsWith('tok.claimed'))
  const unaccounted = syms.map((x) => get(`tok.supply:${x}`) - holders.filter((k) => k.endsWith(`:${x}`)).reduce((sum, k) => sum + get(k), 0n))
  check(`${what}: every token's supply sits with the tracked holders`, unaccounted, syms.map(() => 0n))
}

/** The actor's side of the transactions it sent in one block, on its native balance with their gas added back: 0 on
 *  rUSDC (gas only); on Arc's USDC the native balance is the USDC balance, so it moves by `usdc` too. Skipped if the
 *  actor sent anything else in that block. */
async function gasSide(what: string, receipts: TransactionReceipt[], usdc: bigint) {
  const B = receipts[0].blockNumber
  const gas = receipts.reduce((sum, r) => sum + r.gasUsed * r.effectiveGasPrice, 0n)
  const sentInBlock = (await nonceOf(me, B)) - (await nonceOf(me, B - 1n))
  if (sentInBlock !== receipts.length) {
    note(`${what}: ${sentInBlock} actor transactions in block ${B}, ${receipts.length} checked here; native-balance check skipped`)
    return
  }
  const moved = (await nativeOf(me, B)) - (await nativeOf(me, B - 1n)) + gas
  check(`${what}: actor's native balance, gas added back${receipts.length > 1 ? ` (its ${receipts.length} transactions in the block)` : ''}`, moved, REAL ? usdc * WEI_PER_UNIT : 0n)
}

/** One block's books: the tracked quantities move exactly as `expected` (the sum over every transaction of this run
 *  in the block), the invariants hold, the gas adds up. */
async function booksBlock(what: string, receipts: TransactionReceipt[], expected: Moves) {
  const B = receipts[0].blockNumber
  if (receipts.some((r) => r.blockNumber !== B)) throw new Error(`${what}: books across blocks`)
  const s0 = await snapshot(B - 1n)
  const s1 = await snapshot(B)
  const actorUsdc = expected['usdc:burner'] ?? 0n
  const tracked = { ...expected }
  if (REAL) delete tracked['usdc:burner']
  moves(what, s0, s1, tracked)
  invariants(what, s1, s0)
  await gasSide(what, receipts, actorUsdc)
  return { s0, s1 }
}
/** One transaction's books, alone in its block. */
const books = (what: string, receipt: TransactionReceipt, expected: Moves) => booksBlock(what, [receipt], expected)

// ── Pools: the model's positions, checked against StateView ───────────────────

const poolRec = (k: Kind): PoolRec => {
  const p = progress.pools[k]
  if (!p) throw new Error(`${k} has no pool yet`)
  return p
}
function recordChange(k: Kind, c: Omit<PosChange, 'id'> & { id: string }) {
  const rec = poolRec(k)
  rec.changes = rec.changes.filter((x) => x.id !== c.id).concat(c)
  snapCache.clear()
  save()
}
interface Position {
  owner: Address
  lower: number
  upper: number
  salt: Hex
  liquidity: bigint
}
function positionsAt(k: Kind, b: bigint): Position[] {
  const m = new Map<string, Position>()
  for (const c of poolRec(k).changes) {
    if (BigInt(c.block) > b) continue
    const key = `${c.owner}|${c.lower}|${c.upper}|${c.salt}`
    const p = m.get(key) ?? { owner: c.owner, lower: c.lower, upper: c.upper, salt: c.salt, liquidity: 0n }
    p.liquidity += BigInt(c.delta)
    m.set(key, p)
  }
  return [...m.values()].filter((p) => p.liquidity !== 0n)
}
/** The pool at block `b`: price, tick and active liquidity from StateView, ticks from the model's own positions. The
 *  positions, the active liquidity, every tick and both fees are checked against the chain. */
async function poolAt(what: string, k: Kind, b: bigint): Promise<V4.PoolModel> {
  const rec = poolRec(k)
  const pos = positionsAt(k, b)
  const pool: V4.PoolModel = { sqrtPrice: 0n, tick: 0, liquidity: 0n, spacing: TICK_SPACING, ticks: new Map() }
  for (const p of pos) {
    for (const [t, net] of [[p.lower, p.liquidity], [p.upper, -p.liquidity]] as const) {
      const s = pool.ticks.get(t) ?? { gross: 0n, net: 0n }
      pool.ticks.set(t, { gross: s.gross + p.liquidity, net: s.net + net })
    }
  }
  const tickList = [...pool.ticks.keys()].sort((a, b2) => a - b2)
  const reads: Read[] = [
    { key: 'slot0', to: STATE_VIEW, abi: ABI.stateView, fn: 'getSlot0', args: [rec.poolId] },
    { key: 'liquidity', to: STATE_VIEW, abi: ABI.stateView, fn: 'getLiquidity', args: [rec.poolId] },
    ...tickList.map((t) => ({ key: `tick ${t}`, to: STATE_VIEW, abi: ABI.stateView, fn: 'getTickLiquidity', args: [rec.poolId, t] as const })),
    ...pos.map((p) => ({ key: `pos`, to: STATE_VIEW, abi: ABI.stateView, fn: 'getPositionInfo', args: [rec.poolId, p.owner, p.lower, p.upper, p.salt] as const })),
  ]
  const res = await multiread(reads, b)
  const [sqrtPrice, tick, protocolFee, lpFee] = res[0] as readonly [bigint, number, number, number]
  pool.sqrtPrice = sqrtPrice
  pool.tick = tick
  const active = pos.filter((p) => p.lower <= tick && tick < p.upper).reduce((s, p) => s + p.liquidity, 0n)
  pool.liquidity = res[1] as bigint
  const chainTicks = tickList.map((t, i) => {
    const [gross, net] = res[2 + i] as readonly [bigint, bigint]
    return { t, gross, net }
  })
  const chainPos = pos.map((p, i) => (res[2 + tickList.length + i] as readonly [bigint, bigint, bigint])[0])
  check(`${what}: pool model at block ${b} == chain (fees, active liquidity, ${tickList.length} ticks, ${pos.length} positions)`, {
    fees: [protocolFee, lpFee], active: pool.liquidity, ticks: chainTicks, positions: chainPos,
  }, {
    fees: [0, 0], active, ticks: tickList.map((t) => ({ t, gross: pool.ticks.get(t)?.gross, net: pool.ticks.get(t)?.net })), positions: pos.map((p) => p.liquidity),
  })
  return pool
}
const poolKeyOf = (token: Address) => {
  const [c0, c1] = BigInt(USDC) < BigInt(token) ? [USDC, token] : [token, USDC]
  return { currency0: c0, currency1: c1, fee: 0, tickSpacing: TICK_SPACING, hooks: HOOK }
}
const poolIdOf = (token: Address) => {
  const k = poolKeyOf(token)
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]))
}
const LIMIT = (zeroForOne: boolean) => (zeroForOne ? V4.MIN_SQRT_PRICE + 1n : V4.MAX_SQRT_PRICE - 1n)

type Side = 'buy' | 'sell'
interface PoolTradeModel {
  isBuy: boolean
  /** gross USDC: what the pool took on a buy (fees on top), or paid out on a sell (fees taken from it) */
  gross: bigint
  fees: Fees
  tokenAmount: bigint
  /** what the trader paid (buy: USDC, sell: tokens) and received (buy: tokens, sell: USDC) */
  paid: bigint
  received: bigint
  swap: V4.SwapResult
  snipeBps: bigint
}
/** V14-SPEC §3 on top of Uniswap's pool math: the hook's fees and the pool's swap for one trade in `pool` (updated). */
function modelPoolTrade(pool: V4.PoolModel, usdcIs0: boolean, creatorBps: bigint, snipeBps: bigint, side: Side, exact: 'in' | 'out', amount: bigint): PoolTradeModel {
  const isBuy = side === 'buy'
  const zeroForOne = isBuy === usdcIs0
  const usdcOf = (r: V4.SwapResult) => (usdcIs0 ? r.amount0 : r.amount1)
  const tokOf = (r: V4.SwapResult) => (usdcIs0 ? r.amount1 : r.amount0)
  if (isBuy && exact === 'in') {
    const fees = feesOnGross(amount, creatorBps, snipeBps)
    const swap = V4.swap(pool, zeroForOne, -(amount - fees.total), LIMIT(zeroForOne))
    if (-usdcOf(swap) !== amount - fees.total) throw new Error('model: PartialFill')
    return { isBuy, gross: amount, fees, tokenAmount: tokOf(swap), paid: amount, received: tokOf(swap), swap, snipeBps }
  }
  if (!isBuy && exact === 'in') {
    const swap = V4.swap(pool, zeroForOne, -amount, LIMIT(zeroForOne))
    const gross = usdcOf(swap)
    const fees = feesOnGross(gross, creatorBps, 0n)
    return { isBuy, gross, fees, tokenAmount: amount, paid: amount, received: gross - fees.platform - fees.creator, swap, snipeBps: 0n }
  }
  if (isBuy) {
    const swap = V4.swap(pool, zeroForOne, amount, LIMIT(zeroForOne))
    const net = -usdcOf(swap)
    const fees = feesOnNet(net, creatorBps, snipeBps)
    return { isBuy, gross: net + fees.total, fees, tokenAmount: tokOf(swap), paid: net + fees.total, received: tokOf(swap), swap, snipeBps }
  }
  const fees = feesOnNet(amount, creatorBps, 0n)
  const swap = V4.swap(pool, zeroForOne, amount + fees.total, LIMIT(zeroForOne))
  if (usdcOf(swap) !== amount + fees.total) throw new Error('model: PartialFill')
  return { isBuy, gross: amount + fees.total, fees, tokenAmount: -tokOf(swap), paid: -tokOf(swap), received: amount, swap, snipeBps: 0n }
}

/** What a window buy reads and writes besides the pool: the hook's rounding held for the token (lockHeld), its bid
 *  count (the next bid's salt) and the pool's reference (bidRefTick). */
interface PoolState {
  pool: V4.PoolModel
  held: bigint
  bids: bigint
  bidRef: number
}
interface TradeStep {
  m: PoolTradeModel
  before: { sqrtPrice: bigint; tick: number; liquidity: bigint }
  /** the reference the trade's bid is placed from (for a trade that places none, the pool's reference, unchanged) */
  ref: number
  bid?: BidModel
  post: PoolState
}
/** One pool trade on a copy of `pre` (V14-SPEC §3 and §5): the hook's fees and Uniswap's swap, then, for a buy that pays
 *  a surcharge, the reference moving to the price just before the buy if that is cheaper, and the bid placed from half
 *  the reference with everything the hook holds. */
function modelTradeStep(pre: PoolState, usdcIs0: boolean, creatorBps: bigint, snipeBps: bigint, side: Side, exact: 'in' | 'out', amount: bigint): TradeStep {
  const pool = V4.clonePool(pre.pool)
  const before = { sqrtPrice: pool.sqrtPrice, tick: pool.tick, liquidity: pool.liquidity }
  const m = modelPoolTrade(pool, usdcIs0, creatorBps, snipeBps, side, exact, amount)
  const ref = m.fees.snipe > 0n ? cheaperOf(usdcIs0, before.tick, pre.bidRef) : pre.bidRef
  const bid = m.fees.snipe > 0n ? modelBid(pool, usdcIs0, ref, pre.held + m.fees.snipe) : undefined
  const held = pre.held + m.fees.snipe - (bid?.used ?? 0n)
  return { m, before, ref, bid, post: { pool, held, bids: pre.bids + (bid ? 1n : 0n), bidRef: ref } }
}

interface CheckedTrade extends PoolTradeModel {
  /** the pool's tick just before the trade */
  tickBefore: number
  /** the pool's reference (bidRefTick) just before the trade */
  refBefore: number
  /** the reference the trade's bid is placed from, and the pool's after it */
  refTick: number
  /** the bid the trade placed: a buy inside the pool's window turns its surcharge into one (V14-SPEC §5) */
  bid?: BidModel
  /** lockHeld after the trade: a unit or two of rounding at most */
  heldAfter: bigint
  /** the state after the trade, the next trade's in the same block */
  post: PoolState
}
/** Transactions of this run that landed in one block: their books are checked together, once, at the block's end. */
interface BlockGroup {
  block: bigint
  receipts: TransactionReceipt[]
  moves: Moves
  whats: string[]
}
interface TradeCtx {
  /** the state just before the trade when an earlier transaction of this run landed in the same block (B-1 is then
   *  before both): the model's state after that one, which its own events checked */
  pre?: PoolState
  /** set when several transactions of this run share the block: the books are added up for the block */
  group?: BlockGroup
  /** whether no later transaction of this run landed in the same block (the chain's state at B is this trade's) */
  lastInBlock?: boolean
}
/** The USDC a receipt moved into `who` (ERC-20 Transfer logs, in less out). */
const usdcInto = (r: TransactionReceipt, who: Address) =>
  eventsOf<{ from: Address; to: Address; value: bigint }>(r, USDC, ABI.erc20, 'Transfer').reduce((sum, t) => sum + (getAddress(t.to) === who ? t.value : 0n) - (getAddress(t.from) === who ? t.value : 0n), 0n)
/** Checks one pool trade (router or RawSwapper) at its block against the model: events, pool state, books. A buy inside
 *  the window must move the pool's reference down to the price just before it if that is cheaper (V14-SPEC §5), and
 *  place its surcharge (with the unit or two of rounding any earlier bid left) as a bid of its own: a fresh position at
 *  salt bidCount + 1, from half the reference (so never above half the graduation price, nor above half any price a
 *  window buy has started from), wholly on the USDC side of the price the buy leaves, paid by burning the claims,
 *  nothing but rounding left waiting. Any other trade places nothing and leaves the reference alone. */
async function checkPoolTrade(what: string, k: Kind, sent: Sent, side: Side, exact: 'in' | 'out', amount: bigint, trader: 'burner' | 'raw', ctx: TradeCtx = {}): Promise<CheckedTrade> {
  const { receipt } = sent
  const B = receipt.blockNumber
  const B0 = B - 1n
  const rec = poolRec(k)
  const s = sym(k)
  const token = tokenOf(k)
  const c = BigInt(rec.creatorBps)
  const bps = side === 'buy' ? snipeBpsAt(BigInt(rec.openBlock), B, c) : 0n
  if (side === 'buy') {
    check(`${what}: the surcharge is the window's at the block it landed in (${blocks(B - BigInt(rec.openBlock))} after graduation)`, await rd<bigint>(HOOK, ABI.hook, 'snipeBpsOf', [token], B), bps)
  }
  let pre = ctx.pre
  if (pre) note(`${what}: shares block ${B} with the trade before it, so it starts from the model's state after that one (held to that trade's events, and to the chain at the block's end)`)
  else {
    const launch = await rd<readonly [Hex, { bidRefTick: number }]>(HOOK, ABI.hook, 'launchOf', [token], B0)
    pre = {
      pool: await poolAt(what, k, B0),
      held: await rd<bigint>(HOOK, ABI.hook, 'lockHeld', [token], B0),
      bids: await rd<bigint>(HOOK, ABI.hook, 'bidCount', [token], B0),
      bidRef: launch[1].bidRefTick,
    }
  }
  const t = modelTradeStep(pre, rec.usdcIs0, c, bps, side, exact, amount)
  const { m, before, bid } = t
  const ref = t.ref
  const heldAfter = t.post.held
  const hookModifies = eventsOf<ModifyEvent>(receipt, POOL_MANAGER, ABI.pm, 'ModifyLiquidity').filter((e) => getAddress(e.sender) === HOOK)
  if (m.fees.snipe > 0n) {
    const from = ref === before.tick
      ? `the price just before the buy (tick ${before.tick})${ref !== pre.bidRef ? `, under the pool's reference (tick ${pre.bidRef}), which moves down to it` : ''}`
      : `the pool's reference (tick ${ref}${ref === rec.graduationTick ? ', the graduation price' : ''}): the price before the buy (tick ${before.tick}) was above it`
    if (ctx.lastInBlock ?? true) {
      const after = await rd<readonly [Hex, { bidRefTick: number }]>(HOOK, ABI.hook, 'launchOf', [token], B)
      check(`${what}: bidRefTick after the buy == its reference, the cheaper of the price before the buy and the reference before it (tick ${pre.bidRef})`, after[1].bidRefTick, ref)
    }
    if (bid) {
      const salt = pad(toHex(pre.bids + 1n), { size: 32 })
      const range = bidRange(rec.usdcIs0, ref)
      check(`${what}: BidLocked == model, its range from half ${from}`, eventsOf(receipt, HOOK, ABI.hook, 'BidLocked'), [{
        token, usdc: bid.used, liquidity: bid.liquidity, tickLower: range.lower, tickUpper: range.upper,
      }])
      const gradTop = rec.usdcIs0 ? bidRange(true, rec.graduationTick).lower : bidRange(false, rec.graduationTick).upper
      checkThat(`${what}: the bid's top is not above half the graduation price`, notAboveGraduationBid(rec.usdcIs0, rec.graduationTick, bid), `top at tick ${rec.usdcIs0 ? bid.lower : bid.upper}, half the graduation price at ${gradTop}`)
      checkThat(`${what}: the bid is wholly on the USDC side of the price the buy left`, usdcSide(rec.usdcIs0, bid, m.swap.tick), `tick ${m.swap.tick} after, bid [${bid.lower}, ${bid.upper}]`)
      check(`${what}: Uniswap ModifyLiquidity: a fresh position, salt ${pre.bids + 1n}`, hookModifies, [{ id: rec.poolId, sender: HOOK, tickLower: bid.lower, tickUpper: bid.upper, liquidityDelta: bid.liquidity, salt }])
      check(`${what}: the bid's position (owner the hook, salt ${pre.bids + 1n})`, await rd(STATE_VIEW, ABI.stateView, 'getPositionInfo', [rec.poolId, HOOK, bid.lower, bid.upper, salt], B), [bid.liquidity, 0n, 0n])
      check(`${what}: the fees became claims, then the bid burned what it took`, claimMoves(receipt), [m.fees.total, -bid.used])
      checkThat(`${what}: nothing waits: lockHeld after the buy ≤ 2 units`, heldAfter <= 2n, `${pre.held} + ${m.fees.snipe} surcharge - ${bid.used} placed = ${heldAfter}`)
      recordChange(k, { id: `${receipt.transactionHash}:bid`, owner: HOOK, lower: bid.lower, upper: bid.upper, salt, block: B.toString(), delta: bid.liquidity.toString() })
    } else {
      check(`${what}: a surcharge too small to buy any liquidity: no bid, it waits as rounding`, [eventsOf(receipt, HOOK, ABI.hook, 'BidLocked'), hookModifies], [[], []])
    }
  } else {
    check(`${what}: no surcharge, no bid, no position`, [eventsOf(receipt, HOOK, ABI.hook, 'BidLocked'), hookModifies], [[], []])
    check(`${what}: the fees became the hook's claims (ERC-6909 mint)`, claimMoves(receipt), [m.fees.total])
  }
  const sender = trader === 'raw' ? RAW() : ROUTER
  check(`${what}: PoolTrade == model`, eventsOf<PoolTradeEvent>(receipt, HOOK, ABI.hook, 'PoolTrade'), [{
    token, sender, isBuy: side === 'buy', usdcAmount: m.gross, tokenAmount: m.tokenAmount, platformFee: m.fees.platform, creatorFee: m.fees.creator, snipeFee: m.fees.snipe,
  }])
  check(`${what}: Uniswap Swap event == pool model (deltas, price, liquidity, tick, fee 0)`, eventsOf<SwapEvent>(receipt, POOL_MANAGER, ABI.pm, 'Swap'), [{
    id: rec.poolId, sender, amount0: m.swap.amount0, amount1: m.swap.amount1, sqrtPriceX96: m.swap.sqrtPrice, liquidity: m.swap.liquidity, tick: m.swap.tick, fee: 0,
  }])
  if (m.swap.crossed.length) note(`${what}: crossed ticks ${m.swap.crossed.join(', ')} in ${m.swap.steps} steps`)
  check(`${what}: the PoolManager's ${U} moved by the whole ${side === 'buy' ? 'buy (the bid only turned claims into liquidity)' : 'sell less the fees it keeps as claims'}`, usdcInto(receipt, POOL_MANAGER), side === 'buy' ? m.paid : -m.received)
  const holder = trader === 'raw' ? 'raw' : 'burner'
  const expected: Moves = {
    [`usdc:${holder}`]: side === 'buy' ? -m.paid : m.received,
    [`tok.${holder}:${s}`]: side === 'buy' ? m.received : -m.paid,
    'usdc:poolManager': side === 'buy' ? m.paid : -m.received,
    [`tok.poolManager:${s}`]: side === 'buy' ? -m.received : m.paid,
    [`hook.platform:${s}`]: m.fees.platform,
    [`hook.creator:${s}`]: m.fees.creator,
    [`hook.lockHeld:${s}`]: heldAfter - pre.held,
    [`hook.bids:${s}`]: bid ? 1n : 0n,
    [`hook.bidRef:${s}`]: BigInt(ref - pre.bidRef),
    'hook.claims': m.fees.total - (bid?.used ?? 0n),
    // A bid sits wholly on the USDC side of the price, so the price and the active liquidity are the swap's alone.
    [`pool.sqrtP:${s}`]: m.swap.sqrtPrice - before.sqrtPrice,
    [`pool.tick:${s}`]: BigInt(m.swap.tick - before.tick),
    [`pool.liquidity:${s}`]: m.swap.liquidity - before.liquidity,
  }
  if (ctx.group) {
    for (const [key, v] of Object.entries(expected)) ctx.group.moves[key] = (ctx.group.moves[key] ?? 0n) + v
    ctx.group.receipts.push(receipt)
    ctx.group.whats.push(what)
  } else {
    await books(what, receipt, expected)
  }
  return { ...m, tickBefore: before.tick, refBefore: pre.bidRef, refTick: ref, bid, heldAfter, post: t.post }
}

interface TradeItem {
  what: string
  sent: Sent
  side: Side
  exact: 'in' | 'out'
  amount: bigint
  trader: 'burner' | 'raw'
}
/** Checks trades sent back to back, in their nonce order. Those that landed alone in a block are checked as usual;
 *  where several landed in one block, each after the first starts from the model's state after the one before it (B-1
 *  is before them all), and their books are checked together at the block's end. */
async function checkTrades(k: Kind, items: TradeItem[]): Promise<CheckedTrade[]> {
  const out: CheckedTrade[] = []
  let group: BlockGroup | undefined
  for (const [i, it] of items.entries()) {
    const B = it.sent.receipt.blockNumber
    const prev = items[i - 1]
    const next = items[i + 1]
    const withPrev = prev !== undefined && prev.sent.receipt.blockNumber === B
    const withNext = next !== undefined && next.sent.receipt.blockNumber === B
    if (withPrev && it.sent.receipt.transactionIndex <= prev.sent.receipt.transactionIndex) throw new Error(`${it.what}: landed before ${prev.what} in block ${B}`)
    if (!withPrev && (withNext || group)) {
      if (group) await booksBlock(`block ${group.block}, its ${group.whats.length} window transactions`, group.receipts, group.moves)
      group = withNext ? { block: B, receipts: [], moves: {}, whats: [] } : undefined
    }
    out.push(await checkPoolTrade(it.what, k, it.sent, it.side, it.exact, it.amount, it.trader, { pre: withPrev ? out[i - 1].post : undefined, group, lastInBlock: !withNext }))
  }
  if (group) await booksBlock(`block ${group.block}, its ${group.whats.length} window transactions`, group.receipts, group.moves)
  return out
}

// ── Steps ─────────────────────────────────────────────────────────────────────

async function step(id: string, fn: () => Promise<void>, always = false) {
  if (progress.done[id] && !always) return
  console.log(`\n── ${id}`)
  const failuresBefore = failures
  const checksBefore = checks
  stepFailed = []
  await fn()
  const ok = failures === failuresBefore
  const result: StepResult = { step: id, ok, checks: checks - checksBefore, failed: stepFailed, at: new Date().toISOString() }
  progress.results = progress.results.filter((r) => r.step !== id).concat(result)
  if (ok && !always) progress.done[id] = result.at
  save()
  if (!ok) {
    console.log(`\nstep ${id}: ${stepFailed.length} check(s) failed. Stopping; a re-run re-checks it without re-sending its transactions.`)
    await summary()
    process.exit(1)
  }
}

const FEE_PLUGIN_ID = (() => {
  const a = parseInt(toFunctionSelector('onLaunch(address,address,bytes)').slice(2), 16)
  const b = parseInt(toFunctionSelector('onFees(address,uint256)').slice(2), 16)
  return `0x${((a ^ b) >>> 0).toString(16).padStart(8, '0')}` as const
})()

/** The runtime code at an address equals the local build, immutables and metadata hashes masked on both sides
 *  (scripts/verify-bytecode.ts). */
async function verifyBytecode(name: string, art: Artifact, address: Address) {
  const onchain = (await retry(() => pub.getCode({ address, blockNumber: head }))) ?? '0x'
  const strip = (hex: string) => hex.replace(/^0x/, '').toLowerCase()
  let local = strip(art.deployedBytecode.object)
  let remote = strip(onchain)
  if (local.length !== remote.length) return check(`bytecode: ${name} size`, `${remote.length / 2} bytes on chain`, `${local.length / 2} bytes local`)
  const mask = (hex: string, start: number, length: number) => hex.slice(0, start * 2) + '0'.repeat(length * 2) + hex.slice((start + length) * 2)
  let immutables = 0
  for (const refs of Object.values(art.deployedBytecode.immutableReferences ?? {})) {
    for (const { start, length } of refs) {
      local = mask(local, start, length)
      remote = mask(remote, start, length)
      immutables++
    }
  }
  const METADATA = /a264697066735822[0-9a-f]{68}64736f6c6343[0-9a-f]{6}0033/g
  const blank = (hex: string) => hex.replace(METADATA, (m) => m.slice(0, 16) + '0'.repeat(68) + m.slice(84))
  const sections = (local.match(METADATA) ?? []).length
  return checkThat(`bytecode: ${name} at ${address} equals the local build`, blank(local) === blank(remote), `${local.length / 2} bytes, ${immutables} immutable slots and ${sections} metadata hash(es) masked`)
}

/** Step 1: the deployment made by the Foundry script, read back: wiring, constants, the hook's address and salt, and
 *  every contract byte for byte against the local build. Read-only; also runs without a signer. */
async function deployment() {
  await step('deploy', async () => {
    const at = head
    const a = (x: unknown) => getAddress(x as string)
    console.log(`launchpad ${LP}, hook ${HOOK}, router ${ROUTER}, ${U} ${USDC}, chain ${chainId}, block ${at}`)
    const pmCode = await retry(() => pub.getCode({ address: POOL_MANAGER, blockNumber: at }))
    const fixture = readFileSync(resolve(ROOT, 'contracts-v14/test/fixtures/PoolManager.arc.hex'), 'utf8').trim()
    check("Uniswap's PoolManager: its code on this chain is the tests' fixture, byte for byte", keccak256(pmCode ?? '0x'), keccak256(fixture as Hex))
    check('PoolManager.protocolFeeController (none: no protocol fee on new pools)', a(await rd(POOL_MANAGER, ABI.pm, 'protocolFeeController', [], at)), zeroAddress)
    for (const [n, addr] of [['StateView', STATE_VIEW], ['CREATE2 deployer', CREATE2_DEPLOYER], ['Multicall3', MULTICALL3]] as const) {
      checkThat(`${n} has code`, ((await retry(() => pub.getCode({ address: addr, blockNumber: at }))) ?? '0x').length > 2, addr)
    }
    // Wiring.
    check('launchpad wiring', {
      usdc: a(await rd(LP, ABI.pad, 'usdc', [], at)), poolManager: a(await rd(LP, ABI.pad, 'poolManager', [], at)), hook: a(await rd(LP, ABI.pad, 'hook', [], at)),
      router: a(await rd(LP, ABI.pad, 'router', [], at)), pairFactory: a(await rd(LP, ABI.pad, 'pairFactory', [], at)), feeTo: a(await rd(LP, ABI.pad, 'feeTo', [], at)),
      feeToSetter: a(await rd(LP, ABI.pad, 'feeToSetter', [], at)), launchFee: await rd(LP, ABI.pad, 'launchFee', [], at),
    }, { usdc: USDC, poolManager: POOL_MANAGER, hook: HOOK, router: ROUTER, pairFactory: HOOK, feeTo: FEE_TO, feeToSetter: getAddress(dep.feeToSetter), launchFee: BigInt(dep.launchFee) })
    check('launchpad.isLaunchPair: PoolManager and hook yes, router no', [
      await rd(LP, ABI.pad, 'isLaunchPair', [POOL_MANAGER], at), await rd(LP, ABI.pad, 'isLaunchPair', [HOOK], at), await rd(LP, ABI.pad, 'isLaunchPair', [ROUTER], at),
    ], [true, true, false])
    check('hook wiring', { launchpad: a(await rd(HOOK, ABI.hook, 'launchpad', [], at)), usdc: a(await rd(HOOK, ABI.hook, 'usdc', [], at)), poolManager: a(await rd(HOOK, ABI.hook, 'poolManager', [], at)) }, { launchpad: LP, usdc: USDC, poolManager: POOL_MANAGER })
    check('router wiring', { launchpad: a(await rd(ROUTER, ABI.router, 'launchpad', [], at)), usdc: a(await rd(ROUTER, ABI.router, 'usdc', [], at)), poolManager: a(await rd(ROUTER, ABI.router, 'poolManager', [], at)) }, { launchpad: LP, usdc: USDC, poolManager: POOL_MANAGER })
    // Constants.
    const padConst = ['TOTAL_SUPPLY', 'CURVE_SUPPLY', 'POOL_SUPPLY', 'VIRTUAL_TOKENS_0', 'VIRTUAL_USDC_0', 'FEE_BPS', 'MAX_LAUNCH_FEE', 'MAX_CREATOR_FEE_BPS', 'SNIPE_BLOCKS', 'SNIPE_START_BPS', 'MAX_TOTAL_FEE_BPS']
    const padWant = [TOTAL_SUPPLY, CURVE_SUPPLY, POOL_SUPPLY, VIRTUAL_TOKENS_0, VIRTUAL_USDC_0, FEE_BPS, 100_000_000n, 1000n, SNIPE_BLOCKS, SNIPE_START_BPS, MAX_TOTAL_FEE_BPS]
    const padGot: bigint[] = []
    for (const n of padConst) padGot.push(await rd<bigint>(LP, ABI.pad, n, [], at))
    check(`launchpad constants (${padConst.join(', ')})`, padGot, padWant)
    const hookConst = ['LP_FEE', 'TICK_SPACING', 'FEE_BPS', 'SNIPE_BLOCKS', 'SNIPE_START_BPS', 'MAX_TOTAL_FEE_BPS', 'BID_DISCOUNT_TICKS', 'BID_SPAN_TICKS']
    const hookGot: string[] = []
    for (const n of hookConst) hookGot.push(String(await rd(HOOK, ABI.hook, n, [], at)))
    check(`hook constants (${hookConst.join(', ')})`, hookGot, ['0', String(TICK_SPACING), String(FEE_BPS), String(SNIPE_BLOCKS), String(SNIPE_START_BPS), String(MAX_TOTAL_FEE_BPS), String(BID_DISCOUNT_TICKS), String(BID_SPAN_TICKS)])
    // The hook's address: its low 14 bits are exactly its permissions, and it is CREATE2 of the recorded salt and init code.
    check("the hook address's low 14 bits (its permission flags)", `0x${(BigInt(HOOK) & 0x3fffn).toString(16)}`, `0x${HOOK_FLAGS.toString(16)}`)
    const perms = await rd<Record<string, boolean>>(HOOK, ABI.hook, 'getHookPermissions', [], at)
    check('getHookPermissions()', perms, {
      beforeInitialize: true, afterInitialize: false, beforeAddLiquidity: true, afterAddLiquidity: false, beforeRemoveLiquidity: false, afterRemoveLiquidity: false,
      beforeSwap: true, afterSwap: true, beforeDonate: true, afterDonate: false, beforeSwapReturnDelta: true, afterSwapReturnDelta: true,
      afterAddLiquidityReturnDelta: false, afterRemoveLiquidityReturnDelta: false,
    })
    const hookTx = await retry(() => pub.getTransaction({ hash: dep.txs.hook }))
    check('the hook was deployed through the deterministic CREATE2 deployer', getAddress(hookTx.to ?? zeroAddress), CREATE2_DEPLOYER)
    const salt = slice(hookTx.input, 0, 32)
    const initCode = slice(hookTx.input, 32)
    check('hook salt == the recorded salt', salt, dep.hookSalt)
    check('hook address == CREATE2(deployer, salt, keccak256(init code))', getContractAddress({ opcode: 'CREATE2', from: CREATE2_DEPLOYER, salt, bytecodeHash: keccak256(initCode) }), HOOK)
    const args = encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [POOL_MANAGER, LP, USDC])
    const METADATA = /a264697066735822[0-9a-f]{68}64736f6c6343[0-9a-f]{6}0033/g
    const blank = (hex: string) => hex.toLowerCase().replace(METADATA, (m) => m.slice(0, 16) + '0'.repeat(68) + m.slice(84))
    check("hook init code == the local build's creation code + (PoolManager, launchpad, USDC)", blank(initCode), blank(ART.hook.bytecode.object + args.slice(2)))
    // Plugins.
    for (const [n, addr, abi] of [['split', SPLIT, ABI.split], ['holders', HOLDERS, ABI.holders], ['combo', COMBO, ABI.combo]] as const) {
      check(`${n}: launchpad, usdc, IArchitexFeePlugin (${FEE_PLUGIN_ID}), IERC165, not 0xffffffff`, [
        a(await rd(addr, abi, 'launchpad', [], at)), a(await rd(addr, abi, 'usdc', [], at)), await rd(addr, abi, 'supportsInterface', [FEE_PLUGIN_ID], at),
        await rd(addr, abi, 'supportsInterface', ['0x01ffc9a7'], at), await rd(addr, abi, 'supportsInterface', ['0xffffffff'], at),
      ], [LP, USDC, true, true, false])
    }
    check('split.MAX_PAYEES, combo.MAX_ENTRIES, combo.TOTAL_BPS', [await rd(SPLIT, ABI.split, 'MAX_PAYEES', [], at), await rd(COMBO, ABI.combo, 'MAX_ENTRIES', [], at), await rd(COMBO, ABI.combo, 'TOTAL_BPS', [], at)], [20n, 5n, 10_000n])
    check(`${U}.decimals`, await rd(USDC, ABI.erc20, 'decimals', [], at), 6)
    if (!REAL) {
      check('rUSDC.symbol', await rd(USDC, ABI.erc20, 'symbol', [], at), 'rUSDC')
      // The actor mints, as the owner; on anvil another owner is impersonated for the mints instead.
      check(`rUSDC.owner is ${SIGNER === 'anvil' && RUSDC_OWNER !== me ? 'impersonated to mint' : 'the actor (it mints)'}`, a(await rd(USDC, ABI.erc20, 'owner', [], at)), SIGNER === 'anvil' ? RUSDC_OWNER : me)
    }
    // Byte for byte.
    for (const [n, art, addr] of [
      ['ArchitexLaunchpadV14', ART.pad, LP], ['ArchitexLaunchHook', ART.hook, HOOK], ['ArchitexV4Router', ART.router, ROUTER],
      ['SplitPlugin', ART.split, SPLIT], ['HolderDistributionPlugin', ART.holders, HOLDERS], ['ComboPlugin', ART.combo, COMBO],
    ] as const) await verifyBytecode(n, art, addr)
    // The deployer kept no power: the wiring is set once, and only feeToSetter touches the fee settings.
    const stranger = fixedAddress('stranger')
    await expectRevert('initialize again, by the deployer', LP, ABI.pad, 'initialize', [HOOK, ROUTER], 'AlreadyInitialized', at, getAddress(dep.deployer))
    await expectRevert('initialize by anyone else', LP, ABI.pad, 'initialize', [HOOK, ROUTER], 'Forbidden', at, stranger)
    await expectRevert('setFeeTo by a stranger', LP, ABI.pad, 'setFeeTo', [stranger], 'Forbidden', at, stranger)
    await expectRevert('hook.graduate by anyone but the launchpad', HOOK, ABI.hook, 'graduate', [LP, POOL_SUPPLY, 1n, 0n, false, 0], 'OnlyLaunchpad', at, stranger)
    await expectRevert('hook.release by anyone but the launchpad', HOOK, ABI.hook, 'release', [LP], 'OnlyLaunchpad', at, stranger)
    if (!progress.tokens[KINDS[0]]) check('no token launched yet', await rd(LP, ABI.pad, 'tokensLength', [], at), 0n)
  }, !DRIVING)
}

/** Deploys the test RawSwapper (contracts-v14/test/V14Base.sol) and checks its code against the local build. */
async function deployRaw() {
  await step('raw', async () => {
    let receipt: TransactionReceipt
    const what = 'deploy RawSwapper'
    const mined = minedTx('raw', what)
    if (mined) receipt = await retry(() => pub.getTransactionReceipt({ hash: mined.hash }))
    else receipt = await sendRaw('raw', what, undefined, encodeDeployData({ abi: ABI.raw, bytecode: ART.raw.bytecode.object, args: [POOL_MANAGER] }))
    if (!receipt.contractAddress) throw new Error('no contract address in the RawSwapper receipt')
    progress.raw = getAddress(receipt.contractAddress)
    progress.rawBlock = receipt.blockNumber.toString()
    LABELS.set(progress.raw, 'RawSwapper')
    snapCache.clear()
    save()
    note(`RawSwapper at ${progress.raw}`)
    check('RawSwapper.manager == the PoolManager', getAddress(await rd<string>(RAW(), ABI.raw, 'manager', [], receipt.blockNumber)), POOL_MANAGER)
    await verifyBytecode('RawSwapper', ART.raw, RAW())
    await books('deploy RawSwapper', receipt, {})
  })
}

async function fund() {
  await step('fund', async () => {
    for (const [who, whoLabel, amount] of [[me, 'burner', A.burnerMint], [RAW(), 'raw', A.rawUsdc]] as const) {
      const what = `mint ${fmt(amount)} rUSDC to the ${whoLabel}`
      const { receipt } = await tx('fund', what, USDC, ABI.erc20, 'mint', [who, amount], 0n, RUSDC_OWNER)
      const B = receipt.blockNumber
      check(`${what}: rUSDC supply`, (await rd<bigint>(USDC, ABI.erc20, 'totalSupply', [], B)) - (await rd<bigint>(USDC, ABI.erc20, 'totalSupply', [], B - 1n)), amount)
      await books(what, receipt, { [`usdc:${whoLabel}`]: amount })
    }
  })
}

async function approvals() {
  await step('approve', async () => {
    // rUSDC: unlimited, it has no value. Arc's USDC: what the curve trades need, no more.
    const want = REAL ? (A.windowBuy + A.curveBuy * 2n + BigInt(dep.launchFee)) * 2n : maxUint256
    const spenders: [string, Address][] = REAL ? [['launchpad', LP]] : [['launchpad', LP], ['router', ROUTER]]
    for (const [l, spender] of spenders) {
      const { receipt } = await tx('approve', `approve the ${l}`, USDC, ABI.erc20, 'approve', [spender, want])
      check(`approve the ${l}: allowance`, await rd<bigint>(USDC, ABI.erc20, 'allowance', [me, spender], receipt.blockNumber), want)
      await books(`approve the ${l}`, receipt, {})
    }
  })
}

/** Predicts every launch token's address (CREATE from the launchpad) before any exists, so the run knows which pools
 *  will have USDC as currency0 and which as currency1, and runs the exact-out and crash scenarios on one of each. */
async function plan() {
  await step('plan', async () => {
    const nonce = BigInt(await nonceOf(LP, head))
    const made = await rd<bigint>(LP, ABI.pad, 'tokensLength', [], head)
    check('launchpad nonce == 1 + tokens launched (EIP-161: contracts start at nonce 1)', nonce, 1n + made)
    for (const [i, k] of KINDS.entries()) {
      const address = getContractAddress({ from: LP, nonce: nonce + BigInt(i) - made })
      progress.planned[k] = { address, usdcIs0: BigInt(USDC) < BigInt(address) }
      note(`${sym(k)}: ${address}, USDC is currency${BigInt(USDC) < BigInt(address) ? '0' : '1'}`)
    }
    // The PoolManager's USDC before any of this suite's pools exist: the final solvency check counts from here.
    progress.notes.pmUsdcBaseline = (await rd<bigint>(USDC, ABI.erc20, 'balanceOf', [POOL_MANAGER], head)).toString()
    const hi = KINDS.find((k) => progress.planned[k]?.usdcIs0)
    const lo = KINDS.find((k) => progress.planned[k]?.usdcIs0 === false)
    progress.features = REAL ? [] : ([hi, lo].filter(Boolean) as Kind[])
    progress.openLp = KINDS.find((k) => spec(k).open)
    progress.closedLp = KINDS.find((k) => !spec(k).open)
    if (!REAL) {
      note(`exact-out and crash scenarios on ${progress.features.map(sym).join(' and ')}; outside liquidity accepted by ${sym(progress.openLp as Kind)}, refused by ${sym(progress.closedLp as Kind)}`)
      if (!hi || !lo) note(`every token sorts ${hi ? 'above' : 'below'} ${U}: only one pool orientation is covered (see --preview to pick a deploy nonce that covers both)`)
    }
    save()
  })
}

/** The launch, and right after it (before any check reads the chain, so they land inside the 20-block window) the
 *  curve buys that pay the surcharge. Then everything is checked at the blocks the transactions landed in. */
async function create(k: Kind, first: boolean) {
  const id = `create:${k}`
  await step(id, async () => {
    const s = spec(k)
    const predicted = progress.planned[k]?.address
    if (!predicted) throw new Error(`${k}: not planned`)
    const fee = BigInt(dep.launchFee)
    const created = await tx(id, `createToken ${s.symbol}`, LP, ABI.pad, 'createToken', [
      s.name, s.symbol, '', Number(s.feeBps), s.plugin, s.data, s.open, s.firstBuy,
      s.firstBuy > 0n ? modelCurveBuy(INITIAL_CURVE, s.firstBuy, s.feeBps, 0n).tokensOut : 0n, fee, // maxLaunchFee = launchFee
    ], fee + s.firstBuy)
    const window: Sent[] = []
    for (let i = 0; i < s.windowBuys; i++) {
      // The quote at the latest block is a floor: a later block pays a smaller surcharge.
      window.push(await tx(id, `buy ${s.symbol} in the curve's window (${i + 1})`, LP, ABI.pad, 'buy', async () => {
        const [out] = await simulate<readonly [bigint]>(LP, ABI.pad, 'quoteBuy', [predicted, A.windowBuy], head)
        return [predicted, A.windowBuy, out, me, await deadline()]
      }, A.windowBuy))
    }

    const { receipt, args } = created
    const B = receipt.blockNumber
    const e = eventsOf<{ token: Address; creator: Address; plugin: Address; openPool: boolean; creatorFeeBps: number; name: string; symbol: string; metadataURI: string }>(receipt, LP, ABI.pad, 'TokenCreated')
    check('TokenCreated emitted once', e.length, 1)
    const token = getAddress(e[0].token)
    check('the token landed at its predicted address (CREATE from the launchpad)', token, predicted)
    progress.tokens[k] = token
    progress.tokenBlocks[k] = B.toString()
    LABELS.set(token, s.symbol)
    snapCache.clear()
    save()
    note(`${s.symbol} = ${token}; USDC is currency${progress.planned[k]?.usdcIs0 ? '0' : '1'} of its pool`)
    check('TokenCreated', pick(e[0], ['creator', 'plugin', 'openPool', 'creatorFeeBps', 'name', 'symbol', 'metadataURI']), {
      creator: me, plugin: s.plugin, openPool: s.open, creatorFeeBps: Number(s.feeBps), name: s.name, symbol: s.symbol, metadataURI: '',
    })
    const firstBuy = args[7] as bigint
    const launchFee = args[9] as bigint
    const m = firstBuy > 0n ? modelCurveBuy(INITIAL_CURVE, firstBuy, s.feeBps, 0n) : undefined
    const c = await curveAt(token, B)
    check('curves(token): registration', pick(c, ['token', 'creator', 'createdAt', 'createdBlock', 'graduated', 'openPool', 'creatorFeeBps', 'pluginHooks', 'plugin', 'metadataURI', 'virtualUsdc', 'virtualTokens', 'tokensSold']), {
      token, creator: me, createdAt: await timeOf(B), createdBlock: B, graduated: false, openPool: s.open, creatorFeeBps: Number(s.feeBps), pluginHooks: s.hooks, plugin: s.plugin, metadataURI: '',
      virtualUsdc: VIRTUAL_USDC_0 + (m?.net ?? 0n), virtualTokens: VIRTUAL_TOKENS_0 - (m?.tokensOut ?? 0n), tokensSold: m?.tokensOut ?? 0n,
    })
    check('token wiring and supply', {
      launchpad: getAddress(await rd<string>(token, ABI.token, 'launchpad', [], B)), router: getAddress(await rd<string>(token, ABI.token, 'router', [], B)),
      poolManager: getAddress(await rd<string>(token, ABI.token, 'poolManager', [], B)), hook: getAddress(await rd<string>(token, ABI.token, 'hook', [], B)),
      usdc: getAddress(await rd<string>(token, ABI.token, 'usdc', [], B)), graduated: await rd<boolean>(token, ABI.token, 'graduated', [], B),
      totalSupply: await rd<bigint>(token, ABI.token, 'totalSupply', [], B), decimals: await rd<number>(token, ABI.token, 'decimals', [], B),
    }, { launchpad: LP, router: ROUTER, poolManager: POOL_MANAGER, hook: HOOK, usdc: USDC, graduated: false, totalSupply: TOTAL_SUPPLY, decimals: 18 })
    check('dividends exclude the launchpad, the PoolManager, the hook, 0x…dEaD and 0; not the actor', await Promise.all(
      [LP, POOL_MANAGER, HOOK, DEAD, zeroAddress, me].map((x) => rd<boolean>(token, ABI.token, 'isExcluded', [x], B)),
    ), [true, true, true, true, true, false])
    const key = await rd<{ currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }>(HOOK, ABI.hook, 'poolKeyOf', [token], B)
    check("hook.poolKeyOf(token) == the model's key (sorted, fee 0, spacing 200, the hook)", { ...key, currency0: getAddress(key.currency0), currency1: getAddress(key.currency1), hooks: getAddress(key.hooks) }, poolKeyOf(token))
    await expectRevert('hook.launchOf before graduation', HOOK, ABI.hook, 'launchOf', [token], 'UnknownLaunch', B)
    const room = MAX_TOTAL_FEE_BPS - FEE_BPS - s.feeBps
    check(`snipeBpsOf(token) in the creation block == min(9000, 9900 - 50 - creator fee = ${room})`, await rd<bigint>(LP, ABI.pad, 'snipeBpsOf', [token], B), snipeBpsAt(B, B, s.feeBps))
    check('pairOf(token) is nothing before graduation', getAddress(await rd<string>(LP, ABI.pad, 'pairOf', [token], B)), zeroAddress)
    const trades = eventsOf<TradeEvent>(receipt, LP, ABI.pad, 'Trade')
    check("the creator's first buy: one Trade, or none", trades.length, m ? 1 : 0)
    if (m) {
      check("the creator's first buy pays no surcharge though its block's is 90% (V14-SPEC §5): Trade == model", trades.map((t) => pick(t, ['trader', 'isBuy', 'usdcAmount', 'tokenAmount', 'platformFee', 'creatorFee', 'snipeFee', 'virtualUsdc', 'virtualTokens'])), [{
        trader: me, isBuy: true, usdcAmount: m.usdcSpent, tokenAmount: m.tokensOut, platformFee: m.platformFee, creatorFee: m.creatorFee, snipeFee: 0n,
        virtualUsdc: VIRTUAL_USDC_0 + m.net, virtualTokens: VIRTUAL_TOKENS_0 - m.tokensOut,
      }])
    }
    // Plugin configuration.
    if (k === 'split') {
      check('Split: payeesOf, totalShares', [await rd(SPLIT, ABI.split, 'payeesOf', [token], B), await rd(SPLIT, ABI.split, 'totalShares', [token], B)], [[PAYEES, SHARES], 10n])
    }
    if (k === 'combo') {
      check('Combo: allocationOf (Holders and Split are plugins, the wallet is not)', await rd(COMBO, ABI.combo, 'allocationOf', [token], B), [COMBO_TARGETS, COMBO_BPS, [true, true, false]])
      check('Combo configured its entries: Holders, and Split with its own payees', [
        await rd(HOLDERS, ABI.holders, 'isConfigured', [token], B), await rd(SPLIT, ABI.split, 'isConfigured', [token], B), await rd(SPLIT, ABI.split, 'payeesOf', [token], B),
      ], [true, true, [COMBO_PAYEES, COMBO_SHARES]])
    }
    if (s.hooks && s.plugin !== COMBO) check(`${k} plugin: isConfigured`, await rd(s.plugin, ABI.split, 'isConfigured', [token], B), true)
    if (s.hooks) await expectRevert(`${k} plugin: a second onLaunch (write-once)`, s.plugin, ABI.split, 'onLaunch', [token, me, s.data], 'AlreadyConfigured', B, LP)
    if (!s.hooks && !REAL) check(`${k}: the destination is a plain address (no code)`, (await retry(() => pub.getCode({ address: s.plugin }))) ?? '0x', '0x')
    const expected: Moves = {
      'usdc:launchpad': launchFee + (m?.usdcSpent ?? 0n), 'usdc:burner': -(launchFee + (m?.usdcSpent ?? 0n)), 'lp.pendingFees': launchFee + (m?.platformFee ?? 0n),
      [`lp.creator:${s.symbol}`]: m?.creatorFee ?? 0n, [`curve.vU:${s.symbol}`]: VIRTUAL_USDC_0 + (m?.net ?? 0n), [`curve.vT:${s.symbol}`]: VIRTUAL_TOKENS_0 - (m?.tokensOut ?? 0n),
      [`curve.sold:${s.symbol}`]: m?.tokensOut ?? 0n, [`tok.supply:${s.symbol}`]: TOTAL_SUPPLY, [`tok.launchpad:${s.symbol}`]: TOTAL_SUPPLY - (m?.tokensOut ?? 0n),
      [`tok.burner:${s.symbol}`]: m?.tokensOut ?? 0n,
    }
    await books(`create ${s.symbol}`, receipt, expected)
    if (first) await launchRefusals(token, B)

    // The window buys, each at the block it landed in (V14-SPEC §5): the surcharge is SNIPE_START_BPS × (end - block) / 20.
    let paid = 0
    for (const [i, w] of window.entries()) {
      const bps = await checkCurveBuy(`window buy ${i + 1}`, k, w)
      if (bps > 0n) paid++
    }
    if (window.length) {
      progress.notes[`${id}:windowPaid`] = String(paid)
      if (paid < window.length) note(`${paid} of ${window.length} window buys landed inside the window (the rest after it, surcharge 0)`)
    }
  })
}

/** createToken's refusals and the pre-graduation locks, simulated for free once, where the first token exists. */
async function launchRefusals(token: Address, B: bigint) {
  const s = spec(KINDS[0])
  const fee = BigInt(dep.launchFee)
  const launch = (plugin: Address, data: Hex, feeBps = 0, maxFee = fee, name = 'Refused') => [name, 'NO', '', feeBps, plugin, data, false, 0n, 0n, maxFee] as const
  if (fee > 0n) await expectRevert('createToken with maxLaunchFee below the fee', LP, ABI.pad, 'createToken', launch(s.plugin, s.data, Number(s.feeBps), fee - 1n), 'LaunchFeeAboveMax', B)
  await expectRevert('createToken at a 10.01% creator fee', LP, ABI.pad, 'createToken', launch(s.plugin, s.data, 1001), 'CreatorFeeTooHigh', B)
  await expectRevert('createToken with an empty name', LP, ABI.pad, 'createToken', launch(s.plugin, s.data, 0, fee, ''), 'InvalidName', B)
  const next = getContractAddress({ from: LP, nonce: BigInt(await nonceOf(LP, B)) })
  for (const [l, plugin] of [
    ['the zero address', zeroAddress], ['the launchpad', LP], [U, USDC], ['the router', ROUTER], ['the hook', HOOK], ['the PoolManager', POOL_MANAGER],
    ['an existing launch token', token], ['the new token itself (predicted address)', next],
  ] as const) await expectRevert(`createToken paying ${l}`, LP, ABI.pad, 'createToken', launch(plugin, '0x'), 'InvalidPlugin', B)
  await expectRevert('createToken with pluginData for a plain address', LP, ABI.pad, 'createToken', launch(fixedAddress('mistyped'), '0x01'), 'DataForNonPlugin', B)
  if (!REAL) {
    for (const [l, payee] of [['the PoolManager', POOL_MANAGER], ['the hook', HOOK]] as const) {
      await expectRevert(`a Split paying ${l}`, LP, ABI.pad, 'createToken', launch(SPLIT, splitData([payee], [1n])), 'InvalidRecipient', B)
    }
  }
  const key = poolKeyOf(token)
  await expectRevert('anyone initializing the token\'s pool first', POOL_MANAGER, ABI.pm, 'initialize', [key, V4.sqrtAtTick(0)], 'WrappedError(hook: PoolCreationRestricted)', B)
  await expectRevert('a transfer of the token into the PoolManager before graduation', token, ABI.token, 'transfer', [POOL_MANAGER, 0n], 'PoolLockedUntilGraduation', B, LP)
  await expectRevert('router.quoteBuy before graduation', ROUTER, ABI.router, 'quoteBuy', [token, usd(1)], 'NotGraduated', B)
  await expectRevert('hook.snipeBpsOf before graduation (no pool, no window)', HOOK, ABI.hook, 'snipeBpsOf', [token], 'UnknownLaunch', B)
  check('syncPoolFees for a live curve books nothing', await simulate(LP, ABI.pad, 'syncPoolFees', [token], B), [0n, 0n])
  await expectRevert('a curve buy past its deadline', LP, ABI.pad, 'buy', [token, usd(1), 0n, me, (await timeOf(B)) - 1n], 'Expired', B)
  await expectRevert('accrueTradeFees (the v1.3 push path, gone)', LP, ABI.pad, 'accrueTradeFees', [token, 1n, 1n], 'Forbidden', B, HOOK)
}

/** A curve buy, at the block it landed in: the surcharge from createdBlock and that block, the Trade event, the quote at
 *  the block before (with its own block's surcharge), pendingSnipe and the books. Returns the surcharge in bps. */
async function checkCurveBuy(what: string, k: Kind, sent: Sent): Promise<bigint> {
  const s = spec(k)
  const { receipt, args } = sent
  const B = receipt.blockNumber
  const B0 = B - 1n
  const token = tokenOf(k)
  const usdcIn = args[1] as bigint
  const c0 = await curveAt(token, B0)
  const bps = snipeBpsAt(c0.createdBlock, B, s.feeBps)
  const m = modelCurveBuy(c0, usdcIn, s.feeBps, bps)
  check(`${what}: landed ${blocks(B - c0.createdBlock)} after the launch, surcharge ${bps} bps: snipeBpsOf at that block`, await rd<bigint>(LP, ABI.pad, 'snipeBpsOf', [token], B), bps)
  const bps0 = snipeBpsAt(c0.createdBlock, B0, s.feeBps)
  const [qOut, qPlat, qCreator, qSnipe, qSpent, qGrad] = await rd<readonly [bigint, bigint, bigint, bigint, bigint, boolean]>(LP, ABI.pad, 'quoteBuy', [token, usdcIn], B0)
  const q0 = modelCurveBuy(c0, usdcIn, s.feeBps, bps0)
  check(`${what}: quoteBuy at the block before (surcharge ${bps0} bps) == model`, { qOut, qPlat, qCreator, qSnipe, qSpent, qGrad }, {
    qOut: q0.tokensOut, qPlat: q0.platformFee, qCreator: q0.creatorFee, qSnipe: q0.snipeFee, qSpent: q0.usdcSpent, qGrad: q0.graduates,
  })
  check(`${what}: fees are ceil(usdcIn × 50, × creator, × ${bps} / 1e4)`, [m.platformFee, m.creatorFee, m.snipeFee], [divCeil(usdcIn * FEE_BPS, BPS), divCeil(usdcIn * s.feeBps, BPS), divCeil(usdcIn * bps, BPS)])
  check(`${what}: Trade == model`, eventsOf<TradeEvent>(receipt, LP, ABI.pad, 'Trade').map((t) => pick(t, ['trader', 'isBuy', 'usdcAmount', 'tokenAmount', 'platformFee', 'creatorFee', 'snipeFee', 'virtualUsdc', 'virtualTokens'])), [{
    trader: me, isBuy: true, usdcAmount: m.usdcSpent, tokenAmount: m.tokensOut, platformFee: m.platformFee, creatorFee: m.creatorFee, snipeFee: m.snipeFee,
    virtualUsdc: c0.virtualUsdc + m.net, virtualTokens: c0.virtualTokens - m.tokensOut,
  }])
  const x = s.symbol
  await books(what, receipt, {
    'usdc:launchpad': m.usdcSpent, 'usdc:burner': -m.usdcSpent, 'lp.pendingFees': m.platformFee, [`lp.creator:${x}`]: m.creatorFee, [`lp.snipe:${x}`]: m.snipeFee,
    [`curve.vU:${x}`]: m.net, [`curve.vT:${x}`]: -m.tokensOut, [`curve.sold:${x}`]: m.tokensOut, [`tok.launchpad:${x}`]: -m.tokensOut, [`tok.burner:${x}`]: m.tokensOut,
  })
  return bps
}

/** After the curve's window: a buy (quote == fill) and a sell of half of it. */
async function curveTrades(k: Kind, first: boolean) {
  const id = `curve:${k}`
  await step(id, async () => {
    const s = spec(k)
    const token = tokenOf(k)
    await waitForBlock(BigInt(progress.tokenBlocks[k] as string) + SNIPE_BLOCKS)
    const buy = await tx(id, `buy ${s.symbol} on the curve, after its window`, LP, ABI.pad, 'buy', async () => {
      const [out] = await simulate<readonly [bigint]>(LP, ABI.pad, 'quoteBuy', [token, A.curveBuy], head)
      return [token, A.curveBuy, out, me, await deadline()]
    }, A.curveBuy)
    const B = buy.receipt.blockNumber
    const bps = await checkCurveBuy('curve buy', k, buy)
    check('the window is over: no surcharge', bps, 0n)
    const [q] = await rd<readonly [bigint]>(LP, ABI.pad, 'quoteBuy', [token, buy.args[1]], B - 1n)
    const got = eventsOf<TradeEvent>(buy.receipt, LP, ABI.pad, 'Trade')[0]?.tokenAmount ?? 0n
    check('quote at the block before == fill', got, q)
    const [back] = await rd<readonly [bigint]>(LP, ABI.pad, 'quoteSell', [token, got], B)
    checkThat('selling it straight back returns less than was paid (V13-SPEC §6.4)', back < (buy.args[1] as bigint), `${fmt(back)} < ${fmt(buy.args[1] as bigint)}`)

    const sell = await tx(id, `sell ${s.symbol} on the curve (half)`, LP, ABI.pad, 'sell', async () => {
      const half = got / 2n
      const [out] = await simulate<readonly [bigint]>(LP, ABI.pad, 'quoteSell', [token, half], head)
      return [token, half, out, me, await deadline()]
    })
    const S = sell.receipt.blockNumber
    const tokensIn = sell.args[1] as bigint
    const c0 = await curveAt(token, S - 1n)
    const m = modelCurveSell(c0, tokensIn, s.feeBps)
    const [usdcOut, platformFee, creatorFee] = await rd<readonly [bigint, bigint, bigint]>(LP, ABI.pad, 'quoteSell', [token, tokensIn], S - 1n)
    check('quoteSell == model (both fees on the gross, rounded up)', { usdcOut, platformFee, creatorFee }, pick(m, ['usdcOut', 'platformFee', 'creatorFee']))
    check('Trade == model (usdcAmount is gross; sells pay no surcharge)', eventsOf<TradeEvent>(sell.receipt, LP, ABI.pad, 'Trade').map((t) => pick(t, ['trader', 'isBuy', 'usdcAmount', 'tokenAmount', 'platformFee', 'creatorFee', 'snipeFee', 'virtualUsdc', 'virtualTokens'])), [{
      trader: me, isBuy: false, usdcAmount: m.gross, tokenAmount: tokensIn, platformFee: m.platformFee, creatorFee: m.creatorFee, snipeFee: 0n,
      virtualUsdc: c0.virtualUsdc - m.gross, virtualTokens: c0.virtualTokens + tokensIn,
    }])
    const x = s.symbol
    await books('curve sell', sell.receipt, {
      'usdc:launchpad': -m.usdcOut, 'usdc:burner': m.usdcOut, 'lp.pendingFees': m.platformFee, [`lp.creator:${x}`]: m.creatorFee,
      [`curve.vU:${x}`]: -m.gross, [`curve.vT:${x}`]: tokensIn, [`curve.sold:${x}`]: -tokensIn, [`tok.launchpad:${x}`]: tokensIn, [`tok.burner:${x}`]: -tokensIn,
    })
    if (first) {
      await expectRevert('a curve sell past its deadline', LP, ABI.pad, 'sell', [token, E18, 0n, me, (await timeOf(S)) - 1n], 'Expired', S)
      await expectRevert('a curve sell of more than the curve sold', LP, ABI.pad, 'sell', [token, c0.tokensSold + 1n, 0n, me, (await timeOf(S)) + 3600n], 'ExceedsSold', S)
      await expectRevert('a curve buy with minTokensOut above the quote', LP, ABI.pad, 'buy', [token, usd(1), E18 * 10n ** 12n, me, (await timeOf(S)) + 3600n], 'SlippageExceeded', S)
    }
  })
}

interface WindowTrade {
  name: string
  side: Side
  exact: 'in' | 'out'
  amount: bigint
  trader: 'burner' | 'raw'
  /** a dump: sent with no minimum out */
  noMin?: boolean
}
/** A batch of window trades modelled as landing together in block `b`, from `start`. */
function runBatch(start: PoolState, rec: { usdcIs0: boolean; creatorBps: bigint; openBlock: bigint }, trades: WindowTrade[], b: bigint): TradeStep[] {
  let st = start
  return trades.map((t) => {
    const bps = t.side === 'buy' ? snipeBpsAt(rec.openBlock, b, rec.creatorBps) : 0n
    const r = modelTradeStep(st, rec.usdcIs0, rec.creatorBps, bps, t.side, t.exact, t.amount)
    st = r.post
    return r
  })
}
/** The least each trade of a batch sent now can receive, whichever blocks it lands in: the batch is modelled landing
 *  whole in each block from `from` to the window's end, and the lowest fill is kept. A later block lowers a buy's own
 *  surcharge (more tokens) but also puts more of every earlier buy into the pool (fewer), so these bound any split. */
function batchFloors(start: PoolState, rec: { usdcIs0: boolean; creatorBps: bigint; openBlock: bigint }, trades: WindowTrade[], from: bigint): bigint[] {
  const floors = trades.map(() => -1n)
  const last = maxOf(from, rec.openBlock + SNIPE_BLOCKS)
  for (let b = from; b <= last; b++) {
    runBatch(start, rec, trades, b).forEach((r, i) => {
      if (floors[i] < 0n || r.m.received < floors[i]) floors[i] = r.m.received
    })
  }
  return floors
}
/** The pool the sell-out buy just opened, as the model has it (checkGraduation holds it to the chain afterwards), so
 *  the window's transactions can be planned before any check reads the chain. */
async function openedPool(k: Kind, sellOut: Sent): Promise<{ state: PoolState; gradTick: number }> {
  const token = tokenOf(k)
  const s = spec(k)
  const B = sellOut.receipt.blockNumber
  const c0 = await curveAt(token, B - 1n)
  const m = modelCurveBuy(c0, sellOut.args[1] as bigint, s.feeBps, snipeBpsAt(c0.createdBlock, B, s.feeBps))
  const snipeBefore = await rd<bigint>(LP, ABI.pad, 'pendingSnipe', [token], B - 1n)
  const g = modelGraduation(BigInt(USDC) < BigInt(token), c0.virtualUsdc + m.net - VIRTUAL_USDC_0, snipeBefore + m.snipeFee)
  return { state: { pool: g.pool, held: g.toLock - (g.bid?.used ?? 0n), bids: g.bid ? 1n : 0n, bidRef: g.tick }, gradTick: g.tick }
}

/** The sell-out buy (graduation, V14-SPEC §4), then the pool's 20-block window, planned from the model and sent back to
 *  back (no receipt awaited in between, so the window's cases land in time whatever the RPC's latency), each buy with
 *  the lowest fill it can get as its minimum:
 *  - every token: a buy from the graduation price (its bid lands on the graduation bid's range) big enough to lift the
 *    price at least a tick spacing, then a buy from above the graduation price, whose bid still starts from half the
 *    graduation price, the pool's reference (V14-SPEC §5, Claude review #9's L1);
 *  - the scenario tokens (one per pool orientation): a dump of 150M tokens under half the graduation price and a buy
 *    whose bid follows the price down, the crashed price becoming the pool's reference; then, in a second batch sized
 *    from the first, a buy that lifts the price back above the graduation price and one more buy, whose bids must both
 *    still start from half the crashed price (review #9's residual), a sell, and an exact-out buy through the
 *    RawSwapper (the surcharge on a net amount);
 *  - the other tokens: a sell (no surcharge, no bid).
 *  Everything is then checked in order, at the blocks the transactions landed in. */
async function graduate(k: Kind, first: boolean) {
  const id = `graduate:${k}`
  await step(id, async () => {
    const s = spec(k)
    const token = tokenOf(k)
    const feature = progress.features.includes(k)
    await waitForBlock(BigInt(progress.tokenBlocks[k] as string) + SNIPE_BLOCKS)
    const sellOut = await tx(id, `buy ${s.symbol} out (graduation)`, LP, ABI.pad, 'buy', async () => {
      const [out, , , , spent, grad] = await simulate<readonly [bigint, bigint, bigint, bigint, bigint, boolean]>(LP, ABI.pad, 'quoteBuy', [token, A.graduateOffer], head)
      if (!grad) throw new Error(`${s.symbol}: ${fmt(A.graduateOffer)} would not sell out the curve`)
      note(`the sell-out buy will pull ${fmt(spent)} rUSDC`)
      return [token, A.graduateOffer, out, me, await deadline()]
    }, A.graduateOffer)

    // Plan from the model; the checks below hold every step of it to the chain.
    const [opened, dl] = await Promise.all([openedPool(k, sellOut), deadline()])
    const usdcIs0 = BigInt(USDC) < BigInt(token)
    const prec = { usdcIs0, creatorBps: s.feeBps, openBlock: sellOut.receipt.blockNumber }
    const gradTick = opened.gradTick
    const buy = (name: string, amount: bigint): WindowTrade => ({ name, side: 'buy', exact: 'in', amount, trader: 'burner' })
    const sell = (name: string, amount: bigint, noMin = false): WindowTrade => ({ name, side: 'sell', exact: 'in', amount, trader: 'burner', noMin })
    const names = {
      lift: `buy ${s.symbol} in the pool's window (router)`,
      capped: `buy ${s.symbol} again in the pool's window, above the graduation price (router)`,
      dump: `dump ${fmt18(A.dump)} ${s.symbol} under half the graduation price (router)`,
      crash: `buy ${s.symbol} in the pool's window after the crash (router)`,
      back: `buy ${s.symbol} back above the graduation price in the window (router)`,
      after: `buy ${s.symbol} in the window after that lift (router)`,
      sell: `sell ${s.symbol} in the pool's window (router)`,
      rawOut: `exact-out buy of ${fmt18(A.rawWindowOutBuy)} ${s.symbol} in the window (RawSwapper)`,
    }
    /** The state after the trades this step already mined (an earlier run), and the trades still to send. */
    const minedPrefix = async (st: PoolState, trades: WindowTrade[]) => {
      let i = 0
      for (; i < trades.length; i++) {
        const t = minedTx(id, trades[i].name)
        if (!t) break
        const input = (await retry(() => pub.getTransaction({ hash: t.hash }))).input
        const amount = trades[i].trader === 'raw' ? trades[i].amount : ((decodeFunctionData({ abi: ABI.router, data: input }).args ?? [])[1] as bigint)
        trades[i] = { ...trades[i], amount }
        st = runBatch(st, prec, [trades[i]], BigInt(t.block))[0].post
      }
      return { st, from: i }
    }
    const plan = (st: PoolState, trades: WindowTrade[], from: number): Planned[] => {
      // From the latest block itself: the batch lands later, but its first transaction is simulated there.
      const floors = batchFloors(st, prec, trades.slice(from), head)
      return trades.map((t, i) => {
        const minOut = i < from || t.noMin ? 0n : (floors[i - from] * 95n) / 100n
        if (t.trader === 'raw') {
          return { what: t.name, to: RAW(), abi: ABI.raw, fn: 'swap', args: [poolKeyOf(token), { zeroForOne: usdcIs0, amountSpecified: t.amount, sqrtPriceLimitX96: LIMIT(usdcIs0) }] }
        }
        return { what: t.name, to: ROUTER, abi: ABI.router, fn: t.side, args: [token, t.amount, minOut, me, dl], estimateArgs: [token, t.amount, 0n, me, dl] }
      })
    }
    const p1: WindowTrade[] = [
      buy(names.lift, A.poolWindowLift),
      buy(names.capped, A.poolWindowBuy),
      ...(feature ? [sell(names.dump, A.dump, true), buy(names.crash, A.poolWindowBuy)] : [sell(names.sell, A.poolWindowSell)]),
    ]
    const m1 = await minedPrefix(opened.state, p1)
    const sent1 = await sendBatch(id, plan(m1.st, p1, m1.from))
    let p2: WindowTrade[] = []
    let sent2: Sent[] = []
    if (feature) {
      // The lift back: sized from the first batch as it landed, for the highest surcharge it can still pay (the next
      // block's), so it reaches at least 400 ticks above the graduation price wherever it lands.
      let st = opened.state
      sent1.forEach((x, i) => {
        st = runBatch(st, prec, [{ ...p1[i], amount: p1[i].trader === 'raw' ? p1[i].amount : (x.args[1] as bigint) }], x.receipt.blockNumber)[0].post
      })
      p2 = [buy(names.back, 0n), buy(names.after, A.poolWindowBuy), sell(names.sell, A.poolWindowSell), { name: names.rawOut, side: 'buy', exact: 'out', amount: A.rawWindowOutBuy, trader: 'raw' }]
      const m2 = await minedPrefix(st, p2)
      if (m2.from === 0) {
        const target = usdcIs0 ? gradTick - 400 : gradTick + 400
        const reaches = (x: bigint) => {
          try {
            const r = runBatch(st, prec, [buy(names.back, x)], head + 1n)[0]
            return usdcIs0 ? r.post.pool.tick <= target : r.post.pool.tick >= target
          } catch {
            return false
          }
        }
        const balance = await rd<bigint>(USDC, ABI.erc20, 'balanceOf', [me], head)
        const ceiling = balance - A.poolWindowBuy - usd(1)
        if (!reaches(ceiling)) throw new Error(`${s.symbol}: ${fmt(ceiling)} rUSDC cannot lift the price back above graduation`)
        let lo = 0n
        let hi = ceiling
        while (hi - lo > usd(1)) {
          const mid = (lo + hi) / 2n
          if (reaches(mid)) hi = mid
          else lo = mid
        }
        p2[0] = buy(names.back, divCeil(hi, usd(1)) * usd(1))
        note(`the lift back above the graduation price: ${fmt(p2[0].amount)} rUSDC, for the surcharge of block ${head + 1n} (${snipeBpsAt(prec.openBlock, head + 1n, prec.creatorBps)} bps)`)
      }
      sent2 = await sendBatch(id, plan(m2.st, p2, m2.from))
    }

    // The checks, in order.
    await checkGraduation(k, sellOut, first)
    const rec = poolRec(k)
    const trades = [...p1, ...p2]
    const sents = [...sent1, ...sent2]
    const items: TradeItem[] = trades.map((t, i) => ({
      what: t.name, sent: sents[i], side: t.side, exact: t.exact, trader: t.trader,
      amount: t.trader === 'raw' ? t.amount : (sents[i].args[1] as bigint),
    }))
    const landed = sents.map((x) => x.receipt.blockNumber - BigInt(rec.openBlock))
    const blocksUsed = new Set(sents.map((x) => x.receipt.blockNumber)).size
    note(`the window's ${sents.length} transactions landed ${landed.join(', ')} blocks after graduation, in ${blocks(BigInt(blocksUsed))}`)
    progress.notes[`${id}:landed`] = landed.join(',')
    const checked = await checkTrades(k, items)
    const at = (name: string) => checked[trades.findIndex((t) => t.name === name)]
    const gradBid = bidRange(rec.usdcIs0, rec.graduationTick)
    const gradTop = rec.usdcIs0 ? gradBid.lower : gradBid.upper
    const topOf = (r: { lower: number; upper: number }) => (rec.usdcIs0 ? r.lower : r.upper)
    const pricier = (a: number, b: number) => pricierTick(rec.usdcIs0, a, b)

    const wb = at(names.lift)
    const wBuy = sents[0]
    progress.notes[`${id}:poolWindowBps`] = wb.snipeBps.toString()
    if (!wb.bid) note("the pool's window buy landed after the window: no surcharge, no bid")
    else check("window buy: the first trade after graduation, so its bid lands on the graduation bid's range, from the pool's reference (the graduation price)", [wb.tickBefore, wb.refTick, wb.bid.lower, wb.bid.upper], [rec.graduationTick, rec.graduationTick, gradBid.lower, gradBid.upper])
    const B0 = wBuy.receipt.blockNumber - 1n
    const quoted = await rd<bigint>(ROUTER, ABI.router, 'quoteBuy', [token, wBuy.args[1]], B0)
    const q0 = modelPoolTrade(await poolAt('quote model', k, B0), rec.usdcIs0, BigInt(rec.creatorBps), snipeBpsAt(BigInt(rec.openBlock), B0, BigInt(rec.creatorBps)), 'buy', 'in', wBuy.args[1] as bigint)
    check("window buy: router.quoteBuy at the block before == model with that block's surcharge", quoted, q0.received)

    const wb2 = at(names.capped)
    if (!wb2.bid) note('the second window buy landed after the window: no surcharge, no bid')
    else {
      checkThat('above graduation: the buy started from a price above the graduation price (the first buy lifted it)', pricier(wb2.tickBefore, rec.graduationTick), `tick ${wb2.tickBefore} before the buy, ${rec.graduationTick} at graduation`)
      // Half the price before the buy would give a higher range: the lift must be at least a spacing, or the reference
      // and the price before the buy give the same range and nothing is shown.
      const uncapped = bidRange(rec.usdcIs0, wb2.tickBefore)
      checkThat('above graduation: the lift was big enough that the reference decides the range (half the price before the buy is a tick spacing or more above half the graduation price)',
        topOf(uncapped) !== gradTop, `tick ${wb2.tickBefore} before the buy; a bid from it would start at ${topOf(uncapped)}, half the graduation price is at ${gradTop}`)
      check("above graduation: its bid starts from the pool's reference, still the graduation price: the graduation bid's range, not half the price before the buy", [wb2.refBefore, wb2.refTick, wb2.bid.lower, wb2.bid.upper], [rec.graduationTick, rec.graduationTick, gradBid.lower, gradBid.upper])
      if (topOf(uncapped) !== gradTop) {
        note(`the first window buy lifted the tick from ${rec.graduationTick} to ${wb2.tickBefore}; from the price before it the next bid would have started at tick ${topOf(uncapped)}, above half the graduation price at ${gradTop}`)
        progress.notes[`${id}:cappedBid`] = `${wb2.tickBefore},${topOf(uncapped)},${gradTop}`
      }
    }
    if (feature) {
      const d = at(names.dump)
      checkThat("crash: the dump took the price under half the graduation price (past the graduation bid's top)", pastBidTop(rec.usdcIs0, rec.graduationTick, d.swap.tick), `tick ${rec.graduationTick} at graduation, ${d.swap.tick} after the dump, graduation bid's top at ${gradTop}`)
      const cb = at(names.crash)
      if (!cb.bid) note('the crash buy landed after the window: no surcharge, no bid')
      else {
        checkThat('crash: the buy started from under half the graduation price', pastBidTop(rec.usdcIs0, rec.graduationTick, cb.tickBefore), `tick ${cb.tickBefore} before the buy`)
        check("crash: the pool's reference moved down to the crashed price, and its bid is placed from it", [cb.refBefore, cb.refTick], [rec.graduationTick, cb.tickBefore])
        checkThat("crash: its bid followed the price down: from half the crashed price, past the graduation bid's top", rec.usdcIs0 ? cb.bid.lower > gradBid.lower : cb.bid.upper < gradBid.upper,
          `bid [${cb.bid.lower}, ${cb.bid.upper}] from tick ${cb.tickBefore}; graduation bid [${gradBid.lower}, ${gradBid.upper}]; tops ${topOf(cb.bid)} vs ${gradTop}`)
        check('crash: nothing waits after the buy (lockHeld ≤ 2 units)', cb.heldAfter <= 2n, true)
        progress.notes[`${id}:crashBid`] = `${cb.bid.lower},${cb.bid.upper},${cb.tickBefore}`
        progress.notes[`${id}:crashRef`] = cb.refTick.toString()
        const crashBid = bidRange(rec.usdcIs0, cb.refTick)
        const back = at(names.back)
        const after = at(names.after)
        if (!back.bid || !after.bid) note('the lift back or the buy after it landed after the window: no surcharge, no bid')
        else {
          checkThat('lift back: it started above the crashed price (the crash buy lifted it)', pricier(back.tickBefore, cb.refTick), `tick ${back.tickBefore} before it, reference ${cb.refTick}`)
          check("lift back: its bid still starts from half the crashed price, the pool's reference", [back.refBefore, back.refTick, back.bid.lower, back.bid.upper], [cb.refTick, cb.refTick, crashBid.lower, crashBid.upper])
          checkThat('lift back: it took the price back above the graduation price', pricier(back.swap.tick, rec.graduationTick), `tick ${back.swap.tick} after it, ${rec.graduationTick} at graduation`)
          checkThat('after the lift: the buy started above the graduation price', pricier(after.tickBefore, rec.graduationTick), `tick ${after.tickBefore} before it, ${rec.graduationTick} at graduation`)
          check("after the lift: its bid still starts from half the crashed price, not from half the graduation price", [after.refBefore, after.refTick, after.bid.lower, after.bid.upper], [cb.refTick, cb.refTick, crashBid.lower, crashBid.upper])
          const capOnly = bidRange(rec.usdcIs0, cheaperOf(rec.usdcIs0, after.tickBefore, rec.graduationTick))
          const own = bidRange(rec.usdcIs0, after.tickBefore)
          checkThat("after the lift: the reference decides the range (capping at the graduation price alone would put the bid on the graduation bid's range, higher)", topOf(capOnly) !== topOf(crashBid), `graduation cap alone: [${capOnly.lower}, ${capOnly.upper}]; the reference: [${crashBid.lower}, ${crashBid.upper}]`)
          note(`after the lift the bid sits at [${after.bid.lower}, ${after.bid.upper}], from the crash reference ${cb.refTick}; capped at the graduation price alone it would be [${capOnly.lower}, ${capOnly.upper}], from its own price before the buy [${own.lower}, ${own.upper}]`)
          progress.notes[`${id}:liftAfterCrash`] = `${after.tickBefore},${after.bid.lower},${after.bid.upper},${capOnly.lower},${capOnly.upper}`
        }
        const ro = at(names.rawOut)
        if (ro.bid) check('exact-out buy in the window: its bid starts from half the crashed price too', [ro.refBefore, ro.refTick, ro.bid.lower, ro.bid.upper], [cb.refTick, cb.refTick, crashBid.lower, crashBid.upper])
      }
    }
    const si = trades.findIndex((t) => t.name === names.sell)
    const sellSent = sents[si]
    if (si > 0 && sents[si - 1].receipt.blockNumber === sellSent.receipt.blockNumber) note('the window sell shared its block with the trade before it: its quote at the block before is not its fill, so only the model is checked')
    else check('window sell: quote at the block before == fill (a sell has no surcharge to change)', await rd<bigint>(ROUTER, ABI.router, 'quoteSell', [token, sellSent.args[1]], sellSent.receipt.blockNumber - 1n), checked[si].received)
    // The gas the batches were sent with, against what they used.
    const window = progress.txs.filter((t) => t.step === id && t.gasEstimate !== undefined && t.gasLimit !== undefined)
    if (window.length) {
      const over = window.map((t) => BigInt(t.gasUsed) - BigInt(t.gasEstimate as string))
      const maxOver = over.reduce((a, b) => (b > a ? b : a), over[0])
      note(`window gas used vs the estimate taken before the batch's earlier transactions landed: at most ${maxOver >= 0n ? '+' : ''}${maxOver} (limits: the estimate + 30% or + 200,000)`)
      progress.notes[`${id}:gasOverEstimate`] = maxOver.toString()
    }
  })
}

/** Everything the sell-out buy does (V14-SPEC §4), against the model: the curve's exact fill, the pool opened at the
 *  price where one full-range position takes both amounts, that position, the tokens burned, the graduation bid at the
 *  first bid (the curve's surcharge, from half the graduation price down), and the books (the launchpad's float leaves,
 *  the hook keeps only claims). */
async function checkGraduation(k: Kind, sent: Sent, first: boolean) {
  const s = spec(k)
  const x = s.symbol
  const token = tokenOf(k)
  const { receipt, args } = sent
  const B = receipt.blockNumber
  const B0 = B - 1n
  const usdcIn = args[1] as bigint
  const c0 = await curveAt(token, B0)
  const bps = snipeBpsAt(c0.createdBlock, B, s.feeBps)
  const m = modelCurveBuy(c0, usdcIn, s.feeBps, bps)
  const remaining = CURVE_SUPPLY - c0.tokensSold
  check('the sell-out buy: all remaining tokens, graduates', [m.tokensOut, m.graduates], [remaining, true])
  const [qOut, qPlat, qCreator, qSnipe, qSpent, qGrad] = await rd<readonly [bigint, bigint, bigint, bigint, bigint, boolean]>(LP, ABI.pad, 'quoteBuy', [token, usdcIn], B0)
  check('quoteBuy at the block before == model (exact fill)', { qOut, qPlat, qCreator, qSnipe, qSpent, qGrad }, {
    qOut: m.tokensOut, qPlat: m.platformFee, qCreator: m.creatorFee, qSnipe: m.snipeFee, qSpent: m.usdcSpent, qGrad: true,
  })
  checkThat('pulls only what the last tokens cost', m.usdcSpent < usdcIn, `${fmt(m.usdcSpent)} of ${fmt(usdcIn)} offered`)
  check('Trade == model', eventsOf<TradeEvent>(receipt, LP, ABI.pad, 'Trade').map((t) => pick(t, ['trader', 'isBuy', 'usdcAmount', 'tokenAmount', 'platformFee', 'creatorFee', 'snipeFee', 'virtualUsdc', 'virtualTokens'])), [{
    trader: me, isBuy: true, usdcAmount: m.usdcSpent, tokenAmount: remaining, platformFee: m.platformFee, creatorFee: m.creatorFee, snipeFee: m.snipeFee,
    virtualUsdc: c0.virtualUsdc + m.net, virtualTokens: c0.virtualTokens - remaining,
  }])
  const usdcSeeded = c0.virtualUsdc + m.net - VIRTUAL_USDC_0
  const snipeBefore = await rd<bigint>(LP, ABI.pad, 'pendingSnipe', [token], B0)
  const lockAmount = snipeBefore + m.snipeFee
  const usdcIs0 = BigInt(USDC) < BigInt(token)
  const g = modelGraduation(usdcIs0, usdcSeeded, lockAmount)
  const poolId = poolIdOf(token)
  const key = poolKeyOf(token)
  note(`${x} graduated: ${fmt(usdcSeeded)} rUSDC × 200M tokens at tick ${g.tick}; ${fmt(lockAmount)} rUSDC of curve surcharge to bid; ${fmt18(g.burned)} tokens left over`)
  check('Graduated == model', eventsOf(receipt, LP, ABI.pad, 'Graduated'), [{ token, poolId, usdcSeeded, tokensSeeded: POOL_SUPPLY, liquidityLocked: g.liquidity, snipeLocked: lockAmount }])
  check('PoolOpened == model', eventsOf(receipt, HOOK, ABI.hook, 'PoolOpened'), [{ token, poolId, sqrtPriceX96: g.sqrtPrice, tokensAdded: g.tokensUsed, usdcAdded: g.usdcUsed, liquidity: g.liquidity, open: s.open }])
  check('Uniswap Initialize == model (sorted currencies, fee 0, spacing 200, the hook, the price, its tick)', eventsOf(receipt, POOL_MANAGER, ABI.pm, 'Initialize'), [{
    id: poolId, currency0: key.currency0, currency1: key.currency1, fee: 0, tickSpacing: TICK_SPACING, hooks: HOOK, sqrtPriceX96: g.sqrtPrice, tick: g.tick,
  }])
  const modify = eventsOf<ModifyEvent>(receipt, POOL_MANAGER, ABI.pm, 'ModifyLiquidity')
  const wantModify: ModifyEvent[] = [{ id: poolId, sender: HOOK, tickLower: MIN_T, tickUpper: MAX_T, liquidityDelta: g.liquidity, salt: pad('0x0', { size: 32 }) }]
  if (g.bid) wantModify.push({ id: poolId, sender: HOOK, tickLower: g.bid.lower, tickUpper: g.bid.upper, liquidityDelta: g.bid.liquidity, salt: pad(toHex(1), { size: 32 }) })
  check('Uniswap ModifyLiquidity: the full-range position (salt 0), then the graduation bid (salt 1)', modify, wantModify)
  const [sqrtP, tick, protocolFee, lpFee] = await rd<readonly [bigint, number, number, number]>(STATE_VIEW, ABI.stateView, 'getSlot0', [poolId], B)
  check('StateView.getSlot0: the pool opened at the model price, no protocol or LP fee', { sqrtP, tick, protocolFee, lpFee }, { sqrtP: g.sqrtPrice, tick: g.tick, protocolFee: 0, lpFee: 0 })
  // The curve's final price, virtualUsdc / virtualTokens, against the pool's (USDC per token, both in base units).
  const vU = c0.virtualUsdc + m.net
  const vT = c0.virtualTokens - remaining
  const Q192 = 1n << 192n
  const poolScaled = usdcIs0 ? (Q192 * 10n ** 30n) / (sqrtP * sqrtP) : (sqrtP * sqrtP * 10n ** 30n) / Q192
  const curveScaled = (vU * 10n ** 30n) / vT
  const ppb = ((poolScaled > curveScaled ? poolScaled - curveScaled : curveScaled - poolScaled) * 10n ** 9n) / curveScaled
  checkThat("the pool opened at the curve's final price (virtualUsdc / virtualTokens), within 1 ppm", ppb < 1000n, `${ppb} parts per billion apart`)
  check('StateView.getLiquidity == the full-range liquidity (the bid is out of range)', await rd<bigint>(STATE_VIEW, ABI.stateView, 'getLiquidity', [poolId], B), g.liquidity)
  const fullRange = await rd<readonly [bigint, bigint, bigint]>(STATE_VIEW, ABI.stateView, 'getPositionInfo', [poolId, HOOK, MIN_T, MAX_T, pad('0x0', { size: 32 })], B)
  check("the hook's full-range position (owner the hook, salt 0): liquidity, no fees", fullRange, [g.liquidity, 0n, 0n])
  check('the leftover tokens were burned (Transfer to 0 from the hook)', eventsOf<{ from: Address; to: Address; value: bigint }>(receipt, token, ABI.token, 'Transfer').filter((t) => getAddress(t.to) === zeroAddress), g.burned > 0n ? [{ from: HOOK, to: zeroAddress, value: g.burned }] : [])
  if (g.bid) {
    check('BidLocked == model: the first bid, from half the graduation price (the graduation tick)', eventsOf(receipt, HOOK, ABI.hook, 'BidLocked'), [{ token, usdc: g.bid.used, liquidity: g.bid.liquidity, tickLower: g.bid.lower, tickUpper: g.bid.upper }])
    const bidPos = await rd<readonly [bigint, bigint, bigint]>(STATE_VIEW, ABI.stateView, 'getPositionInfo', [poolId, HOOK, g.bid.lower, g.bid.upper, pad(toHex(1), { size: 32 })], B)
    check('the graduation bid position (owner the hook, salt 1)', bidPos, [g.bid.liquidity, 0n, 0n])
    const topPrice = Math.pow(1.0001, usdcIs0 ? -g.bid.lower : g.bid.upper)
    const gradPrice = Math.pow(1.0001, usdcIs0 ? -g.tick : g.tick)
    checkThat("the bid's top is half the graduation price (V14-SPEC §5)", Math.abs(topPrice / gradPrice - 0.5) < 0.02, `${(topPrice / gradPrice).toFixed(4)} of it, ${BID_SPAN_TICKS} ticks deep`)
  } else {
    check('no graduation bid: nothing to place bought any liquidity', eventsOf(receipt, HOOK, ABI.hook, 'BidLocked'), [])
  }
  check("the hook's claims: minted the USDC to bid, burned what the bid took", claimMoves(receipt), [...(g.toLock > 0n ? [g.toLock] : []), ...(g.bid ? [-g.bid.used] : [])])
  const launch = await rd<readonly [Hex, Record<string, unknown>]>(HOOK, ABI.hook, 'launchOf', [token], B)
  check('hook.launchOf(token): bidRefTick starts at the graduation tick', [launch[0], launch[1]], [poolId, { token, usdcIs0, open: s.open, creatorFeeBps: Number(s.feeBps), openBlock: B, graduationTick: g.tick, bidRefTick: g.tick }])
  check("hook.snipeBpsOf in the graduation block: the pool's window opens at 90% (capped)", await rd<bigint>(HOOK, ABI.hook, 'snipeBpsOf', [token], B), snipeBpsAt(B, B, s.feeBps))
  check('isGraduated, token.graduated, pairOf == the PoolManager', [await rd(LP, ABI.pad, 'isGraduated', [token], B), await rd(token, ABI.token, 'graduated', [], B), getAddress(await rd<string>(LP, ABI.pad, 'pairOf', [token], B))], [true, true, POOL_MANAGER])

  // Record the pool and its positions (the model), then the books.
  progress.pools[k] = { poolId, usdcIs0, open: s.open, creatorBps: s.feeBps.toString(), openBlock: B.toString(), graduationTick: g.tick, changes: [] }
  recordChange(k, { id: `${receipt.transactionHash}:full`, owner: HOOK, lower: MIN_T, upper: MAX_T, salt: pad('0x0', { size: 32 }), block: B.toString(), delta: g.liquidity.toString() })
  if (g.bid) recordChange(k, { id: `${receipt.transactionHash}:bid`, owner: HOOK, lower: g.bid.lower, upper: g.bid.upper, salt: pad(toHex(1), { size: 32 }), block: B.toString(), delta: g.bid.liquidity.toString() })
  const lockHeld = g.toLock - (g.bid?.used ?? 0n)
  await books(`graduate ${x}`, receipt, {
    'usdc:launchpad': m.usdcSpent - usdcSeeded - lockAmount, 'usdc:burner': -m.usdcSpent, 'usdc:poolManager': usdcSeeded + lockAmount,
    'lp.pendingFees': m.platformFee, [`lp.creator:${x}`]: m.creatorFee, [`lp.snipe:${x}`]: -snipeBefore,
    [`curve.vU:${x}`]: m.net, [`curve.vT:${x}`]: -remaining, [`curve.sold:${x}`]: remaining, [`curve.grad:${x}`]: 1n,
    [`tok.launchpad:${x}`]: -(remaining + POOL_SUPPLY), [`tok.burner:${x}`]: remaining, [`tok.poolManager:${x}`]: g.tokensUsed, [`tok.supply:${x}`]: -g.burned,
    'hook.claims': lockHeld, [`hook.lockHeld:${x}`]: lockHeld, [`hook.bids:${x}`]: g.bid ? 1n : 0n,
    [`pool.sqrtP:${x}`]: g.sqrtPrice, [`pool.tick:${x}`]: BigInt(g.tick), [`pool.liquidity:${x}`]: g.liquidity, [`hook.bidRef:${x}`]: BigInt(g.tick),
  })
  if (first) {
    await expectRevert('a curve buy after graduation', LP, ABI.pad, 'buy', [token, usd(1), 0n, me, (await timeOf(B)) + 3600n], 'CurveGraduated', B)
    await expectRevert('a curve sell after graduation', LP, ABI.pad, 'sell', [token, E18, 0n, me, (await timeOf(B)) + 3600n], 'CurveGraduated', B)
    await expectRevert('launchpad.quoteBuy after graduation', LP, ABI.pad, 'quoteBuy', [token, usd(1)], 'CurveGraduated', B)
    await expectRevert('initializing the pool again', POOL_MANAGER, ABI.pm, 'initialize', [key, g.sqrtPrice], 'WrappedError(hook: PoolCreationRestricted)', B)
    await expectRevert('a router buy past its deadline', ROUTER, ABI.router, 'buy', [token, usd(1), 0n, me, (await timeOf(B)) - 1n], 'Expired', B)
  }
}

/** After the pool's window: a router buy and sell, quote == fill both ways. */
async function poolTrades(k: Kind) {
  const id = `pool:${k}`
  await step(id, async () => {
    const s = spec(k)
    const token = tokenOf(k)
    await waitForBlock(BigInt(poolRec(k).openBlock) + SNIPE_BLOCKS)
    const buy = await tx(id, `buy ${s.symbol} (router)`, ROUTER, ABI.router, 'buy', async () => [token, A.poolBuy, await simulate<bigint>(ROUTER, ABI.router, 'quoteBuy', [token, A.poolBuy], head), me, await deadline()])
    const q = await rd<bigint>(ROUTER, ABI.router, 'quoteBuy', [token, buy.args[1]], buy.receipt.blockNumber - 1n)
    const mb = await checkPoolTrade('router buy', k, buy, 'buy', 'in', buy.args[1] as bigint, 'burner')
    check('router buy: quote at the block before == fill == model', [q, mb.received], [mb.received, mb.received])
    const sell = await tx(id, `sell ${s.symbol} (router)`, ROUTER, ABI.router, 'sell', async () => [token, A.poolSell, await simulate<bigint>(ROUTER, ABI.router, 'quoteSell', [token, A.poolSell], head), me, await deadline()])
    const qs = await rd<bigint>(ROUTER, ABI.router, 'quoteSell', [token, sell.args[1]], sell.receipt.blockNumber - 1n)
    const ms = await checkPoolTrade('router sell', k, sell, 'sell', 'in', sell.args[1] as bigint, 'burner')
    check('router sell: quote at the block before == fill == model; fees on the gross', [qs, ms.fees.platform, ms.fees.creator], [ms.received, divCeil(ms.gross * FEE_BPS, BPS), divCeil(ms.gross * BigInt(poolRec(k).creatorBps), BPS)])
    await expectRevert('a router buy with minTokensOut above the quote', ROUTER, ABI.router, 'buy', [token, usd(1), E18 * 10n ** 12n, me, (await timeOf(sell.receipt.blockNumber)) + 3600n], 'SlippageExceeded', sell.receipt.blockNumber)
  })
}

/** Launch tokens for the RawSwapper's exact-out sells and its outside liquidity. */
async function fundRaw() {
  await step('fund:raw', async () => {
    const kinds = [...new Set([...progress.features, progress.openLp].filter(Boolean) as Kind[])]
    for (const k of kinds) {
      const what = `transfer ${fmt18(A.rawTokens)} ${sym(k)} to the RawSwapper`
      const { receipt } = await tx('fund:raw', what, tokenOf(k), ABI.token, 'transfer', [RAW(), A.rawTokens])
      await books(what, receipt, { [`tok.burner:${sym(k)}`]: -A.rawTokens, [`tok.raw:${sym(k)}`]: A.rawTokens })
    }
  })
}

/** Exact-out swaps through the RawSwapper after the window, and the swaps and donations the hook refuses. */
async function rawSwaps(k: Kind) {
  const id = `raw:${k}`
  await step(id, async () => {
    const s = spec(k)
    const token = tokenOf(k)
    const rec = poolRec(k)
    const key = poolKeyOf(token)
    const buy = await tx(id, `exact-out buy of ${fmt18(A.rawOutBuy)} ${s.symbol} (RawSwapper)`, RAW(), ABI.raw, 'swap', [key, { zeroForOne: rec.usdcIs0, amountSpecified: A.rawOutBuy, sqrtPriceLimitX96: LIMIT(rec.usdcIs0) }])
    const mb = await checkPoolTrade('exact-out buy', k, buy, 'buy', 'out', A.rawOutBuy, 'raw')
    check('exact-out buy: exactly the tokens asked for; fees on the net on top', [mb.received, mb.gross - mb.fees.total], [A.rawOutBuy, -(rec.usdcIs0 ? mb.swap.amount0 : mb.swap.amount1)])
    const sell = await tx(id, `exact-out sell for ${fmt(A.rawOutSellUsdc)} rUSDC of ${s.symbol} (RawSwapper)`, RAW(), ABI.raw, 'swap', [key, { zeroForOne: !rec.usdcIs0, amountSpecified: A.rawOutSellUsdc, sqrtPriceLimitX96: LIMIT(!rec.usdcIs0) }])
    const ms = await checkPoolTrade('exact-out sell', k, sell, 'sell', 'out', A.rawOutSellUsdc, 'raw')
    check('exact-out sell: exactly the USDC asked for; the pool paid it plus the fees', [ms.received, ms.gross], [A.rawOutSellUsdc, A.rawOutSellUsdc + ms.fees.total])
    const B = sell.receipt.blockNumber
    await expectRevert('a donation of the token', RAW(), ABI.raw, 'donate', [key, rec.usdcIs0 ? 0n : E18, rec.usdcIs0 ? E18 : 0n], 'WrappedError(hook: DonationsRefused)', B)
    await expectRevert(`a donation of ${U}`, RAW(), ABI.raw, 'donate', [key, rec.usdcIs0 ? usd(1) : 0n, rec.usdcIs0 ? 0n : usd(1)], 'WrappedError(hook: DonationsRefused)', B)
    const [sqrtP] = await rd<readonly [bigint]>(STATE_VIEW, ABI.stateView, 'getSlot0', [rec.poolId], B)
    await expectRevert('an exact-in buy a price limit stops early (fees fixed on the trader\'s USDC)', RAW(), ABI.raw, 'swap', [key, { zeroForOne: rec.usdcIs0, amountSpecified: -usd(1000), sqrtPriceLimitX96: rec.usdcIs0 ? sqrtP - 1n : sqrtP + 1n }], 'WrappedError(hook: PartialFill)', B)
  })
}

/** Outside liquidity (V14-SPEC §6): refused by a closed pool, accepted by an open one, where the locked positions stay
 *  put, trades still pay every fee, and the outside LP can take its own liquidity back out. */
async function outsideLiquidity() {
  const k = progress.openLp
  const closed = progress.closedLp
  if (!k || !closed) return
  const id = 'lp'
  await step(id, async () => {
    const s = spec(k)
    const token = tokenOf(k)
    const rec = poolRec(k)
    const key = poolKeyOf(token)
    const closedKey = poolKeyOf(tokenOf(closed))
    const cTick = floorTick((await rd<readonly [bigint, number]>(STATE_VIEW, ABI.stateView, 'getSlot0', [poolRec(closed).poolId], head))[1])
    await expectRevert(`outside liquidity in the closed ${sym(closed)} pool`, RAW(), ABI.raw, 'addLiquidity', [closedKey, { tickLower: cTick - 2000, tickUpper: cTick + 2200, liquidityDelta: 10n ** 12n, salt: pad('0x0', { size: 32 }) }], 'WrappedError(hook: ClosedPool)', head)

    const add = await tx(id, `add outside liquidity to the open ${s.symbol} pool (RawSwapper)`, RAW(), ABI.raw, 'addLiquidity', async () => {
      const [sqrtP, tick] = await rd<readonly [bigint, number]>(STATE_VIEW, ABI.stateView, 'getSlot0', [rec.poolId], head)
      const lower = floorTick(tick) - 2000
      const upper = floorTick(tick) + 2200
      const [a0, a1] = rec.usdcIs0 ? [A.lpUsdc, A.lpTokens] : [A.lpTokens, A.lpUsdc]
      const liquidity = V4.liquidityForAmounts(sqrtP, V4.sqrtAtTick(lower), V4.sqrtAtTick(upper), a0, a1)
      return [key, { tickLower: lower, tickUpper: upper, liquidityDelta: liquidity, salt: pad('0x0', { size: 32 }) }]
    })
    const p = add.args[1] as { tickLower: number; tickUpper: number; liquidityDelta: bigint; salt: Hex }
    await checkLiquidity('outside add', k, add, p.tickLower, p.tickUpper, p.liquidityDelta)
    const buy = await tx(id, `buy ${s.symbol} through the outside liquidity (router)`, ROUTER, ABI.router, 'buy', async () => [token, A.poolBuy, 0n, me, await deadline()])
    const mb = await checkPoolTrade('router buy with outside liquidity in range', k, buy, 'buy', 'in', A.poolBuy, 'burner')
    check('the trade still pays the platform and creator fees', [mb.fees.platform, mb.fees.creator], [divCeil(A.poolBuy * FEE_BPS, BPS), divCeil(A.poolBuy * s.feeBps, BPS)])
    const remove = await tx(id, `remove half the outside liquidity (RawSwapper)`, RAW(), ABI.raw, 'addLiquidity', [key, { tickLower: p.tickLower, tickUpper: p.tickUpper, liquidityDelta: -(p.liquidityDelta / 2n), salt: p.salt }])
    await checkLiquidity('outside remove', k, remove, p.tickLower, p.tickUpper, -(p.liquidityDelta / 2n))
  })
}
async function checkLiquidity(what: string, k: Kind, sent: Sent, lower: number, upper: number, delta: bigint) {
  const { receipt } = sent
  const B = receipt.blockNumber
  const rec = poolRec(k)
  const x = sym(k)
  const pool = await poolAt(what, k, B - 1n)
  const before = pool.liquidity
  const d = V4.modifyLiquidity(pool, lower, upper, delta)
  const [usdcDelta, tokDelta] = rec.usdcIs0 ? [d.amount0, d.amount1] : [d.amount1, d.amount0]
  const salt = pad('0x0', { size: 32 })
  check(`${what}: Uniswap ModifyLiquidity (owner the RawSwapper)`, eventsOf<ModifyEvent>(receipt, POOL_MANAGER, ABI.pm, 'ModifyLiquidity'), [{ id: rec.poolId, sender: RAW(), tickLower: lower, tickUpper: upper, liquidityDelta: delta, salt }])
  recordChange(k, { id: `${receipt.transactionHash}:lp`, owner: RAW(), lower, upper, salt, block: B.toString(), delta: delta.toString() })
  const liq = positionsAt(k, B).find((p) => p.owner === RAW())?.liquidity ?? 0n
  check(`${what}: the RawSwapper's position`, (await rd<readonly [bigint]>(STATE_VIEW, ABI.stateView, 'getPositionInfo', [rec.poolId, RAW(), lower, upper, salt], B))[0], liq)
  note(`${what}: ${fmt(usdcDelta < 0n ? -usdcDelta : usdcDelta)} rUSDC and ${fmt18(tokDelta < 0n ? -tokDelta : tokDelta)} ${x}`)
  await books(what, receipt, {
    'usdc:raw': usdcDelta, 'usdc:poolManager': -usdcDelta, [`tok.raw:${x}`]: tokDelta, [`tok.poolManager:${x}`]: -tokDelta, [`pool.liquidity:${x}`]: pool.liquidity - before,
  })
}

// ── Fees ──────────────────────────────────────────────────────────────────────

/** The release part of a sync or collection: FeesReleased and PoolFeesAccrued equal what the hook held at the block
 *  before, and the claims burn by exactly that. Returns (platform, creator). */
async function checkRelease(what: string, k: Kind, receipt: TransactionReceipt) {
  const token = tokenOf(k)
  const B0 = receipt.blockNumber - 1n
  const p = await rd<bigint>(HOOK, ABI.hook, 'pendingPlatform', [token], B0)
  const c = await rd<bigint>(HOOK, ABI.hook, 'pendingCreator', [token], B0)
  const releases = eventsOf(receipt, HOOK, ABI.hook, 'FeesReleased').filter((e) => getAddress((e as { token: Address }).token) === token)
  check(`${what}: FeesReleased and PoolFeesAccrued == what the hook held`, [releases, eventsOf(receipt, LP, ABI.pad, 'PoolFeesAccrued').filter((e) => getAddress((e as { token: Address }).token) === token)],
    p + c > 0n ? [[{ token, platformFee: p, creatorFee: c }], [{ token, platformFee: p, creatorFee: c }]] : [[], []])
  return { p, c }
}

async function syncOne(k: Kind) {
  await step(`sync:${k}`, async () => {
    const x = sym(k)
    const { receipt } = await tx(`sync:${k}`, `syncPoolFees ${x}`, LP, ABI.pad, 'syncPoolFees', [tokenOf(k)])
    const { p, c } = await checkRelease('syncPoolFees', k, receipt)
    checkThat('there were pool fees to book', p + c > 0n, `${fmt(p)} platform, ${fmt(c)} creator`)
    check("the hook's claims burned by exactly that", claimMoves(receipt), [-(p + c)])
    await books(`syncPoolFees ${x}`, receipt, {
      'usdc:launchpad': p + c, 'usdc:poolManager': -(p + c), 'lp.pendingFees': p, [`lp.creator:${x}`]: c, [`hook.platform:${x}`]: -p, [`hook.creator:${x}`]: -c, 'hook.claims': -(p + c),
    })
    await expectRevert('hook.release by anyone but the launchpad', HOOK, ABI.hook, 'release', [tokenOf(k)], 'OnlyLaunchpad', receipt.blockNumber)
    check('a second sync right after books nothing', await simulate(LP, ABI.pad, 'syncPoolFees', [tokenOf(k)], receipt.blockNumber), [0n, 0n])
  })
}

async function syncBatch(kinds: Kind[]) {
  await step('syncBatch', async () => {
    const { receipt } = await tx('syncBatch', `syncPoolFeesBatch ${kinds.map(sym).join(', ')}`, LP, ABI.pad, 'syncPoolFeesBatch', [kinds.map(tokenOf)])
    const expected: Moves = { 'usdc:launchpad': 0n, 'usdc:poolManager': 0n, 'lp.pendingFees': 0n, 'hook.claims': 0n }
    const burns: bigint[] = []
    for (const k of kinds) {
      const x = sym(k)
      const { p, c } = await checkRelease(`batch: ${x}`, k, receipt)
      if (p + c > 0n) burns.push(-(p + c))
      expected['usdc:launchpad'] += p + c
      expected['usdc:poolManager'] -= p + c
      expected['lp.pendingFees'] += p
      expected[`lp.creator:${x}`] = c
      expected[`hook.platform:${x}`] = -p
      expected[`hook.creator:${x}`] = -c
      expected['hook.claims'] -= p + c
    }
    check("the hook's claims burned token by token", claimMoves(receipt), burns)
    await books('syncPoolFeesBatch', receipt, expected)
  })
}

/** collectCreatorFees (V13-SPEC §2.1): syncs the pool's fees first, then pays the token's plugin exactly what is booked. */
async function collect(k: Kind) {
  const id = `collect:${k}`
  await step(id, async () => {
    const s = spec(k)
    const x = s.symbol
    const token = tokenOf(k)
    const { receipt } = await tx(id, `collectCreatorFees ${x}`, LP, ABI.pad, 'collectCreatorFees', [token])
    const B = receipt.blockNumber
    const B0 = B - 1n
    const { p, c } = await checkRelease('collectCreatorFees syncs first', k, receipt)
    const booked = await rd<bigint>(LP, ABI.pad, 'pendingCreatorFees', [token], B0)
    const amount = booked + c
    note(`${x}: ${fmt(booked)} booked (curve and synced pool fees) + ${fmt(c)} released now = ${fmt(amount)} to ${label(s.plugin)}`)
    check('CreatorFeesCollected', eventsOf(receipt, LP, ABI.pad, 'CreatorFeesCollected'), amount > 0n ? [{ token, plugin: s.plugin, amount }] : [])
    if (s.feeBps === 0n) check('a 0% creator fee collects nothing', amount, 0n)
    else checkThat('there were creator fees to collect', amount > 0n, fmt(amount))
    const expected: Moves = {
      'usdc:launchpad': p + c - amount, 'usdc:poolManager': -(p + c), 'lp.pendingFees': p, [`lp.creator:${x}`]: -booked,
      [`hook.platform:${x}`]: -p, [`hook.creator:${x}`]: -c, 'hook.claims': -(p + c),
    }
    if (REAL) {
      expected['usdc:burner'] = amount // the actor is Run B's creator-fee destination
    } else if (k === 'wallet' || k === 'zero') {
      expected[`usdc:${k === 'wallet' ? 'creatorWallet' : 'zeroWallet'}`] = amount
    } else if (k === 'split') {
      check('Split: FeesReceived from the launchpad', eventsOf(receipt, SPLIT, ABI.split, 'FeesReceived'), [{ token, from: LP, amount }])
      Object.assign(expected, { 'usdc:split': amount, [`split.received:${x}`]: amount })
    } else if (k === 'holders') {
      await holdersCredited('holders', receipt, token, LP, amount)
      Object.assign(expected, { [`usdc:tok:${x}`]: amount, [`holders.distributed:${x}`]: amount, [`tok.distributed:${x}`]: amount })
    } else {
      const slices = [(amount * 5000n) / BPS, (amount * 3000n) / BPS]
      slices.push(amount - slices[0] - slices[1])
      check('Combo: previewSplit == 50/30/20, the last taking the remainder', await rd(COMBO, ABI.combo, 'previewSplit', [token, amount], B0), slices)
      check('Combo: FeesForwarded', eventsOf(receipt, COMBO, ABI.combo, 'FeesForwarded'), [
        { token, target: HOLDERS, amount: slices[0], viaHook: true }, { token, target: SPLIT, amount: slices[1], viaHook: true }, { token, target: COMBO_WALLET, amount: slices[2], viaHook: false },
      ])
      check('Combo → Split: FeesReceived from the Combo', eventsOf(receipt, SPLIT, ABI.split, 'FeesReceived'), [{ token, from: COMBO, amount: slices[1] }])
      await holdersCredited('Combo → holders', receipt, token, COMBO, slices[0])
      Object.assign(expected, {
        [`usdc:tok:${x}`]: slices[0], [`holders.distributed:${x}`]: slices[0], [`tok.distributed:${x}`]: slices[0],
        'usdc:split': slices[1], [`split.received:${x}`]: slices[1], 'usdc:comboWallet': slices[2],
      })
    }
    await books(`collectCreatorFees ${x}`, receipt, expected)
  })
}

async function releaseSplit() {
  const token = tokenOf('split')
  for (const [i, payee] of PAYEES.entries()) {
    const id = `release:split:${i + 1}`
    await step(id, async () => {
      const { receipt } = await tx(id, `Split release to payee ${i + 1}`, SPLIT, ABI.split, 'release', [token, payee])
      const B0 = receipt.blockNumber - 1n
      const received = await rd<bigint>(SPLIT, ABI.split, 'totalReceived', [token], B0)
      const paid = await rd<bigint>(SPLIT, ABI.split, 'released', [token, payee], B0)
      const owed = (received * SHARES[i]) / 10n - paid
      check(`payee ${i + 1}: releasable == totalReceived × ${SHARES[i]}/10 - released`, await rd<bigint>(SPLIT, ABI.split, 'releasable', [token, payee], B0), owed)
      check('Released', eventsOf(receipt, SPLIT, ABI.split, 'Released'), [{ token, payee, amount: owed }])
      await books(`release payee ${i + 1}`, receipt, { 'usdc:split': -owed, [`usdc:payee${i + 1}`]: owed, 'split.released:RSPL': owed })
    })
  }
}

// ── The dividend stream (LaunchTokenV14, V13-SPEC §3) ────────────────────────

const storageAt = async (address: Address, slot: bigint, block: bigint): Promise<bigint> => {
  const word = await retry(() => pub.getStorageAt({ address, slot: `0x${slot.toString(16).padStart(64, '0')}`, blockNumber: block }))
  return word ? hexToBigInt(word) : 0n
}
async function streamAt(token: Address, block: bigint): Promise<TokenStream> {
  const packed = await storageAt(token, SLOT.stream, block)
  return {
    perShare: await storageAt(token, SLOT.perShare, block),
    rate: await storageAt(token, SLOT.rate, block),
    eligible: packed & (2n ** 128n - 1n),
    lastAccrual: (packed >> 128n) & (2n ** 64n - 1n),
    end: packed >> 192n,
  }
}
async function correctionOf(token: Address, holder: Address, block: bigint): Promise<bigint> {
  const slot = hexToBigInt(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, SLOT.corrections])))
  const raw = await storageAt(token, slot, block)
  return raw >= 2n ** 255n ? raw - 2n ** 256n : raw
}
interface HolderView {
  holder: Address
  stream: TokenStream
  balance: bigint
  correction: bigint
  claimed: bigint
  claimable: bigint
  undistributed: bigint
  streamRate: bigint
  streamEnd: bigint
  lastAccrual: bigint
  totalDistributed: bigint
  time: bigint
}
async function holderAt(token: Address, holder: Address, block: bigint): Promise<HolderView> {
  return {
    holder,
    stream: await streamAt(token, block),
    balance: await rd<bigint>(token, ABI.token, 'balanceOf', [holder], block),
    correction: await correctionOf(token, holder, block),
    claimed: await rd<bigint>(token, ABI.token, 'claimed', [holder], block),
    claimable: await rd<bigint>(token, ABI.token, 'claimable', [holder], block),
    undistributed: await rd<bigint>(token, ABI.token, 'undistributed', [], block),
    streamRate: await rd<bigint>(token, ABI.token, 'streamRate', [], block),
    streamEnd: await rd<bigint>(token, ABI.token, 'streamEnd', [], block),
    lastAccrual: await rd<bigint>(token, ABI.token, 'lastAccrual', [], block),
    totalDistributed: await rd<bigint>(token, ABI.token, 'totalDistributed', [], block),
    time: await timeOf(block),
  }
}
function viewsMatchModel(what: string, v: HolderView) {
  check(`${what}: claimable, undistributed, streamRate, streamEnd, lastAccrual == model of the stored stream`, {
    claimable: v.claimable, undistributed: v.undistributed, streamRate: v.streamRate, streamEnd: v.streamEnd, lastAccrual: v.lastAccrual,
  }, {
    claimable: claimableAt(v.stream, v.time, v.balance, v.correction, v.claimed), undistributed: undistributedAt(v.stream, v.time),
    streamRate: v.stream.rate / MAGNITUDE, streamEnd: v.stream.end, lastAccrual: v.stream.lastAccrual,
  })
}
/** The eligible holders of a token here: the actor, and the RawSwapper while it holds some. */
async function eligibleHolders(token: Address, block: bigint): Promise<Address[]> {
  const list: Address[] = [me]
  if (rawAt(block) && (await rd<bigint>(token, ABI.token, 'balanceOf', [RAW()], block)) > 0n) list.push(RAW())
  return list
}
/** The Holders plugin receiving `amount` for `token`: it forwards all of it to the token's distribute, which streams it
 *  over 24 hours; the token's stored stream moves exactly as the model says. */
async function holdersCredited(what: string, receipt: TransactionReceipt, token: Address, from: Address, amount: bigint) {
  const B = receipt.blockNumber
  const now = await timeOf(B)
  check(`${what}: FeesReceived, Distributed, DividendsDistributed`, [
    eventsOf(receipt, HOLDERS, ABI.holders, 'FeesReceived'), eventsOf(receipt, HOLDERS, ABI.holders, 'Distributed'), eventsOf(receipt, token, ABI.token, 'DividendsDistributed'),
  ], [[{ token, from, amount }], [{ token, amount }], [{ from: HOLDERS, amount }]])
  const s0 = await streamAt(token, B - 1n)
  const expected = distributeAt(s0, now, amount)
  check(`${what}: the token's stream (per-share, rate, eligible, lastAccrual, end) == model`, await streamAt(token, B), expected)
  if (s0.end === 0n) check(`${what}: a first stream runs exactly DRIP_PERIOD`, expected.end - now, DRIP_PERIOD)
  for (const h of await eligibleHolders(token, B)) viewsMatchModel(`${what} (${label(h)})`, await holderAt(token, h, B))
}
/** Everyone eligible has earned everything the stream paid out: Σ (claimed + claimable) + undistributed ==
 *  totalDistributed, less a unit or two of rounding per holder. */
async function conservation(what: string, token: Address, block: bigint) {
  const hs = await eligibleHolders(token, block)
  const views = await Promise.all(hs.map((h) => holderAt(token, h, block)))
  for (const v of views) viewsMatchModel(`${what} (${label(v.holder)})`, v)
  const earned = views.reduce((s, v) => s + v.claimed + v.claimable, 0n)
  const dust = views[0].totalDistributed - earned - views[0].undistributed
  checkThat(`${what}: Σ (claimed + claimable) + undistributed == totalDistributed, within ${hs.length + 1} units`, dust >= 0n && dust <= BigInt(hs.length + 1), `${dust} unit(s) of dust over ${hs.length} holder(s)`)
  check(`${what}: token ${U} == distributed - Σ claimed`, await rd<bigint>(USDC, ABI.erc20, 'balanceOf', [token], block), views[0].totalDistributed - views.reduce((s, v) => s + v.claimed, 0n))
}

async function sample() {
  const kinds = KINDS.filter(usesHolders)
  if (!kinds.length) return
  await step('sample', async () => {
    const b1 = maxOf(await latest(), head)
    const first = new Map<Kind, HolderView>()
    for (const k of kinds) first.set(k, await holderAt(tokenOf(k), me, b1))
    note(`waiting ${SAMPLE_SECONDS} s for the streams to pay out`)
    await sleep(SAMPLE_SECONDS * 1000)
    const b2 = maxOf(await latest(), b1 + 1n)
    for (const k of kinds) {
      const v1 = first.get(k) as HolderView
      const v2 = await holderAt(tokenOf(k), me, b2)
      const dt = v2.time - v1.time
      check(`${sym(k)}: nothing touched the token between the readings`, [v2.stream, v2.balance, v2.correction], [v1.stream, v1.balance, v1.correction])
      viewsMatchModel(`${sym(k)} at t1`, v1)
      viewsMatchModel(`${sym(k)} at t2 (${dt} s later)`, v2)
      const grew = v2.claimable - v1.claimable
      const approx = (v1.streamRate * dt * v1.balance) / v1.stream.eligible
      checkThat(`${sym(k)}: the Holders stream accrues: claimable grows with time`, grew > 0n, `${fmt(v1.claimable)} → ${fmt(v2.claimable)} ${U} in ${dt} s`)
      checkThat(`${sym(k)}: by ≈ streamRate × dt × share (within dt + 2 units)`, grew - approx <= dt + 2n && approx - grew <= dt + 2n, `${grew} vs ${approx}`)
      checkThat(`${sym(k)}: undistributed never rises`, v2.undistributed <= v1.undistributed, `${fmt(v1.undistributed)} → ${fmt(v2.undistributed)}`)
    }
  })
}

async function claim(k: Kind) {
  const id = `claim:${k}`
  await step(id, async () => {
    const token = tokenOf(k)
    const x = sym(k)
    const { receipt } = await tx(id, `claim ${x} dividends`, token, ABI.token, 'claim', [])
    const B = receipt.blockNumber
    const v0 = await holderAt(token, me, B - 1n)
    const v1 = await holderAt(token, me, B)
    const due = claimableAt(v0.stream, v1.time, v0.balance, v0.correction, v0.claimed)
    viewsMatchModel('the block before the claim', v0)
    check("DividendClaimed == claimable at the claim's block", eventsOf(receipt, token, ABI.token, 'DividendClaimed'), [{ holder: me, amount: due }])
    checkThat('the claim pays > 0', due > 0n, `${fmt(due)} ${U}`)
    check('the claim accrued the stream first (stored stream == model)', v1.stream, accrueAt(v0.stream, v1.time))
    await books(`claim ${x}`, receipt, { [`usdc:tok:${x}`]: -due, 'usdc:burner': due, [`tok.claimed.burner:${x}`]: due })
    await conservation(`after the ${x} claim`, token, B)
  })
}

async function collectPlatformFees() {
  await step('collectFees', async () => {
    const { receipt } = await tx('collectFees', 'collectFees', LP, ABI.pad, 'collectFees', [])
    const B0 = receipt.blockNumber - 1n
    const pending = await rd<bigint>(LP, ABI.pad, 'pendingFees', [], B0)
    checkThat('platform fees were waiting', pending > 0n, `${fmt(pending)} ${U}`)
    check('FeesCollected to feeTo', eventsOf(receipt, LP, ABI.pad, 'FeesCollected'), [{ feeTo: FEE_TO, amount: pending }])
    await books('collectFees', receipt, { 'usdc:launchpad': -pending, 'lp.pendingFees': -pending, [FEE_TO === me ? 'usdc:burner' : 'usdc:feeTo']: pending })
  })
}

// ── Run B: sell what is left, so the curve float comes back ─────────────────

async function sellAll(k: Kind) {
  const id = `sellAll:${k}`
  await step(id, async () => {
    const s = spec(k)
    const token = tokenOf(k)
    const sell = await tx(id, `sell all ${s.symbol} back to the curve`, LP, ABI.pad, 'sell', async () => {
      const all = await rd<bigint>(token, ABI.token, 'balanceOf', [me], head)
      const [out] = await simulate<readonly [bigint]>(LP, ABI.pad, 'quoteSell', [token, all], head)
      return [token, all, out, me, await deadline()]
    })
    const S = sell.receipt.blockNumber
    const tokensIn = sell.args[1] as bigint
    const c0 = await curveAt(token, S - 1n)
    const m = modelCurveSell(c0, tokensIn, s.feeBps)
    check('Trade == model', eventsOf<TradeEvent>(sell.receipt, LP, ABI.pad, 'Trade').map((t) => pick(t, ['usdcAmount', 'tokenAmount', 'platformFee', 'creatorFee', 'snipeFee'])), [{ usdcAmount: m.gross, tokenAmount: tokensIn, platformFee: m.platformFee, creatorFee: m.creatorFee, snipeFee: 0n }])
    const x = s.symbol
    await books('sell all', sell.receipt, {
      'usdc:launchpad': -m.usdcOut, 'usdc:burner': m.usdcOut, 'lp.pendingFees': m.platformFee, [`lp.creator:${x}`]: m.creatorFee,
      [`curve.vU:${x}`]: -m.gross, [`curve.vT:${x}`]: tokensIn, [`curve.sold:${x}`]: -tokensIn, [`tok.launchpad:${x}`]: tokensIn, [`tok.burner:${x}`]: -tokensIn,
    })
  })
}

// ── Final state ───────────────────────────────────────────────────────────────

async function finalState() {
  await step('final', async () => {
    const B = maxOf(await latest(), head)
    const s = await snapshot(B)
    invariants('final', s)
    const made = KINDS.filter((k) => progress.tokens[k])
    let windowBuys = 0
    let windowPaid = 0
    for (const k of made) {
      const token = tokenOf(k)
      const x = sym(k)
      const supply = s.get(`tok.supply:${x}`) ?? 0n
      // The only burn is the graduation's leftover: the 200M less what the full-range position took (PoolOpened).
      const gradTx = progress.txs.find((t) => t.step === `graduate:${k}` && t.what.endsWith('out (graduation)'))
      const opened = gradTx ? eventsOf<{ tokensAdded: bigint }>(await retry(() => pub.getTransactionReceipt({ hash: gradTx.hash })), HOOK, ABI.hook, 'PoolOpened') : []
      const burned = opened.length ? POOL_SUPPLY - opened[0].tokensAdded : 0n
      check(`${x}: supply == 1e9 less only the graduation's leftover burn (${burned} wei)`, supply, TOTAL_SUPPLY - burned)
      windowBuys += spec(k).windowBuys
      windowPaid += Number(progress.notes[`create:${k}:windowPaid`] ?? '0')
      const line = [`${x}: ${progress.pools[k] ? 'graduated' : `on the curve (${fmt((s.get(`curve.vU:${x}`) ?? 0n) - VIRTUAL_USDC_0)} ${U} float)`}`]
      if (progress.pools[k]) {
        const rec = poolRec(k)
        const pool = await poolAt(`${x} final`, k, B)
        const pos = positionsAt(k, B)
        line.push(`tick ${pool.tick}, ${pos.filter((p) => p.owner === HOOK).length} hook positions (${(s.get(`hook.bids:${x}`) ?? 0n).toString()} bids)`)
        check(`${x}: hook.bidCount == the bid positions`, s.get(`hook.bids:${x}`), BigInt(pos.filter((p) => p.owner === HOOK && p.lower !== MIN_T).length))
        const bids = pos.filter((p) => p.owner === HOOK && p.lower !== MIN_T)
        check(`${x}: no bid starts above half the graduation price (V14-SPEC §11)`, bids.filter((b) => !notAboveGraduationBid(rec.usdcIs0, rec.graduationTick, b)).map((b) => `[${b.lower}, ${b.upper}]`), [])
        line.push(`lockHeld ${fmt(s.get(`hook.lockHeld:${x}`) ?? 0n)}, USDC is currency${rec.usdcIs0 ? '0' : '1'}`)
      }
      if (usesHolders(k) && !REAL) await conservation(`${x} final`, token, B)
      note(line.join('; '))
    }
    if (!REAL) {
      // The PoolManager holds at least what every position is worth at the pools' prices (rounded down) plus the hook's
      // claims; what is left over is the rounding every swap and add keeps in the pools' favour.
      let usdcInPools = 0n
      for (const k of made.filter((kk) => progress.pools[kk])) {
        const rec = poolRec(k)
        const x = sym(k)
        const sqrtP = s.get(`pool.sqrtP:${x}`) ?? 0n
        const tick = Number(s.get(`pool.tick:${x}`) ?? 0n)
        let a0 = 0n
        let a1 = 0n
        for (const p of positionsAt(k, B)) {
          const [sa, sb] = [V4.sqrtAtTick(p.lower), V4.sqrtAtTick(p.upper)]
          if (tick < p.lower) a0 += V4.amount0Delta(sa, sb, p.liquidity, false)
          else if (tick < p.upper) {
            a0 += V4.amount0Delta(sqrtP, sb, p.liquidity, false)
            a1 += V4.amount1Delta(sa, sqrtP, p.liquidity, false)
          } else a1 += V4.amount1Delta(sa, sb, p.liquidity, false)
        }
        const [u, t] = rec.usdcIs0 ? [a0, a1] : [a1, a0]
        usdcInPools += u
        const dust = (s.get(`tok.poolManager:${x}`) ?? 0n) - t
        checkThat(`${x}: the PoolManager holds the tokens its positions are worth, and a little rounding more`, dust >= 0n && dust < 10n ** 9n, `${fmt18(t)} in positions, ${dust} wei over`)
      }
      const baseline = BigInt(progress.notes.pmUsdcBaseline ?? '0')
      const usdcDust = (s.get('usdc:poolManager') ?? 0n) - baseline - usdcInPools - (s.get('hook.claims') ?? 0n)
      checkThat(`the PoolManager holds the ${U} every position is worth plus the hook's claims, and a little rounding more`, usdcDust >= 0n && usdcDust < 1000n, `${fmt(usdcInPools)} in positions over a ${fmt(baseline)} baseline, ${usdcDust} unit(s) over`)
      check('the Split plugin holds Σ usdcHeld of its tokens', s.get('usdc:split'), (await rd<bigint>(SPLIT, ABI.split, 'usdcHeld', [tokenOf('split')], B)) + (await rd<bigint>(SPLIT, ABI.split, 'usdcHeld', [tokenOf('combo')], B)))
      check('the Holders plugin and the Combo hold nothing (they forward it all)', [s.get('usdc:holders'), s.get('usdc:combo')], [0n, 0n])
    }
    checkThat('the curve surcharge was exercised: window buys landed inside the window', windowPaid > 0, `${windowPaid} of ${windowBuys} window buys paid it`)
    if (!REAL) {
      const bps = made.map((k) => BigInt(progress.notes[`graduate:${k}:poolWindowBps`] ?? '0'))
      checkThat("the pool's surcharge was exercised: window buys paid it and placed it as bids", bps.some((b) => b > 0n), `window buys paid ${bps.join(', ')} bps`)
      // Both cases, in both pool orientations: the cap and the crash each pick a different end of _cheaperOf.
      const sides = (ks: Kind[]) => [...new Set(ks.map((k) => `USDC as currency${poolRec(k).usdcIs0 ? '0' : '1'}`))].sort()
      const graduated = made.filter((k) => progress.pools[k])
      const capped = graduated.filter((k) => progress.notes[`graduate:${k}:cappedBid`])
      check(`the cap was exercised in every orientation: a window buy from above the graduation price got the graduation bid's range (${capped.map(sym).join(', ') || 'none'})`, sides(capped), sides(graduated))
      const crashed = progress.features.filter((k) => progress.notes[`graduate:${k}:crashBid`])
      check(`the crash case was exercised in every orientation: a window buy after a dump under half the graduation price placed its bid from the crashed price (${crashed.map(sym).join(', ') || 'none'})`,
        sides(crashed), sides(progress.features))
      const held = progress.features.filter((k) => progress.notes[`graduate:${k}:liftAfterCrash`])
      check(`the reference held after a lift in every orientation: after the crash, a lift back above the graduation price and one more window buy, whose bid still started from half the crashed price (${held.map(sym).join(', ') || 'none'})`,
        sides(held), sides(progress.features))
      // Where each pool's reference ended: the crashed price where a window buy followed a crash, else graduation's.
      check("each pool's bidRefTick at the end: the crashed price after a crash buy, the graduation price otherwise",
        graduated.map((k) => `${sym(k)} ${s.get(`hook.bidRef:${sym(k)}`)}`),
        graduated.map((k) => `${sym(k)} ${progress.notes[`graduate:${k}:crashRef`] ?? poolRec(k).graduationTick}`))
    }
  }, true)
}

// ── Summary and record ────────────────────────────────────────────────────────

interface Row {
  step: string
  what: string
  hash: string
  gasUsed: bigint
  costWei: bigint
}
async function summary() {
  const rows: Row[] = []
  for (const [what, hash] of Object.entries(dep.txs)) {
    const r = await retry(() => pub.getTransactionReceipt({ hash }))
    rows.push({ step: 'deploy', what, hash, gasUsed: r.gasUsed, costWei: r.gasUsed * r.effectiveGasPrice })
  }
  for (const t of progress.txs) rows.push({ step: t.step, what: t.what, hash: t.hash, gasUsed: BigInt(t.gasUsed), costWei: BigInt(t.gasUsed) * BigInt(t.gasPrice) })
  const usdcOfWei = (wei: bigint) => Number(formatUnits(wei, 18)).toFixed(6)
  const live = (gas: bigint) => usdcOfWei(gas * LIVE_GAS_PRICE)
  const result = (id: string) => (id === 'deploy' ? 'deployed' : progress.done[id] ? 'pass' : progress.results.find((r) => r.step === id)?.ok === false ? 'FAIL' : '…')
  const stepChecks = (id: string) => progress.results.find((r) => r.step === id)?.checks ?? 0
  console.log(`\n── gas (${rows.length} transactions; "at 25 gwei" is what Arc Testnet charges)`)
  if (MARKDOWN) {
    // Hashes only mean something on Arc Testnet; a fork's are thrown away with it.
    const hashes = chainId === ARC_TESTNET
    console.log(hashes ? '| step | transaction | tx hash | gas | USDC at 25 gwei |\n| --- | --- | --- | ---: | ---: |' : '| step | transaction | gas | USDC at 25 gwei |\n| --- | --- | ---: | ---: |')
    for (const r of rows) console.log(`| ${r.step} | ${r.what} |${hashes ? ` \`${r.hash}\` |` : ''} ${r.gasUsed.toLocaleString('en-US')} | ${live(r.gasUsed)} |`)
    const steps = [...new Set(rows.map((r) => r.step))]
    console.log('\n| step | transactions | checks | gas | USDC at 25 gwei | result |\n| --- | ---: | ---: | ---: | ---: | --- |')
    for (const st of steps) {
      const rs = rows.filter((r) => r.step === st)
      const g = rs.reduce((sum, r) => sum + r.gasUsed, 0n)
      console.log(`| ${st} | ${rs.length} | ${stepChecks(st) || ''} | ${g.toLocaleString('en-US')} | ${live(g)} | ${result(st)} |`)
    }
    const noTx = progress.results.filter((r) => !rows.some((x) => x.step === r.step))
    for (const r of noTx) console.log(`| ${r.step} | 0 | ${r.checks} | 0 | 0 | ${r.ok ? 'pass' : 'FAIL'} |`)
  } else {
    for (const r of rows) console.log(`${r.step.padEnd(18)} ${r.what.slice(0, 58).padEnd(58)} ${r.hash.slice(0, 18)}…  ${r.gasUsed.toString().padStart(9)}  ${live(r.gasUsed)}`)
  }
  const deployGas = rows.filter((r) => r.step === 'deploy').reduce((s, r) => s + r.gasUsed, 0n)
  const driveGas = rows.filter((r) => r.step !== 'deploy').reduce((s, r) => s + r.gasUsed, 0n)
  const driveWei = rows.filter((r) => r.step !== 'deploy').reduce((s, r) => s + r.costWei, 0n)
  console.log(`deploy: ${deployGas} gas, ${live(deployGas)} USDC at 25 gwei`)
  console.log(`drive:  ${driveGas} gas, ${live(driveGas)} USDC at 25 gwei (${usdcOfWei(driveWei)} USDC at this chain's prices)`)
  console.log(`total:  ${deployGas + driveGas} gas, ${live(deployGas + driveGas)} USDC at 25 gwei`)
  const totalChecks = progress.results.reduce((s, r) => s + r.checks, 0)
  const failedSteps = progress.results.filter((r) => !r.ok)
  console.log(`steps: ${Object.keys(progress.done).length} done${failedSteps.length ? `, failing: ${failedSteps.map((r) => r.step).join(', ')}` : ''}; checks across steps: ${totalChecks}; this run: ${checks} checks, ${failures} failed, ${rpcRetries} RPC retries`)
  return { deployGas, driveGas, totalChecks, txs: rows.length }
}

async function writeRecord() {
  if (!DRIVING) return
  const s = await summary()
  const record = JSON.parse(readFileSync(DEPLOYMENT, 'utf8')) as Record<string, unknown>
  record.rehearsal = {
    actor: me,
    signer: SIGNER,
    rawSwapper: progress.raw ?? null,
    tokens: Object.fromEntries(KINDS.filter((k) => progress.tokens[k]).map((k) => [sym(k), {
      address: tokenOf(k), kind: k, creatorFeeBps: Number(spec(k).feeBps), open: spec(k).open, usdcIsCurrency0: BigInt(USDC) < BigInt(tokenOf(k)),
      poolId: progress.pools[k]?.poolId ?? null,
    }])),
    steps: Object.keys(progress.done).length,
    transactions: s.txs,
    checks: s.totalChecks,
    gas: { deploy: s.deployGas.toString(), drive: s.driveGas.toString() },
    usdcAt25Gwei: Number(formatUnits((s.deployGas + s.driveGas) * LIVE_GAS_PRICE, 18)).toFixed(6),
    finishedAt: new Date().toISOString(),
  }
  writeFileSync(DEPLOYMENT, `${JSON.stringify(record, null, 2)}\n`)
  console.log(`\nwrote the rehearsal record into ${DEPLOYMENT}`)
}

// ── Run ───────────────────────────────────────────────────────────────────────

try {
  console.log(`${dep.network}, chain ${chainId}, ${REAL ? "Run B (Arc's USDC)" : 'Run A (rUSDC)'}, signer ${SIGNER}${DRIVING ? `, actor ${me}` : ''}`)
  if (SIGNER === 'anvil') {
    await rpc('anvil_impersonateAccount', [me])
    const bal = await nativeOf(me, await latest())
    if (bal < 100n * E18) await rpc('anvil_setBalance', [me, toHex(100n * E18)])
    if (RUSDC_OWNER !== me) {
      // The actor is someone else (an anvil default account, say): the owner mints rUSDC and is feeTo, as itself.
      await rpc('anvil_impersonateAccount', [RUSDC_OWNER])
      if ((await nativeOf(RUSDC_OWNER, await latest())) < E18) await rpc('anvil_setBalance', [RUSDC_OWNER, toHex(10n * E18)])
      note(`anvil: impersonating rUSDC's owner ${RUSDC_OWNER} for the mints`)
    }
    note(`anvil: impersonating ${me}; native balance ${fmt18(bal)} → ${fmt18(await nativeOf(me, await latest()))}`)
  }
  await deployment()
  if (!DRIVING) {
    if (progressExists && Object.keys(progress.tokens).length) await finalState()
    else console.log('\nSIGNER not set and nothing driven yet: read-only checks only.')
    await summary()
    process.exit(failures ? 1 : 0)
  }
  progress.actor = me
  save()
  console.log(`\nactor ${me}: ${fmt18(await nativeOf(me, head))} USDC native${REAL ? '' : `, ${fmt(await rd<bigint>(USDC, ABI.erc20, 'balanceOf', [me], head))} rUSDC`}`)
  await recoverPending()
  if (!REAL) {
    await deployRaw()
    await fund()
  }
  await approvals()
  await plan()
  for (const [i, k] of KINDS.entries()) await create(k, i === 0)
  for (const [i, k] of KINDS.entries()) await curveTrades(k, i === 0)
  if (REAL) {
    // Sell everything back first, so the float returns and every fee but the surcharge comes back to the actor (it is
    // the creator-fee destination and feeTo).
    for (const k of KINDS) {
      await sellAll(k)
      await collect(k)
    }
  } else {
    for (const [i, k] of KINDS.entries()) await graduate(k, i === 0)
    await fundRaw()
    for (const k of KINDS) await poolTrades(k)
    for (const k of progress.features) await rawSwaps(k)
    await outsideLiquidity()
    await syncOne('wallet')
    await syncBatch(['split', 'zero', 'wallet'])
    for (const k of KINDS) {
      await collect(k)
      if (k === 'split') await releaseSplit()
    }
    await sample()
    for (const k of KINDS.filter(usesHolders)) await claim(k)
  }
  await collectPlatformFees()
  await finalState()
  await writeRecord()
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
  process.exit(failures ? 1 : 0)
} catch (e) {
  console.log(`\nERROR: ${errorText(e).split('\n').slice(0, 8).join('\n')}`)
  save()
  await summary().catch(() => undefined)
  process.exit(1)
}
