/**
 * Dev-only fake launchpad v1.3 suite: the launchpad, the launch router and the reference plugins, simulated in
 * memory with the same maths the site quotes with (lib/curve.ts). Loaded only via a dynamic import inside
 * `import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1'`, which is a compile-time dead branch in
 * production. The marker string below must not appear in dist/.
 *
 * It is a stand-in for exercising the UI, not a second implementation to trust: amounts follow the contracts'
 * formulas, but blocks are simulated (one every two seconds) and nothing here is checked against a chain.
 */
import { decodeAbiParameters, getAddress, keccak256, toHex, type Address, type Hash, type Hex } from 'viem'
import { activeChain } from '../chain'
import { listedPlugin, listedPluginAt, pluginAddress } from '../content/plugins/registry'
import { CURVE, INITIAL_CURVE, quoteBuy, quotePoolBuy, quotePoolSell, quoteSell, realUsdc, type CurveState, type PoolReserves } from './curve'
import { FIXTURE_SUITE } from './deployment'
import type { LaunchRecord, LaunchTrade } from './launch'
import { setLaunchFixtureApi, type FixtureCreateArgs } from './launchFixtureApi'
// The builder's own encoders, so a fixture launch carries exactly what the builder would send.
import { encodeComboData as encodeCombo, encodeSplitData as encodeSplit } from './plugins/plan'
import type { CreatorFeeState } from './plugins/state'
import { rememberToken } from './tokens'

export const LAUNCHPAD_FIXTURE_XSS_PAYLOAD = '<img src=x onerror=alert(1)>'

const USDC = 1_000_000n
const E18 = 10n ** 18n
const MAGNITUDE = 10n ** 36n
const DRIP_PERIOD = 86_400
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

function addr(n: number): Address {
  return getAddress(`0x${n.toString(16).padStart(40, '0')}`)
}

interface FixtureLaunch extends LaunchRecord {
  state: CurveState
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
  lastRunBlock: number
}

interface HolderBook {
  unreleased: bigint
  lastDrip: number
  streamEnd: number
  distributed: bigint
  /** USDC per token-wei, scaled by 1e36. */
  index: bigint
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
  holders: Map<string, HolderBook>
  combos: Map<string, { target: Address; bps: number; isPlugin: boolean }[]>
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
  holders: new Map(),
  combos: new Map(),
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
  if (holders) settleHolder(holders, owner, token)
  store.balances.set(key(owner, token), value)
}

function spendAllowance(owner: Address, spender: Address, amount: bigint): void {
  const slot = key(owner, usdcAddress(), spender)
  const allowed = store.allowances.get(slot) ?? 0n
  if (allowed < amount) throw new Error('ERC20InsufficientAllowance')
  store.allowances.set(slot, allowed - amount)
}

// ─── Holder dividends (the token's tracker, simplified) ──────────────────────

function eligibleSupply(token: Address, book: HolderBook): bigint {
  let tracked = 0n
  for (const [slot, value] of store.balances) {
    if (slot.endsWith(`:${token.toLowerCase()}`)) tracked += value
  }
  const supply = book.others + tracked
  return supply < E18 ? 0n : supply
}

function settleHolder(book: HolderBook, owner: Address, token: Address): void {
  const id = owner.toLowerCase()
  const snap = book.snaps.get(id) ?? 0n
  const balance = fixtureBalance(owner, token)
  book.accrued.set(id, (book.accrued.get(id) ?? 0n) + ((book.index - snap) * balance) / MAGNITUDE)
  book.snaps.set(id, book.index)
}

function holderClaimable(book: HolderBook, owner: Address, token: Address): bigint {
  const id = owner.toLowerCase()
  return (book.accrued.get(id) ?? 0n) + ((book.index - (book.snaps.get(id) ?? 0n)) * fixtureBalance(owner, token)) / MAGNITUDE
}

function holderReleasable(book: HolderBook, token: Address, now = nowSeconds()): bigint {
  if (book.unreleased === 0n || eligibleSupply(token, book) === 0n) return 0n
  if (now >= book.streamEnd) return book.unreleased
  return (book.unreleased * BigInt(now - book.lastDrip)) / BigInt(book.streamEnd - book.lastDrip)
}

function drip(token: Address, book: HolderBook, now = nowSeconds()): bigint {
  const due = holderReleasable(book, token, now)
  if (due === 0n) return 0n
  book.unreleased -= due
  book.distributed += due
  book.lastDrip = now
  book.index += (due * MAGNITUDE) / eligibleSupply(token, book)
  return due
}

// ─── Plugins ─────────────────────────────────────────────────────────────────

function configure(token: Address, plugin: Address, data: Hex): void {
  const listed = listedPluginAt(plugin)
  if (!listed) return
  switch (listed.kind) {
    case 'split': {
      const [payees, shares] = decodeAbiParameters([{ type: 'address[]' }, { type: 'uint256[]' }], data)
      store.splits.set(token.toLowerCase(), { payees: [...payees], shares: [...shares], received: 0n, released: new Map() })
      return
    }
    case 'buyback':
      store.buybacks.set(token.toLowerCase(), { held: 0n, spent: 0n, burned: 0n, lastRunBlock: 0 })
      return
    case 'holders':
      store.holders.set(token.toLowerCase(), {
        unreleased: 0n,
        lastDrip: 0,
        streamEnd: 0,
        distributed: 0n,
        index: 0n,
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
          const isPlugin = Boolean(listedPluginAt(target))
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
  const listed = listedPluginAt(target)
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
    case 'holders': {
      const book = store.holders.get(id)
      if (!book) return
      const now = nowSeconds()
      drip(token, book, now)
      const kept = book.unreleased
      const from = Math.max(book.streamEnd, now)
      // The amount-weighted stream end the plugin sets (IHolderDistributionPlugin): floor((kept·from + amount·to) /
      // (kept + amount)), never before now + 1. Dust leaves it where it is; a big delivery pushes it towards 24h.
      const weighted = (kept * BigInt(from) + amount * BigInt(now + DRIP_PERIOD)) / (kept + amount)
      book.streamEnd = Math.max(Number(weighted), now + 1)
      book.unreleased = kept + amount
      book.lastDrip = now
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

function buyInternal(trader: Address, token: Address, usdcIn: bigint, time: number, spender?: Address): { tokensOut: bigint; usdcSpent: bigint } {
  const launch = find(token)
  if (!launch.graduated) {
    const quote = quoteBuy(launch.state, usdcIn, launch.creatorFeeBps)
    if (spender) spendAllowance(trader, spender, quote.usdcSpent)
    setBalance(trader, usdcAddress(), fixtureBalance(trader, usdcAddress()) - quote.usdcSpent)
    setBalance(trader, token, fixtureBalance(trader, token) + quote.tokensOut)
    launch.state = quote.next
    accrue(token, quote.creatorFee)
    record(token, {
      trader,
      isBuy: true,
      usdcAmount: quote.usdcSpent,
      tokenAmount: quote.tokensOut,
      platformFee: quote.platformFee,
      creatorFee: quote.creatorFee,
      time,
      txHash: nextHash('buy'),
      virtualUsdc: quote.next.virtualUsdc,
      virtualTokens: quote.next.virtualTokens,
      venue: 'curve',
    })
    if (quote.graduates) {
      launch.graduated = true
      launch.pool = { reserveToken: CURVE.POOL_SUPPLY, reserveUsdc: realUsdc(quote.next) }
    }
    return { tokensOut: quote.tokensOut, usdcSpent: quote.usdcSpent }
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
      time,
      txHash: nextHash('sell'),
      virtualUsdc: quote.next.virtualUsdc,
      virtualTokens: quote.next.virtualTokens,
      venue: 'curve',
    })
    return quote.usdcOut
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

function createInternal(owner: Address, args: FixtureCreateArgs, time: number, spender?: Address): Address {
  if (args.maxLaunchFee < FIXTURE_LAUNCH_FEE) throw new Error('LaunchFeeAboveMax')
  const token = addr(0x1000 + store.launches.length)
  const firstBuy = args.initialBuyUsdc > 0n ? quoteBuy(INITIAL_CURVE, args.initialBuyUsdc, args.creatorFeeBps) : undefined
  if (spender) spendAllowance(owner, spender, FIXTURE_LAUNCH_FEE + (firstBuy?.usdcSpent ?? 0n))
  setBalance(owner, usdcAddress(), fixtureBalance(owner, usdcAddress()) - FIXTURE_LAUNCH_FEE)
  rememberToken({ address: token, name: args.name, symbol: args.symbol, decimals: 18, faucet: false, isLaunch: true })
  store.launches.unshift({
    token,
    creator: owner,
    pair: addr(0x2000 + store.launches.length),
    virtualUsdc: INITIAL_CURVE.virtualUsdc,
    virtualTokens: INITIAL_CURVE.virtualTokens,
    tokensSold: 0n,
    createdAt: BigInt(time),
    graduated: false,
    creatorFeeBps: args.creatorFeeBps,
    pluginHooks: Boolean(listedPluginAt(args.plugin)),
    plugin: args.plugin,
    metadataURI: args.metadataURI,
    name: args.name,
    symbol: args.symbol,
    state: INITIAL_CURVE,
  })
  configure(token, args.plugin, args.pluginData)
  if (args.initialBuyUsdc > 0n) buyInternal(owner, token, args.initialBuyUsdc, time)
  return token
}

function runBuybackInternal(token: Address, time: number): Hash {
  const book = store.buybacks.get(token.toLowerCase())
  if (!book) throw new Error('NotConfigured')
  if (blockNumber() < book.lastRunBlock + 1) throw new Error('AlreadyRanThisBlock')
  const launch = find(token)
  const cap = ((launch.graduated ? (launch.pool as PoolReserves).reserveUsdc : launch.state.virtualUsdc) * 25n) / 10_000n
  const offer = book.held < cap ? book.held : cap
  if (offer === 0n) throw new Error('NothingToBuy')
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

function launchWith(kind: 'wallet' | 'custom' | 'split' | 'buyback' | 'holders' | 'combo', args: Omit<FixtureCreateArgs, 'plugin' | 'pluginData' | 'maxLaunchFee' | 'initialBuyUsdc'>, time: number, data: Hex = '0x'): Address {
  const plugin = kind === 'wallet' ? CREATOR : kind === 'custom' ? CUSTOM_DESTINATION : pluginAddress(listedPlugin(kind))
  return createInternal(CREATOR, { ...args, plugin, pluginData: data, initialBuyUsdc: 0n, maxLaunchFee: FIXTURE_LAUNCH_FEE }, time)
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
    gradHolders.index = (40n * USDC * MAGNITUDE) / (620_000_000n * E18)
    gradHolders.distributed = 40n * USDC
  }
  collect(grad)

  const combo = encodeCombo([pluginAddress(listedPlugin('holders')), pluginAddress(listedPlugin('buyback'))], [6_000, 4_000], ['0x', '0x'])
  const gcmb = launchWith('combo', { name: 'Graduated Combo', symbol: 'GCMB', metadataURI: '', creatorFeeBps: 50 }, NOW - 50_000, combo)
  buyInternal(WHALE, gcmb, 1_000_000n * USDC, NOW - 40_000)
  buyInternal(alice, gcmb, 2_500n * USDC, NOW - 9_000)
  collect(gcmb)
  store.seeded.set(gcmb.toLowerCase(), 500_000n * E18)
  const gcmbHolders = store.holders.get(gcmb.toLowerCase())
  if (gcmbHolders) gcmbHolders.others = 300_000_000n * E18

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

  launchWith('wallet', { name: 'Pepe', symbol: 'PEPE', metadataURI: '', creatorFeeBps: 0 }, NOW - 120)

  const mint = launchWith(
    'combo',
    { name: 'Fresh mint', symbol: 'MINT', metadataURI: 'https://example.com/mint.png', creatorFeeBps: 300 },
    NOW - 30,
    encodeCombo([CREATOR, pluginAddress(listedPlugin('split')), pluginAddress(listedPlugin('buyback'))], [5_000, 3_000, 2_000], ['0x', splitTwo, '0x']),
  )
  buyInternal(bob, mint, 50n * USDC, NOW - 20)
}

// ─── The API the hooks call ──────────────────────────────────────────────────

function collect(token: Address): Hash {
  const launch = find(token)
  const amount = store.pending.get(token.toLowerCase()) ?? 0n
  store.pending.set(token.toLowerCase(), 0n)
  deliver(token, launch.plugin, amount)
  return nextHash('collect')
}

function syncRecord(launch: FixtureLaunch): LaunchRecord {
  const { state, ...record } = launch
  return { ...record, virtualUsdc: state.virtualUsdc, virtualTokens: state.virtualTokens, tokensSold: state.tokensSold }
}

function creatorFees(token: Address, owner: Address | undefined): CreatorFeeState | undefined {
  const launch = store.launches.find((item) => item.token.toLowerCase() === token.toLowerCase())
  if (!launch) return undefined
  const id = token.toLowerCase()
  const split = store.splits.get(id)
  const buyback = store.buybacks.get(id)
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
      offer: (() => {
        if (buyback.held === 0n || blockNumber() < buyback.lastRunBlock + 1) return 0n
        const cap = ((launch.graduated ? (launch.pool as PoolReserves).reserveUsdc : launch.state.virtualUsdc) * 25n) / 10_000n
        return buyback.held < cap ? buyback.held : cap
      })(),
    },
    holders: holders && {
      unreleased: holders.unreleased,
      releasable: holderReleasable(holders, token),
      streamEnd: BigInt(holders.streamEnd),
      totalDistributed: holders.distributed,
      eligibleSupply: eligibleSupply(token, holders),
      you: owner ? { balance: fixtureBalance(owner, token), claimable: holderClaimable(holders, owner, token) } : undefined,
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
      buyInternal(owner, token, usdcIn, nowSeconds(), launch.graduated ? FIXTURE_SUITE.launchRouter : FIXTURE_SUITE.launchpad)
      emit()
      return { hash: nextHash('buy') }
    },
    sell: (owner, token, tokensIn) => {
      sellInternal(owner, token, tokensIn, nowSeconds())
      emit()
      return { hash: nextHash('sell') }
    },
    create: (owner, args) => {
      const token = createInternal(owner, args, nowSeconds(), FIXTURE_SUITE.launchpad)
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
    drip: (token) => {
      const book = store.holders.get(token.toLowerCase())
      if (!book) throw new Error('NotConfigured')
      drip(token, book)
      emit()
      return nextHash('drip')
    },
    dripAndClaim: (token, owner) => {
      const book = store.holders.get(token.toLowerCase())
      if (!book) throw new Error('NotConfigured')
      drip(token, book)
      settleHolder(book, owner, token)
      const paid = book.accrued.get(owner.toLowerCase()) ?? 0n
      book.accrued.set(owner.toLowerCase(), 0n)
      setBalance(owner, usdcAddress(), fixtureBalance(owner, usdcAddress()) + paid)
      emit()
      return nextHash('claim')
    },
  })
}

install()
