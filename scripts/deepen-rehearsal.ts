/**
 * Arc Testnet rehearsal of the Deepen pool creator-fee plugin (docs/launchpad/DEEPEN-REHEARSAL.md; V13-SPEC §2.3).
 *
 *   bun run scripts/deepen-rehearsal.ts                 # read-only: wiring, constants and the state reached so far
 *   BURNER_KEY=0x… bun run scripts/deepen-rehearsal.ts  # deploys the plugin and drives the rehearsal; resumable
 *
 * It deploys one DeepenPoolPlugin against the existing rUSDC launchpad suite
 * (deployments/arc-testnet-v13-rehearsal.json: launchpad 0xCEbf26B8…, mintable rUSDC 0x30929701…, whose owner is the
 * burner, so the burner mints the rUSDC it needs), confirms the deployed code equals the local build, and drives four
 * tokens with different burn shares plus a Combo entry through the curve and the pool, checking to the unit after every
 * transaction. It then reproduces the round-5 review's H1 attack live with the Settler from
 * contracts/test/review2/CapInflationSettle.t.sol and records its P&L, which is a loss.
 *
 * After every transaction it checks: previewRun equals what the run offered; the plugin's rUSDC balance covers the sum
 * of every token's usdcHeld; the plugin holds no launch token and no LP; LP at 0x…dEaD never falls and rose by exactly
 * the run's reported liquidity; the token's total supply fell by exactly tokensBurned; the pool cap equals an
 * off-chain 0.25% of the LOCKED part of the reserve, prorated by the time since the last run; and the launchpad's
 * books balance (USDC held == pendingFees + Σ pendingCreatorFees + Σ live curve floats).
 *
 * Testnet only: it refuses every chain but Arc Testnet (5042002) and never sends to mainnet. The key is read from
 * BURNER_KEY into this process alone, is never printed, logged or written, and the script cannot echo it.
 *
 * Progress (the deployed addresses, mined transactions and finished steps) lives in
 * deployments/arc-testnet-deepen-rehearsal.progress.json (gitignored): a re-run skips finished steps, never re-sends a
 * mined transaction and re-checks a step whose transaction was mined but not yet checked.
 *
 * Environment: DEPLOYMENT (the base v1.3 suite, default deployments/arc-testnet-v13-rehearsal.json),
 * RECORD (the deepen record written, default deployments/arc-testnet-deepen-rehearsal.json), PROGRESS, ARC_TESTNET_RPC,
 * ARTIFACTS (default contracts/out), GAS_CAP (USDC of gas this driver may spend, default 1.5), MARKDOWN=1.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  decodeFunctionData,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseEventLogs,
  stringToHex,
  toFunctionSelector,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

// ── Configuration ─────────────────────────────────────────────────────────────

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ARC_TESTNET = 5042002
const ARC_MAINNET = 5042
const DEAD = getAddress('0x000000000000000000000000000000000000dEaD')

const DEPLOYMENT = resolve(ROOT, process.env.DEPLOYMENT ?? 'deployments/arc-testnet-v13-rehearsal.json')
const RECORD = resolve(ROOT, process.env.RECORD ?? 'deployments/arc-testnet-deepen-rehearsal.json')
const PROGRESS = resolve(ROOT, process.env.PROGRESS ?? RECORD.replace(/\.json$/, '.progress.json'))
const ARTIFACTS = resolve(ROOT, process.env.ARTIFACTS ?? 'contracts/out')
const RPC = process.env.ARC_TESTNET_RPC ?? 'https://rpc.testnet.arc.io'
const MARKDOWN = process.env.MARKDOWN === '1'

// Curve, fee and plugin constants (V13-SPEC §1, §2.3, §5); the wiring checks compare them with the contracts.
const E18 = 10n ** 18n
const BPS = 10_000n
const FEE_BPS = 50n
const TOTAL_SUPPLY = 1_000_000_000n * E18
const CURVE_SUPPLY = 800_000_000n * E18
const POOL_SUPPLY = 200_000_000n * E18
const VIRTUAL_USDC_0 = 8_333_333_333n
const VIRTUAL_TOKENS_0 = 1_066_666_667n * E18
const MINIMUM_LIQUIDITY = 1000n
const CAP_BPS = 25n
const RUN_INTERVAL = 3600n
const MIN_RUN_USDC = 3n
const DEFAULT_BURN_BPS = 5_000n
/** On Arc the native balance is the gas token at 6 decimals: one USDC base unit is 1e12 wei. */
const WEI_PER_UNIT = 10n ** 12n

interface Deployment {
  chainId: number
  deployer: string
  usdc: string
  launchpad: string
  pairFactory: string
  router: string
  plugins: { split: string; buybackBurn: string; holders: string; combo: string }
  launchFee: string
  feeTo: string
  feeToSetter: string
}
const dep = JSON.parse(readFileSync(DEPLOYMENT, 'utf8')) as Deployment
const USDC = getAddress(dep.usdc)
const LP = getAddress(dep.launchpad)
const FACTORY = getAddress(dep.pairFactory)
const ROUTER = getAddress(dep.router)
const COMBO = getAddress(dep.plugins.combo)

const artifactJson = (name: string) =>
  JSON.parse(readFileSync(resolve(ARTIFACTS, `${name}.sol`, `${name}.json`), 'utf8')) as {
    abi: Abi
    bytecode: { object: Hex }
    deployedBytecode: { object: string; immutableReferences?: Record<string, { start: number; length: number }[]> }
  }
const artifact = (name: string): Abi => artifactJson(name).abi
// The Settler lives in a test file, so its artifact path is contracts/out/CapInflationSettle.t.sol/Settler.json.
const settlerArtifact = JSON.parse(
  readFileSync(resolve(ARTIFACTS, 'CapInflationSettle.t.sol', 'Settler.json'), 'utf8'),
) as { abi: Abi; bytecode: { object: Hex } }
const ABI = {
  pad: artifact('ArchitexLaunchpad'),
  router: artifact('LaunchRouter'),
  factory: artifact('LaunchPairFactory'),
  pair: artifact('LaunchPair'),
  token: artifact('LaunchToken'),
  erc20: artifact('TestToken'),
  combo: artifact('ComboPlugin'),
  deepen: artifact('DeepenPoolPlugin'),
  settler: settlerArtifact.abi,
}

const usd = (n: number) => BigInt(Math.round(n * 1e6))
const fmt = (units: bigint) => formatUnits(units, 6)
const fmt18 = (units: bigint) => formatUnits(units, 18)
const GAS_CAP_WEI = BigInt(Math.round(Number(process.env.GAS_CAP ?? '1.5') * 1e6)) * WEI_PER_UNIT

// ── The tokens ──────────────────────────────────────────────────────────────

type Kind = 'd1' | 'd0' | 'dfull' | 'dcombo' | 'atk'
const MAIN: readonly Kind[] = ['d1', 'd0', 'dfull', 'dcombo']

/** A fixed address nobody holds a key for: the last 20 bytes of a hash of a label. It only ever receives fees. */
const fixedAddress = (label: string) => getAddress(`0x${keccak256(stringToHex(`architex/deepen-rehearsal/${label}`)).slice(-40)}`)
const COMBO_WALLET = fixedAddress('combo-wallet')

interface Spec {
  name: string
  symbol: string
  feeBps: bigint
  burnBps: bigint // the burn share the plugin ends up configured with (through data, or the Combo's forwarded data)
  plugin: Address
  data: Hex
  hooks: boolean
  combo?: { targets: Address[]; bps: number[]; datas: Hex[] } // for the Combo token
}
let DEEPEN: Address // set after deploy
const deepenData = (burnBps: bigint | null): Hex =>
  burnBps === null ? '0x' : encodeAbiParameters([{ type: 'uint16' }], [Number(burnBps)])

// Built once DEEPEN is known.
let SPECS: Record<Kind, Spec>
function buildSpecs() {
  // Combo of Deepen pool (burn share 2,500, forwarded as its onLaunch data) and a plain wallet, 70/30.
  const comboTargets = [DEEPEN, COMBO_WALLET]
  const comboBps = [7000, 3000]
  const comboDatas: Hex[] = [deepenData(2_500n), '0x']
  SPECS = {
    d1: { name: 'Deepen Default', symbol: 'DPD', feeBps: 200n, burnBps: DEFAULT_BURN_BPS, plugin: DEEPEN, data: deepenData(null), hooks: true },
    d0: { name: 'Deepen Liquidity', symbol: 'DP0', feeBps: 100n, burnBps: 0n, plugin: DEEPEN, data: deepenData(0n), hooks: true },
    dfull: { name: 'Deepen Burn', symbol: 'DPF', feeBps: 100n, burnBps: 10_000n, plugin: DEEPEN, data: deepenData(10_000n), hooks: true },
    dcombo: {
      name: 'Deepen Combo',
      symbol: 'DPC',
      feeBps: 200n,
      burnBps: 2_500n,
      plugin: COMBO,
      data: encodeAbiParameters([{ type: 'address[]' }, { type: 'uint16[]' }, { type: 'bytes[]' }], [comboTargets, comboBps, comboDatas]),
      hooks: true,
      combo: { targets: comboTargets, bps: comboBps, datas: comboDatas },
    },
    atk: { name: 'Deepen Target', symbol: 'DPT', feeBps: 100n, burnBps: DEFAULT_BURN_BPS, plugin: DEEPEN, data: deepenData(null), hooks: true },
  }
}

/** USDC (6 decimals) per action. rUSDC is minted freely, so trades are large enough for every cap to bind. */
const AMOUNTS = {
  initialBuy: usd(100),
  curveBuy: usd(1000),
  graduateOffer: usd(60_000),
  poolBuy: usd(500),
}
const GRADUATION_BUDGET = usd(30_000)
/** rUSDC to have on hand per token before its curve and pool trades (minted lazily, only if short). */
const planPerToken = () => BigInt(dep.launchFee) + AMOUNTS.initialBuy + AMOUNTS.curveBuy + GRADUATION_BUDGET + AMOUNTS.poolBuy
const ATTACK_POT = usd(200_000)
const ATTACK_MINT = 10_000_000_000n * usd(1) // 10 billion rUSDC for the attacker, matching the forge fixture

// ── RPC ───────────────────────────────────────────────────────────────────────

const pub = createPublicClient({ transport: http(RPC, { retryCount: 3, retryDelay: 400, timeout: 30_000 }) })
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

function errorText(e: unknown): string {
  if (e instanceof BaseError) return `${e.shortMessage} ${e.details ?? ''} ${e.message}`
  if (e instanceof Error) return e.message
  return typeof e === 'string' ? e : 'unknown error'
}
const TRANSIENT =
  /exceeds defined limit|resource not found|429|too many|rate.?limit|timeout|timed out|took too long|ECONNRESET|ECONNREFUSED|socket|fetch failed|network error|50[234]|header not found|unknown block|block not found|missing trie node|temporar|busy|HTTP request failed/i
const transient = (e: unknown) => {
  const text = errorText(e)
  return !/revert/i.test(text) && TRANSIENT.test(text)
}

let inflight = 0
const rpcQueue: (() => void)[] = []
let rpcRetries = 0
async function retry<T>(fn: () => Promise<T>): Promise<T> {
  let delay = 400
  for (let attempt = 1; ; attempt++) {
    while (inflight >= 3) await new Promise<void>((go) => rpcQueue.push(go))
    inflight++
    try {
      return await fn()
    } catch (e) {
      if (attempt >= 10 || !transient(e)) throw e
      rpcRetries++
    } finally {
      inflight--
      rpcQueue.shift()?.()
    }
    await sleep(delay + Math.floor(Math.random() * 250))
    delay = Math.min(delay * 2, 8000)
  }
}

async function rd<T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], blockNumber?: bigint): Promise<T> {
  return (await retry(() => pub.readContract({ address, abi, functionName, args, blockNumber }))) as T
}
const erc20Of = (token: Address, who: Address, block: bigint) => rd<bigint>(token, ABI.erc20, 'balanceOf', [who], block)
const usdcOf = (who: Address, block: bigint) => erc20Of(USDC, who, block)
const nativeOf = (who: Address, block: bigint) => retry(() => pub.getBalance({ address: who, blockNumber: block }))
const nonceOf = (who: Address, block: bigint) => retry(() => pub.getTransactionCount({ address: who, blockNumber: block }))
const timeOf = async (block: bigint) => (await retry(() => pub.getBlock({ blockNumber: block }))).timestamp
const latest = () => retry(() => pub.getBlockNumber({ cacheTime: 0 }))
const deadline = async () => (await timeOf(head)) + 3600n
/** Waits until the chain's latest block is at least `target` seconds, and reads from there on. */
async function waitUntilTime(target: bigint) {
  for (;;) {
    const b = await latest()
    if (b >= head && (await timeOf(b)) >= target) {
      head = b
      return
    }
    await sleep(1000)
  }
}

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
  console.log(ok ? `ok   ${label}: ${a.length > 90 ? `${a.slice(0, 87)}…` : a}` : `FAIL ${label}: got ${a}, expected ${show(expected)}`)
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

async function expectRevert(label: string, address: Address, abi: Abi, functionName: string, args: readonly unknown[], errorName: string, block: bigint, from?: Address) {
  let got = 'ok'
  try {
    await retry(() => pub.simulateContract({ address, abi, functionName, args, account: from ?? me ?? (dep.deployer as Address), blockNumber: block }))
  } catch (e) {
    got = revertName(e)
  }
  check(errorName === 'ok' ? `${label} is accepted` : `${label} reverts`, got, errorName)
}
function revertName(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError)
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.signature ?? r.reason ?? 'unknown revert'
  }
  return errorText(e).split('\n')[0]
}

// ── Model: the spec's formulas, written independently of the contracts ────────

const divCeil = (a: bigint, b: bigint) => (a === 0n ? 0n : (a - 1n) / b + 1n)
const minOf = (a: bigint, b: bigint) => (a < b ? a : b)
const maxOf = (a: bigint, b: bigint) => (a > b ? a : b)
const mulDiv = (a: bigint, b: bigint, d: bigint) => (a * b) / d
function sqrt(n: bigint): bigint {
  if (n < 2n) return n
  let x = n
  let y = (x + 1n) / 2n
  while (y < x) {
    x = y
    y = (x + n / x) / 2n
  }
  return x
}

interface CurveState {
  virtualUsdc: bigint
  virtualTokens: bigint
  tokensSold: bigint
}
const INITIAL_CURVE: CurveState = { virtualUsdc: VIRTUAL_USDC_0, virtualTokens: VIRTUAL_TOKENS_0, tokensSold: 0n }
interface BuyQuote {
  tokensOut: bigint
  platformFee: bigint
  creatorFee: bigint
  usdcSpent: bigint
  graduates: boolean
  net: bigint
}
/** V13-SPEC §5 buy math, including the exact-fill (sell-out) buy. */
function modelCurveBuy(c: CurveState, usdcIn: bigint, creatorBps: bigint): BuyQuote {
  const k = c.virtualUsdc * c.virtualTokens
  const platformFee = divCeil(usdcIn * FEE_BPS, BPS)
  const creatorFee = divCeil(usdcIn * creatorBps, BPS)
  if (platformFee + creatorFee >= usdcIn) throw new Error('model: fees eat the whole input')
  const net = usdcIn - platformFee - creatorFee
  const out = c.virtualTokens - divCeil(k, c.virtualUsdc + net)
  const remaining = CURVE_SUPPLY - c.tokensSold
  if (out < remaining) return { tokensOut: out, platformFee, creatorFee, usdcSpent: usdcIn, graduates: false, net }
  const feeBps = FEE_BPS + creatorBps
  const fillNet = divCeil(k, c.virtualTokens - remaining) - c.virtualUsdc
  const gross = fillNet + divCeil(fillNet * feeBps, BPS - feeBps)
  const usdcSpent = minOf(gross, usdcIn)
  const totalFee = usdcSpent - fillNet
  const fillPlatform = divCeil(totalFee * FEE_BPS, feeBps)
  return { tokensOut: remaining, platformFee: fillPlatform, creatorFee: totalFee - fillPlatform, usdcSpent, graduates: true, net: fillNet }
}
/** V13-SPEC §4: launch-pool buy, both fees from the USDC in, constant product with no pool fee. */
function modelPoolBuy(reserveToken: bigint, reserveUsdc: bigint, usdcIn: bigint, creatorBps: bigint) {
  const platformFee = divCeil(usdcIn * FEE_BPS, BPS)
  const creatorFee = divCeil(usdcIn * creatorBps, BPS)
  const net = usdcIn - platformFee - creatorFee
  return { tokensOut: (net * reserveToken) / (reserveUsdc + net), platformFee, creatorFee, net }
}
/** V13-SPEC §4: launch-pool sell, both fees from the USDC out. */
function modelPoolSell(reserveToken: bigint, reserveUsdc: bigint, tokensIn: bigint, creatorBps: bigint) {
  const gross = (tokensIn * reserveUsdc) / (reserveToken + tokensIn)
  const platformFee = divCeil(gross * FEE_BPS, BPS)
  const creatorFee = divCeil(gross * creatorBps, BPS)
  return { gross, platformFee, creatorFee, usdcOut: gross - platformFee - creatorFee }
}

// The Deepen pool's own math (DeepenPoolPlugin.sol), ported to check the run to the unit.
/** _sides: burnBps of the offer buys to burn (rounded down), the rest buys and adds; a side below MIN goes to 0. */
function sides(offer: bigint, burnBps: bigint): [bigint, bigint] {
  let usdcToBurn = (offer * burnBps) / BPS
  let usdcToDeepen = offer - usdcToBurn
  if (usdcToBurn < MIN_RUN_USDC) [usdcToBurn, usdcToDeepen] = [0n, offer]
  else if (usdcToDeepen < MIN_RUN_USDC) [usdcToBurn, usdcToDeepen] = [offer, 0n]
  return [usdcToBurn, usdcToDeepen]
}
/** _usdcToBuy: the buy half of the deepen offer, rounded down, in [MIN_RUN_USDC, offer]. feeBps = 50 + creator. */
function usdcToBuy(offer: bigint, reserveUsdc: bigint, feeBps: bigint): bigint {
  const q = BPS - feeBps
  const s = BPS + q
  const root = sqrt(s * s * reserveUsdc * reserveUsdc + 4n * q * q * offer * reserveUsdc)
  let toBuy = mulDiv(2n * BPS * offer, reserveUsdc, s * reserveUsdc + root)
  if (toBuy < MIN_RUN_USDC) toBuy = MIN_RUN_USDC
  if (toBuy > offer) toBuy = offer
  return toBuy
}
/** _addAmounts: the Uniswap V2 optimal add at the pool's reserves, and the LP it mints. */
function addAmounts(tokens: bigint, usdcLeft: bigint, reserveToken: bigint, reserveUsdc: bigint, supply: bigint) {
  if (tokens === 0n || usdcLeft === 0n) return { tokenAmount: 0n, usdcAmount: 0n, liquidity: 0n }
  let usdcAmount = mulDiv(tokens, reserveUsdc, reserveToken)
  let tokenAmount = tokens
  if (usdcAmount > usdcLeft) {
    usdcAmount = usdcLeft
    tokenAmount = mulDiv(usdcLeft, reserveToken, reserveUsdc)
  }
  const liquidity = minOf((tokenAmount * supply) / reserveToken, (usdcAmount * supply) / reserveUsdc)
  if (liquidity === 0n) return { tokenAmount: 0n, usdcAmount: 0n, liquidity: 0n }
  return { tokenAmount, usdcAmount, liquidity }
}
interface RunOutcome {
  usdcSpent: bigint
  usdcBurning: bigint
  usdcAdded: bigint
  tokensBought: bigint
  tokensAdded: bigint
  tokensBurned: bigint
  liquidity: bigint
}
/** A full off-chain model of one graduated run against a pool of (reserveToken, reserveUsdc, lpSupply). */
function modelPoolRun(reserveToken: bigint, reserveUsdc: bigint, lpSupply: bigint, offer: bigint, burnBps: bigint, creatorBps: bigint): RunOutcome {
  const feeBps = FEE_BPS + creatorBps
  const [usdcToBurn, usdcToDeepen] = sides(offer, burnBps)
  let rT = reserveToken
  let rU = reserveUsdc
  const o: RunOutcome = { usdcSpent: 0n, usdcBurning: 0n, usdcAdded: 0n, tokensBought: 0n, tokensAdded: 0n, tokensBurned: 0n, liquidity: 0n }
  if (usdcToBurn !== 0n) {
    const m = modelPoolBuy(rT, rU, usdcToBurn, creatorBps)
    o.tokensBought += m.tokensOut
    o.usdcBurning = usdcToBurn
    o.usdcSpent = usdcToBurn
    rT -= m.tokensOut
    rU += m.net
  }
  if (usdcToDeepen !== 0n) {
    const toBuy = usdcToBuy(usdcToDeepen, rU, feeBps)
    const m = modelPoolBuy(rT, rU, toBuy, creatorBps)
    o.tokensBought += m.tokensOut
    o.usdcSpent += toBuy
    rT -= m.tokensOut
    rU += m.net
    const add = addAmounts(m.tokensOut, usdcToDeepen - toBuy, rT, rU, lpSupply)
    o.tokensAdded = add.tokenAmount
    o.usdcAdded = add.usdcAmount
    o.liquidity = add.liquidity
    o.usdcSpent += add.usdcAmount
  }
  o.tokensBurned = o.tokensBought - o.tokensAdded
  return o
}
/** What a run offers at time `t`: 0.25% of the base, prorated (full cap on the first run), capped by held, 0 below MIN. */
function runOffer(held: bigint, base: bigint, lastRunAt: bigint, t: bigint): bigint {
  const cap = (base * CAP_BPS) / BPS
  const budget = lastRunAt === 0n || t - lastRunAt >= RUN_INTERVAL ? cap : (cap * (t - lastRunAt)) / RUN_INTERVAL
  const offer = minOf(held, budget)
  return offer < MIN_RUN_USDC ? 0n : offer
}

// ── Chain guard, key, progress ───────────────────────────────────────────────

const chainId = await retry(() => pub.getChainId())
if (chainId !== ARC_TESTNET) {
  throw new Error(`Refusing to run on chain ${chainId}${chainId === ARC_MAINNET ? ' (Arc mainnet)' : ''}: this rehearsal is for Arc Testnet (${ARC_TESTNET}) only.`)
}
if (dep.chainId !== chainId) throw new Error(`${DEPLOYMENT} is for chain ${dep.chainId}, the RPC is chain ${chainId}`)

const rawKey = process.env.BURNER_KEY?.trim()
let account: ReturnType<typeof privateKeyToAccount> | undefined
if (rawKey) {
  const key = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('BURNER_KEY is not a 32-byte hex private key')
  account = privateKeyToAccount(key as Hex)
}
const me: Address | undefined = account?.address

interface TxRecord {
  step: string
  what: string
  hash: Hex
  block: string
  gasUsed: string
  gasPrice: string
  status: string
}
interface StepResult {
  step: string
  ok: boolean
  checks: number
  failed: string[]
  at: string
}
interface Progress {
  launchpad: Address
  burner?: Address
  deepen?: Address
  settler?: Address
  tokens: Partial<Record<Kind, Address>>
  done: Record<string, string>
  txs: TxRecord[]
  results: StepResult[]
  notes: Record<string, string>
  pending?: { step: string; what: string; hash: Hex; nonce: number }
}
const progressExists = existsSync(PROGRESS)
const progress: Progress = progressExists
  ? (JSON.parse(readFileSync(PROGRESS, 'utf8')) as Progress)
  : { launchpad: LP, tokens: {}, done: {}, txs: [], results: [], notes: {} }
if (getAddress(progress.launchpad) !== LP) throw new Error(`${PROGRESS} belongs to launchpad ${progress.launchpad}, not ${LP}`)
if (me && progress.burner && getAddress(progress.burner) !== me) throw new Error(`${PROGRESS} was driven by ${progress.burner}, not ${me}`)
function save() {
  if (!account) return
  const tmp = `${PROGRESS}.tmp`
  writeFileSync(tmp, `${JSON.stringify(progress, null, 2)}\n`)
  renameSync(tmp, PROGRESS)
}
const tokenOf = (kind: Kind): Address => {
  const t = progress.tokens[kind]
  if (!t) throw new Error(`no ${kind} token yet`)
  return getAddress(t)
}

let head = await latest()

// ── Sending ───────────────────────────────────────────────────────────────────

let nextNonce = 0
const spentWei = () => progress.txs.reduce((sum, t) => sum + BigInt(t.gasUsed) * BigInt(t.gasPrice), 0n)

function recordTx(step: string, what: string, r: TransactionReceipt) {
  progress.txs.push({
    step,
    what,
    hash: r.transactionHash,
    block: r.blockNumber.toString(),
    gasUsed: r.gasUsed.toString(),
    gasPrice: r.effectiveGasPrice.toString(),
    status: r.status,
  })
  if (r.blockNumber > head) head = r.blockNumber
}

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
          const seen = await pub.getTransaction({ hash }).catch(() => undefined)
          if (seen) return 'sent'
          await sleep(1000)
        }
        return 'taken'
      }
      if (attempt >= 8 || !transient(e)) throw e
      await sleep(500 * 2 ** attempt)
    }
  }
}

/** Signs and sends one transaction (`to` undefined = a contract creation), waits for the receipt, records it. */
async function sendRaw(step: string, what: string, to: Address | undefined, data: Hex): Promise<TransactionReceipt> {
  if (!account || !me) throw new Error('BURNER_KEY is needed to send transactions')
  try {
    await retry(() => pub.call({ account: me, to, data, blockNumber: head }))
  } catch (e) {
    throw new Error(`${what} would revert: ${revertName(e)}`)
  }
  const estimate = await retry(() => pub.estimateGas({ account: me, to, data, blockNumber: head }))
  const gas = estimate + estimate / 4n + 25_000n
  const block = await retry(() => pub.getBlock({ blockNumber: head }))
  const tip = await retry(() => pub.estimateMaxPriorityFeePerGas())
  const maxFeePerGas = (block.baseFeePerGas ?? 0n) * 2n + tip
  const worst = gas * maxFeePerGas
  if (spentWei() + worst > GAS_CAP_WEI) {
    throw new Error(`${what}: gas cap reached (${formatUnits(spentWei(), 18)} USDC spent, cap ${formatUnits(GAS_CAP_WEI, 18)}; raise GAS_CAP to go on)`)
  }
  for (let attempt = 1; ; attempt++) {
    const pendingNonce = await retry(() => pub.getTransactionCount({ address: me, blockTag: 'pending' }))
    const nonce = Math.max(pendingNonce, nextNonce)
    const serialized = await account.signTransaction({ type: 'eip1559', chainId, to, data, gas, nonce, maxFeePerGas, maxPriorityFeePerGas: tip })
    const hash = keccak256(serialized)
    progress.pending = { step, what, hash, nonce }
    save()
    if ((await broadcast(serialized, hash)) === 'taken') {
      if (attempt >= 3) throw new Error(`${what}: nonce ${nonce} keeps being taken by another transaction from the burner`)
      note(`nonce ${nonce} was taken by another transaction from the burner; re-signing`)
      continue
    }
    nextNonce = nonce + 1
    const receipt = await retry(() => pub.waitForTransactionReceipt({ hash, pollingInterval: 500, timeout: 180_000 }))
    recordTx(step, what, receipt)
    progress.pending = undefined
    save()
    console.log(`     ${what}: ${hash} (block ${receipt.blockNumber}, gas ${receipt.gasUsed}, ${receipt.status})`)
    if (receipt.status !== 'success') throw new Error(`${what} reverted on chain: ${hash}`)
    return receipt
  }
}

const minedTx = (step: string, what: string) => progress.txs.find((t) => t.step === step && t.what === what && t.status === 'success')

/** Sends a call once; a transaction this step already mined is re-used, not re-sent. Returns the receipt and the
 *  arguments the mined transaction actually carried. */
async function tx(step: string, what: string, to: Address, abi: Abi, functionName: string, args: readonly unknown[]) {
  const mined = minedTx(step, what)
  if (!mined) {
    const data = encodeFunctionData({ abi, functionName, args })
    return { receipt: await sendRaw(step, what, to, data), args }
  }
  const receipt = await retry(() => pub.getTransactionReceipt({ hash: mined.hash }))
  const sent = await retry(() => pub.getTransaction({ hash: mined.hash }))
  if (receipt.blockNumber > head) head = receipt.blockNumber
  console.log(`     ${what}: ${mined.hash} (mined in an earlier run; re-checking)`)
  return { receipt, args: decodeFunctionData({ abi, data: sent.input }).args ?? [] }
}

async function recoverPending() {
  const p = progress.pending
  if (!p) return
  note(`recovering ${p.what} (${p.hash}) from an interrupted run`)
  let receipt: TransactionReceipt | undefined
  for (let i = 0; i < 40 && !receipt; i++) {
    receipt = await pub.getTransactionReceipt({ hash: p.hash }).catch(() => undefined)
    if (!receipt) await sleep(3000)
  }
  if (receipt) recordTx(p.step, p.what, receipt)
  else note('it was never mined; the step will send it again')
  progress.pending = undefined
  save()
}

// ── Typed events ──────────────────────────────────────────────────────────────

function eventsOf<T>(receipt: TransactionReceipt, address: Address, abi: Abi, eventName: string): T[] {
  const logs = receipt.logs.filter((l) => getAddress(l.address) === address)
  return parseEventLogs({ abi, logs, eventName }).map((l) => (l as unknown as { args: T }).args)
}
interface CurveView extends CurveState {
  token: Address
  creator: Address
  pair: Address
  graduated: boolean
  creatorFeeBps: number
  pluginHooks: boolean
  plugin: Address
}
const curveAt = (token: Address, block: bigint) => rd<CurveView>(LP, ABI.pad, 'curves', [token], block)
const reservesAt = async (pair: Address, block: bigint) => {
  const [reserveToken, reserveUsdc] = await rd<readonly [bigint, bigint, number]>(pair, ABI.pair, 'getReserves', [], block)
  return { reserveToken, reserveUsdc }
}
const pick = <T extends object, K extends keyof T>(o: T, keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, o[k]]))

// ── Shared checks ─────────────────────────────────────────────────────────────

/** Launchpad identity (V13-SPEC §6.1), summed over every token on the launchpad (its own and this rehearsal's). */
async function identity(what: string, block: bigint) {
  const held = await usdcOf(LP, block)
  const pendingFees = await rd<bigint>(LP, ABI.pad, 'pendingFees', [], block)
  const count = await rd<bigint>(LP, ABI.pad, 'tokensLength', [], block)
  let creator = 0n
  let floats = 0n
  for (let start = 0n; start < count; start += 100n) {
    for (const c of await rd<CurveView[]>(LP, ABI.pad, 'curvesPage', [start, 100n], block)) {
      creator += await rd<bigint>(LP, ABI.pad, 'pendingCreatorFees', [c.token], block)
      if (!c.graduated) floats += c.virtualUsdc - VIRTUAL_USDC_0
    }
  }
  check(`${what}: launchpad USDC == pendingFees + Σ pendingCreatorFees + Σ curve floats`, held, pendingFees + creator + floats)
}

/** The burner's own side: rUSDC moved by `usdc`, native moved by the gas alone (gas is Arc's USDC, not rUSDC). */
async function burnerSide(what: string, receipt: TransactionReceipt, usdc: bigint) {
  if (!me) return
  const B = receipt.blockNumber
  const gas = receipt.gasUsed * receipt.effectiveGasPrice
  const txsInBlock = (await nonceOf(me, B)) - (await nonceOf(me, B - 1n))
  if (txsInBlock !== 1) {
    note(`${what}: ${txsInBlock} burner transactions in block ${B}; native-balance check skipped`)
  } else {
    const moved = (await nativeOf(me, B)) - (await nativeOf(me, B - 1n)) + gas
    check(`${what}: burner native balance moved by the gas only`, moved, 0n)
  }
  check(`${what}: burner rUSDC`, (await usdcOf(me, B)) - (await usdcOf(me, B - 1n)), usdc)
}

/** The plugin's own containment, checked after every step that touches it: no token, no LP, and rUSDC ≥ Σ usdcHeld. */
async function pluginClean(what: string, block: bigint) {
  let sumHeld = 0n
  for (const k of MAIN) {
    const t = progress.tokens[k]
    if (!t) continue
    sumHeld += await rd<bigint>(DEEPEN, ABI.deepen, 'usdcHeld', [getAddress(t)], block)
    check(`${what}: plugin holds no ${k} token`, await erc20Of(getAddress(t), DEEPEN, block), 0n)
    const pair = getAddress((await curveAt(getAddress(t), block)).pair)
    if (pair !== getAddress('0x0000000000000000000000000000000000000000')) {
      check(`${what}: plugin holds no ${k} LP`, await erc20Of(pair, DEEPEN, block), 0n)
    }
  }
  const atk = progress.tokens.atk
  if (atk) sumHeld += await rd<bigint>(DEEPEN, ABI.deepen, 'usdcHeld', [getAddress(atk)], block)
  checkThat(`${what}: plugin rUSDC covers Σ usdcHeld`, (await usdcOf(DEEPEN, block)) >= sumHeld, `${fmt(await usdcOf(DEEPEN, block))} ≥ ${fmt(sumHeld)}`)
}

// ── Read-only: wiring and constants ──────────────────────────────────────────

const FEE_PLUGIN_ID = (() => {
  const a = parseInt(toFunctionSelector('onLaunch(address,address,bytes)').slice(2), 16)
  const b = parseInt(toFunctionSelector('onFees(address,uint256)').slice(2), 16)
  return `0x${((a ^ b) >>> 0).toString(16).padStart(8, '0')}` as Hex
})()

async function wiring() {
  console.log(`\n── wiring (rehearsal USDC, launchpad ${LP}, chain ${chainId}, block ${head})`)
  const at = head
  const a = (x: unknown) => getAddress(x as string)
  check('launchpad.usdc', a(await rd(LP, ABI.pad, 'usdc', [], at)), USDC)
  check('launchpad.router', a(await rd(LP, ABI.pad, 'router', [], at)), ROUTER)
  check('launchpad.pairFactory', a(await rd(LP, ABI.pad, 'pairFactory', [], at)), FACTORY)
  check('rUSDC.symbol', await rd(USDC, ABI.erc20, 'symbol', [], at), 'rUSDC')
  check('rUSDC.owner (can mint)', a(await rd(USDC, ABI.erc20, 'owner', [], at)), getAddress(dep.deployer))
  if (!DEEPEN) return
  check('deepen.launchpad', a(await rd(DEEPEN, ABI.deepen, 'launchpad', [], at)), LP)
  check('deepen.usdc', a(await rd(DEEPEN, ABI.deepen, 'usdc', [], at)), USDC)
  check('deepen declares IArchitexFeePlugin', await rd(DEEPEN, ABI.deepen, 'supportsInterface', [FEE_PLUGIN_ID], at), true)
  check('deepen declares IERC165', await rd(DEEPEN, ABI.deepen, 'supportsInterface', ['0x01ffc9a7'], at), true)
  check('deepen rejects 0xffffffff', await rd(DEEPEN, ABI.deepen, 'supportsInterface', ['0xffffffff'], at), false)
  check('deepen.CAP_BPS', await rd(DEEPEN, ABI.deepen, 'CAP_BPS', [], at), CAP_BPS)
  check('deepen.RUN_INTERVAL', await rd(DEEPEN, ABI.deepen, 'RUN_INTERVAL', [], at), RUN_INTERVAL)
  check('deepen.MIN_RUN_USDC', await rd(DEEPEN, ABI.deepen, 'MIN_RUN_USDC', [], at), MIN_RUN_USDC)
  check('deepen.DEFAULT_BURN_BPS', await rd(DEEPEN, ABI.deepen, 'DEFAULT_BURN_BPS', [], at), DEFAULT_BURN_BPS)
  check('deepen.LP_RECIPIENT', a(await rd(DEEPEN, ABI.deepen, 'LP_RECIPIENT', [], at)), DEAD)
}

// ── Bytecode verification (scripts/verify-bytecode.ts, inline) ─────────────────

function verifyBytecode(name: string, onchain: string): boolean {
  const art = artifactJson(name)
  const strip = (hex: string) => hex.replace(/^0x/, '').toLowerCase()
  let local = strip(art.deployedBytecode.object)
  let remote = strip(onchain)
  if (local.length !== remote.length) {
    return check(`bytecode: ${name} length`, `${remote.length / 2} bytes on chain`, `${local.length / 2} bytes local`)
  }
  const mask = (hex: string, startByte: number, lengthBytes: number) =>
    hex.slice(0, startByte * 2) + '0'.repeat(lengthBytes * 2) + hex.slice((startByte + lengthBytes) * 2)
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
  const metadataSections = (local.match(METADATA) ?? []).length
  local = blank(local)
  remote = blank(remote)
  return checkThat(`bytecode: ${name} equals the local build`, local === remote, `${local.length / 2} bytes, masked ${immutables} immutable slots and ${metadataSections} metadata hashes`)
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

/** Deploys DeepenPoolPlugin(launchpad) and confirms the code equals the local build. */
async function deployPlugin() {
  await step('deploy:deepen', async () => {
    if (!me) return
    if (progress.deepen) {
      DEEPEN = getAddress(progress.deepen)
    } else {
      const data = encodeDeployData({ abi: ABI.deepen, bytecode: artifactJson('DeepenPoolPlugin').bytecode.object, args: [LP] })
      const receipt = await sendRaw('deploy:deepen', 'deploy DeepenPoolPlugin', undefined, data)
      if (!receipt.contractAddress) throw new Error('no contract address in the deploy receipt')
      DEEPEN = getAddress(receipt.contractAddress)
      progress.deepen = DEEPEN
      save()
    }
    note(`DeepenPoolPlugin at ${DEEPEN}`)
    buildSpecs()
    const B = maxOf(await latest(), head)
    check('deepen.launchpad == the launchpad', getAddress(await rd<string>(DEEPEN, ABI.deepen, 'launchpad', [], B)), LP)
    check('deepen.usdc == rUSDC', getAddress(await rd<string>(DEEPEN, ABI.deepen, 'usdc', [], B)), USDC)
    const code = await retry(() => pub.getCode({ address: DEEPEN }))
    verifyBytecode('DeepenPoolPlugin', code ?? '0x')
    await wiring()
  })
  if (!DEEPEN && progress.deepen) {
    DEEPEN = getAddress(progress.deepen)
    buildSpecs()
  }
}

async function approvals() {
  await step('approve', async () => {
    if (!me) return
    for (const [label, spender] of [
      ['launchpad', LP],
      ['router', ROUTER],
      ['deepen', DEEPEN],
    ] as const) {
      const allowance = await rd<bigint>(USDC, ABI.erc20, 'allowance', [me, spender], head)
      if (allowance >= 10n ** 30n && !progress.txs.some((t) => t.what === `approve ${label}`)) {
        check(`allowance for the ${label} is set`, allowance >= 10n ** 30n, true)
        continue
      }
      const { receipt } = await tx('approve', `approve ${label}`, USDC, ABI.erc20, 'approve', [spender, 2n ** 256n - 1n])
      check(`approve ${label}: allowance`, await rd<bigint>(USDC, ABI.erc20, 'allowance', [me, spender], receipt.blockNumber), 2n ** 256n - 1n)
      await burnerSide(`approve ${label}`, receipt, 0n)
    }
  })
}

/** Mints `need` rUSDC to `to` if it holds less. */
async function ensureRusdc(step_: string, to: Address, need: bigint) {
  const have = await usdcOf(to, head)
  if (have >= need) return
  await tx(step_, `mint rUSDC to ${to === me ? 'burner' : to.slice(0, 10)}`, USDC, ABI.erc20, 'mint', [to, need - have])
}

async function create(kind: Kind) {
  const id = `create:${kind}`
  await step(id, async () => {
    if (!me) return
    const s = SPECS[kind]
    await ensureRusdc(id, me, planPerToken())
    const fee = await rd<bigint>(LP, ABI.pad, 'launchFee', [], head)
    const { receipt } = await tx(id, `createToken ${s.symbol}`, LP, ABI.pad, 'createToken', [
      s.name, s.symbol, '', Number(s.feeBps), s.plugin, s.data, AMOUNTS.initialBuy,
      modelCurveBuy(INITIAL_CURVE, AMOUNTS.initialBuy, s.feeBps).tokensOut, fee,
    ])
    const B = receipt.blockNumber
    const created = eventsOf<{ token: Address; plugin: Address; pair: Address; creatorFeeBps: number }>(receipt, LP, ABI.pad, 'TokenCreated')
    check('TokenCreated emitted once', created.length, 1)
    const e = created[0]
    progress.tokens[kind] = e.token
    save()
    note(`${s.symbol} = ${e.token}, pair ${e.pair}`)
    const c = await curveAt(e.token, B)
    check('curves(token): plugin, creatorFeeBps, hooks, not graduated', pick(c, ['plugin', 'creatorFeeBps', 'pluginHooks', 'graduated']), {
      plugin: s.plugin, creatorFeeBps: Number(s.feeBps), pluginHooks: s.hooks, graduated: false,
    })
    // The deepen plugin is configured for the token with the intended burn share; onFees/run are gated on it.
    check('deepen isConfigured(token)', await rd(DEEPEN, ABI.deepen, 'isConfigured', [e.token], B), true)
    check('deepen burnBpsOf(token)', await rd(DEEPEN, ABI.deepen, 'burnBpsOf', [e.token], B), s.burnBps)
    check('deepen totals start at zero', [
      await rd(DEEPEN, ABI.deepen, 'usdcHeld', [e.token], B),
      await rd(DEEPEN, ABI.deepen, 'totalUsdcSpent', [e.token], B),
      await rd(DEEPEN, ABI.deepen, 'nextRunBlock', [e.token], B),
      await rd(DEEPEN, ABI.deepen, 'lastRunAt', [e.token], B),
    ], [0n, 0n, 0n, 0n])
    // Write-once: a second onLaunch reverts AlreadyConfigured. The probe must carry the deepen plugin's own data
    // (a uint16 burn share, or empty), not the Combo's array data, which the plugin rejects as NonCanonicalData
    // before it reaches the AlreadyConfigured guard.
    const deepenProbe = s.combo ? s.combo.datas[0] : s.data
    await expectRevert('a second onLaunch (write-once)', DEEPEN, ABI.deepen, 'onLaunch', [e.token, me, deepenProbe], 'AlreadyConfigured', B, LP)
    if (s.combo) {
      // The Combo path: the sub-plugin (deepen) was configured through the Combo's forwarded data.
      check('combo allocationOf', await rd(COMBO, ABI.combo, 'allocationOf', [e.token], B), [s.combo.targets, s.combo.bps, [true, false]])
      check('combo configured deepen for the token', await rd(DEEPEN, ABI.deepen, 'isConfigured', [e.token], B), true)
      check('combo forwarded burnBps 2500 to deepen', await rd(DEEPEN, ABI.deepen, 'burnBpsOf', [e.token], B), 2_500n)
      check('deepen Configured carries the creator', eventsOf(receipt, DEEPEN, ABI.deepen, 'Configured'), [{ token: e.token, creator: me }])
    }
    check('deepen BurnShareSet', eventsOf(receipt, DEEPEN, ABI.deepen, 'BurnShareSet'), [{ token: e.token, burnBps: Number(s.burnBps) }])
    await pluginClean('create', B)
    await identity('create', B)
  })
}

async function curveBuy(kind: Kind) {
  const id = `buy:${kind}`
  await step(id, async () => {
    if (!me) return
    const s = SPECS[kind]
    const token = tokenOf(kind)
    const [pre] = await rd<readonly [bigint, bigint, bigint, bigint, boolean]>(LP, ABI.pad, 'quoteBuy', [token, AMOUNTS.curveBuy], head)
    const { receipt, args } = await tx(id, `buy ${s.symbol} (curve)`, LP, ABI.pad, 'buy', [token, AMOUNTS.curveBuy, pre, me, await deadline()])
    const B = receipt.blockNumber
    const B0 = B - 1n
    const usdcIn = args[1] as bigint
    const c0 = await curveAt(token, B0)
    const m = modelCurveBuy(c0, usdcIn, s.feeBps)
    const [qOut, qPlat, qCreator, qSpent, qGrad] = await rd<readonly [bigint, bigint, bigint, bigint, boolean]>(LP, ABI.pad, 'quoteBuy', [token, usdcIn], B0)
    check('quoteBuy == model', { tokensOut: qOut, platformFee: qPlat, creatorFee: qCreator, usdcSpent: qSpent, graduates: qGrad }, pick(m, ['tokensOut', 'platformFee', 'creatorFee', 'usdcSpent', 'graduates']))
    check('curve after: virtualUsdc, tokensSold', pick(await curveAt(token, B), ['virtualUsdc', 'tokensSold']), { virtualUsdc: c0.virtualUsdc + m.net, tokensSold: c0.tokensSold + m.tokensOut })
    await burnerSide('buy', receipt, -m.usdcSpent)
    await identity('buy', B)
  })
}

async function curveSell(kind: Kind) {
  const id = `sell:${kind}`
  await step(id, async () => {
    if (!me) return
    const s = SPECS[kind]
    const token = tokenOf(kind)
    const half = (await erc20Of(token, me, head)) / 2n
    const [preOut] = await rd<readonly [bigint, bigint, bigint]>(LP, ABI.pad, 'quoteSell', [token, half], head)
    const { receipt, args } = await tx(id, `sell ${s.symbol} (curve, half)`, LP, ABI.pad, 'sell', [token, half, preOut, me, await deadline()])
    const B = receipt.blockNumber
    const B0 = B - 1n
    const tokensIn = args[1] as bigint
    const c0 = await curveAt(token, B0)
    const m = modelCurveSell(c0, tokensIn, s.feeBps)
    const [usdcOut, platformFee, creatorFee] = await rd<readonly [bigint, bigint, bigint]>(LP, ABI.pad, 'quoteSell', [token, tokensIn], B0)
    check('quoteSell == model', { usdcOut, platformFee, creatorFee }, pick(m, ['usdcOut', 'platformFee', 'creatorFee']))
    await burnerSide('sell', receipt, m.usdcOut)
    await identity('sell', B)
  })
}
function modelCurveSell(c: CurveState, tokensIn: bigint, creatorBps: bigint) {
  const gross = c.virtualUsdc - divCeil(c.virtualUsdc * c.virtualTokens, c.virtualTokens + tokensIn)
  const platformFee = divCeil(gross * FEE_BPS, BPS)
  const creatorFee = divCeil(gross * creatorBps, BPS)
  return { gross, platformFee, creatorFee, usdcOut: gross - platformFee - creatorFee }
}

/** Collects a token's creator fees into the plugin's pot (into deepen directly, or through the Combo). */
async function collect(kind: Kind, round: number) {
  const id = `collect${round}:${kind}`
  await step(id, async () => {
    if (!me) return
    const s = SPECS[kind]
    const token = tokenOf(kind)
    const { receipt } = await tx(id, `collectCreatorFees ${s.symbol}`, LP, ABI.pad, 'collectCreatorFees', [token])
    const B = receipt.blockNumber
    const B0 = B - 1n
    const amount = await rd<bigint>(LP, ABI.pad, 'pendingCreatorFees', [token], B0)
    checkThat('there were creator fees to collect', amount > 0n, `${fmt(amount)} rUSDC`)
    check('CreatorFeesCollected', eventsOf<{ token: Address; plugin: Address; amount: bigint }>(receipt, LP, ABI.pad, 'CreatorFeesCollected'), [{ token, plugin: s.plugin, amount }])
    check('pendingCreatorFees after == 0', await rd<bigint>(LP, ABI.pad, 'pendingCreatorFees', [token], B), 0n)
    const heldDelta = (await rd<bigint>(DEEPEN, ABI.deepen, 'usdcHeld', [token], B)) - (await rd<bigint>(DEEPEN, ABI.deepen, 'usdcHeld', [token], B0))
    if (s.combo) {
      const deepenSlice = (amount * 7000n) / BPS
      const walletSlice = amount - deepenSlice
      check('combo previewSplit == 70/30', await rd(COMBO, ABI.combo, 'previewSplit', [token, amount], B0), [deepenSlice, walletSlice])
      check('combo FeesForwarded to deepen (viaHook) and the wallet', eventsOf(receipt, COMBO, ABI.combo, 'FeesForwarded'), [
        { token, target: DEEPEN, amount: deepenSlice, viaHook: true },
        { token, target: COMBO_WALLET, amount: walletSlice, viaHook: false },
      ])
      check('deepen FeesReceived from the Combo', eventsOf(receipt, DEEPEN, ABI.deepen, 'FeesReceived'), [{ token, from: COMBO, amount: deepenSlice }])
      check('deepen usdcHeld rose by its Combo slice', heldDelta, deepenSlice)
      check('the wallet received its slice', (await usdcOf(COMBO_WALLET, B)) - (await usdcOf(COMBO_WALLET, B0)), walletSlice)
    } else {
      check('deepen FeesReceived from the launchpad', eventsOf(receipt, DEEPEN, ABI.deepen, 'FeesReceived'), [{ token, from: LP, amount }])
      check('deepen usdcHeld rose by exactly the fees', heldDelta, amount)
    }
    await pluginClean('collect', B)
    await identity('collect', B)
  })
}

/** A top-up straight into the pot by a non-launchpad caller (the burner), proving anyone may deliver fees. */
async function topUp(kind: Kind, amount: bigint) {
  const id = `topup:${kind}`
  await step(id, async () => {
    if (!me) return
    const token = tokenOf(kind)
    await ensureRusdc(id, me, amount)
    const { receipt } = await tx(id, `onFees ${SPECS[kind].symbol} (${fmt(amount)})`, DEEPEN, ABI.deepen, 'onFees', [token, amount])
    const B = receipt.blockNumber
    const B0 = B - 1n
    check('deepen FeesReceived from the burner (not the launchpad)', eventsOf(receipt, DEEPEN, ABI.deepen, 'FeesReceived'), [{ token, from: me, amount }])
    check('usdcHeld rose by exactly the top-up', (await rd<bigint>(DEEPEN, ABI.deepen, 'usdcHeld', [token], B)) - (await rd<bigint>(DEEPEN, ABI.deepen, 'usdcHeld', [token], B0)), amount)
    check('plugin rUSDC rose by exactly the top-up', (await usdcOf(DEEPEN, B)) - (await usdcOf(DEEPEN, B0)), amount)
    await burnerSide('topup', receipt, -amount)
    await pluginClean('topup', B)
    await identity('topup', B)
  })
}

/** One paced run for a token, on the curve or in the pool, checked to the unit against the off-chain model. */
async function run(kind: Kind, round: string) {
  const id = `run${round}:${kind}`
  await step(id, async () => {
    if (!me) return
    const s = SPECS[kind]
    const token = tokenOf(kind)
    const what = `deepen run ${s.symbol} (${round})`
    if (!minedTx(id, what)) {
      // A token that has run before gets a prorated budget; let a few seconds pass so it is comfortably above the
      // minimum (a run seconds after the last would offer cap × elapsed / 3600, which can round to nothing).
      const last = await rd<bigint>(DEEPEN, ABI.deepen, 'lastRunAt', [token], head)
      if (last !== 0n) await waitUntilTime(last + 10n)
    }
    const { receipt } = await tx(id, what, DEEPEN, ABI.deepen, 'run', [token])
    const B = receipt.blockNumber
    const B0 = B - 1n
    const t = await timeOf(B)
    const t0 = await timeOf(B0)
    const graduated = await rd<boolean>(LP, ABI.pad, 'isGraduated', [token], B0)
    const held0 = await rd<bigint>(DEEPEN, ABI.deepen, 'usdcHeld', [token], B0)
    const lastRunAt = await rd<bigint>(DEEPEN, ABI.deepen, 'lastRunAt', [token], B0)
    const c0 = await curveAt(token, B0)
    const pair = getAddress(c0.pair)

    // The cap base: on the curve virtualUsdc, in the pool the LOCKED part reserve * LP@dEaD / LP supply.
    let base: bigint
    let deadLp0 = 0n
    let lpSupply0 = 0n
    let r0 = { reserveToken: 0n, reserveUsdc: 0n }
    if (graduated) {
      r0 = await reservesAt(pair, B0)
      deadLp0 = await erc20Of(pair, DEAD, B0)
      lpSupply0 = await rd<bigint>(pair, ABI.pair, 'totalSupply', [], B0)
      base = mulDiv(r0.reserveUsdc, deadLp0, lpSupply0)
    } else {
      base = await rd<bigint>(LP, ABI.pad, 'virtualUsdcOf', [token], B0)
    }
    const offer = runOffer(held0, base, lastRunAt, t)
    const cap = (base * CAP_BPS) / BPS

    // previewRun at the block before equals the model at that block's time (offer and the split).
    const [pOffered, pBurn, pDeepen, pGrad] = await rd<readonly [bigint, bigint, bigint, boolean]>(DEEPEN, ABI.deepen, 'previewRun', [token], B0)
    const offer0 = runOffer(held0, base, lastRunAt, t0)
    const [expBurn0, expDeepen0] = graduated ? sides(offer0, s.burnBps) : [offer0, 0n]
    check('previewRun (block before) == the pacing model at its time', { pOffered, pBurn, pDeepen, pGrad }, { pOffered: offer0, pBurn: expBurn0, pDeepen: expDeepen0, pGrad: graduated })
    checkThat('the cap matches an off-chain 0.25% of the base, prorated', true, `base ${fmt(base)}, cap ${fmt(cap)}, elapsed ${lastRunAt === 0n ? 'first run (full cap)' : `${t - lastRunAt}s`}, offer ${fmt(offer)}`)
    checkThat('offer ≤ one cap', offer <= cap, `${fmt(offer)} ≤ ${fmt(cap)}`)

    const dr = eventsOf<{ token: Address; caller: Address; graduated: boolean; usdcSpent: bigint; usdcBurning: bigint; usdcAdded: bigint; tokensBought: bigint; tokensAdded: bigint; tokensBurned: bigint; liquidity: bigint }>(receipt, DEEPEN, ABI.deepen, 'DeepenRun')
    check('one DeepenRun', dr.length, 1)
    const o = dr[0]

    if (!graduated) {
      // Curve run: the whole offer buys through the launchpad and everything held is burned.
      const m = modelCurveBuy(c0, offer, s.feeBps)
      check('curve run: DeepenRun == model (buy-and-burn the whole offer)', pick(o, ['graduated', 'usdcSpent', 'usdcBurning', 'usdcAdded', 'tokensBought', 'tokensAdded', 'tokensBurned', 'liquidity']), {
        graduated: false, usdcSpent: offer, usdcBurning: offer, usdcAdded: 0n, tokensBought: m.tokensOut, tokensAdded: 0n, tokensBurned: m.tokensOut, liquidity: 0n,
      })
      check('previewRun offered burn side == whole offer', [pOffered, pBurn, pDeepen], [offer0, offer0, 0n])
    } else {
      // Pool run: the full off-chain model of both sides.
      const model = modelPoolRun(r0.reserveToken, r0.reserveUsdc, lpSupply0, offer, s.burnBps, s.feeBps)
      check('pool run: DeepenRun == the off-chain model of both sides', pick(o, ['graduated', 'usdcSpent', 'usdcBurning', 'usdcAdded', 'tokensBought', 'tokensAdded', 'tokensBurned', 'liquidity']), {
        graduated: true, usdcSpent: model.usdcSpent, usdcBurning: model.usdcBurning, usdcAdded: model.usdcAdded, tokensBought: model.tokensBought, tokensAdded: model.tokensAdded, tokensBurned: model.tokensBurned, liquidity: model.liquidity,
      })
      // previewSplit at B0 must agree with the model's split parts.
      const [psBurn, psBuy, psLiq] = await rd<readonly [bigint, bigint, bigint]>(DEEPEN, ABI.deepen, 'previewSplit', [token, offer0], B0)
      const [mBurn, mDeepen] = sides(offer0, s.burnBps)
      let reserveAfterBurn = r0.reserveUsdc
      if (mBurn !== 0n) reserveAfterBurn += modelPoolBuy(r0.reserveToken, r0.reserveUsdc, mBurn, s.feeBps).net
      const mBuy = mDeepen === 0n ? 0n : usdcToBuy(mDeepen, reserveAfterBurn, FEE_BPS + s.feeBps)
      check('previewSplit (block before) == model', { psBurn, psBuy, psLiq }, { psBurn: mBurn, psBuy: mBuy, psLiq: mDeepen === 0n ? 0n : mDeepen - mBuy })
      // LP at 0x…dEaD rose by exactly the run's reported liquidity, and never falls.
      const deadLp1 = await erc20Of(pair, DEAD, B)
      check('LP at 0x…dEaD rose by exactly the run liquidity', deadLp1 - deadLp0, o.liquidity)
      checkThat('LP at 0x…dEaD never falls', deadLp1 >= deadLp0, `${deadLp0} → ${deadLp1}`)
    }

    // Common: usdcHeld fell by the spend, supply fell by exactly tokensBurned, plugin holds nothing.
    check('usdcHeld fell by exactly the spend', (await rd<bigint>(DEEPEN, ABI.deepen, 'usdcHeld', [token], B)) - held0, -o.usdcSpent)
    check('DeepenRun.caller == the burner, graduated flag right', [getAddress(o.caller), o.graduated], [me, graduated])
    const supply = async (b: bigint) => rd<bigint>(token, ABI.token, 'totalSupply', [], b)
    check('total supply fell by exactly tokensBurned', (await supply(B0)) - (await supply(B)), o.tokensBurned)
    check('lastRunAt == this block time, nextRunBlock == this block + 1', [await rd(DEEPEN, ABI.deepen, 'lastRunAt', [token], B), await rd(DEEPEN, ABI.deepen, 'nextRunBlock', [token], B)], [t, B + 1n])
    // A second run in the same block reverts AlreadyRanThisBlock (simulated, free); previewRun in-block is zero.
    check('previewRun in the same block offers nothing', await rd(DEEPEN, ABI.deepen, 'previewRun', [token], B), [0n, 0n, 0n, graduated])
    await expectRevert('a second run in the same block', DEEPEN, ABI.deepen, 'run', [token], 'AlreadyRanThisBlock', B)
    await pluginClean('run', B)
    await identity('run', B)
  })
}

async function graduate(kind: Kind) {
  const id = `graduate:${kind}`
  await step(id, async () => {
    if (!me) return
    const s = SPECS[kind]
    const token = tokenOf(kind)
    const what = `buy ${s.symbol} out (graduation)`
    let minOut = 0n
    if (!minedTx(id, what)) {
      const [pOut, , , pSpent, pGrad] = await rd<readonly [bigint, bigint, bigint, bigint, boolean]>(LP, ABI.pad, 'quoteBuy', [token, AMOUNTS.graduateOffer], head)
      if (!pGrad) throw new Error(`${s.symbol}: a ${fmt(AMOUNTS.graduateOffer)} buy would not sell out the curve`)
      await ensureRusdc(id, me, pSpent + usd(1000))
      minOut = pOut
    }
    const { receipt, args } = await tx(id, what, LP, ABI.pad, 'buy', [token, AMOUNTS.graduateOffer, minOut, me, await deadline()])
    const B = receipt.blockNumber
    const B0 = B - 1n
    const c0 = await curveAt(token, B0)
    const usdcIn = args[1] as bigint
    const m = modelCurveBuy(c0, usdcIn, s.feeBps)
    const remaining = CURVE_SUPPLY - c0.tokensSold
    check('the sell-out buy: all remaining tokens, graduates', [m.tokensOut, m.graduates], [remaining, true])
    const usdcSeeded = c0.virtualUsdc + m.net - VIRTUAL_USDC_0
    check('Graduated: 200M tokens and the float seeded', eventsOf(receipt, LP, ABI.pad, 'Graduated').map((g) => pick(g as { usdcSeeded: bigint; tokensSeeded: bigint }, ['usdcSeeded', 'tokensSeeded'])), [{ usdcSeeded, tokensSeeded: POOL_SUPPLY }])
    check('token.graduated(), isGraduated(token)', [await rd(token, ABI.token, 'graduated', [], B), await rd(LP, ABI.pad, 'isGraduated', [token], B)], [true, true])
    check('reserves == seeded amounts', await reservesAt(c0.pair, B), { reserveToken: POOL_SUPPLY, reserveUsdc: usdcSeeded })
    const lpSupply = await rd<bigint>(c0.pair, ABI.pair, 'totalSupply', [], B)
    check('every LP token is at 0x…dEaD (locked)', await erc20Of(c0.pair, DEAD, B), lpSupply)
    check('the plugin holds no LP after graduation', await erc20Of(c0.pair, DEEPEN, B), 0n)
    note(`${s.symbol} graduated: ${fmt(usdcSeeded)} rUSDC × 200M tokens, ${fmt(m.usdcSpent)} rUSDC spent`)
    await burnerSide('graduation', receipt, -m.usdcSpent)
    await identity('graduation', B)
  })
}

async function poolBuy(kind: Kind) {
  const id = `poolbuy:${kind}`
  await step(id, async () => {
    if (!me) return
    const s = SPECS[kind]
    const token = tokenOf(kind)
    const [preOut] = await rd<readonly [bigint, bigint, bigint]>(ROUTER, ABI.router, 'quoteBuy', [token, AMOUNTS.poolBuy], head)
    const { receipt, args } = await tx(id, `buy ${s.symbol} (launch router)`, ROUTER, ABI.router, 'buy', [token, AMOUNTS.poolBuy, preOut, me, await deadline()])
    const B = receipt.blockNumber
    const B0 = B - 1n
    const usdcIn = args[1] as bigint
    const pair = (await curveAt(token, B0)).pair
    const r0 = await reservesAt(pair, B0)
    const [tokensOut, platformFee, creatorFee] = await rd<readonly [bigint, bigint, bigint]>(ROUTER, ABI.router, 'quoteBuy', [token, usdcIn], B0)
    const m = modelPoolBuy(r0.reserveToken, r0.reserveUsdc, usdcIn, s.feeBps)
    check('router.quoteBuy == model', { tokensOut, platformFee, creatorFee }, pick(m, ['tokensOut', 'platformFee', 'creatorFee']))
    check('pool reserves after', await reservesAt(pair, B), { reserveToken: r0.reserveToken - tokensOut, reserveUsdc: r0.reserveUsdc + m.net })
    progress.notes[`${id}:tokensOut`] = tokensOut.toString()
    await burnerSide('pool buy', receipt, -usdcIn)
    await identity('pool buy', B)
  })
}

async function poolSell(kind: Kind) {
  const id = `poolsell:${kind}`
  await step(id, async () => {
    if (!me) return
    const s = SPECS[kind]
    const token = tokenOf(kind)
    const bought = BigInt(progress.notes[`poolbuy:${kind}:tokensOut`] ?? '0')
    const tokensIn = bought > 0n ? bought / 2n : (await erc20Of(token, me, head)) / 1000n
    const [preOut] = await rd<readonly [bigint, bigint, bigint]>(ROUTER, ABI.router, 'quoteSell', [token, tokensIn], head)
    const { receipt, args } = await tx(id, `sell ${s.symbol} (launch router)`, ROUTER, ABI.router, 'sell', [token, tokensIn, preOut, me, await deadline()])
    const B = receipt.blockNumber
    const B0 = B - 1n
    const sold = args[1] as bigint
    const pair = (await curveAt(token, B0)).pair
    const r0 = await reservesAt(pair, B0)
    const [usdcOut, platformFee, creatorFee] = await rd<readonly [bigint, bigint, bigint]>(ROUTER, ABI.router, 'quoteSell', [token, sold], B0)
    const m = modelPoolSell(r0.reserveToken, r0.reserveUsdc, sold, s.feeBps)
    check('router.quoteSell == model', { usdcOut, platformFee, creatorFee }, pick(m, ['usdcOut', 'platformFee', 'creatorFee']))
    check('pool reserves after', await reservesAt(pair, B), { reserveToken: r0.reserveToken + sold, reserveUsdc: r0.reserveUsdc - m.gross })
    await burnerSide('pool sell', receipt, m.usdcOut)
    await identity('pool sell', B)
  })
}

// ── The H1 attack, live ────────────────────────────────────────────────────────

/** The push that just lets one run's cap cover `pot`, from CapInflationSettle.t.sol `_pushFor`. */
function pushFor(pot: bigint, reserveUsdc: bigint, creatorBps: bigint): bigint {
  const root = sqrt(400n * pot * reserveUsdc)
  if (root <= reserveUsdc) return 0n
  const b = root - reserveUsdc
  return (b * BPS) / (BPS - FEE_BPS - creatorBps) + 2n
}

async function attack() {
  // The attack token: a fresh graduated Deepen token, 1% creator fee, default burn share, topped up and never run.
  await create('atk')
  await graduate('atk')
  await topUp('atk', ATTACK_POT)

  await step('deploy:settler', async () => {
    if (!me) return
    const token = tokenOf('atk')
    const pair = getAddress((await curveAt(token, head)).pair)
    if (!progress.settler) {
      const data = encodeDeployData({ abi: ABI.settler, bytecode: settlerArtifact.bytecode.object, args: [DEEPEN, LP, ROUTER, pair, token, USDC] })
      const receipt = await sendRaw('deploy:settler', 'deploy Settler', undefined, data)
      if (!receipt.contractAddress) throw new Error('no contract address in the Settler deploy receipt')
      progress.settler = getAddress(receipt.contractAddress)
      save()
    }
    note(`Settler at ${progress.settler}`)
    const B = maxOf(await latest(), head)
    check('Settler wired to the deepen plugin', getAddress(await rd<string>(progress.settler as Address, ABI.settler, 'plugin', [], B)), DEEPEN)
    check('Settler wired to the attack token', getAddress(await rd<string>(progress.settler as Address, ABI.settler, 'token', [], B)), token)
  })

  await step('attack', async () => {
    if (!me || !progress.settler) return
    const settler = getAddress(progress.settler)
    const token = tokenOf('atk')
    const pair = getAddress((await curveAt(token, head)).pair)
    const attackWhat = 'Settler.attack (push, park, run, unpark, sell)'
    // Fund the attacker with the rUSDC the forge fixture uses (10 billion), so the P&L is comparable. On a re-check
    // the attack is already mined, so skip the mint (its result is read from the mined transaction's block).
    if (!minedTx('attack', attackWhat)) {
      await ensureRusdc('attack', settler, ATTACK_MINT)
      const r = await reservesAt(pair, head)
      const push = pushFor(ATTACK_POT, r.reserveUsdc, SPECS.atk.feeBps)
      const held0 = await rd<bigint>(DEEPEN, ABI.deepen, 'usdcHeld', [token], head)
      const [honestOffer] = await rd<readonly [bigint, bigint, bigint, boolean]>(DEEPEN, ABI.deepen, 'previewRun', [token], head)
      note(`pot ${fmt(held0)} rUSDC, honest first-run offer ${fmt(honestOffer)} rUSDC, push ${fmt(push)} rUSDC`)
      // attack(push, park=true, withRun=true, sweep=false), one transaction.
      await tx('attack', attackWhat, settler, ABI.settler, 'attack', [push, true, true, false])
    }
    const receipt = await retry(() => pub.getTransactionReceipt({ hash: minedTx('attack', attackWhat)!.hash }))
    const B = receipt.blockNumber
    const B0 = B - 1n
    // Everything from the attacker's own ledger at the attack's block (robust to re-checks) and the pool it hit.
    const book = await rd<{ usdcStart: bigint; usdcEnd: bigint; peakCapital: bigint; buyIn: bigint; buyPlatformFee: bigint; buyCreatorFee: bigint; parkUsdc: bigint; parkTokens: bigint; sellPlatformFee: bigint; sellCreatorFee: bigint; potSpent: bigint }>(settler, ABI.settler, 'book', [], B)
    const pnl = book.usdcEnd - book.usdcStart
    const totalFees = book.buyPlatformFee + book.buyCreatorFee + book.sellPlatformFee + book.sellCreatorFee
    const held0 = await rd<bigint>(DEEPEN, ABI.deepen, 'usdcHeld', [token], B0)
    const [honestOffer] = await rd<readonly [bigint, bigint, bigint, boolean]>(DEEPEN, ABI.deepen, 'previewRun', [token], B0)
    const reserveB0 = (await reservesAt(pair, B0)).reserveUsdc
    // A push of b lifts the pool's USDC side, and so the locked part, from R to at most R + b (the square root of the
    // price move). Parking adds nothing. So one run spends at most honest * (R + push) / R, the DeepenCapBase bound.
    const pushBound = (honestOffer * (reserveB0 + book.buyIn)) / reserveB0 + 4n
    for (const [k, v] of [['pnl', pnl], ['potSpent', book.potSpent], ['push', book.buyIn], ['parkUsdc', book.parkUsdc], ['peakCapital', book.peakCapital], ['honestOffer', honestOffer], ['totalFees', totalFees], ['pot', held0]] as const) progress.notes[`attack:${k}`] = v.toString()
    save()
    note(`pot ${fmt(held0)} rUSDC, honest first-run offer ${fmt(honestOffer)} rUSDC`)
    note(`push (router buy): ${fmt(book.buyIn)} rUSDC`)
    note(`park, USDC side:  ${fmt(book.parkUsdc)} rUSDC`)
    note(`peak capital:     ${fmt(book.peakCapital)} rUSDC`)
    note(`pot spent by run: ${fmt(book.potSpent)} rUSDC`)
    note(`total fees paid:  ${fmt(totalFees)} rUSDC`)
    note(`NET P&L:          ${pnl < 0n ? '-' : ''}${fmt(pnl < 0n ? -pnl : pnl)} rUSDC`)
    checkThat('the H1 attack LOSES rUSDC (the fix holds it to a loss)', pnl < 0n, `${pnl < 0n ? '-' : ''}${fmt(pnl < 0n ? -pnl : pnl)} rUSDC`)
    // The push does raise the locked-part cap (that is expected), but only by ~0.25% of the push, so one run spends
    // far less than the pot; the loss is the overpayment at the pushed price plus the fees paid on the push twice.
    checkThat('one run spent at most 0.25% of the PUSHED locked part (parking added nothing beyond the push)', book.potSpent <= pushBound, `pot spent ${fmt(book.potSpent)} ≤ ${fmt(pushBound)} (honest ${fmt(honestOffer)}, reserve ${fmt(reserveB0)}, push ${fmt(book.buyIn)})`)
    checkThat('the run did not drain the pot: it spent far less than the push it cost to inflate it', book.potSpent < book.buyIn && book.potSpent < held0, `pot spent ${fmt(book.potSpent)} ≪ push ${fmt(book.buyIn)}, pot ${fmt(held0)}`)
    checkThat('the loss covers the fees on the push, charged going in and out', -pnl >= totalFees - book.potSpent, `loss ${fmt(-pnl)} ≥ fees ${fmt(totalFees)} - run give-back ${fmt(book.potSpent)}`)
    // The attacker ends holding no token and no LP (the Settler asserts this internally too).
    check('attacker ends holding no token', await erc20Of(token, settler, B), 0n)
    check('attacker ends holding no LP', await erc20Of(pair, settler, B), 0n)
    await pluginClean('attack', B)
    await identity('attack', B)
  })
}

// ── Deployment record ──────────────────────────────────────────────────────────

function writeRecord() {
  if (!account || !progress.deepen) return
  const deployTx = (what: string) => progress.txs.find((t) => t.what === what)?.hash ?? null
  const record = {
    chainId,
    network: 'Arc Testnet',
    commit: 'bd8a8e1',
    baseSuite: 'deployments/arc-testnet-v13-rehearsal.json',
    deployer: me,
    usdc: USDC,
    launchpad: LP,
    pairFactory: FACTORY,
    router: ROUTER,
    combo: COMBO,
    deepenPool: progress.deepen,
    settler: progress.settler ?? null,
    tokens: Object.fromEntries(Object.entries(progress.tokens).map(([k, v]) => [SPECS?.[k as Kind]?.symbol ?? k, getAddress(v as string)])),
    deployedAt: new Date().toISOString(),
    txs: { deepenPool: deployTx('deploy DeepenPoolPlugin'), settler: deployTx('deploy Settler') },
  }
  writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`)
  console.log(`\nwrote ${RECORD}: deepenPool ${progress.deepen}`)
}

// ── Summary ───────────────────────────────────────────────────────────────────

interface Row {
  step: string
  what: string
  hash: string
  gasUsed: bigint
  costWei: bigint
  checks: number
  result: string
}
async function summary() {
  const rows: Row[] = []
  const resultFor = (stepId: string) => (progress.results.find((r) => r.step === stepId)?.ok ?? false) ? 'pass' : progress.done[stepId] ? 'pass' : 'FAIL'
  for (const t of progress.txs) {
    const stepResult = progress.results.find((r) => r.step === t.step)
    rows.push({
      step: t.step,
      what: t.what,
      hash: t.hash,
      gasUsed: BigInt(t.gasUsed),
      costWei: BigInt(t.gasUsed) * BigInt(t.gasPrice),
      checks: stepResult?.checks ?? 0,
      result: t.step.startsWith('deploy') && !stepResult ? 'deployed' : resultFor(t.step),
    })
  }
  const usdcOfWei = (wei: bigint) => Number(formatUnits(wei, 18)).toFixed(6)
  console.log(`\n── gas (${rows.length} transactions)`)
  if (MARKDOWN) {
    console.log('| step | transaction | tx hash | gas | USDC | checks | result |\n| --- | --- | --- | ---: | ---: | ---: | --- |')
    for (const r of rows) console.log(`| ${r.step} | ${r.what} | \`${r.hash}\` | ${r.gasUsed.toLocaleString('en-US')} | ${usdcOfWei(r.costWei)} | ${r.checks || ''} | ${r.result} |`)
  } else {
    for (const r of rows) console.log(`${r.step.padEnd(16)} ${r.what.padEnd(40)} ${r.hash}  ${r.gasUsed.toString().padStart(9)}  ${usdcOfWei(r.costWei)}  ${r.result}`)
  }
  const totalGas = rows.reduce((s, r) => s + r.gasUsed, 0n)
  const totalWei = rows.reduce((s, r) => s + r.costWei, 0n)
  console.log(`total:  ${totalGas} gas, ${usdcOfWei(totalWei)} USDC`)
  if (progress.notes['attack:pnl']) {
    const pnl = BigInt(progress.notes['attack:pnl'])
    console.log(`attack: push ${fmt(BigInt(progress.notes['attack:push'] ?? '0'))}, park ${fmt(BigInt(progress.notes['attack:parkUsdc'] ?? '0'))}, pot spent ${fmt(BigInt(progress.notes['attack:potSpent'] ?? '0'))}, honest offer ${fmt(BigInt(progress.notes['attack:honestOffer'] ?? '0'))}, P&L ${pnl < 0n ? '-' : ''}${fmt(pnl < 0n ? -pnl : pnl)} rUSDC`)
  }
  const failedSteps = progress.results.filter((r) => !r.ok)
  console.log(`steps: ${Object.keys(progress.done).length} done${failedSteps.length ? `, failing: ${failedSteps.map((r) => r.step).join(', ')}` : ''}; this run: ${checks} checks, ${failures} failed, ${rpcRetries} RPC retries`)
}

// ── Run ───────────────────────────────────────────────────────────────────────

try {
  if (progress.deepen) {
    DEEPEN = getAddress(progress.deepen)
    buildSpecs()
  }
  await wiring()
  if (!account || !me) {
    console.log('\nBURNER_KEY not set: read-only checks only.')
    if (progress.txs.length) await summary()
    process.exit(failures ? 1 : 0)
  }
  progress.burner = me
  save()
  console.log(`\nburner ${me}: ${fmt18(await nativeOf(me, head))} USDC (native gas), ${fmt(await usdcOf(me, head))} rUSDC`)
  await recoverPending()
  await deployPlugin()
  await approvals()
  for (const k of MAIN) {
    await create(k)
    await curveBuy(k)
    await curveSell(k)
    await collect(k, 1)
    await run(k, '1') // a curve run: buys and burns the whole offer
    await topUp(k, usd(50)) // a non-launchpad caller tops the pot up
  }
  for (const k of MAIN) {
    await graduate(k)
    await poolBuy(k)
    await poolSell(k)
    await collect(k, 2)
    await run(k, '2') // a pool run: the burn side plus the deepen side
  }
  await attack()
  await summary()
  writeRecord()
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
  process.exit(failures ? 1 : 0)
} catch (e) {
  console.log(`\nERROR: ${errorText(e).split('\n').slice(0, 6).join('\n')}`)
  save()
  await summary().catch(() => undefined)
  process.exit(1)
}
