/**
 * Arc Testnet rehearsal of the Architex launchpad v1.3 (docs/launchpad/V13-REHEARSAL.md; V13-SPEC §8 step 2).
 *
 *   bun run scripts/v13-rehearsal.ts                    # read-only: wiring, constants, and the state reached so far
 *   BURNER_KEY=0x… bun run scripts/v13-rehearsal.ts     # drives the rehearsal; resumable
 *   DEPLOYMENT=deployments/arc-testnet-v13-realusdc.json BURNER_KEY=0x… bun run scripts/v13-rehearsal.ts   # real USDC
 *
 * Reads the deployment written by scripts/v13-rehearsal-record.ts and the ABIs in contracts/out (run `forge build`).
 *
 * With a mintable test USDC (rUSDC) it launches five tokens, one per creator-fee destination (a creator wallet, Split,
 * Buyback & burn, Distribute to holders, Combo), buys and sells each on its curve, collects each token's creator fees
 * and follows them to the end (Split releases, buyback runs, holder drips and claims, the Combo's 40/40/20), graduates
 * all five into their launch pools, buys and sells there through the launch router, collects and pays out again, and
 * finally collects the platform fees. With Arc's own USDC (a deployment whose usdc is 0x36…00) it does the curve half
 * of that for two tokens (TOKENS=holders,combo by default) with 1 USDC trades, and no graduation.
 *
 * Every transaction is simulated first (a revert costs nothing) and checked afterwards at its receipt's block against
 * the block before it: the result against the contract's own quote, a local model of the spec's formulas (V13-SPEC §5:
 * both fees from the USDC side, rounded up), where every unit went, and the launchpad identity
 *   USDC held == pendingFees + Σ pendingCreatorFees + Σ (virtualUsdc - VIRTUAL_USDC_0) over curves not graduated
 * to the unit (V13-SPEC §6.1). The burner's side is checked on its native balance with gas added back (on Arc, USDC is
 * the gas token). The run stops at the first step with a failed check.
 *
 * Progress (token addresses, mined transactions, steps done) is kept next to the deployment in *.progress.json
 * (gitignored, or PROGRESS=<file>): a re-run skips finished steps, never re-sends a mined transaction, and re-checks a
 * step whose transaction was mined but not yet checked. Testnet only: refuses any chain but Arc Testnet (5042002), or a
 * local node (31337) at a localhost RPC for dry runs.
 *
 * Environment: DEPLOYMENT, PROGRESS, ARC_TESTNET_RPC, ARTIFACTS (default contracts/out), TOKENS (comma list of
 * wallet,split,buyback,holders,combo), SAMPLE_SECONDS (default 30), GAS_CAP (USDC of gas this driver may spend in
 * total, default 3), MARKDOWN=1 (print the results as a markdown table).
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
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  keccak256,
  maxUint256,
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
const ARC_USDC = getAddress('0x3600000000000000000000000000000000000000')
const DEAD = getAddress('0x000000000000000000000000000000000000dEaD')

const DEPLOYMENT = resolve(ROOT, process.env.DEPLOYMENT ?? 'deployments/arc-testnet-v13-rehearsal.json')
const PROGRESS = resolve(ROOT, process.env.PROGRESS ?? DEPLOYMENT.replace(/\.json$/, '.progress.json'))
const ARTIFACTS = resolve(ROOT, process.env.ARTIFACTS ?? 'contracts/out')
const RPC = process.env.ARC_TESTNET_RPC ?? 'https://rpc.testnet.arc.io'
const LOCAL_RPC = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(RPC)
const SAMPLE_SECONDS = Number(process.env.SAMPLE_SECONDS ?? '30')
const MARKDOWN = process.env.MARKDOWN === '1'

// Curve and fee constants (V13-SPEC §1, §5); the wiring checks compare them with the contracts.
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
const DRIP_PERIOD = 86_400n
/** On Arc the ERC-20 USDC balance is the native balance at 6 decimals: one USDC base unit is 1e12 wei. */
const WEI_PER_UNIT = 10n ** 12n

interface Deployment {
  chainId: number
  mode?: string
  deployer: string
  usdc: string
  launchpad: string
  pairFactory: string
  router: string
  plugins: { split: string; buybackBurn: string; holders: string; combo: string }
  launchFee: string
  feeTo: string
  feeToSetter: string
  deployedAt: string
  txs: Record<string, string>
}
const dep = JSON.parse(readFileSync(DEPLOYMENT, 'utf8')) as Deployment
const USDC = getAddress(dep.usdc)
const LP = getAddress(dep.launchpad)
const FACTORY = getAddress(dep.pairFactory)
const ROUTER = getAddress(dep.router)
const SPLIT = getAddress(dep.plugins.split)
const BUYBACK = getAddress(dep.plugins.buybackBurn)
const HOLDERS = getAddress(dep.plugins.holders)
const COMBO = getAddress(dep.plugins.combo)
/** Real mode: the launchpad runs on Arc's own USDC, which is also the gas token. */
const REAL = USDC === ARC_USDC

const artifact = (name: string): Abi =>
  (JSON.parse(readFileSync(resolve(ARTIFACTS, `${name}.sol`, `${name}.json`), 'utf8')) as { abi: Abi }).abi
const ABI = {
  pad: artifact('ArchitexLaunchpad'),
  router: artifact('LaunchRouter'),
  factory: artifact('LaunchPairFactory'),
  pair: artifact('LaunchPair'),
  token: artifact('LaunchToken'),
  erc20: artifact('TestToken'), // ERC-20 plus the rehearsal USDC's owner-only mint
  split: artifact('SplitPlugin'),
  buyback: artifact('BuybackBurnPlugin'),
  holders: artifact('HolderDistributionPlugin'),
  combo: artifact('ComboPlugin'),
}

// ── The five tokens ───────────────────────────────────────────────────────────

type Kind = 'wallet' | 'split' | 'buyback' | 'holders' | 'combo'
const ALL_KINDS: readonly Kind[] = ['wallet', 'split', 'buyback', 'holders', 'combo']

/** Fixed addresses nobody holds a key for: the last 20 bytes of a hash of a label. They only ever receive fees. */
const fixedAddress = (label: string) => getAddress(`0x${keccak256(stringToHex(`architex/v13-rehearsal/${label}`)).slice(-40)}`)
const CREATOR_WALLET = fixedAddress('creator-wallet')
const PAYEES = [fixedAddress('split-payee-1'), fixedAddress('split-payee-2'), fixedAddress('split-payee-3')]
const SHARES = [5n, 3n, 2n]
const COMBO_WALLET = fixedAddress('combo-wallet')
const COMBO_TARGETS = [BUYBACK, HOLDERS, COMBO_WALLET]
const COMBO_BPS = [4000, 4000, 2000]

interface Spec {
  name: string
  symbol: string
  feeBps: bigint
  plugin: Address
  data: Hex
  hooks: boolean
}
const SPECS: Record<Kind, Spec> = {
  wallet: { name: 'Rehearsal Wallet', symbol: 'RWALLET', feeBps: 250n, plugin: CREATOR_WALLET, data: '0x', hooks: false },
  split: {
    name: 'Rehearsal Split',
    symbol: 'RSPLIT',
    feeBps: 500n,
    plugin: SPLIT,
    data: encodeAbiParameters([{ type: 'address[]' }, { type: 'uint256[]' }], [PAYEES, SHARES]),
    hooks: true,
  },
  buyback: { name: 'Rehearsal Buyback', symbol: 'RBURN', feeBps: 300n, plugin: BUYBACK, data: '0x', hooks: true },
  holders: { name: 'Rehearsal Holders', symbol: 'RHOLD', feeBps: 1000n, plugin: HOLDERS, data: '0x', hooks: true },
  combo: {
    name: 'Rehearsal Combo',
    symbol: 'RCOMBO',
    feeBps: 600n,
    plugin: COMBO,
    data: encodeAbiParameters(
      [{ type: 'address[]' }, { type: 'uint16[]' }, { type: 'bytes[]' }],
      [COMBO_TARGETS, COMBO_BPS, ['0x', '0x', '0x']],
    ),
    hooks: true,
  },
}

const KINDS = (process.env.TOKENS ?? (REAL ? 'holders,combo' : ALL_KINDS.join(','))).split(',').map((k) => k.trim()) as Kind[]
for (const k of KINDS) if (!ALL_KINDS.includes(k)) throw new Error(`TOKENS: unknown kind "${k}" (use ${ALL_KINDS.join(', ')})`)
const has = (k: Kind) => KINDS.includes(k)
const HOLDER_KINDS = (['holders', 'combo'] as Kind[]).filter(has)
const BUYBACK_KINDS = (['buyback', 'combo'] as Kind[]).filter(has)

const usd = (n: number) => BigInt(Math.round(n * 1e6))
/** USDC (6 decimals) per trade. rUSDC is free, so its curve trades are large enough for every cap to bind. */
const AMOUNTS = REAL
  ? { initialBuy: usd(0.2), curveBuy: usd(1), graduateOffer: 0n, poolBuy: 0n }
  : { initialBuy: usd(100), curveBuy: usd(1000), graduateOffer: usd(60_000), poolBuy: usd(500) }
/** A curve sells out for 25,000 USDC net; with a 10% creator fee that is ~27,933 gross. */
const GRADUATION_BUDGET = usd(30_000)
const GAS_CAP_WEI = BigInt(Math.round(Number(process.env.GAS_CAP ?? '3') * 1e6)) * WEI_PER_UNIT
/** Real mode: the burner never goes below this (it pays gas and trades from the same balance). */
const BURNER_FLOOR_WEI = 3n * 10n ** 18n

// ── RPC ───────────────────────────────────────────────────────────────────────

const pub = createPublicClient({ transport: http(RPC, { retryCount: 3, retryDelay: 400, timeout: 30_000 }) })
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

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

async function rd<T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], blockNumber?: bigint): Promise<T> {
  return (await retry(() => pub.readContract({ address, abi, functionName, args, blockNumber }))) as T
}
const erc20Of = (token: Address, who: Address, block: bigint) => rd<bigint>(token, ABI.erc20, 'balanceOf', [who], block)
const usdcOf = (who: Address, block: bigint) => erc20Of(USDC, who, block)
const nativeOf = (who: Address, block: bigint) => retry(() => pub.getBalance({ address: who, blockNumber: block }))
const nonceOf = (who: Address, block: bigint) => retry(() => pub.getTransactionCount({ address: who, blockNumber: block }))
const timeOf = async (block: bigint) => (await retry(() => pub.getBlock({ blockNumber: block }))).timestamp
const latest = () => retry(() => pub.getBlockNumber({ cacheTime: 0 }))

// ── Checks ────────────────────────────────────────────────────────────────────

let failures = 0
let checks = 0
let stepFailed: string[] = []
/** Canonical form for comparisons: bigints as strings, object keys sorted (so key order never matters). */
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
const fmt = (units: bigint) => formatUnits(units, 6)

/** A call that must revert with `errorName`, simulated for free at `block`. */
async function expectRevert(label: string, address: Address, abi: Abi, functionName: string, args: readonly unknown[], errorName: string, block: bigint, from?: Address) {
  let got = 'no revert'
  try {
    await retry(() => pub.simulateContract({ address, abi, functionName, args, account: from ?? me ?? dep.deployer as Address, blockNumber: block }))
  } catch (e) {
    got = revertName(e)
  }
  check(`${label} reverts`, got, errorName)
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
}

/** V13-SPEC §5 buy math, including the exact-fill (sell-out) buy. */
function modelCurveBuy(c: CurveState, usdcIn: bigint, creatorBps: bigint): BuyQuote & { net: bigint } {
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
/** V13-SPEC §5 sell math: gross from the curve, both fees from gross, rounded up. */
function modelCurveSell(c: CurveState, tokensIn: bigint, creatorBps: bigint) {
  const gross = c.virtualUsdc - divCeil(c.virtualUsdc * c.virtualTokens, c.virtualTokens + tokensIn)
  const platformFee = divCeil(gross * FEE_BPS, BPS)
  const creatorFee = divCeil(gross * creatorBps, BPS)
  return { gross, platformFee, creatorFee, usdcOut: gross - platformFee - creatorFee }
}
/** V13-SPEC §4: launch-pool buy, fees out of the USDC in, constant product with no pool fee. */
function modelPoolBuy(reserveToken: bigint, reserveUsdc: bigint, usdcIn: bigint, creatorBps: bigint) {
  const platformFee = divCeil(usdcIn * FEE_BPS, BPS)
  const creatorFee = divCeil(usdcIn * creatorBps, BPS)
  const net = usdcIn - platformFee - creatorFee
  return { tokensOut: (net * reserveToken) / (reserveUsdc + net), platformFee, creatorFee, net }
}
/** V13-SPEC §4: launch-pool sell, fees out of the USDC out. */
function modelPoolSell(reserveToken: bigint, reserveUsdc: bigint, tokensIn: bigint, creatorBps: bigint) {
  const gross = (tokensIn * reserveUsdc) / (reserveToken + tokensIn)
  const platformFee = divCeil(gross * FEE_BPS, BPS)
  const creatorFee = divCeil(gross * creatorBps, BPS)
  return { gross, platformFee, creatorFee, usdcOut: gross - platformFee - creatorFee }
}

interface Stream {
  unreleased: bigint
  lastDrip: bigint
  streamEnd: bigint
}
/** Distribute to holders, [D21]: what a stream owes its holders at `now`. */
function streamDue(s: Stream, now: bigint, eligible: boolean): bigint {
  if (s.unreleased === 0n) return 0n
  const due = now < s.streamEnd ? (s.unreleased * (now - s.lastDrip)) / (s.streamEnd - s.lastDrip) : s.unreleased
  return due !== 0n && !eligible ? 0n : due
}
/** A delivery of `amount`: release what is due, then restart the line with the amount-weighted end. */
function streamAfterFees(s: Stream, amount: bigint, now: bigint, eligible: boolean) {
  const due = streamDue(s, now, eligible)
  const kept = s.unreleased - due
  const from = maxOf(s.streamEnd, now)
  const end = from + divCeil(amount * (now + DRIP_PERIOD - from), kept + amount)
  return { due, next: { unreleased: kept + amount, lastDrip: now, streamEnd: end } }
}

// ── Chain guard, key, progress ───────────────────────────────────────────────

const chainId = await retry(() => pub.getChainId())
if (chainId === ARC_MAINNET || !(chainId === ARC_TESTNET || (LOCAL_RPC && chainId === 31337))) {
  throw new Error(`Refusing to run on chain ${chainId}: this rehearsal is for Arc Testnet (${ARC_TESTNET}) only.`)
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
  if (!account) return // read-only runs never write
  const tmp = `${PROGRESS}.tmp`
  writeFileSync(tmp, `${JSON.stringify(progress, null, 2)}\n`)
  renameSync(tmp, PROGRESS)
}
const tokenOf = (kind: Kind): Address => {
  const t = progress.tokens[kind]
  if (!t) throw new Error(`no ${kind} token yet`)
  return getAddress(t)
}

/** The block every "current state" read uses: the latest receipt this run has seen (never behind our own writes). */
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

/** Sends the signed transaction; resolves 'taken' if its nonce was used by another transaction. */
async function broadcast(serialized: Hex, hash: Hex): Promise<'sent' | 'taken'> {
  for (let attempt = 1; ; attempt++) {
    try {
      await pub.sendRawTransaction({ serializedTransaction: serialized })
      return 'sent'
    } catch (e) {
      const text = errorText(e)
      if (/already known|known transaction|already imported|already exists/i.test(text)) return 'sent'
      if (/nonce too low|nonce is too low|invalid nonce|replacement transaction underpriced/i.test(text)) {
        // Ours if the chain knows it (an earlier attempt whose answer was lost); otherwise the nonce went elsewhere.
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

async function send(step: string, what: string, to: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<TransactionReceipt> {
  if (!account || !me) throw new Error('BURNER_KEY is needed to send transactions')
  const data = encodeFunctionData({ abi, functionName, args })
  // A revert here costs nothing and names its error.
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
  if (REAL) {
    const native = await nativeOf(me, head)
    if (native - worst - usd(1.5) * WEI_PER_UNIT < BURNER_FLOOR_WEI) {
      throw new Error(`${what}: would take the burner below ${formatUnits(BURNER_FLOOR_WEI, 18)} USDC (it holds ${formatUnits(native, 18)})`)
    }
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

/** Sends a step's transaction once: a transaction this step already mined (an earlier run) is re-used, not re-sent.
 *  Returns the receipt and the arguments the mined transaction actually carried. */
async function tx(step: string, what: string, to: Address, abi: Abi, functionName: string, args: readonly unknown[]) {
  const mined = minedTx(step, what)
  if (!mined) return { receipt: await send(step, what, to, abi, functionName, args), args }
  const receipt = await retry(() => pub.getTransactionReceipt({ hash: mined.hash }))
  const sent = await retry(() => pub.getTransaction({ hash: mined.hash }))
  if (receipt.blockNumber > head) head = receipt.blockNumber
  console.log(`     ${what}: ${mined.hash} (mined in an earlier run; re-checking)`)
  return { receipt, args: decodeFunctionData({ abi, data: sent.input }).args ?? [] }
}

/** A transaction left in flight by an interrupted run: record it if it was mined, so it is neither lost nor repeated. */
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

function logsOf<T>(receipt: TransactionReceipt, address: Address, abi: Abi, eventName: string): { args: T; logIndex: number }[] {
  const logs = receipt.logs.filter((l) => getAddress(l.address) === address)
  return parseEventLogs({ abi, logs, eventName }).map((l) => ({ args: l.args as T, logIndex: l.logIndex }))
}
const eventsOf = <T>(receipt: TransactionReceipt, address: Address, abi: Abi, eventName: string): T[] =>
  logsOf<T>(receipt, address, abi, eventName).map((l) => l.args)

interface CurveView extends CurveState {
  token: Address
  creator: Address
  pair: Address
  createdAt: bigint
  graduated: boolean
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
  virtualUsdc: bigint
  virtualTokens: bigint
}
type PoolTradeEvent = Omit<TradeEvent, 'virtualUsdc' | 'virtualTokens'>

const curveAt = (token: Address, block: bigint) => rd<CurveView>(LP, ABI.pad, 'curves', [token], block)
const reservesAt = async (pair: Address, block: bigint) => {
  const [reserveToken, reserveUsdc] = await rd<readonly [bigint, bigint, number]>(pair, ABI.pair, 'getReserves', [], block)
  return { reserveToken, reserveUsdc }
}
const streamAt = async (token: Address, block: bigint): Promise<Stream> => ({
  unreleased: await rd<bigint>(HOLDERS, ABI.holders, 'unreleased', [token], block),
  lastDrip: await rd<bigint>(HOLDERS, ABI.holders, 'lastDrip', [token], block),
  streamEnd: await rd<bigint>(HOLDERS, ABI.holders, 'streamEnd', [token], block),
})
async function quoteCurveBuy(token: Address, usdcIn: bigint, block: bigint): Promise<BuyQuote> {
  const [tokensOut, platformFee, creatorFee, usdcSpent, graduates] = await rd<readonly [bigint, bigint, bigint, bigint, boolean]>(
    LP, ABI.pad, 'quoteBuy', [token, usdcIn], block)
  return { tokensOut, platformFee, creatorFee, usdcSpent, graduates }
}
const pick = <T extends object, K extends keyof T>(o: T, keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, o[k]]))

// ── Shared checks ─────────────────────────────────────────────────────────────

/** Launchpad identity (V13-SPEC §6.1), verified against ArchitexLaunchpad: every path that moves USDC (launch fee,
 *  curve buy and sell, graduation, both collections, router fee accrual) moves one side of it by the same amount. */
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

/** The burner's side of a transaction: `usdc` (6 decimals, signed) left or reached it, and it paid the gas. On Arc the
 *  gas is USDC too, so this is checked on the native balance with the gas added back; with rUSDC the native balance
 *  moves by the gas alone and the rUSDC balance by `usdc`. */
async function burnerSide(what: string, receipt: TransactionReceipt, usdc: bigint) {
  if (!me) return
  const B = receipt.blockNumber
  const gas = receipt.gasUsed * receipt.effectiveGasPrice
  const txsInBlock = (await nonceOf(me, B)) - (await nonceOf(me, B - 1n))
  if (txsInBlock !== 1) {
    note(`${what}: ${txsInBlock} burner transactions in block ${B}; native-balance check skipped`)
  } else {
    const moved = (await nativeOf(me, B)) - (await nativeOf(me, B - 1n)) + gas
    check(`${what}: burner native balance, gas added back`, moved, REAL ? usdc * WEI_PER_UNIT : 0n)
  }
  if (!REAL) check(`${what}: burner rUSDC`, (await usdcOf(me, B)) - (await usdcOf(me, B - 1n)), usdc)
}

interface Moves {
  padUsdc?: bigint
  pendingFees?: bigint
  pendingCreator?: bigint
  burnerTokens?: bigint
  burnerUsdc?: bigint
}
/** Balance and accrual deltas across one transaction: block B-1 against its receipt's block B. */
async function moves(what: string, receipt: TransactionReceipt, token: Address | undefined, m: Moves) {
  const B = receipt.blockNumber
  const B0 = B - 1n
  const delta = async (read: (b: bigint) => Promise<bigint>) => (await read(B)) - (await read(B0))
  if (m.padUsdc !== undefined) check(`${what}: launchpad USDC`, await delta((b) => usdcOf(LP, b)), m.padUsdc)
  if (m.pendingFees !== undefined) check(`${what}: pendingFees`, await delta((b) => rd<bigint>(LP, ABI.pad, 'pendingFees', [], b)), m.pendingFees)
  if (token && m.pendingCreator !== undefined) {
    check(`${what}: pendingCreatorFees`, await delta((b) => rd<bigint>(LP, ABI.pad, 'pendingCreatorFees', [token], b)), m.pendingCreator)
  }
  if (token && me && m.burnerTokens !== undefined) check(`${what}: burner tokens`, await delta((b) => erc20Of(token, me, b)), m.burnerTokens)
  if (m.burnerUsdc !== undefined) await burnerSide(what, receipt, m.burnerUsdc)
}

// ── Read-only: wiring and constants ──────────────────────────────────────────

const FEE_PLUGIN_ID = (() => {
  const a = parseInt(toFunctionSelector('onLaunch(address,address,bytes)').slice(2), 16)
  const b = parseInt(toFunctionSelector('onFees(address,uint256)').slice(2), 16)
  const id: Hex = `0x${((a ^ b) >>> 0).toString(16).padStart(8, '0')}`
  return id
})()

async function wiring() {
  console.log(`\n── wiring (${REAL ? "Arc's USDC" : 'rehearsal USDC'}, launchpad ${LP}, chain ${chainId}, block ${head})`)
  const at = head
  const a = (x: unknown) => getAddress(x as string)
  check('launchpad.usdc', a(await rd(LP, ABI.pad, 'usdc', [], at)), USDC)
  check('launchpad.pairFactory', a(await rd(LP, ABI.pad, 'pairFactory', [], at)), FACTORY)
  check('launchpad.router', a(await rd(LP, ABI.pad, 'router', [], at)), ROUTER)
  check('launchpad.feeTo', a(await rd(LP, ABI.pad, 'feeTo', [], at)), getAddress(dep.feeTo))
  check('launchpad.feeToSetter', a(await rd(LP, ABI.pad, 'feeToSetter', [], at)), getAddress(dep.feeToSetter))
  check('launchpad.launchFee', await rd<bigint>(LP, ABI.pad, 'launchFee', [], at), BigInt(dep.launchFee))
  for (const [name, value] of [
    ['FEE_BPS', FEE_BPS],
    ['MAX_CREATOR_FEE_BPS', 1000n],
    ['MAX_LAUNCH_FEE', 100_000_000n],
    ['TOTAL_SUPPLY', TOTAL_SUPPLY],
    ['CURVE_SUPPLY', CURVE_SUPPLY],
    ['POOL_SUPPLY', POOL_SUPPLY],
    ['VIRTUAL_USDC_0', VIRTUAL_USDC_0],
    ['VIRTUAL_TOKENS_0', VIRTUAL_TOKENS_0],
  ] as const) {
    check(`launchpad.${name}`, await rd<bigint>(LP, ABI.pad, name, [], at), value)
  }
  check('pairFactory.launchpad', a(await rd(FACTORY, ABI.factory, 'launchpad', [], at)), LP)
  check('pairFactory.usdc', a(await rd(FACTORY, ABI.factory, 'usdc', [], at)), USDC)
  check('router.launchpad', a(await rd(ROUTER, ABI.router, 'launchpad', [], at)), LP)
  check('router.factory', a(await rd(ROUTER, ABI.router, 'factory', [], at)), FACTORY)
  check('router.usdc', a(await rd(ROUTER, ABI.router, 'usdc', [], at)), USDC)
  for (const [name, plugin, abi] of [
    ['split', SPLIT, ABI.split],
    ['buybackBurn', BUYBACK, ABI.buyback],
    ['holders', HOLDERS, ABI.holders],
    ['combo', COMBO, ABI.combo],
  ] as const) {
    check(`${name}.launchpad`, a(await rd(plugin, abi, 'launchpad', [], at)), LP)
    check(`${name}.usdc`, a(await rd(plugin, abi, 'usdc', [], at)), USDC)
    check(`${name} declares IArchitexFeePlugin (${FEE_PLUGIN_ID})`, await rd(plugin, abi, 'supportsInterface', [FEE_PLUGIN_ID], at), true)
    check(`${name} declares IERC165`, await rd(plugin, abi, 'supportsInterface', ['0x01ffc9a7'], at), true)
    check(`${name} rejects 0xffffffff`, await rd(plugin, abi, 'supportsInterface', ['0xffffffff'], at), false)
  }
  check('split.MAX_PAYEES', await rd(SPLIT, ABI.split, 'MAX_PAYEES', [], at), 20n)
  check('buybackBurn.CAP_BPS', await rd(BUYBACK, ABI.buyback, 'CAP_BPS', [], at), CAP_BPS)
  check('holders.DRIP_PERIOD', await rd(HOLDERS, ABI.holders, 'DRIP_PERIOD', [], at), DRIP_PERIOD)
  check('combo.MAX_ENTRIES', await rd(COMBO, ABI.combo, 'MAX_ENTRIES', [], at), 5n)
  check('combo.TOTAL_BPS', await rd(COMBO, ABI.combo, 'TOTAL_BPS', [], at), 10_000n)
  check('usdc.decimals', await rd(USDC, ABI.erc20, 'decimals', [], at), 6)
  if (!REAL) {
    check('rUSDC.symbol', await rd(USDC, ABI.erc20, 'symbol', [], at), 'rUSDC')
    check('rUSDC.owner (can mint)', a(await rd(USDC, ABI.erc20, 'owner', [], at)), getAddress(dep.deployer))
  }
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

const planCurve = () => BigInt(KINDS.length) * (BigInt(dep.launchFee) + AMOUNTS.initialBuy + AMOUNTS.curveBuy)
const planPool = () => (REAL ? 0n : BigInt(KINDS.length) * (GRADUATION_BUDGET + AMOUNTS.poolBuy))

async function fund() {
  await step('fund', async () => {
    if (!me) return
    const need = planCurve() + planPool()
    const have = await usdcOf(me, head)
    const minted = progress.txs.some((t) => t.step === 'fund')
    if (have >= need && !minted) {
      check('burner holds the rUSDC the rehearsal needs', have >= need, true)
      return
    }
    check('rUSDC owner is the burner', getAddress(await rd<string>(USDC, ABI.erc20, 'owner', [], head)), me)
    const { receipt, args } = await tx('fund', 'mint rUSDC', USDC, ABI.erc20, 'mint', [me, ((need - have) / usd(1000) + 1n) * usd(1000)])
    const amount = args[1] as bigint
    const B = receipt.blockNumber
    check('mint: rUSDC supply', (await rd<bigint>(USDC, ABI.erc20, 'totalSupply', [], B)) - (await rd<bigint>(USDC, ABI.erc20, 'totalSupply', [], B - 1n)), amount)
    await burnerSide('mint', receipt, amount)
  })
}

async function approvals() {
  await step('approve', async () => {
    if (!me) return
    // Real USDC: approve what the curve trades need, no more. rUSDC: unlimited, it has no value.
    const want = REAL ? (planCurve() * 12n) / 10n : maxUint256
    const spenders: { spender: Address; label: string; need: bigint }[] = [{ spender: LP, label: 'launchpad', need: planCurve() + planPool() }]
    if (!REAL) spenders.push({ spender: ROUTER, label: 'router', need: planPool() })
    for (const { spender, label, need } of spenders) {
      const allowance = await rd<bigint>(USDC, ABI.erc20, 'allowance', [me, spender], head)
      if (allowance >= need && !progress.txs.some((t) => t.what === `approve ${label}`)) {
        check(`allowance for the ${label} covers the plan`, allowance >= need, true)
        continue
      }
      const { receipt } = await tx('approve', `approve ${label}`, USDC, ABI.erc20, 'approve', [spender, want])
      check(`approve ${label}: allowance`, await rd<bigint>(USDC, ABI.erc20, 'allowance', [me, spender], receipt.blockNumber), want)
      await burnerSide(`approve ${label}`, receipt, 0n)
    }
  })
}

async function create(kind: Kind) {
  const id = `create:${kind}`
  await step(id, async () => {
    if (!me) return
    const s = SPECS[kind]
    const fee = await rd<bigint>(LP, ABI.pad, 'launchFee', [], head)
    const { receipt, args } = await tx(id, `createToken ${s.symbol}`, LP, ABI.pad, 'createToken', [
      s.name, s.symbol, '', Number(s.feeBps), s.plugin, s.data, AMOUNTS.initialBuy,
      modelCurveBuy(INITIAL_CURVE, AMOUNTS.initialBuy, s.feeBps).tokensOut, fee, // maxLaunchFee = launchFee [D22]
    ])
    const B = receipt.blockNumber
    const B0 = B - 1n
    const launchFee = args[8] as bigint
    const initialBuy = args[6] as bigint
    const model = modelCurveBuy(INITIAL_CURVE, initialBuy, s.feeBps)
    if (kind === 'wallet') check('the creator wallet is not a contract', (await retry(() => pub.getCode({ address: CREATOR_WALLET }))) ?? '0x', '0x')
    const created = eventsOf<{ token: Address; creator: Address; plugin: Address; pair: Address; creatorFeeBps: number; name: string; symbol: string; metadataURI: string }>(receipt, LP, ABI.pad, 'TokenCreated')
    check('TokenCreated emitted once', created.length, 1)
    const e = created[0]
    const token = e.token
    progress.tokens[kind] = token
    save()
    note(`${s.symbol} = ${token}, launch pair ${e.pair}`)
    check('TokenCreated', pick(e, ['creator', 'plugin', 'creatorFeeBps', 'name', 'symbol', 'metadataURI']), {
      creator: me, plugin: s.plugin, creatorFeeBps: Number(s.feeBps), name: s.name, symbol: s.symbol, metadataURI: '',
    })

    // Registration: plugin, creator fee and the hook decision, locked at launch.
    const c = await curveAt(token, B)
    check('curves(token)', pick(c, ['token', 'creator', 'pair', 'plugin', 'creatorFeeBps', 'pluginHooks', 'graduated']), {
      token, creator: me, pair: e.pair, plugin: s.plugin, creatorFeeBps: Number(s.feeBps), pluginHooks: s.hooks, graduated: false,
    })
    check('pluginOf(token)', getAddress(await rd<string>(LP, ABI.pad, 'pluginOf', [token], B)), s.plugin)
    check('pairFactory.getPair(token)', getAddress(await rd<string>(FACTORY, ABI.factory, 'getPair', [token], B)), e.pair)
    check('token wiring', {
      launchpad: getAddress(await rd<string>(token, ABI.token, 'launchpad', [], B)),
      router: getAddress(await rd<string>(token, ABI.token, 'router', [], B)),
      usdc: getAddress(await rd<string>(token, ABI.token, 'usdc', [], B)),
      pair: getAddress(await rd<string>(token, ABI.token, 'pair', [], B)),
      graduated: await rd<boolean>(token, ABI.token, 'graduated', [], B),
      totalSupply: await rd<bigint>(token, ABI.token, 'totalSupply', [], B),
    }, { launchpad: LP, router: ROUTER, usdc: USDC, pair: e.pair, graduated: false, totalSupply: TOTAL_SUPPLY })
    check('launch pair wiring, empty', {
      token: getAddress(await rd<string>(e.pair, ABI.pair, 'token', [], B)),
      usdc: getAddress(await rd<string>(e.pair, ABI.pair, 'usdc', [], B)),
      router: getAddress(await rd<string>(e.pair, ABI.pair, 'router', [], B)),
      factory: getAddress(await rd<string>(e.pair, ABI.pair, 'factory', [], B)),
      lpSupply: await rd<bigint>(e.pair, ABI.pair, 'totalSupply', [], B),
    }, { token, usdc: USDC, router: ROUTER, factory: FACTORY, lpSupply: 0n })

    // The creator's first buy, in the same transaction, pays the creator fee like any other [D3].
    const trades = eventsOf<TradeEvent>(receipt, LP, ABI.pad, 'Trade')
    check('first buy: one Trade', trades.length, initialBuy > 0n ? 1 : 0)
    if (initialBuy > 0n) {
      const t = trades[0]
      check('first buy: Trade == model', pick(t, ['trader', 'isBuy', 'usdcAmount', 'tokenAmount', 'platformFee', 'creatorFee', 'virtualUsdc', 'virtualTokens']), {
        trader: me, isBuy: true, usdcAmount: model.usdcSpent, tokenAmount: model.tokensOut, platformFee: model.platformFee,
        creatorFee: model.creatorFee, virtualUsdc: VIRTUAL_USDC_0 + model.net, virtualTokens: VIRTUAL_TOKENS_0 - model.tokensOut,
      })
      check('first buy: fees are ceil(usdcIn·50/1e4), ceil(usdcIn·c/1e4)', [t.platformFee, t.creatorFee], [divCeil(initialBuy * FEE_BPS, BPS), divCeil(initialBuy * s.feeBps, BPS)])
      check('curve after the first buy', pick(c, ['virtualUsdc', 'virtualTokens', 'tokensSold']), {
        virtualUsdc: VIRTUAL_USDC_0 + model.net, virtualTokens: VIRTUAL_TOKENS_0 - model.tokensOut, tokensSold: model.tokensOut,
      })
    }
    // The token did not exist at B-1, so its balances are checked at B alone.
    await moves('create', receipt, token, {
      padUsdc: launchFee + model.usdcSpent,
      pendingFees: launchFee + model.platformFee,
      pendingCreator: model.creatorFee,
      burnerUsdc: -(launchFee + model.usdcSpent),
    })
    check('create: burner tokens', await erc20Of(token, me, B), model.tokensOut)
    check('create: launchpad holds the rest of the supply', await erc20Of(token, LP, B), TOTAL_SUPPLY - model.tokensOut)

    // Plugin configuration: onLaunch ran once, before the first buy (V13-SPEC §5).
    if (s.hooks) {
      const configured = logsOf<{ token: Address; creator: Address }>(receipt, s.plugin, ABI.split, 'Configured')
      check(`${kind} plugin: Configured`, configured.map((l) => l.args), [{ token, creator: me }])
      const tradeLog = logsOf<TradeEvent>(receipt, LP, ABI.pad, 'Trade')[0]
      if (configured.length && tradeLog) checkThat('onLaunch ran before the first buy', configured[0].logIndex < tradeLog.logIndex, `log ${configured[0].logIndex} < ${tradeLog.logIndex}`)
      check(`${kind} plugin: isConfigured (was not before)`, [await rd(s.plugin, ABI.split, 'isConfigured', [token], B0), await rd(s.plugin, ABI.split, 'isConfigured', [token], B)], [false, true])
      await expectRevert(`${kind} plugin: a second onLaunch (write-once)`, s.plugin, ABI.split, 'onLaunch', [token, me, s.data], 'AlreadyConfigured', B, LP)
    } else {
      check('wallet: no hooks, nothing logged by the wallet', receipt.logs.filter((l) => getAddress(l.address) === s.plugin).length, 0)
    }
    if (kind === 'split') {
      check('split: payeesOf', await rd(SPLIT, ABI.split, 'payeesOf', [token], B), [PAYEES, SHARES])
      check('split: totalShares', await rd(SPLIT, ABI.split, 'totalShares', [token], B), 10n)
    }
    if (kind === 'combo') {
      check('combo: allocationOf', await rd(COMBO, ABI.combo, 'allocationOf', [token], B), [COMBO_TARGETS, COMBO_BPS, [true, true, false]])
      check('combo: its sub-plugins are configured for the token', [
        await rd(BUYBACK, ABI.buyback, 'isConfigured', [token], B),
        await rd(HOLDERS, ABI.holders, 'isConfigured', [token], B),
      ], [true, true])
      check('combo: sub-plugin Configured events carry the creator', [
        ...eventsOf(receipt, BUYBACK, ABI.buyback, 'Configured'),
        ...eventsOf(receipt, HOLDERS, ABI.holders, 'Configured'),
      ], [{ token, creator: me }, { token, creator: me }])
    }
    for (const [name, plugin] of [['split', SPLIT], ['buyback', BUYBACK], ['holders', HOLDERS], ['combo', COMBO]] as const) {
      const expected = plugin === s.plugin || (kind === 'combo' && (plugin === BUYBACK || plugin === HOLDERS))
      if (!expected) check(`${name} plugin is not configured for ${s.symbol}`, await rd(plugin, ABI.split, 'isConfigured', [token], B), false)
    }
    await identity('create', B)

    // Free negative checks, once: the launch-fee bound [D22] and createToken's validation.
    if (kind === KINDS[0]) {
      const base = [s.name, s.symbol, '', Number(s.feeBps), s.plugin, s.data, 0n, 0n, launchFee] as const
      if (launchFee > 0n) await expectRevert('createToken with maxLaunchFee below the fee', LP, ABI.pad, 'createToken', [...base.slice(0, 8), launchFee - 1n], 'LaunchFeeAboveMax', B)
      await expectRevert('createToken at a 10.01% creator fee', LP, ABI.pad, 'createToken', [s.name, s.symbol, '', 1001, s.plugin, s.data, 0n, 0n, launchFee], 'CreatorFeeTooHigh', B)
      await expectRevert('createToken paying the zero address', LP, ABI.pad, 'createToken', [s.name, s.symbol, '', 0, getAddress('0x0000000000000000000000000000000000000000'), '0x', 0n, 0n, launchFee], 'InvalidPlugin', B)
      await expectRevert('createToken paying the launchpad', LP, ABI.pad, 'createToken', [s.name, s.symbol, '', 0, LP, '0x', 0n, 0n, launchFee], 'InvalidPlugin', B)
    }
  })
}

async function curveBuy(kind: Kind) {
  const id = `buy:${kind}`
  await step(id, async () => {
    const s = SPECS[kind]
    const token = tokenOf(kind)
    const pre = await quoteCurveBuy(token, AMOUNTS.curveBuy, head)
    const { receipt, args } = await tx(id, `buy ${s.symbol} (curve)`, LP, ABI.pad, 'buy', [token, AMOUNTS.curveBuy, pre.tokensOut, me])
    const B = receipt.blockNumber
    const B0 = B - 1n
    const usdcIn = args[1] as bigint
    const c0 = await curveAt(token, B0)
    const q = await quoteCurveBuy(token, usdcIn, B0)
    const m = modelCurveBuy(c0, usdcIn, s.feeBps)
    check('quoteBuy == model', q, pick(m, ['tokensOut', 'platformFee', 'creatorFee', 'usdcSpent', 'graduates']))
    check('fees are ceil(usdcIn·50/1e4), ceil(usdcIn·c/1e4)', [q.platformFee, q.creatorFee], [divCeil(usdcIn * FEE_BPS, BPS), divCeil(usdcIn * s.feeBps, BPS)])
    const t = eventsOf<TradeEvent>(receipt, LP, ABI.pad, 'Trade')
    const net = q.usdcSpent - q.platformFee - q.creatorFee
    check('Trade == quote', t.map((x) => pick(x, ['trader', 'isBuy', 'usdcAmount', 'tokenAmount', 'platformFee', 'creatorFee', 'virtualUsdc', 'virtualTokens'])), [{
      trader: me, isBuy: true, usdcAmount: q.usdcSpent, tokenAmount: q.tokensOut, platformFee: q.platformFee, creatorFee: q.creatorFee,
      virtualUsdc: c0.virtualUsdc + net, virtualTokens: c0.virtualTokens - q.tokensOut,
    }])
    const c1 = await curveAt(token, B)
    check('curve after', pick(c1, ['virtualUsdc', 'virtualTokens', 'tokensSold']), {
      virtualUsdc: c0.virtualUsdc + net, virtualTokens: c0.virtualTokens - q.tokensOut, tokensSold: c0.tokensSold + q.tokensOut,
    })
    await moves('buy', receipt, token, { padUsdc: q.usdcSpent, pendingFees: q.platformFee, pendingCreator: q.creatorFee, burnerTokens: q.tokensOut, burnerUsdc: -q.usdcSpent })
    await identity('buy', B)
    // V13-SPEC §6.4: selling straight back what was just bought returns less than was paid.
    const [back] = await rd<readonly [bigint, bigint, bigint]>(LP, ABI.pad, 'quoteSell', [token, q.tokensOut], B)
    checkThat('selling it straight back returns less than was paid', back < q.usdcSpent, `${fmt(back)} < ${fmt(q.usdcSpent)}`)
    if (kind === KINDS[0] && me) {
      const pair = c1.pair
      await expectRevert('a transfer into the launch pair before graduation', token, ABI.token, 'transfer', [pair, 1n], 'PairLockedUntilGraduation', B)
      await expectRevert('router.quoteBuy before graduation', ROUTER, ABI.router, 'quoteBuy', [token, usd(1)], 'NotGraduated', B)
      await expectRevert('a direct LaunchPair.swap', pair, ABI.pair, 'swap', [1n, 0n, me], 'OnlyRouter', B)
      await expectRevert('accrueTradeFees from anyone but the router', LP, ABI.pad, 'accrueTradeFees', [token, 1n, 1n], 'Forbidden', B)
    }
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
    const { receipt, args } = await tx(id, `sell ${s.symbol} (curve, half)`, LP, ABI.pad, 'sell', [token, half, preOut, me])
    const B = receipt.blockNumber
    const B0 = B - 1n
    const tokensIn = args[1] as bigint
    check('sold half the burner held', tokensIn, (await erc20Of(token, me, B0)) / 2n)
    const c0 = await curveAt(token, B0)
    const [usdcOut, platformFee, creatorFee] = await rd<readonly [bigint, bigint, bigint]>(LP, ABI.pad, 'quoteSell', [token, tokensIn], B0)
    const m = modelCurveSell(c0, tokensIn, s.feeBps)
    check('quoteSell == model', { usdcOut, platformFee, creatorFee }, pick(m, ['usdcOut', 'platformFee', 'creatorFee']))
    check('fees are ceil(gross·50/1e4), ceil(gross·c/1e4), out = gross - both', [platformFee, creatorFee, usdcOut], [divCeil(m.gross * FEE_BPS, BPS), divCeil(m.gross * s.feeBps, BPS), m.gross - platformFee - creatorFee])
    const t = eventsOf<TradeEvent>(receipt, LP, ABI.pad, 'Trade')
    check('Trade == quote (usdcAmount is gross)', t.map((x) => pick(x, ['trader', 'isBuy', 'usdcAmount', 'tokenAmount', 'platformFee', 'creatorFee', 'virtualUsdc', 'virtualTokens'])), [{
      trader: me, isBuy: false, usdcAmount: m.gross, tokenAmount: tokensIn, platformFee, creatorFee,
      virtualUsdc: c0.virtualUsdc - m.gross, virtualTokens: c0.virtualTokens + tokensIn,
    }])
    check('tokensSold after', (await curveAt(token, B)).tokensSold, c0.tokensSold - tokensIn)
    await moves('sell', receipt, token, { padUsdc: -usdcOut, pendingFees: platformFee, pendingCreator: creatorFee, burnerTokens: -tokensIn, burnerUsdc: usdcOut })
    await identity('sell', B)
  })
}

/** A plugin credited by onFees: FeesReceived from `from`, and its USDC and usdcHeld up by `amount`. */
async function credited(what: string, receipt: TransactionReceipt, plugin: Address, abi: Abi, token: Address, from: Address, amount: bigint) {
  const B = receipt.blockNumber
  check(`${what}: FeesReceived`, eventsOf<{ token: Address; from: Address; amount: bigint }>(receipt, plugin, abi, 'FeesReceived'), [{ token, from, amount }])
  check(`${what}: usdcHeld(token)`, (await rd<bigint>(plugin, abi, 'usdcHeld', [token], B)) - (await rd<bigint>(plugin, abi, 'usdcHeld', [token], B - 1n)), amount)
}

/** Distribute to holders receiving `amount` for `token` in `receipt`: the stream moves exactly as [D21] says. */
async function holdersCredited(what: string, receipt: TransactionReceipt, token: Address, from: Address, amount: bigint) {
  const B = receipt.blockNumber
  const B0 = B - 1n
  const now = await timeOf(B)
  const s0 = await streamAt(token, B0)
  const eligible = (await rd<bigint>(token, ABI.token, 'eligibleSupply', [], B0)) > 0n
  const { due, next } = streamAfterFees(s0, amount, now, eligible)
  check(`${what}: FeesReceived`, eventsOf(receipt, HOLDERS, ABI.holders, 'FeesReceived'), [{ token, from, amount }])
  check(`${what}: stream (unreleased, lastDrip, streamEnd)`, await streamAt(token, B), next)
  if (s0.unreleased === 0n) check(`${what}: a delivery to an empty stream runs exactly DRIP_PERIOD`, next.streamEnd - now, DRIP_PERIOD)
  check(`${what}: FeesStreamed`, eventsOf(receipt, HOLDERS, ABI.holders, 'FeesStreamed'), [{ token, amount, unreleased: next.unreleased, streamEnd: next.streamEnd }])
  check(`${what}: what the old stream owed went out first`, eventsOf(receipt, HOLDERS, ABI.holders, 'Distributed'), due > 0n ? [{ token, amount: due }] : [])
  check(`${what}: holders plugin USDC`, (await usdcOf(HOLDERS, B)) - (await usdcOf(HOLDERS, B0)), amount - due)
  check(`${what}: token totalDistributed`, (await rd<bigint>(token, ABI.token, 'totalDistributed', [], B)) - (await rd<bigint>(token, ABI.token, 'totalDistributed', [], B0)), due)
  check(`${what}: plugin totalDistributed`, (await rd<bigint>(HOLDERS, ABI.holders, 'totalDistributed', [token], B)) - (await rd<bigint>(HOLDERS, ABI.holders, 'totalDistributed', [token], B0)), due)
  if (due > 0n) note(`${what}: ${fmt(due)} of the running stream was due and was distributed first`)
}

async function collect(kind: Kind, round: number) {
  const id = `collect${round}:${kind}`
  await step(id, async () => {
    const s = SPECS[kind]
    const token = tokenOf(kind)
    const { receipt } = await tx(id, `collectCreatorFees ${s.symbol}`, LP, ABI.pad, 'collectCreatorFees', [token])
    const B = receipt.blockNumber
    const B0 = B - 1n
    const amount = await rd<bigint>(LP, ABI.pad, 'pendingCreatorFees', [token], B0)
    checkThat('there were creator fees to collect', amount > 0n, `${fmt(amount)} USDC`)
    check('CreatorFeesCollected', eventsOf<{ token: Address; plugin: Address; amount: bigint }>(receipt, LP, ABI.pad, 'CreatorFeesCollected'), [{ token, plugin: s.plugin, amount }])
    check('pendingCreatorFees(token) after', await rd<bigint>(LP, ABI.pad, 'pendingCreatorFees', [token], B), 0n)
    await moves('collect', receipt, token, { padUsdc: -amount, burnerUsdc: 0n })
    const deltaOf = async (who: Address) => (await usdcOf(who, B)) - (await usdcOf(who, B0))

    if (kind === 'wallet') {
      check('wallet received exactly the fees (plain transfer)', await deltaOf(CREATOR_WALLET), amount)
    } else if (kind === 'split') {
      await credited('split', receipt, SPLIT, ABI.split, token, LP, amount)
      check('split: totalReceived', (await rd<bigint>(SPLIT, ABI.split, 'totalReceived', [token], B)) - (await rd<bigint>(SPLIT, ABI.split, 'totalReceived', [token], B0)), amount)
      check('split: plugin USDC', await deltaOf(SPLIT), amount)
    } else if (kind === 'buyback') {
      await credited('buyback', receipt, BUYBACK, ABI.buyback, token, LP, amount)
      check('buyback: plugin USDC', await deltaOf(BUYBACK), amount)
    } else if (kind === 'holders') {
      await holdersCredited('holders', receipt, token, LP, amount)
    } else {
      // Combo: 40% buyback & burn, 40% holders, 20% a wallet; the last entry takes the rounding remainder.
      const s0 = (amount * 4000n) / BPS
      const s1 = (amount * 4000n) / BPS
      const slices = [s0, s1, amount - s0 - s1]
      check('combo: previewSplit == 40/40/20, last takes the remainder', await rd(COMBO, ABI.combo, 'previewSplit', [token, amount], B0), slices)
      check('combo: FeesReceived', eventsOf(receipt, COMBO, ABI.combo, 'FeesReceived'), [{ token, from: LP, amount }])
      check('combo: FeesForwarded', eventsOf(receipt, COMBO, ABI.combo, 'FeesForwarded'), [
        { token, target: BUYBACK, amount: slices[0], viaHook: true },
        { token, target: HOLDERS, amount: slices[1], viaHook: true },
        { token, target: COMBO_WALLET, amount: slices[2], viaHook: false },
      ])
      await credited('combo → buyback', receipt, BUYBACK, ABI.buyback, token, COMBO, slices[0])
      check('combo → buyback: plugin USDC', await deltaOf(BUYBACK), slices[0])
      await holdersCredited('combo → holders', receipt, token, COMBO, slices[1])
      check('combo → wallet', await deltaOf(COMBO_WALLET), slices[2])
      check('combo keeps nothing', [await usdcOf(COMBO, B0), await usdcOf(COMBO, B)], [0n, 0n])
    }
    await identity('collect', B)
  })
}

async function releaseAll(round: number) {
  if (!has('split')) return
  const token = tokenOf('split')
  for (const [i, payee] of PAYEES.entries()) {
    const id = `release${round}:split:${i + 1}`
    await step(id, async () => {
      const { receipt } = await tx(id, `release payee ${i + 1}`, SPLIT, ABI.split, 'release', [token, payee])
      const B = receipt.blockNumber
      const B0 = B - 1n
      const received = await rd<bigint>(SPLIT, ABI.split, 'totalReceived', [token], B0)
      const paid = await rd<bigint>(SPLIT, ABI.split, 'released', [token, payee], B0)
      const owed = (received * SHARES[i]) / 10n - paid
      check(`payee ${i + 1}: releasable == totalReceived·${SHARES[i]}/10 - released`, await rd<bigint>(SPLIT, ABI.split, 'releasable', [token, payee], B0), owed)
      checkThat(`payee ${i + 1}: something to release`, owed > 0n, fmt(owed))
      check('Released', eventsOf(receipt, SPLIT, ABI.split, 'Released'), [{ token, payee, amount: owed }])
      check(`payee ${i + 1} received exactly that`, (await usdcOf(payee, B)) - (await usdcOf(payee, B0)), owed)
      check('split plugin USDC', (await usdcOf(SPLIT, B)) - (await usdcOf(SPLIT, B0)), -owed)
      check('split usdcHeld', (await rd<bigint>(SPLIT, ABI.split, 'usdcHeld', [token], B)) - (await rd<bigint>(SPLIT, ABI.split, 'usdcHeld', [token], B0)), -owed)
      check('nothing left releasable for the payee', await rd<bigint>(SPLIT, ABI.split, 'releasable', [token, payee], B), 0n)
    })
  }
}

async function buyback(kind: Kind, round: number) {
  const id = `run${round}:${kind}`
  await step(id, async () => {
    const s = SPECS[kind]
    const token = tokenOf(kind)
    const { receipt } = await tx(id, `buyback run ${s.symbol}`, BUYBACK, ABI.buyback, 'run', [token])
    const B = receipt.blockNumber
    const B0 = B - 1n
    const graduated = await rd<boolean>(LP, ABI.pad, 'isGraduated', [token], B0)
    const held = await rd<bigint>(BUYBACK, ABI.buyback, 'usdcHeld', [token], B0)
    const pair = (await curveAt(token, B0)).pair
    const r0 = await reservesAt(pair, B0)
    const reserve = graduated ? r0.reserveUsdc : await rd<bigint>(LP, ABI.pad, 'virtualUsdcOf', [token], B0)
    const cap = (reserve * CAP_BPS) / BPS
    const offer = minOf(held, cap)
    check('previewRun == min(usdcHeld, 0.25% of the USDC-side reserve)', await rd(BUYBACK, ABI.buyback, 'previewRun', [token], B0), [offer, graduated])
    let tokensOut: bigint
    let platformFee: bigint
    let creatorFee: bigint
    if (graduated) {
      ;[tokensOut, platformFee, creatorFee] = await rd<readonly [bigint, bigint, bigint]>(ROUTER, ABI.router, 'quoteBuy', [token, offer], B0)
      check('bought through the launch router: PoolTrade == quote', eventsOf<PoolTradeEvent>(receipt, ROUTER, ABI.router, 'PoolTrade'), [{
        token, trader: BUYBACK, isBuy: true, usdcAmount: offer, tokenAmount: tokensOut, platformFee, creatorFee,
      }])
      check('PoolFeesAccrued', eventsOf(receipt, LP, ABI.pad, 'PoolFeesAccrued'), [{ token, platformFee, creatorFee }])
      const r1 = await reservesAt(pair, B)
      check('pool reserves after', r1, { reserveToken: r0.reserveToken - tokensOut, reserveUsdc: r0.reserveUsdc + offer - platformFee - creatorFee })
      await moves('buyback', receipt, token, { padUsdc: platformFee + creatorFee, pendingFees: platformFee, pendingCreator: creatorFee, burnerUsdc: 0n })
    } else {
      const q = await quoteCurveBuy(token, offer, B0)
      ;({ tokensOut, platformFee, creatorFee } = q)
      check('a normal curve buy of the whole offer', [q.usdcSpent, q.graduates], [offer, false])
      check('bought on the curve: Trade == quote', eventsOf<TradeEvent>(receipt, LP, ABI.pad, 'Trade').map((x) => pick(x, ['trader', 'isBuy', 'usdcAmount', 'tokenAmount', 'platformFee', 'creatorFee'])), [{
        trader: BUYBACK, isBuy: true, usdcAmount: offer, tokenAmount: tokensOut, platformFee, creatorFee,
      }])
      await moves('buyback', receipt, token, { padUsdc: offer, pendingFees: platformFee, pendingCreator: creatorFee, burnerUsdc: 0n })
    }
    check('BuybackRun', eventsOf(receipt, BUYBACK, ABI.buyback, 'BuybackRun'), [{ token, caller: me, graduated, usdcSpent: offer, tokensBurned: tokensOut }])
    checkThat('spend ≤ 0.25% cap', offer <= cap, `${fmt(offer)} ≤ ${fmt(cap)} (reserve ${fmt(reserve)}, waiting ${fmt(held)})`)
    if (held > cap) check('the cap binds: spend == cap', offer, cap)
    const supply = async (b: bigint) => rd<bigint>(token, ABI.token, 'totalSupply', [], b)
    check('total supply fell by the tokens bought (burned)', (await supply(B)) - (await supply(B0)), -tokensOut)
    check('buyback holds no tokens before or after', [await erc20Of(token, BUYBACK, B0), await erc20Of(token, BUYBACK, B)], [0n, 0n])
    check('usdcHeld fell by the spend', (await rd<bigint>(BUYBACK, ABI.buyback, 'usdcHeld', [token], B)) - held, -offer)
    check('buyback plugin USDC fell by the spend', (await usdcOf(BUYBACK, B)) - (await usdcOf(BUYBACK, B0)), -offer)
    check('totals: totalUsdcSpent, totalTokensBurned', [
      (await rd<bigint>(BUYBACK, ABI.buyback, 'totalUsdcSpent', [token], B)) - (await rd<bigint>(BUYBACK, ABI.buyback, 'totalUsdcSpent', [token], B0)),
      (await rd<bigint>(BUYBACK, ABI.buyback, 'totalTokensBurned', [token], B)) - (await rd<bigint>(BUYBACK, ABI.buyback, 'totalTokensBurned', [token], B0)),
    ], [offer, tokensOut])
    check('nextRunBlock == this block + 1', await rd(BUYBACK, ABI.buyback, 'nextRunBlock', [token], B), B + 1n)
    check('previewRun in the same block offers nothing', await rd(BUYBACK, ABI.buyback, 'previewRun', [token], B), [0n, graduated])
    await expectRevert('a second run in the same block', BUYBACK, ABI.buyback, 'run', [token], 'AlreadyRanThisBlock', B)
    await identity('buyback', B)
  })
}

async function sample(round: number) {
  if (!HOLDER_KINDS.length) return
  await step(`sample${round}`, async () => {
    // Distribute to holders drips over 24 hours [D21]: what a holder can be paid grows with time, by the formula.
    const b1 = maxOf(await latest(), head)
    const t1 = await timeOf(b1)
    const first = new Map<Kind, bigint>()
    for (const kind of HOLDER_KINDS) first.set(kind, await rd<bigint>(HOLDERS, ABI.holders, 'releasable', [tokenOf(kind)], b1))
    note(`waiting ${SAMPLE_SECONDS} s for the drip to grow`)
    await sleep(SAMPLE_SECONDS * 1000)
    const b2 = maxOf(await latest(), b1 + 1n)
    const t2 = await timeOf(b2)
    for (const kind of HOLDER_KINDS) {
      const token = tokenOf(kind)
      const s = await streamAt(token, b1)
      check(`${kind}: stream unchanged between the samples`, await streamAt(token, b2), s)
      const r1 = first.get(kind) ?? 0n
      const r2 = await rd<bigint>(HOLDERS, ABI.holders, 'releasable', [token], b2)
      check(`${kind}: releasable at t1 == unreleased·(t1-lastDrip)/(end-lastDrip)`, r1, streamDue(s, t1, true))
      check(`${kind}: releasable at t2 (${t2 - t1} s later)`, r2, streamDue(s, t2, true))
      checkThat(`${kind}: releasable grows with time`, r2 > r1, `${fmt(r1)} → ${fmt(r2)} of ${fmt(s.unreleased)} USDC`)
    }
  })
}

async function drip(kind: Kind, round: number) {
  const id = `drip${round}:${kind}`
  await step(id, async () => {
    if (!me) return
    const token = tokenOf(kind)
    const { receipt } = await tx(id, `dripAndClaim ${SPECS[kind].symbol}`, HOLDERS, ABI.holders, 'dripAndClaim', [token])
    const B = receipt.blockNumber
    const B0 = B - 1n
    const now = await timeOf(B)
    const s0 = await streamAt(token, B0)
    const eligibleSupply = await rd<bigint>(token, ABI.token, 'eligibleSupply', [], B0)
    const sole = eligibleSupply === (await erc20Of(token, me, B0))
    const released = streamDue(s0, now, eligibleSupply > 0n)
    checkThat('something was due', released > 0n, `${fmt(released)} of ${fmt(s0.unreleased)} USDC after ${now - s0.lastDrip} s`)
    check('Distributed == unreleased·(now-lastDrip)/(end-lastDrip)', eventsOf(receipt, HOLDERS, ABI.holders, 'Distributed'), [{ token, amount: released }])
    check('the token took it through distribute', eventsOf(receipt, token, ABI.token, 'DividendsDistributed'), [{ from: HOLDERS, amount: released }])
    check('stream after', await streamAt(token, B), { unreleased: s0.unreleased - released, lastDrip: now, streamEnd: s0.streamEnd })
    const claimableBefore = await rd<bigint>(token, ABI.token, 'claimable', [me], B0)
    const claims = eventsOf<{ holder: Address; amount: bigint }>(receipt, token, ABI.token, 'DividendClaimed')
    check('one claim, paid to the caller', claims.map((c) => c.holder), [me])
    const claimed = claims[0]?.amount ?? 0n
    checkThat('the claim pays > 0', claimed > 0n, fmt(claimed))
    checkThat('the claim is never more than released', claimed <= claimableBefore + released, `${fmt(claimed)} ≤ ${fmt(claimableBefore)} waiting + ${fmt(released)} released`)
    if (sole) checkThat('sole eligible holder: all of it, less at most 1 unit of rounding', claimed + 1n >= claimableBefore + released, `${claimableBefore + released - claimed} unit(s) of dust`)
    await burnerSide('dripAndClaim', receipt, claimed)
    check('holders plugin USDC', (await usdcOf(HOLDERS, B)) - (await usdcOf(HOLDERS, B0)), -released)
    check("token's USDC (dividends not yet claimed)", (await usdcOf(token, B)) - (await usdcOf(token, B0)), released - claimed)
    check('claimed(burner)', (await rd<bigint>(token, ABI.token, 'claimed', [me], B)) - (await rd<bigint>(token, ABI.token, 'claimed', [me], B0)), claimed)
    check('claimable(burner) after', await rd<bigint>(token, ABI.token, 'claimable', [me], B), 0n)
    const distributed = await rd<bigint>(token, ABI.token, 'totalDistributed', [], B)
    check('token.totalDistributed == plugin.totalDistributed(token)', distributed, await rd<bigint>(HOLDERS, ABI.holders, 'totalDistributed', [token], B))
    const claimedTotal = await rd<bigint>(token, ABI.token, 'claimed', [me], B)
    checkThat('Σ claimed + Σ claimable ≤ Σ distributed (§6.6)', claimedTotal <= distributed, `${fmt(claimedTotal)} ≤ ${fmt(distributed)}`)
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
      const pre = await quoteCurveBuy(token, AMOUNTS.graduateOffer, head)
      if (!pre.graduates) throw new Error(`${s.symbol}: a ${fmt(AMOUNTS.graduateOffer)} buy would not sell out the curve`)
      const have = await usdcOf(me, head)
      if (have < pre.usdcSpent) await tx(id, 'mint rUSDC (top-up)', USDC, ABI.erc20, 'mint', [me, pre.usdcSpent - have + usd(1000)])
      minOut = pre.tokensOut
    }
    const { receipt, args } = await tx(id, what, LP, ABI.pad, 'buy', [token, AMOUNTS.graduateOffer, minOut, me])
    const B = receipt.blockNumber
    const B0 = B - 1n
    const usdcIn = args[1] as bigint
    const c0 = await curveAt(token, B0)
    const q = await quoteCurveBuy(token, usdcIn, B0)
    const m = modelCurveBuy(c0, usdcIn, s.feeBps)
    const remaining = CURVE_SUPPLY - c0.tokensSold
    check('quoteBuy == model', q, pick(m, ['tokensOut', 'platformFee', 'creatorFee', 'usdcSpent', 'graduates']))
    check('the sell-out buy: all remaining tokens, graduates', [q.tokensOut, q.graduates], [remaining, true])
    // Exact fill (V13-SPEC §5), written out.
    const feeBps = FEE_BPS + s.feeBps
    const net = divCeil(c0.virtualUsdc * c0.virtualTokens, c0.virtualTokens - remaining) - c0.virtualUsdc
    const gross = net + divCeil(net * feeBps, BPS - feeBps)
    const totalFee = q.usdcSpent - net
    check('usdcSpent == min(net + ceil(net·(50+c)/(1e4-(50+c))), usdcIn)', q.usdcSpent, minOf(gross, usdcIn))
    check('platformFee == ceil(totalFee·50/(50+c)), creatorFee == the rest', [q.platformFee, q.creatorFee], [divCeil(totalFee * FEE_BPS, feeBps), totalFee - divCeil(totalFee * FEE_BPS, feeBps)])
    checkThat('pulls only what the last tokens cost', q.usdcSpent < usdcIn, `${fmt(q.usdcSpent)} of ${fmt(usdcIn)} offered`)
    const virtualUsdc = c0.virtualUsdc + net
    check('Trade == quote', eventsOf<TradeEvent>(receipt, LP, ABI.pad, 'Trade').map((x) => pick(x, ['trader', 'isBuy', 'usdcAmount', 'tokenAmount', 'platformFee', 'creatorFee', 'virtualUsdc', 'virtualTokens'])), [{
      trader: me, isBuy: true, usdcAmount: q.usdcSpent, tokenAmount: remaining, platformFee: q.platformFee, creatorFee: q.creatorFee,
      virtualUsdc, virtualTokens: c0.virtualTokens - remaining,
    }])
    const usdcSeeded = virtualUsdc - VIRTUAL_USDC_0
    const liquidity = sqrt(POOL_SUPPLY * usdcSeeded) - MINIMUM_LIQUIDITY
    check('Graduated', eventsOf(receipt, LP, ABI.pad, 'Graduated'), [{ token, pair: c0.pair, usdcSeeded, tokensSeeded: POOL_SUPPLY, liquidityLocked: liquidity }])
    check('launch pair Mint', eventsOf(receipt, c0.pair, ABI.pair, 'Mint'), [{ sender: LP, amountToken: POOL_SUPPLY, amountUsdc: usdcSeeded }])
    note(`${s.symbol} graduated: ${fmt(usdcSeeded)} USDC × 200M tokens seeded, ${fmt(q.usdcSpent)} USDC spent`)
    check('LaunchPair.getReserves() == seeded amounts', await reservesAt(c0.pair, B), { reserveToken: POOL_SUPPLY, reserveUsdc: usdcSeeded })
    check('pair balances == reserves (nothing extra)', [await erc20Of(token, c0.pair, B), await usdcOf(c0.pair, B)], [POOL_SUPPLY, usdcSeeded])
    const c1 = await curveAt(token, B)
    check('curves(token) after', pick(c1, ['graduated', 'tokensSold', 'virtualUsdc']), { graduated: true, tokensSold: CURVE_SUPPLY, virtualUsdc })
    check('token.graduated(), isGraduated(token)', [await rd(token, ABI.token, 'graduated', [], B), await rd(LP, ABI.pad, 'isGraduated', [token], B)], [true, true])
    // LP tokens (V13-SPEC §4, §5): all of the graduation liquidity is minted to 0x…dEaD, MINIMUM_LIQUIDITY included.
    const lpSupply = await rd<bigint>(c0.pair, ABI.pair, 'totalSupply', [], B)
    check('LP supply == sqrt(tokens·usdc) (MINIMUM_LIQUIDITY + liquidityLocked)', lpSupply, liquidity + MINIMUM_LIQUIDITY)
    check('every LP token is at 0x…dEaD', await rd(c0.pair, ABI.pair, 'balanceOf', [DEAD], B), lpSupply)
    check('no LP token with the launchpad or the buyer', [await rd(c0.pair, ABI.pair, 'balanceOf', [LP], B), await rd(c0.pair, ABI.pair, 'balanceOf', [me], B)], [0n, 0n])
    check('the launchpad holds none of the token (800M sold, 200M pooled)', await erc20Of(token, LP, B), 0n)
    await moves('graduation', receipt, token, {
      padUsdc: q.usdcSpent - usdcSeeded, pendingFees: q.platformFee, pendingCreator: q.creatorFee, burnerTokens: remaining, burnerUsdc: -q.usdcSpent,
    })
    await identity('graduation (the float leaves the sum)', B)
    await expectRevert('launchpad.quoteBuy after graduation', LP, ABI.pad, 'quoteBuy', [token, usd(1)], 'CurveGraduated', B)
    await expectRevert('a curve sell after graduation', LP, ABI.pad, 'sell', [token, E18, 0n, me], 'CurveGraduated', B)
    await expectRevert('a direct LaunchPair.swap after graduation', c0.pair, ABI.pair, 'swap', [E18, 0n, me], 'OnlyRouter', B)
  })
}

async function poolBuy(kind: Kind) {
  const id = `poolbuy:${kind}`
  await step(id, async () => {
    if (!me) return
    const s = SPECS[kind]
    const token = tokenOf(kind)
    const [preOut] = await rd<readonly [bigint, bigint, bigint]>(ROUTER, ABI.router, 'quoteBuy', [token, AMOUNTS.poolBuy], head)
    const deadline = (await timeOf(head)) + 3600n
    const { receipt, args } = await tx(id, `buy ${s.symbol} (launch router)`, ROUTER, ABI.router, 'buy', [token, AMOUNTS.poolBuy, preOut, me, deadline])
    const B = receipt.blockNumber
    const B0 = B - 1n
    const usdcIn = args[1] as bigint
    const pair = (await curveAt(token, B0)).pair
    const r0 = await reservesAt(pair, B0)
    const [tokensOut, platformFee, creatorFee] = await rd<readonly [bigint, bigint, bigint]>(ROUTER, ABI.router, 'quoteBuy', [token, usdcIn], B0)
    const m = modelPoolBuy(r0.reserveToken, r0.reserveUsdc, usdcIn, s.feeBps)
    check('router.quoteBuy == model', { tokensOut, platformFee, creatorFee }, pick(m, ['tokensOut', 'platformFee', 'creatorFee']))
    check('PoolTrade == quote', eventsOf(receipt, ROUTER, ABI.router, 'PoolTrade'), [{ token, trader: me, isBuy: true, usdcAmount: usdcIn, tokenAmount: tokensOut, platformFee, creatorFee }])
    check('PoolFeesAccrued (recorded per token)', eventsOf(receipt, LP, ABI.pad, 'PoolFeesAccrued'), [{ token, platformFee, creatorFee }])
    check('pool reserves after', await reservesAt(pair, B), { reserveToken: r0.reserveToken - tokensOut, reserveUsdc: r0.reserveUsdc + m.net })
    await moves('pool buy', receipt, token, { padUsdc: platformFee + creatorFee, pendingFees: platformFee, pendingCreator: creatorFee, burnerTokens: tokensOut, burnerUsdc: -usdcIn })
    progress.notes[`${id}:tokensOut`] = tokensOut.toString()
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
    const tokensInPlan = bought > 0n ? bought / 2n : (await erc20Of(token, me, head)) / 1000n
    const [preOut] = await rd<readonly [bigint, bigint, bigint]>(ROUTER, ABI.router, 'quoteSell', [token, tokensInPlan], head)
    const deadline = (await timeOf(head)) + 3600n
    const { receipt, args } = await tx(id, `sell ${s.symbol} (launch router)`, ROUTER, ABI.router, 'sell', [token, tokensInPlan, preOut, me, deadline])
    const B = receipt.blockNumber
    const B0 = B - 1n
    const tokensIn = args[1] as bigint
    const pair = (await curveAt(token, B0)).pair
    const r0 = await reservesAt(pair, B0)
    const [usdcOut, platformFee, creatorFee] = await rd<readonly [bigint, bigint, bigint]>(ROUTER, ABI.router, 'quoteSell', [token, tokensIn], B0)
    const m = modelPoolSell(r0.reserveToken, r0.reserveUsdc, tokensIn, s.feeBps)
    check('router.quoteSell == model', { usdcOut, platformFee, creatorFee }, pick(m, ['usdcOut', 'platformFee', 'creatorFee']))
    check('PoolTrade == quote (usdcAmount is gross)', eventsOf(receipt, ROUTER, ABI.router, 'PoolTrade'), [{ token, trader: me, isBuy: false, usdcAmount: m.gross, tokenAmount: tokensIn, platformFee, creatorFee }])
    check('PoolFeesAccrued (recorded per token)', eventsOf(receipt, LP, ABI.pad, 'PoolFeesAccrued'), [{ token, platformFee, creatorFee }])
    check('pool reserves after', await reservesAt(pair, B), { reserveToken: r0.reserveToken + tokensIn, reserveUsdc: r0.reserveUsdc - m.gross })
    await moves('pool sell', receipt, token, { padUsdc: platformFee + creatorFee, pendingFees: platformFee, pendingCreator: creatorFee, burnerTokens: -tokensIn, burnerUsdc: usdcOut })
    await identity('pool sell', B)
  })
}

async function collectPlatformFees() {
  await step('collectFees', async () => {
    const { receipt } = await tx('collectFees', 'collectFees', LP, ABI.pad, 'collectFees', [])
    const B = receipt.blockNumber
    const B0 = B - 1n
    const pending = await rd<bigint>(LP, ABI.pad, 'pendingFees', [], B0)
    const feeTo = getAddress(await rd<string>(LP, ABI.pad, 'feeTo', [], B0))
    checkThat('platform fees were waiting', pending > 0n, `${fmt(pending)} USDC`)
    check('FeesCollected', eventsOf(receipt, LP, ABI.pad, 'FeesCollected'), [{ feeTo, amount: pending }])
    check('pendingFees after', await rd<bigint>(LP, ABI.pad, 'pendingFees', [], B), 0n)
    check('launchpad USDC', (await usdcOf(LP, B)) - (await usdcOf(LP, B0)), -pending)
    if (feeTo === me) await burnerSide('feeTo (the burner) received exactly pendingFees', receipt, pending)
    else check('feeTo received exactly pendingFees', (await usdcOf(feeTo, B)) - (await usdcOf(feeTo, B0)), pending)
    await identity('collectFees', B)
  })
}

async function finalState() {
  await step('final', async () => {
    const B = maxOf(await latest(), head)
    const made = KINDS.filter((k) => progress.tokens[k])
    const held = async (plugin: Address, abi: Abi, kinds: Kind[]) => {
      let sum = 0n
      for (const k of kinds.filter((x) => made.includes(x))) sum += await rd<bigint>(plugin, abi, 'usdcHeld', [tokenOf(k)], B)
      return sum
    }
    check('split USDC == Σ usdcHeld over its tokens', await usdcOf(SPLIT, B), await held(SPLIT, ABI.split, ['split']))
    check('buyback USDC == Σ usdcHeld over its tokens', await usdcOf(BUYBACK, B), await held(BUYBACK, ABI.buyback, ['buyback', 'combo']))
    check('holders USDC == Σ usdcHeld (unreleased) over its tokens', await usdcOf(HOLDERS, B), await held(HOLDERS, ABI.holders, ['holders', 'combo']))
    check('combo USDC == 0 (it forwards everything)', await usdcOf(COMBO, B), 0n)
    await identity('final', B)
    for (const k of made) {
      const token = tokenOf(k)
      const supply = await rd<bigint>(token, ABI.token, 'totalSupply', [], B)
      const c = await curveAt(token, B)
      const line = [`${SPECS[k].symbol}: ${c.graduated ? 'graduated' : `on the curve (${fmt(c.virtualUsdc - VIRTUAL_USDC_0)} USDC float)`}`, `supply ${formatUnits(supply, 18)}`]
      if (BUYBACK_KINDS.includes(k)) {
        check(`${SPECS[k].symbol}: every token burned was burned by the buyback`, TOTAL_SUPPLY - supply, await rd<bigint>(BUYBACK, ABI.buyback, 'totalTokensBurned', [token], B))
      }
      if (HOLDER_KINDS.includes(k) && me) {
        const distributed = await rd<bigint>(token, ABI.token, 'totalDistributed', [], B)
        const claimed = await rd<bigint>(token, ABI.token, 'claimed', [me], B)
        const claimable = await rd<bigint>(token, ABI.token, 'claimable', [me], B)
        checkThat(`${SPECS[k].symbol}: Σ claimed + Σ claimable ≤ Σ distributed (§6.6)`, claimed + claimable <= distributed, `${fmt(claimed)} + ${fmt(claimable)} ≤ ${fmt(distributed)}`)
        check(`${SPECS[k].symbol}: token USDC == distributed - claimed`, await usdcOf(token, B), distributed - claimed)
        line.push(`dividends ${fmt(distributed)} distributed, ${fmt(claimed)} claimed`)
      }
      if (c.graduated) {
        const r = await reservesAt(c.pair, B)
        check(`${SPECS[k].symbol}: pool reserves == pool balances`, r, { reserveToken: await erc20Of(token, c.pair, B), reserveUsdc: await usdcOf(c.pair, B) })
        line.push(`pool ${fmt(r.reserveUsdc)} USDC × ${formatUnits(r.reserveToken, 18)} tokens`)
      }
      note(line.join(', '))
    }
  }, true)
}

// ── Summary ───────────────────────────────────────────────────────────────────

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
    const r = await retry(() => pub.getTransactionReceipt({ hash: hash as Hex }))
    rows.push({ step: 'deploy', what, hash, gasUsed: r.gasUsed, costWei: r.gasUsed * r.effectiveGasPrice })
  }
  for (const t of progress.txs) rows.push({ step: t.step, what: t.what, hash: t.hash, gasUsed: BigInt(t.gasUsed), costWei: BigInt(t.gasUsed) * BigInt(t.gasPrice) })
  const usdcOfWei = (wei: bigint) => Number(formatUnits(wei, 18)).toFixed(6)
  const result = (stepId: string) => (stepId === 'deploy' ? 'deployed' : (progress.results.find((r) => r.step === stepId)?.ok ?? false) ? 'pass' : progress.done[stepId] ? 'pass' : 'FAIL')
  console.log(`\n── gas (${rows.length} transactions)`)
  if (MARKDOWN) {
    console.log('| step | transaction | tx hash | gas | USDC | result |\n| --- | --- | --- | ---: | ---: | --- |')
    for (const r of rows) console.log(`| ${r.step} | ${r.what} | \`${r.hash}\` | ${r.gasUsed.toLocaleString('en-US')} | ${usdcOfWei(r.costWei)} | ${result(r.step)} |`)
  } else {
    for (const r of rows) console.log(`${r.step.padEnd(20)} ${r.what.padEnd(34)} ${r.hash}  ${r.gasUsed.toString().padStart(10)}  ${usdcOfWei(r.costWei)}  ${result(r.step)}`)
  }
  const deployGas = rows.filter((r) => r.step === 'deploy').reduce((s, r) => s + r.gasUsed, 0n)
  const deployWei = rows.filter((r) => r.step === 'deploy').reduce((s, r) => s + r.costWei, 0n)
  const driveGas = rows.filter((r) => r.step !== 'deploy').reduce((s, r) => s + r.gasUsed, 0n)
  const driveWei = rows.filter((r) => r.step !== 'deploy').reduce((s, r) => s + r.costWei, 0n)
  console.log(`deploy: ${deployGas} gas, ${usdcOfWei(deployWei)} USDC`)
  console.log(`drive:  ${driveGas} gas, ${usdcOfWei(driveWei)} USDC`)
  console.log(`total:  ${deployGas + driveGas} gas, ${usdcOfWei(deployWei + driveWei)} USDC`)
  const failedSteps = progress.results.filter((r) => !r.ok)
  console.log(`steps: ${Object.keys(progress.done).length} done${failedSteps.length ? `, failing: ${failedSteps.map((r) => r.step).join(', ')}` : ''}; this run: ${checks} checks, ${failures} failed, ${rpcRetries} RPC retries`)
}

// ── Run ───────────────────────────────────────────────────────────────────────

try {
  await wiring()
  if (!account || !me) {
    if (progressExists && Object.keys(progress.tokens).length) await finalState()
    else console.log('\nBURNER_KEY not set and nothing driven yet: read-only checks only.')
    await summary()
    process.exit(failures ? 1 : 0)
  }
  progress.burner = me
  save()
  console.log(`\nburner ${me}: ${formatUnits(await nativeOf(me, head), 18)} USDC (native)${REAL ? '' : `, ${fmt(await usdcOf(me, head))} rUSDC`}`)
  console.log(`tokens: ${KINDS.join(', ')}; wallet ${CREATOR_WALLET}, payees ${PAYEES.join(', ')}, combo wallet ${COMBO_WALLET}`)
  await recoverPending()
  if (!REAL) await fund()
  await approvals()
  for (const k of KINDS) await create(k)
  for (const k of KINDS) {
    await curveBuy(k)
    await curveSell(k)
  }
  for (const k of KINDS) {
    await collect(k, 1)
    if (k === 'split') await releaseAll(1)
    if (BUYBACK_KINDS.includes(k)) await buyback(k, 1)
  }
  await sample(1)
  for (const k of HOLDER_KINDS) await drip(k, 1)
  if (!REAL) {
    for (const k of KINDS) await graduate(k)
    for (const k of KINDS) {
      await poolBuy(k)
      await poolSell(k)
    }
    for (const k of KINDS) {
      await collect(k, 2)
      if (k === 'split') await releaseAll(2)
      if (BUYBACK_KINDS.includes(k)) await buyback(k, 2)
    }
    await sample(2)
    for (const k of HOLDER_KINDS) await drip(k, 2)
  }
  await collectPlatformFees()
  await finalState()
  await summary()
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
  process.exit(failures ? 1 : 0)
} catch (e) {
  console.log(`\nERROR: ${errorText(e).split('\n').slice(0, 6).join('\n')}`)
  save()
  await summary().catch(() => undefined)
  process.exit(1)
}
