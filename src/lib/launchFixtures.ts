/**
 * Dev-only fake launchpad suites: v1.3's launchpad, launch router and reference plugins, and v1.4's launchpad, hook
 * (its Uniswap pools, simulated as their full-range position: a constant product on what each holds) and router,
 * simulated in memory with the same maths the site quotes with (lib/curve.ts, lib/launchV14.ts). Loaded only via a
 * dynamic import inside
 * `import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1'`, which is a compile-time dead branch in
 * production. The marker string below must not appear in dist/.
 *
 * It is a stand-in for exercising the UI, not a second implementation to trust: amounts follow the contracts'
 * formulas, but blocks are simulated (one every two seconds) and nothing here is checked against a chain.
 */
import { decodeAbiParameters, getAddress, keccak256, toHex, zeroAddress, type Address, type Hash, type Hex } from 'viem'
import { activeChain } from '../chain'
import { listedPlugin, listedPluginAt, pluginAddress } from '../content/plugins/registry'
import { sqrt } from './amm'
import { CURVE, INITIAL_CURVE, quoteBuy, quotePoolBuy, quotePoolSell, quoteSell, realUsdc, type CurveState, type PoolReserves } from './curve'
import { FIXTURE_SUITE, FIXTURE_SUITE_V14, isV14Available, suiteFor, type LaunchVersion } from './deployment'
import type { LaunchRecord, LaunchTrade } from './launch'
import { setLaunchFixtureApi, type FixtureCreateArgs } from './launchFixtureApi'
import { launchPoolKey, poolFeesOnGross, poolIdOf, snipeBps, usdcIsCurrency0, type PoolTradeFees } from './launchV14'
// The builder's own encoders, so a fixture launch carries exactly what the builder would send.
import { encodeBurnShareData as encodeBurnShare, encodeComboData as encodeCombo, encodeSplitData as encodeSplit } from './plugins/plan'
import { DEEPEN_DEFAULT_BURN_BPS, type CreatorFeeState } from './plugins/state'
import { rememberToken } from './tokens'

export const LAUNCHPAD_FIXTURE_XSS_PAYLOAD = '<img src=x onerror=alert(1)>'

const USDC = 1_000_000n
const E18 = 10n ** 18n
/** LaunchToken's dividend magnitude. */
const MAGNITUDE = 2n ** 128n
const DRIP_PERIOD = 86_400
/** Buyback & burn pacing, which Deepen pool shares: the budget refills over an hour; offers under 3 units are no run. */
const RUN_INTERVAL = 3_600
const MIN_RUN_USDC = 3n
const FIXTURE_LAUNCH_FEE = 1n * USDC
const FIXTURE_USDC_BALANCE = 10_000n * USDC
const CREATOR = getAddress('0x00000000000000000000000000000000000000c0')
const WHALE = getAddress('0x000000000000000000000000000000000000a11e')
const TRADERS = [getAddress('0x00000000000000000000000000000000000000b1'), getAddress('0x00000000000000000000000000000000000000b2')]
const CUSTOM_DESTINATION = getAddress('0x00000000000000000000000000000000dEaD0001')
const NOW = Math.floor(Date.now() / 1000)

const usdcAddress = () => activeChain.usdc
const nowSeconds = () => Math.floor(Date.now() / 1000)
/** A simulated block every two seconds. */
const blockNumber = () => Math.floor(Date.now() / 2_000)
/** The simulated block a unix time falls in. */
const blockAt = (seconds: number) => Math.floor(seconds / 2)

function addr(n: number): Address {
  return getAddress(`0x${n.toString(16).padStart(40, '0')}`)
}

/** v1.4 launch tokens: on either side of USDC (0x3600…), so both pool orderings show. */
function addrV14(n: number, aboveUsdc: boolean): Address {
  return getAddress(`0x${aboveUsdc ? 'a14' : '014'}${n.toString(16).padStart(37, '0')}`)
}

interface FixtureLaunch extends LaunchRecord {
  state: CurveState
}

/**
 * A graduated v1.4 token's Uniswap pool, simulated as its full-range position: a constant product on the USDC and the
 * tokens it holds, with no LP fee and the hook's fees on the USDC side. Its bids (the curve's snipe fees at graduation,
 * then each window buy's own, placed inside that buy) sit below the market, and are counted, not traded against.
 */
interface PoolBook {
  usdc: bigint
  tokens: bigint
  usdcIs0: boolean
  openBlock: number
  poolId: Hex
  /** The bids placed (hook.bidCount), and the USDC in them. */
  bids: number
  locked: bigint
}

interface SplitBook {
  payees: Address[]
  shares: bigint[]
  received: bigint
  released: Map<string, bigint>
}

interface BuybackBook {
  held: bigint
  spent: bigint
  burned: bigint
  /** The simulated block of the latest run: one run a block. */
  lastRunBlock: number
  /** Unix seconds of the latest run, 0 if it never ran: the budget refills over the hour after it. */
  lastRunAt: number
}

/** Buyback & burn's book, plus the burn share and what the pool runs have added and locked. */
interface DeepenBook extends BuybackBook {
  burnBps: number
  usdcAdded: bigint
  tokensAdded: bigint
  liquidity: bigint
}

/**
 * A launch token's dividend stream, kept the way LaunchToken keeps it: `rate` pays the eligible supply continuously
 * from `lastAccrual` to `end`, magnified by 2^128, and pauses (its end moving out) under one whole eligible token.
 */
interface HolderBook {
  /** USDC × 2^128 per second, to the whole eligible supply. */
  rate: bigint
  lastAccrual: number
  end: number
  /** Magnified USDC per token-wei earned so far. */
  perShare: bigint
  distributed: bigint
  /** Per tracked wallet: the per-share value it was last settled at, and what it has earned and not claimed. */
  snaps: Map<string, bigint>
  accrued: Map<string, bigint>
  /** Eligible supply held by wallets this fixture does not track. */
  others: bigint
}

interface Store {
  launches: FixtureLaunch[]
  trades: Map<string, LaunchTrade[]>
  balances: Map<string, bigint>
  /** Tokens any wallet holds before it trades, so a panel that needs a holder has one. */
  seeded: Map<string, bigint>
  allowances: Map<string, bigint>
  pending: Map<string, bigint>
  splits: Map<string, SplitBook>
  buybacks: Map<string, BuybackBook>
  deepens: Map<string, DeepenBook>
  holders: Map<string, HolderBook>
  combos: Map<string, { target: Address; bps: number; isPlugin: boolean }[]>
  /** v1.4: the curve's snipe fees the launchpad holds for each token's pool, and the pools once they open. */
  snipe: Map<string, bigint>
  pools: Map<string, PoolBook>
  version: number
}

const listeners = new Set<() => void>()
const store: Store = {
  launches: [],
  trades: new Map(),
  balances: new Map(),
  seeded: new Map(),
  allowances: new Map(),
  pending: new Map(),
  splits: new Map(),
  buybacks: new Map(),
  deepens: new Map(),
  holders: new Map(),
  combos: new Map(),
  snipe: new Map(),
  pools: new Map(),
  version: 1,
}
let hashCounter = 0

function key(...parts: string[]): string {
  return parts.map((part) => part.toLowerCase()).join(':')
}

function nextHash(label: string): Hash {
  hashCounter += 1
  return keccak256(toHex(`fixture:${label}:${hashCounter}`))
}

function emit(): void {
  store.version += 1
  listeners.forEach((listener) => listener())
}

function find(token: Address): FixtureLaunch {
  const launch = store.launches.find((item) => item.token.toLowerCase() === token.toLowerCase())
  if (!launch) throw new Error('UnknownToken')
  return launch
}

// ─── Balances ────────────────────────────────────────────────────────────────

export function fixtureBalance(owner: Address | undefined, token: Address): bigint {
  if (!owner) return 0n
  const stored = store.balances.get(key(owner, token))
  if (stored !== undefined) return stored
  if (token.toLowerCase() === usdcAddress().toLowerCase()) return FIXTURE_USDC_BALANCE
  return store.seeded.get(token.toLowerCase()) ?? 0n
}

function setBalance(owner: Address, token: Address, value: bigint): void {
  if (value < 0n) throw new Error('ERC20InsufficientBalance')
  const holders = store.holders.get(token.toLowerCase())
  // As the token does on every transfer: accrue the stream with the supply that held until now, then settle.
  if (holders) settleHolder(holders, owner, token, nowSeconds())
  store.balances.set(key(owner, token), value)
}

function spendAllowance(owner: Address, spender: Address, amount: bigint): void {
  const slot = key(owner, usdcAddress(), spender)
  const allowed = store.allowances.get(slot) ?? 0n
  if (allowed < amount) throw new Error('ERC20InsufficientAllowance')
  store.allowances.set(slot, allowed - amount)
}

// ─── Holder dividends (the token's stream, simplified) ───────────────────────

/** The raw eligible supply: wallets outside the excluded set (the curve and the pool are never in `balances`). */
function rawEligible(token: Address, book: HolderBook): bigint {
  let tracked = 0n
  for (const [slot, value] of store.balances) {
    if (slot.endsWith(`:${token.toLowerCase()}`)) tracked += value
  }
  return book.others + tracked
}

function eligibleSupply(token: Address, book: HolderBook): bigint {
  const supply = rawEligible(token, book)
  return supply < E18 ? 0n : supply
}

/** The per-share value accrued up to `now`, without writing it (LaunchToken._perShareNow). */
function perShareAt(token: Address, book: HolderBook, now: number): bigint {
  if (book.lastAccrual >= book.end) return book.perShare
  const eligible = rawEligible(token, book)
  if (eligible < E18) return book.perShare
  const upTo = Math.min(now, book.end)
  return book.perShare + (book.rate * BigInt(upTo - book.lastAccrual)) / eligible
}

/** LaunchToken._accrue: pays the stream up to `now`, or moves its end out while fewer than one token is eligible. */
function accrueStream(token: Address, book: HolderBook, now: number): void {
  if (book.lastAccrual >= book.end || book.lastAccrual >= now) return
  if (rawEligible(token, book) < E18) {
    book.end += now - book.lastAccrual
    book.lastAccrual = now
    return
  }
  book.perShare = perShareAt(token, book, now)
  book.lastAccrual = Math.min(now, book.end)
}

/** LaunchToken.distribute: the amount joins what the stream owes; the end moves to the amount-weighted average. */
function distribute(token: Address, book: HolderBook, amount: bigint, now: number): void {
  if (amount === 0n) return
  accrueStream(token, book, now)
  const owed = book.end > now ? book.rate * BigInt(book.end - now) : 0n
  const added = amount * MAGNITUDE
  const from = Math.max(book.end, now)
  const to = now + DRIP_PERIOD
  const end = Math.max(from + Number((added * BigInt(to - from)) / (owed + added)), now + 1)
  book.rate = (owed + added) / BigInt(end - now)
  book.lastAccrual = now
  book.end = end
  book.distributed += amount
}

/** What the running stream still owes from now on (LaunchToken.undistributed). */
function undistributed(token: Address, book: HolderBook, now: number): bigint {
  if (book.lastAccrual >= book.end) return 0n
  const from = rawEligible(token, book) < E18 ? book.lastAccrual : Math.min(now, book.end)
  return (book.rate * BigInt(book.end - from)) / MAGNITUDE
}

function settleHolder(book: HolderBook, owner: Address, token: Address, now: number): void {
  accrueStream(token, book, now)
  const id = owner.toLowerCase()
  const earned = ((book.perShare - (book.snaps.get(id) ?? 0n)) * fixtureBalance(owner, token)) / MAGNITUDE
  book.accrued.set(id, (book.accrued.get(id) ?? 0n) + earned)
  book.snaps.set(id, book.perShare)
}

function holderClaimable(book: HolderBook, owner: Address, token: Address, now: number): bigint {
  const id = owner.toLowerCase()
  const earned = ((perShareAt(token, book, now) - (book.snaps.get(id) ?? 0n)) * fixtureBalance(owner, token)) / MAGNITUDE
  return (book.accrued.get(id) ?? 0n) + earned
}

// ─── Plugins ─────────────────────────────────────────────────────────────────

/** The suite a fixture token's plugins belong to: its own launchpad's. */
function suiteOfToken(token: Address) {
  return suiteFor(store.launches.find((item) => item.token.toLowerCase() === token.toLowerCase())?.version)
}

function configure(token: Address, plugin: Address, data: Hex): void {
  const listed = listedPluginAt(plugin, suiteOfToken(token))
  if (!listed) return
  switch (listed.kind) {
    case 'split': {
      const [payees, shares] = decodeAbiParameters([{ type: 'address[]' }, { type: 'uint256[]' }], data)
      store.splits.set(token.toLowerCase(), { payees: [...payees], shares: [...shares], received: 0n, released: new Map() })
      return
    }
    case 'buyback':
      store.buybacks.set(token.toLowerCase(), { held: 0n, spent: 0n, burned: 0n, lastRunBlock: 0, lastRunAt: 0 })
      return
    case 'deepen': {
      // Empty data is the plugin's default; anything else is one uint16.
      const burnBps = data === '0x' ? DEEPEN_DEFAULT_BURN_BPS : decodeAbiParameters([{ type: 'uint16' }], data)[0]
      store.deepens.set(token.toLowerCase(), {
        held: 0n,
        spent: 0n,
        burned: 0n,
        lastRunBlock: 0,
        lastRunAt: 0,
        burnBps,
        usdcAdded: 0n,
        tokensAdded: 0n,
        liquidity: 0n,
      })
      return
    }
    case 'holders':
      store.holders.set(token.toLowerCase(), {
        rate: 0n,
        lastAccrual: 0,
        end: 0,
        perShare: 0n,
        distributed: 0n,
        snaps: new Map(),
        accrued: new Map(),
        others: 0n,
      })
      return
    case 'combo': {
      const [targets, bps, datas] = decodeAbiParameters([{ type: 'address[]' }, { type: 'uint16[]' }, { type: 'bytes[]' }], data)
      store.combos.set(
        token.toLowerCase(),
        targets.map((target, index) => {
          const isPlugin = Boolean(listedPluginAt(target, suiteOfToken(token)))
          if (isPlugin) configure(token, target, datas[index] ?? '0x')
          return { target, bps: Number(bps[index] ?? 0), isPlugin }
        }),
      )
    }
  }
}

/** A collection, delivered as the launchpad's collectCreatorFees would (a Combo forwards its slices). */
function deliver(token: Address, target: Address, amount: bigint): void {
  if (amount === 0n) return
  const listed = listedPluginAt(target, suiteOfToken(token))
  const id = token.toLowerCase()
  switch (listed?.kind) {
    case 'split': {
      const book = store.splits.get(id)
      if (book) book.received += amount
      return
    }
    case 'buyback': {
      const book = store.buybacks.get(id)
      if (book) book.held += amount
      return
    }
    case 'deepen': {
      const book = store.deepens.get(id)
      if (book) book.held += amount
      return
    }
    case 'holders': {
      // The plugin forwards straight to the token's distribute, which streams it to holders.
      const book = store.holders.get(id)
      if (book) distribute(token, book, amount, nowSeconds())
      return
    }
    case 'combo': {
      const entries = store.combos.get(id) ?? []
      let remaining = amount
      entries.forEach((entry, index) => {
        const slice = index === entries.length - 1 ? remaining : (amount * BigInt(entry.bps)) / 10_000n
        remaining -= slice
        if (entry.isPlugin) deliver(token, entry.target, slice)
      })
      return
    }
    default:
      // A wallet or a custom address: the USDC simply leaves.
      return
  }
}

// ─── Trading ─────────────────────────────────────────────────────────────────

function record(token: Address, trade: Omit<LaunchTrade, 'block' | 'logIndex'>): void {
  const list = store.trades.get(token.toLowerCase()) ?? []
  list.unshift({ ...trade, block: store.version + 10, logIndex: list.length })
  store.trades.set(token.toLowerCase(), list)
}

function accrue(token: Address, creatorFee: bigint): void {
  store.pending.set(token.toLowerCase(), (store.pending.get(token.toLowerCase()) ?? 0n) + creatorFee)
}

// ─── v1.4's pools (the hook and the v4 router) ───────────────────────────────

/** A trade in a v1.4 pool: the router's exact-in buy or sell, the hook's fees on the USDC side. Throws the refusal. */
function poolTrade(book: PoolBook, side: 'buy' | 'sell', amountIn: bigint, creatorFeeBps: number, snipe: number) {
  if (amountIn <= 0n) throw new Error('ZeroAmount')
  if (side === 'buy') {
    const fees = poolFeesOnGross(amountIn, creatorFeeBps, snipe)
    const net = amountIn - fees.platformFee - fees.creatorFee - fees.snipeFee
    const out = (net * book.tokens) / (book.usdc + net)
    if (out === 0n) throw new Error('ZeroAmount')
    return { out, gross: amountIn, fees, next: { usdc: book.usdc + net, tokens: book.tokens - out } }
  }
  const gross = (amountIn * book.usdc) / (book.tokens + amountIn)
  const fees: PoolTradeFees = poolFeesOnGross(gross, creatorFeeBps, 0)
  return { out: gross - fees.platformFee - fees.creatorFee, gross, fees, next: { usdc: book.usdc - gross, tokens: book.tokens + amountIn } }
}

function poolOf(token: Address): PoolBook {
  const book = store.pools.get(token.toLowerCase())
  if (!book) throw new Error('UnknownLaunch')
  return book
}

/** The snipe fee a buy of `launch` pays at `time`: on the curve from its creation block, in the pool from its opening. */
function snipeAt(launch: FixtureLaunch, time: number): number {
  if (launch.version !== 'v14') return 0
  const opened = launch.graduated ? store.pools.get(launch.token.toLowerCase())?.openBlock : Number(launch.createdBlock ?? 0n)
  return opened === undefined ? 0 : snipeBps(BigInt(opened), BigInt(blockAt(time)), launch.creatorFeeBps)
}

/** Graduation into Uniswap: the pool opens at the curve's last price with its USDC and the 200M, and the curve's snipe fees become its first bid. */
function openPool(launch: FixtureLaunch, next: CurveState, time: number): void {
  const id = launch.token.toLowerCase()
  const snipe = store.snipe.get(id) ?? 0n
  store.pools.set(id, {
    usdc: realUsdc(next),
    tokens: CURVE.POOL_SUPPLY,
    usdcIs0: usdcIsCurrency0(usdcAddress(), launch.token),
    openBlock: blockAt(time),
    poolId: poolIdOf(launchPoolKey(launch.token, usdcAddress(), FIXTURE_SUITE_V14.hook)),
    // The curve's snipe fees become the pool's first bid, from half the graduation price down.
    bids: snipe > 0n ? 1 : 0,
    locked: snipe,
  })
  store.snipe.set(id, 0n)
}

function buyInternal(trader: Address, token: Address, usdcIn: bigint, time: number, spender?: Address, firstBuy = false): { tokensOut: bigint; usdcSpent: bigint } {
  const launch = find(token)
  if (!launch.graduated) {
    // v1.4's curve takes its snipe fee in the first blocks, except on the creator's first buy in the launch itself.
    const snipe = firstBuy ? 0 : snipeAt(launch, time)
    const quote = quoteBuy(launch.state, usdcIn, launch.creatorFeeBps, snipe)
    if (spender) spendAllowance(trader, spender, quote.usdcSpent)
    setBalance(trader, usdcAddress(), fixtureBalance(trader, usdcAddress()) - quote.usdcSpent)
    setBalance(trader, token, fixtureBalance(trader, token) + quote.tokensOut)
    launch.state = quote.next
    accrue(token, quote.creatorFee)
    if (quote.snipeFee > 0n) store.snipe.set(token.toLowerCase(), (store.snipe.get(token.toLowerCase()) ?? 0n) + quote.snipeFee)
    record(token, {
      trader,
      isBuy: true,
      usdcAmount: quote.usdcSpent,
      tokenAmount: quote.tokensOut,
      platformFee: quote.platformFee,
      creatorFee: quote.creatorFee,
      ...(launch.version === 'v14' ? { snipeFee: quote.snipeFee } : {}),
      time,
      txHash: nextHash('buy'),
      virtualUsdc: quote.next.virtualUsdc,
      virtualTokens: quote.next.virtualTokens,
      venue: 'curve',
    })
    if (quote.graduates) {
      launch.graduated = true
      if (launch.version === 'v14') openPool(launch, quote.next, time)
      else launch.pool = { reserveToken: CURVE.POOL_SUPPLY, reserveUsdc: realUsdc(quote.next) }
    }
    return { tokensOut: quote.tokensOut, usdcSpent: quote.usdcSpent }
  }
  if (launch.version === 'v14') {
    const book = poolOf(token)
    const trade = poolTrade(book, 'buy', usdcIn, launch.creatorFeeBps, snipeAt(launch, time))
    if (spender) spendAllowance(trader, spender, usdcIn)
    setBalance(trader, usdcAddress(), fixtureBalance(trader, usdcAddress()) - usdcIn)
    setBalance(trader, token, fixtureBalance(trader, token) + trade.out)
    book.usdc = trade.next.usdc
    book.tokens = trade.next.tokens
    // A buy inside the window places its own snipe fee as a bid, in the same transaction.
    if (trade.fees.snipeFee > 0n) {
      book.bids += 1
      book.locked += trade.fees.snipeFee
    }
    accrue(token, trade.fees.creatorFee)
    record(token, {
      trader: FIXTURE_SUITE_V14.router,
      viaRouter: true,
      isBuy: true,
      usdcAmount: usdcIn,
      tokenAmount: trade.out,
      ...trade.fees,
      time,
      txHash: nextHash('v4-buy'),
      venue: 'pool',
    })
    return { tokensOut: trade.out, usdcSpent: usdcIn }
  }
  const pool = launch.pool as PoolReserves
  const quote = quotePoolBuy(pool, usdcIn, launch.creatorFeeBps)
  if (spender) spendAllowance(trader, spender, usdcIn)
  setBalance(trader, usdcAddress(), fixtureBalance(trader, usdcAddress()) - usdcIn)
  setBalance(trader, token, fixtureBalance(trader, token) + quote.tokensOut)
  launch.pool = quote.next
  accrue(token, quote.creatorFee)
  record(token, {
    trader,
    isBuy: true,
    usdcAmount: usdcIn,
    tokenAmount: quote.tokensOut,
    platformFee: quote.platformFee,
    creatorFee: quote.creatorFee,
    time,
    txHash: nextHash('pool-buy'),
    venue: 'pool',
  })
  return { tokensOut: quote.tokensOut, usdcSpent: usdcIn }
}

function sellInternal(trader: Address, token: Address, tokensIn: bigint, time: number): bigint {
  const launch = find(token)
  if (fixtureBalance(trader, token) < tokensIn) throw new Error('ERC20InsufficientBalance')
  if (!launch.graduated) {
    const quote = quoteSell(launch.state, tokensIn, launch.creatorFeeBps)
    setBalance(trader, token, fixtureBalance(trader, token) - tokensIn)
    setBalance(trader, usdcAddress(), fixtureBalance(trader, usdcAddress()) + quote.usdcOut)
    launch.state = quote.next
    accrue(token, quote.creatorFee)
    record(token, {
      trader,
      isBuy: false,
      usdcAmount: quote.gross,
      tokenAmount: tokensIn,
      platformFee: quote.platformFee,
      creatorFee: quote.creatorFee,
      ...(launch.version === 'v14' ? { snipeFee: 0n } : {}),
      time,
      txHash: nextHash('sell'),
      virtualUsdc: quote.next.virtualUsdc,
      virtualTokens: quote.next.virtualTokens,
      venue: 'curve',
    })
    return quote.usdcOut
  }
  if (launch.version === 'v14') {
    const book = poolOf(token)
    const trade = poolTrade(book, 'sell', tokensIn, launch.creatorFeeBps, 0)
    setBalance(trader, token, fixtureBalance(trader, token) - tokensIn)
    setBalance(trader, usdcAddress(), fixtureBalance(trader, usdcAddress()) + trade.out)
    book.usdc = trade.next.usdc
    book.tokens = trade.next.tokens
    accrue(token, trade.fees.creatorFee)
    record(token, {
      trader: FIXTURE_SUITE_V14.router,
      viaRouter: true,
      isBuy: false,
      usdcAmount: trade.gross,
      tokenAmount: tokensIn,
      ...trade.fees,
      time,
      txHash: nextHash('v4-sell'),
      venue: 'pool',
    })
    return trade.out
  }
  const quote = quotePoolSell(launch.pool as PoolReserves, tokensIn, launch.creatorFeeBps)
  setBalance(trader, token, fixtureBalance(trader, token) - tokensIn)
  setBalance(trader, usdcAddress(), fixtureBalance(trader, usdcAddress()) + quote.usdcOut)
  launch.pool = quote.next
  accrue(token, quote.creatorFee)
  record(token, {
    trader,
    isBuy: false,
    usdcAmount: quote.gross,
    tokenAmount: tokensIn,
    platformFee: quote.platformFee,
    creatorFee: quote.creatorFee,
    time,
    txHash: nextHash('pool-sell'),
    venue: 'pool',
  })
  return quote.usdcOut
}

function createInternal(owner: Address, args: FixtureCreateArgs, time: number, spender?: Address, aboveUsdc = true): Address {
  if (args.maxLaunchFee < FIXTURE_LAUNCH_FEE) throw new Error('LaunchFeeAboveMax')
  const v14 = args.version === 'v14'
  const token = v14 ? addrV14(store.launches.length, aboveUsdc) : addr(0x1000 + store.launches.length)
  const firstBuy = args.initialBuyUsdc > 0n ? quoteBuy(INITIAL_CURVE, args.initialBuyUsdc, args.creatorFeeBps) : undefined
  if (spender) spendAllowance(owner, spender, FIXTURE_LAUNCH_FEE + (firstBuy?.usdcSpent ?? 0n))
  setBalance(owner, usdcAddress(), fixtureBalance(owner, usdcAddress()) - FIXTURE_LAUNCH_FEE)
  rememberToken({ address: token, name: args.name, symbol: args.symbol, decimals: 18, faucet: false, isLaunch: true })
  store.launches.unshift({
    ...(v14 ? { version: 'v14' as const, createdBlock: BigInt(blockAt(time)), openPool: args.openPool } : {}),
    token,
    creator: owner,
    pair: v14 ? zeroAddress : addr(0x2000 + store.launches.length),
    virtualUsdc: INITIAL_CURVE.virtualUsdc,
    virtualTokens: INITIAL_CURVE.virtualTokens,
    tokensSold: 0n,
    createdAt: BigInt(time),
    graduated: false,
    creatorFeeBps: args.creatorFeeBps,
    pluginHooks: Boolean(listedPluginAt(args.plugin, suiteFor(args.version))),
    plugin: args.plugin,
    metadataURI: args.metadataURI,
    name: args.name,
    symbol: args.symbol,
    state: INITIAL_CURVE,
  })
  configure(token, args.plugin, args.pluginData)
  // The creator's first buy runs in the launch transaction itself: on v1.4 it pays no snipe fee.
  if (args.initialBuyUsdc > 0n) buyInternal(owner, token, args.initialBuyUsdc, time, undefined, true)
  return token
}

/**
 * What a Buyback & burn or Deepen pool run may offer at `time`, as both plugins pace it: min(held, budget), the budget
 * being the cap (0.25% of the USDC-side reserve) prorated by the time since the last run, full for a first run or after
 * an hour; 0 when it already ran this block or the offer is under the 3-unit minimum. Deepen pool takes its pool cap
 * from the locked part of the reserve; every LP in a fixture pool is locked, so that is the whole reserve here.
 */
function pacedOffer(book: BuybackBook, launch: FixtureLaunch, time: number): bigint {
  if (blockNumber() < book.lastRunBlock + 1) return 0n
  const cap = ((launch.graduated ? (launch.pool as PoolReserves).reserveUsdc : launch.state.virtualUsdc) * 25n) / 10_000n
  const elapsed = book.lastRunAt === 0 ? RUN_INTERVAL : Math.min(Math.max(0, time - book.lastRunAt), RUN_INTERVAL)
  const budget = (cap * BigInt(elapsed)) / BigInt(RUN_INTERVAL)
  const offer = book.held < budget ? book.held : budget
  return offer < MIN_RUN_USDC ? 0n : offer
}

/**
 * DeepenPoolPlugin._sides: a pool run's burn share of the offer (rounded down) and the rest. A side under the minimum
 * could buy nothing, so the whole offer goes through the other one, the burn side giving way first.
 */
function deepenSides(offer: bigint, burnBps: number): { toBurn: bigint; toDeepen: bigint } {
  const toBurn = (offer * BigInt(burnBps)) / 10_000n
  if (toBurn < MIN_RUN_USDC) return { toBurn: 0n, toDeepen: offer }
  if (offer - toBurn < MIN_RUN_USDC) return { toBurn: offer, toDeepen: 0n }
  return { toBurn, toDeepen: offer - toBurn }
}

/** What a Deepen pool run would offer now, and how it would divide it (DeepenPoolPlugin.previewRun). */
function deepenPreview(book: DeepenBook, launch: FixtureLaunch, time: number): { offer: bigint; toBurn: bigint; toDeepen: bigint } {
  const offer = pacedOffer(book, launch, time)
  if (offer === 0n) return { offer, toBurn: 0n, toDeepen: 0n }
  // On the curve there is no pool to add to: the whole offer buys and burns, whatever the burn share.
  if (!launch.graduated) return { offer, toBurn: offer, toDeepen: 0n }
  return { offer, ...deepenSides(offer, book.burnBps) }
}

/**
 * DeepenPoolPlugin._usdcToBuy: the part of the deepen side that buys the token, sized so the add takes every token it
 * buys at the price the buy leaves (b + n + n²/R = U, with n = b·q/10⁴ what the buy puts in the pool).
 */
function deepenBuy(usdcToDeepen: bigint, reserveUsdc: bigint, feeBps: bigint): bigint {
  const q = 10_000n - feeBps
  const s = 10_000n + q
  const root = sqrt(s * s * reserveUsdc * reserveUsdc + 4n * q * q * usdcToDeepen * reserveUsdc)
  const toBuy = (2n * 10_000n * usdcToDeepen * reserveUsdc) / (s * reserveUsdc + root)
  return toBuy < MIN_RUN_USDC ? MIN_RUN_USDC : toBuy > usdcToDeepen ? usdcToDeepen : toBuy
}

/**
 * DeepenPoolPlugin._addAmounts: all the tokens bought with the USDC they pair with at the pool's price, or all the USDC
 * left with the tokens it matches, and the LP that mints. A fixture pool's LP supply is √(k): it holds no one else's
 * liquidity, and with no pool fee, trades leave k where it was and adds at the pool's price grow √k with the supply.
 */
function deepenAdd(tokens: bigint, usdcLeft: bigint, pool: PoolReserves): { tokens: bigint; usdc: bigint; liquidity: bigint } {
  if (tokens === 0n || usdcLeft === 0n) return { tokens: 0n, usdc: 0n, liquidity: 0n }
  let usdc = (tokens * pool.reserveUsdc) / pool.reserveToken
  let added = tokens
  if (usdc > usdcLeft) {
    usdc = usdcLeft
    added = (usdcLeft * pool.reserveToken) / pool.reserveUsdc
  }
  const supply = sqrt(pool.reserveToken * pool.reserveUsdc)
  const byToken = (added * supply) / pool.reserveToken
  const byUsdc = (usdc * supply) / pool.reserveUsdc
  const liquidity = byToken < byUsdc ? byToken : byUsdc
  return liquidity === 0n ? { tokens: 0n, usdc: 0n, liquidity: 0n } : { tokens: added, usdc, liquidity }
}

/**
 * A Deepen pool run, as DeepenPoolPlugin.run makes it: on the curve, Buyback & burn's run; in the pool, the burn side
 * buys and burns, then the deepen side buys and adds what it bought to the pool with USDC. Whatever the add does not
 * take is burned; USDC that does not fit stays held.
 */
function runDeepenInternal(token: Address, time: number): Hash {
  const book = store.deepens.get(token.toLowerCase())
  if (!book) throw new Error('NotConfigured')
  if (blockNumber() < book.lastRunBlock + 1) throw new Error('AlreadyRanThisBlock')
  const launch = find(token)
  const offer = pacedOffer(book, launch, time)
  if (offer === 0n) throw new Error('NothingToBuy')
  book.lastRunAt = time
  const plugin = pluginAddress(listedPlugin('deepen'))
  store.balances.set(key(plugin, usdcAddress()), offer)
  let spent = 0n
  let burned = 0n
  if (!launch.graduated) {
    // A sell-out buy takes only what the last tokens cost; the rest stays held for the next run, in the pool.
    const bought = buyInternal(plugin, token, offer, time)
    spent = bought.usdcSpent
    burned = bought.tokensOut
  } else {
    const { toBurn, toDeepen } = deepenSides(offer, book.burnBps)
    if (toBurn > 0n) {
      const bought = buyInternal(plugin, token, toBurn, time)
      spent += bought.usdcSpent
      burned += bought.tokensOut
    }
    if (toDeepen > 0n) {
      const toBuy = deepenBuy(toDeepen, (launch.pool as PoolReserves).reserveUsdc, CURVE.FEE_BPS + BigInt(launch.creatorFeeBps))
      const bought = buyInternal(plugin, token, toBuy, time)
      const pool = launch.pool as PoolReserves
      const add = deepenAdd(bought.tokensOut, toDeepen - bought.usdcSpent, pool)
      launch.pool = { reserveToken: pool.reserveToken + add.tokens, reserveUsdc: pool.reserveUsdc + add.usdc }
      spent += bought.usdcSpent + add.usdc
      burned += bought.tokensOut - add.tokens
      book.usdcAdded += add.usdc
      book.tokensAdded += add.tokens
      book.liquidity += add.liquidity
    }
  }
  store.balances.delete(key(plugin, usdcAddress()))
  store.balances.delete(key(plugin, token))
  book.held -= spent
  book.spent += spent
  book.burned += burned
  book.lastRunBlock = blockNumber()
  return nextHash('deepen')
}

function runBuybackInternal(token: Address, time: number): Hash {
  const book = store.buybacks.get(token.toLowerCase())
  if (!book) throw new Error('NotConfigured')
  if (blockNumber() < book.lastRunBlock + 1) throw new Error('AlreadyRanThisBlock')
  const launch = find(token)
  const offer = pacedOffer(book, launch, time)
  if (offer === 0n) throw new Error('NothingToBuy')
  book.lastRunAt = time
  const plugin = pluginAddress(listedPlugin('buyback'))
  store.balances.set(key(plugin, usdcAddress()), offer)
  const { tokensOut, usdcSpent } = buyInternal(plugin, token, offer, time)
  store.balances.delete(key(plugin, usdcAddress()))
  store.balances.delete(key(plugin, token))
  book.held -= usdcSpent
  book.spent += usdcSpent
  book.burned += tokensOut
  book.lastRunBlock = blockNumber()
  return nextHash('buyback')
}

// ─── The initial market ──────────────────────────────────────────────────────

type SeedArgs = Omit<FixtureCreateArgs, 'plugin' | 'pluginData' | 'maxLaunchFee' | 'initialBuyUsdc' | 'version' | 'openPool'>

function launchWith(kind: 'wallet' | 'custom' | 'split' | 'buyback' | 'deepen' | 'holders' | 'combo', args: SeedArgs, time: number, data: Hex = '0x'): Address {
  const plugin = kind === 'wallet' ? CREATOR : kind === 'custom' ? CUSTOM_DESTINATION : pluginAddress(listedPlugin(kind))
  return createInternal(CREATOR, { ...args, plugin, pluginData: data, initialBuyUsdc: 0n, maxLaunchFee: FIXTURE_LAUNCH_FEE, version: 'v13', openPool: false }, time)
}

/** A v1.4 launch, its fees to one of v1.4's own plugins or the creator; `aboveUsdc` picks which side of USDC it sorts. */
function launchWithV14(
  kind: 'wallet' | 'split' | 'holders' | 'combo',
  args: SeedArgs & { openPool: boolean; initialBuyUsdc?: bigint },
  time: number,
  aboveUsdc: boolean,
  data: Hex = '0x',
): Address {
  const plugin = kind === 'wallet' ? CREATOR : pluginAddress(listedPlugin(kind), suiteFor('v14'))
  const version: LaunchVersion = 'v14'
  return createInternal(
    CREATOR,
    { ...args, plugin, pluginData: data, initialBuyUsdc: args.initialBuyUsdc ?? 0n, maxLaunchFee: FIXTURE_LAUNCH_FEE, version },
    time,
    undefined,
    aboveUsdc,
  )
}

function seedMarket(): void {
  store.balances.set(key(WHALE, usdcAddress()), 10_000_000n * USDC)
  for (const trader of TRADERS) store.balances.set(key(trader, usdcAddress()), 100_000n * USDC)
  const [alice, bob] = TRADERS

  const splitThree = encodeSplit([CREATOR, alice, bob], [50n, 30n, 20n])
  const splitTwo = encodeSplit([CREATOR, bob], [1n, 1n])

  const grad = launchWith('holders', { name: 'Graduated Coin', symbol: 'GRAD', metadataURI: 'https://example.com/grad.png', creatorFeeBps: 100 }, NOW - 86_400)
  buyInternal(alice, grad, 400n * USDC, NOW - 80_000)
  buyInternal(WHALE, grad, 1_000_000n * USDC, NOW - 72_000)
  buyInternal(bob, grad, 900n * USDC, NOW - 7_200)
  sellInternal(alice, grad, fixtureBalance(alice, grad) / 3n, NOW - 3_600)
  store.seeded.set(grad.toLowerCase(), 2_000_000n * E18)
  const gradHolders = store.holders.get(grad.toLowerCase())
  if (gradHolders) {
    gradHolders.others = 600_000_000n * E18
    // An earlier distribution two hours ago, so a holder has already earned something when the page opens.
    distribute(grad, gradHolders, 40n * USDC, NOW - 7_200)
  }
  collect(grad)

  const combo = encodeCombo([pluginAddress(listedPlugin('holders')), pluginAddress(listedPlugin('buyback'))], [6_000, 4_000], ['0x', '0x'])
  const gcmb = launchWith('combo', { name: 'Graduated Combo', symbol: 'GCMB', metadataURI: '', creatorFeeBps: 50 }, NOW - 50_000, combo)
  buyInternal(WHALE, gcmb, 1_000_000n * USDC, NOW - 40_000)
  buyInternal(alice, gcmb, 2_500n * USDC, NOW - 9_000)
  store.seeded.set(gcmb.toLowerCase(), 500_000n * E18)
  const gcmbHolders = store.holders.get(gcmb.toLowerCase())
  if (gcmbHolders) gcmbHolders.others = 300_000_000n * E18
  collect(gcmb)

  // A paused stream: the only holder sold out after the fees were collected, so nobody holds a whole token.
  const quiet = launchWith('holders', { name: 'Quiet', symbol: 'QUIET', metadataURI: '', creatorFeeBps: 400 }, NOW - 5_400)
  buyInternal(bob, quiet, 600n * USDC, NOW - 5_000)
  collect(quiet)
  sellInternal(bob, quiet, fixtureBalance(bob, quiet), NOW - 4_000)

  const near = launchWith('split', { name: 'Almost there', symbol: 'NEAR', metadataURI: '', creatorFeeBps: 1_000 }, NOW - 14_400, splitThree)
  buyInternal(WHALE, near, 20_000n * USDC, NOW - 14_000)
  buyInternal(alice, near, 1_200n * USDC, NOW - 6_000)
  collect(near)
  buyInternal(bob, near, 300n * USDC, NOW - 1_800)

  const xss = launchWith('custom', { name: LAUNCHPAD_FIXTURE_XSS_PAYLOAD, symbol: 'XSS', metadataURI: 'javascript:alert(1)', creatorFeeBps: 500 }, NOW - 7_200)
  buyInternal(bob, xss, 150n * USDC, NOW - 7_000)

  const doge = launchWith('buyback', { name: 'Doge on Arc', symbol: 'DOGE', metadataURI: 'https://example.com/doge.png', creatorFeeBps: 250 }, NOW - 3_600)
  buyInternal(CREATOR, doge, 5_700n * USDC, NOW - 3_500)
  buyInternal(alice, doge, 800n * USDC, NOW - 2_000)
  collect(doge)
  const dogeBook = store.buybacks.get(doge.toLowerCase())
  if (dogeBook) dogeBook.lastRunBlock = 0
  runBuybackInternal(doge, NOW - 1_900)
  if (dogeBook) dogeBook.lastRunBlock = 0
  sellInternal(alice, doge, fixtureBalance(alice, doge) / 4n, NOW - 600)

  // Deepen pool after graduation: one run made 40 minutes ago, so the next one is part refilled and splits.
  const deep = launchWith('deepen', { name: 'Deep Pool', symbol: 'DEEP', metadataURI: '', creatorFeeBps: 100 }, NOW - 30_000, encodeBurnShare(5_000))
  buyInternal(WHALE, deep, 1_000_000n * USDC, NOW - 26_000)
  buyInternal(alice, deep, 3_000n * USDC, NOW - 20_000)
  sellInternal(alice, deep, fixtureBalance(alice, deep) / 2n, NOW - 12_000)
  collect(deep)
  const deepBook = store.deepens.get(deep.toLowerCase())
  if (deepBook) deepBook.lastRunBlock = 0
  runDeepenInternal(deep, NOW - 2_400)
  if (deepBook) deepBook.lastRunBlock = 0
  buyInternal(bob, deep, 1_500n * USDC, NOW - 900)

  // Deepen pool as a Combo entry on a token still on its curve: every run buys and burns, whatever the burn share.
  const slow = launchWith(
    'combo',
    { name: 'Slow burn', symbol: 'SLOW', metadataURI: '', creatorFeeBps: 300 },
    NOW - 9_000,
    encodeCombo([pluginAddress(listedPlugin('holders')), pluginAddress(listedPlugin('deepen'))], [6_000, 4_000], ['0x', encodeBurnShare(7_500)]),
  )
  buyInternal(alice, slow, 2_000n * USDC, NOW - 8_000)
  buyInternal(bob, slow, 700n * USDC, NOW - 4_000)
  collect(slow)

  launchWith('wallet', { name: 'Pepe', symbol: 'PEPE', metadataURI: '', creatorFeeBps: 0 }, NOW - 120)

  const mint = launchWith(
    'combo',
    { name: 'Fresh mint', symbol: 'MINT', metadataURI: 'https://example.com/mint.png', creatorFeeBps: 300 },
    NOW - 30,
    encodeCombo([CREATOR, pluginAddress(listedPlugin('split')), pluginAddress(listedPlugin('buyback'))], [5_000, 3_000, 2_000], ['0x', splitTwo, '0x']),
  )
  buyInternal(bob, mint, 50n * USDC, NOW - 20)

  // ─── Launchpad v1.4 (only while the fixture previews it as live) ──────────
  if (!isV14Available) return
  const splitV14 = encodeSplit([CREATOR, alice], [3n, 1n])

  // Graduated into a closed Uniswap pool (USDC is its currency0), with buys that paid the pool's snipe fee in its first
  // blocks, so the hook holds some for anyone to lock.
  const harbor = launchWithV14('holders', { name: 'Harbor', symbol: 'HRBR', metadataURI: '', creatorFeeBps: 150, openPool: false }, NOW - 20_000, true)
  buyInternal(alice, harbor, 900n * USDC, NOW - 19_990)
  buyInternal(WHALE, harbor, 1_000_000n * USDC, NOW - 12_000)
  buyInternal(bob, harbor, 400n * USDC, NOW - 11_996)
  buyInternal(alice, harbor, 250n * USDC, NOW - 11_990)
  sellInternal(WHALE, harbor, fixtureBalance(WHALE, harbor) / 20n, NOW - 6_000)
  buyInternal(bob, harbor, 2_000n * USDC, NOW - 1_200)
  store.seeded.set(harbor.toLowerCase(), 1_500_000n * E18)
  const harborHolders = store.holders.get(harbor.toLowerCase())
  if (harborHolders) harborHolders.others = 500_000_000n * E18
  collect(harbor)

  // Graduated into an open pool on the other side of USDC (its currency1); one buy in its window placed a bid.
  const lowTide = launchWithV14('split', { name: 'Low Tide', symbol: 'LOWT', metadataURI: '', creatorFeeBps: 50, openPool: true }, NOW - 40_000, false, splitV14)
  buyInternal(WHALE, lowTide, 1_000_000n * USDC, NOW - 30_000)
  buyInternal(alice, lowTide, 700n * USDC, NOW - 29_994)
  sellInternal(alice, lowTide, fixtureBalance(alice, lowTide) / 2n, NOW - 3_000)
  collect(lowTide)

  // On the curve, open pool when it graduates: its first buys paid the curve's snipe fee, held for the pool.
  const tide = launchWithV14('split', { name: 'Tidewater', symbol: 'TIDE', metadataURI: '', creatorFeeBps: 200, openPool: true }, NOW - 7_000, false, splitV14)
  buyInternal(alice, tide, 150n * USDC, NOW - 6_998)
  buyInternal(bob, tide, 90n * USDC, NOW - 6_990)
  buyInternal(alice, tide, 3_000n * USDC, NOW - 5_000)
  sellInternal(bob, tide, fixtureBalance(bob, tide) / 2n, NOW - 2_000)

  // Launched just now with the creator's own first buy (no snipe fee on that one): still in its window.
  launchWithV14('combo', { name: 'Fresh Catch', symbol: 'CTCH', metadataURI: '', creatorFeeBps: 300, openPool: false, initialBuyUsdc: 25n * USDC }, NOW - 6, true, encodeCombo(
    [CREATOR, pluginAddress(listedPlugin('holders'), suiteFor('v14'))],
    [5_000, 5_000],
    ['0x', '0x'],
  ))
}

// ─── The API the hooks call ──────────────────────────────────────────────────

function collect(token: Address): Hash {
  const launch = find(token)
  const amount = store.pending.get(token.toLowerCase()) ?? 0n
  store.pending.set(token.toLowerCase(), 0n)
  deliver(token, launch.plugin, amount)
  return nextHash('collect')
}

/** The pool as the hook and StateView report it: √(currency1/currency0) in Q64.96 and the liquidity in range. */
function poolState(book: PoolBook): NonNullable<LaunchRecord['v4']> {
  const [amount0, amount1] = book.usdcIs0 ? [book.usdc, book.tokens] : [book.tokens, book.usdc]
  return {
    poolId: book.poolId,
    sqrtPriceX96: sqrt((amount1 << 192n) / amount0),
    usdcIs0: book.usdcIs0,
    openBlock: BigInt(book.openBlock),
    liquidity: sqrt(book.usdc * book.tokens),
    bidCount: BigInt(book.bids),
  }
}

function syncRecord(launch: FixtureLaunch): LaunchRecord {
  const { state, ...record } = launch
  const book = store.pools.get(launch.token.toLowerCase())
  return { ...record, virtualUsdc: state.virtualUsdc, virtualTokens: state.virtualTokens, tokensSold: state.tokensSold, ...(book ? { v4: poolState(book) } : {}) }
}

function creatorFees(token: Address, owner: Address | undefined): CreatorFeeState | undefined {
  const launch = store.launches.find((item) => item.token.toLowerCase() === token.toLowerCase())
  if (!launch) return undefined
  const id = token.toLowerCase()
  const split = store.splits.get(id)
  const buyback = store.buybacks.get(id)
  const deepen = store.deepens.get(id)
  const holders = store.holders.get(id)
  const combo = store.combos.get(id)
  const totalShares = split ? split.shares.reduce((sum, share) => sum + share, 0n) : 0n
  return {
    pending: store.pending.get(id) ?? 0n,
    split: split && {
      totalShares,
      totalReceived: split.received,
      payees: split.payees.map((address, index) => {
        const share = split.shares[index] ?? 0n
        const released = split.released.get(address.toLowerCase()) ?? 0n
        const owed = totalShares > 0n ? (split.received * share) / totalShares : 0n
        return { address, share, released, releasable: owed > released ? owed - released : 0n }
      }),
    },
    buyback: buyback && {
      held: buyback.held,
      totalSpent: buyback.spent,
      totalBurned: buyback.burned,
      offer: pacedOffer(buyback, launch, nowSeconds()),
      lastRunAt: BigInt(buyback.lastRunAt),
    },
    deepen: deepen && {
      burnBps: deepen.burnBps,
      held: deepen.held,
      ...deepenPreview(deepen, launch, nowSeconds()),
      lastRunAt: BigInt(deepen.lastRunAt),
      totalSpent: deepen.spent,
      totalBurned: deepen.burned,
      totalUsdcAdded: deepen.usdcAdded,
      totalTokensAdded: deepen.tokensAdded,
      totalLiquidity: deepen.liquidity,
    },
    holders: holders && {
      undistributed: undistributed(token, holders, nowSeconds()),
      // LaunchToken's views: the rate reads 0 while nothing pays (ended or paused), and a paused stream's end moves
      // out with the clock.
      streamRate: nowSeconds() >= holders.end || eligibleSupply(token, holders) === 0n ? 0n : holders.rate / MAGNITUDE,
      streamEnd: BigInt(
        holders.lastAccrual < holders.end && eligibleSupply(token, holders) === 0n ? holders.end + (nowSeconds() - holders.lastAccrual) : holders.end,
      ),
      totalDistributed: holders.distributed,
      eligibleSupply: eligibleSupply(token, holders),
      readAt: BigInt(nowSeconds()),
      you: owner ? { balance: fixtureBalance(owner, token), claimable: holderClaimable(holders, owner, token, nowSeconds()) } : undefined,
      // The fixture keeps a dividend book only for tokens whose fees go to Distribute to holders.
      fromFees: true,
    },
    combo: combo ? combo.map((entry) => ({ ...entry })) : undefined,
  }
}

function install(): void {
  seedMarket()

  setLaunchFixtureApi({
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    version: () => store.version,
    launchFee: () => FIXTURE_LAUNCH_FEE,
    list: () => [...store.launches].map(syncRecord).sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt > b.createdAt ? -1 : 1)),
    get: (token) => {
      const found = store.launches.find((item) => item.token.toLowerCase() === token.toLowerCase())
      return found ? syncRecord(found) : undefined
    },
    balance: fixtureBalance,
    allowance: (owner, token, spender) => (owner ? (store.allowances.get(key(owner, token, spender)) ?? 0n) : 0n),
    trades: (token) => [...(store.trades.get(token.toLowerCase()) ?? [])].sort((a, b) => b.time - a.time).slice(0, 50),
    approve: (owner, token, spender, value) => {
      store.allowances.set(key(owner, token, spender), value)
      emit()
      return nextHash('approve')
    },
    buy: (owner, token, usdcIn) => {
      const launch = find(token)
      const suite = launch.version === 'v14' ? { launchpad: FIXTURE_SUITE_V14.launchpad, router: FIXTURE_SUITE_V14.router } : { launchpad: FIXTURE_SUITE.launchpad, router: FIXTURE_SUITE.launchRouter }
      buyInternal(owner, token, usdcIn, nowSeconds(), launch.graduated ? suite.router : suite.launchpad)
      emit()
      return { hash: nextHash('buy') }
    },
    sell: (owner, token, tokensIn) => {
      sellInternal(owner, token, tokensIn, nowSeconds())
      emit()
      return { hash: nextHash('sell') }
    },
    create: (owner, args) => {
      const token = createInternal(owner, args, nowSeconds(), args.version === 'v14' ? FIXTURE_SUITE_V14.launchpad : FIXTURE_SUITE.launchpad)
      emit()
      return { hash: nextHash('create'), token }
    },
    creatorFees,
    collect: (token) => {
      const hash = collect(token)
      emit()
      return hash
    },
    release: (token, payee) => {
      const book = store.splits.get(token.toLowerCase())
      const state = creatorFees(token, undefined)?.split?.payees.find((row) => row.address.toLowerCase() === payee.toLowerCase())
      if (!book || !state || state.releasable === 0n) throw new Error('NothingToRelease')
      book.released.set(payee.toLowerCase(), (book.released.get(payee.toLowerCase()) ?? 0n) + state.releasable)
      setBalance(payee, usdcAddress(), fixtureBalance(payee, usdcAddress()) + state.releasable)
      emit()
      return nextHash('release')
    },
    runBuyback: (token) => {
      const hash = runBuybackInternal(token, nowSeconds())
      emit()
      return hash
    },
    runDeepen: (token) => {
      const hash = runDeepenInternal(token, nowSeconds())
      emit()
      return hash
    },
    blockNumber: () => BigInt(blockNumber()),
    quoteV4: (token, side, amountIn) => {
      const launch = find(token)
      return poolTrade(poolOf(token), side, amountIn, launch.creatorFeeBps, side === 'buy' ? snipeAt(launch, nowSeconds()) : 0).out
    },
    snipeHeld: (token) => {
      const launch = store.launches.find((item) => item.token.toLowerCase() === token.toLowerCase())
      if (launch?.version !== 'v14' || launch.graduated) return undefined
      return store.snipe.get(token.toLowerCase()) ?? 0n
    },
    claim: (token, owner) => {
      // The token's claim: accrue, then pay the owner everything it has earned so far.
      const book = store.holders.get(token.toLowerCase())
      if (!book) return nextHash('claim')
      settleHolder(book, owner, token, nowSeconds())
      const paid = book.accrued.get(owner.toLowerCase()) ?? 0n
      book.accrued.set(owner.toLowerCase(), 0n)
      setBalance(owner, usdcAddress(), fixtureBalance(owner, usdcAddress()) + paid)
      emit()
      return nextHash('claim')
    },
  })
}

install()
