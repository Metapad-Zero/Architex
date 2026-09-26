import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem'
import { CURVE } from './curve'

/**
 * Launchpad v1.4's own arithmetic (docs/launchpad/V14-SPEC.md), mirrored from the contracts in contracts-v14/src the
 * way lib/curve.ts mirrors the curve: the anti-sniping fee's schedule, the Uniswap v4 pool a token graduates into, its
 * price, and the fees the hook takes on a pool trade. The reference vectors in `__tests__/fixtures/v14-vectors.json`
 * come from the contracts themselves (contracts-v14/test/SiteVectorsV14.t.sol), with USDC at Arc's own address.
 *
 * Arc's USDC (0x3600…) sorts below most token addresses, so it is currency0 of about four pools in five and currency1
 * of the rest: every price here is read either way round.
 */
export const V14 = {
  /** Blocks in which a buy pays the snipe fee: after a curve's creation, and again after its pool opens (about 10 s). */
  SNIPE_BLOCKS: 20n,
  /** The fee in the opening block, falling linearly to 0 over SNIPE_BLOCKS: 90%. */
  SNIPE_START_BPS: 9_000n,
  /** Platform, creator and snipe fees together never take more than 99% of a buy. */
  MAX_TOTAL_FEE_BPS: 9_900n,
  /** Every v1.4 pool charges no LP fee (the hook's fees are the whole trading cost) and spaces its ticks by 200. */
  LP_FEE: 0,
  TICK_SPACING: 200,
  /** A bid's top sits this many ticks past the price it is placed from, on the cheaper side: about half of it. */
  BID_DISCOUNT_TICKS: 6_932,
  /** How far down a bid runs from its top: about 10,000 times lower. */
  BID_SPAN_TICKS: 92_200,
  /** Uniswap's usable tick range at a spacing of 200 (TickMath.minUsableTick, maxUsableTick). */
  MIN_USABLE_TICK: -887_200,
  MAX_USABLE_TICK: 887_200,
} as const

/** About how many blocks Arc makes a second (V14-SPEC §2: two blocks share most one-second timestamps). */
export const ARC_BLOCKS_PER_SECOND = 2n

const BPS = 10_000n
const Q96 = 1n << 96n
const Q192 = 1n << 192n
const E36 = 10n ** 36n

function ceilDiv(a: bigint, b: bigint): bigint {
  return a === 0n ? 0n : (a - 1n) / b + 1n
}

// ─── The anti-sniping fee ────────────────────────────────────────────────────

/**
 * The snipe fee, in bps, on a buy in `block` of a window that opened in `openBlock` (the curve's creation block, or
 * the block its pool opened): SNIPE_START_BPS in the opening block, falling linearly to 0 after SNIPE_BLOCKS, and never
 * more than leaves platform, creator and snipe fees together under MAX_TOTAL_FEE_BPS. `_curveSnipeBps` on the
 * launchpad and `_snipeBps` on the hook. Sells never pay it, and nor does the creator's first buy in the launch
 * transaction.
 */
export function snipeBps(openBlock: bigint, block: bigint, creatorFeeBps: number | bigint): number {
  const end = openBlock + V14.SNIPE_BLOCKS
  if (block >= end) return 0
  // No trade lands before its window opens; a clock that has not caught up yet reads as the opening block.
  const left = end - block > V14.SNIPE_BLOCKS ? V14.SNIPE_BLOCKS : end - block
  const bps = (V14.SNIPE_START_BPS * left) / V14.SNIPE_BLOCKS
  const room = V14.MAX_TOTAL_FEE_BPS - CURVE.FEE_BPS - BigInt(creatorFeeBps)
  return Number(bps > room ? room : bps)
}

/** The first block of `openBlock`'s window in which a buy pays no snipe fee. */
export function snipeWindowEnd(openBlock: bigint): bigint {
  return openBlock + V14.SNIPE_BLOCKS
}

/** Roughly how many seconds are left until `block` reaches `end` on Arc, rounded up; 0 once it has. */
export function secondsUntil(end: bigint, block: bigint): number {
  return end > block ? Number(ceilDiv(end - block, ARC_BLOCKS_PER_SECOND)) : 0
}

// ─── The Uniswap v4 pool ─────────────────────────────────────────────────────

/** A Uniswap v4 PoolKey: its currencies sorted by address, the LP fee, the tick spacing and the hook. */
export interface PoolKey {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}

/** Whether USDC is the pool's currency0: it sorts below the token (addresses compare as numbers). */
export function usdcIsCurrency0(usdc: Address, token: Address): boolean {
  return BigInt(usdc) < BigInt(token)
}

/** The pool a v1.4 token graduates into, known from launch: `ArchitexLaunchHook._keyFor`. */
export function launchPoolKey(token: Address, usdc: Address, hook: Address): PoolKey {
  const [currency0, currency1] = usdcIsCurrency0(usdc, token) ? [usdc, token] : [token, usdc]
  return { currency0, currency1, fee: V14.LP_FEE, tickSpacing: V14.TICK_SPACING, hooks: hook }
}

/** Uniswap v4's PoolId: keccak256 of the ABI-encoded key (`PoolIdLibrary.toId`). */
export function poolIdOf(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  )
}

/** A graduated v1.4 token's pool, as the site reads it: the hook's launchOf, StateView's getSlot0 and getLiquidity. */
export interface V4PoolState {
  poolId: Hex
  /** √(currency1 per currency0), as a Q64.96 number. */
  sqrtPriceX96: bigint
  usdcIs0: boolean
  /** The block the pool opened in: its own snipe window counts from here. */
  openBlock: bigint
  /** Liquidity in range at the current price; read for the size hint, absent until then. */
  liquidity?: bigint
  /** How many bids the pool has (hook.bidCount): the graduation bid, if the curve collected snipe fees, and one per buy in its snipe window. */
  bidCount?: bigint
  /** The pool's tick now (StateView's getSlot0); absent until read. */
  tick?: number
  /** The tick the pool opened at (launchOf): the graduation bid's reference, and where the bid reference starts. */
  graduationTick?: number
  /**
   * The pool's bid reference (launchOf's bidRefTick): the lowest price any buy in its window has started from, the
   * graduation price to begin with. It only ever moves down. Absent until read.
   */
  bidRefTick?: number
}

// ─── Bids ────────────────────────────────────────────────────────────────────

function ceilTick(tick: number): number {
  return Math.ceil(tick / V14.TICK_SPACING) * V14.TICK_SPACING + 0
}

function floorTick(tick: number): number {
  return Math.floor(tick / V14.TICK_SPACING) * V14.TICK_SPACING + 0
}

/**
 * A bid's range from its reference tick (`ArchitexLaunchHook._bidRange`): its top about half the price at `refTick`
 * (BID_DISCOUNT_TICKS past it, rounded away from the price onto the tick spacing), its bottom BID_SPAN_TICKS further,
 * clamped to the usable ticks. With USDC as currency0 a higher tick is a cheaper token, so the range lies above the
 * reference tick; with USDC as currency1, below. The graduation bid takes the graduation tick as its reference; a window
 * buy's, windowBidRange's.
 */
export function bidRange(usdcIs0: boolean, refTick: number): { lower: number; upper: number } {
  if (usdcIs0) {
    const lower = ceilTick(refTick + V14.BID_DISCOUNT_TICKS + 1)
    return { lower, upper: Math.min(lower + V14.BID_SPAN_TICKS, V14.MAX_USABLE_TICK) }
  }
  const upper = floorTick(refTick - V14.BID_DISCOUNT_TICKS)
  return { lower: Math.max(upper - V14.BID_SPAN_TICKS, V14.MIN_USABLE_TICK), upper }
}

/**
 * The tick of the cheaper token price of two (`ArchitexLaunchHook._cheaperOf`): with USDC as currency0 a higher tick
 * is a cheaper token, so the higher of the two; with USDC as currency1, the lower.
 */
export function cheaperOf(usdcIs0: boolean, a: number, b: number): number {
  if (usdcIs0) return a > b ? a : b
  return a < b ? a : b
}

/**
 * Where a buy in a pool's snipe window places its fee (`ArchitexLaunchHook._afterSwap`): from half the lower of the
 * price just before that buy (`preTick`) and the pool's bid reference as it stood before the buy (`bidRefTick`, launchOf
 * read before it). That lower price becomes the reference (`cheaperOf`), so the reference is the lowest price any window
 * buy has started from, the graduation price to begin with: bids follow a crash down and never move back up, and none
 * starts above half the graduation price. A buy only moves the price up, so every bid is wholly under the market.
 */
export function windowBidRange(usdcIs0: boolean, preTick: number, bidRefTick: number): { lower: number; upper: number } {
  return bidRange(usdcIs0, cheaperOf(usdcIs0, preTick, bidRefTick))
}

/**
 * Where the next buy in a pool's window would start its bid, as a price in v4SpotPrice's units: the edge of
 * windowBidRange nearest the market, from the pool's tick now and its bid reference. Later bids in the window start
 * there or lower (a sell first lowers it; buys never raise it). Undefined until the tick and the reference are read.
 */
export function nextBidSpotPrice(pool: Pick<V4PoolState, 'usdcIs0' | 'tick' | 'bidRefTick'>): bigint | undefined {
  if (pool.tick === undefined || pool.bidRefTick === undefined) return undefined
  const range = windowBidRange(pool.usdcIs0, pool.tick, pool.bidRefTick)
  return v4SpotPrice({ usdcIs0: pool.usdcIs0, sqrtPriceX96: sqrtPriceAtTick(pool.usdcIs0 ? range.lower : range.upper) })
}

// ─── Ticks (Uniswap's TickMath) ──────────────────────────────────────────────

const MAX_TICK = 887_272
const MAX_UINT256 = (1n << 256n) - 1n
/** For bit i of |tick| (i ≥ 1), 1/√(1.0001^(2^i)) in Q128.128, exactly as TickMath has it. */
const TICK_FACTORS: ReadonlyArray<readonly [number, bigint]> = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
]

/** TickMath.getSqrtPriceAtTick: √(1.0001^tick) as a Q64.96 number, rounded exactly as the contracts round it. */
export function sqrtPriceAtTick(tick: number): bigint {
  const abs = Math.abs(tick)
  if (!Number.isInteger(tick) || abs > MAX_TICK) throw new Error('InvalidTick')
  let price = abs & 0x1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n
  for (const [bit, factor] of TICK_FACTORS) if (abs & bit) price = (price * factor) >> 128n
  if (tick > 0) price = MAX_UINT256 / price
  // Q128.128 to Q64.96, rounded up (so getTickAtSqrtPrice of the result is the tick again).
  return (price + (1n << 32n) - 1n) >> 32n
}

/** TickMath.getTickAtSqrtPrice: the greatest tick whose sqrt price is at most `sqrtPriceX96`. */
export function tickAtSqrtPrice(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 < sqrtPriceAtTick(-MAX_TICK) || sqrtPriceX96 >= sqrtPriceAtTick(MAX_TICK)) throw new Error('InvalidSqrtPrice')
  let low = -MAX_TICK
  let high = MAX_TICK - 1
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2)
    if (sqrtPriceAtTick(mid) <= sqrtPriceX96) low = mid
    else high = mid - 1
  }
  return low
}

type Priced = Pick<V4PoolState, 'sqrtPriceX96' | 'usdcIs0'>

/**
 * A pool's price in the units of lib/curve.ts's spotPrice (USDC with 6 decimals per whole token, scaled by 1e18).
 * The pool's own price is currency1 per currency0: the token's price when USDC is currency1, its inverse otherwise.
 * 0 for a pool that has no price.
 */
export function v4SpotPrice(pool: Priced): bigint {
  const ratio = pool.sqrtPriceX96 * pool.sqrtPriceX96
  if (ratio === 0n) return 0n
  return pool.usdcIs0 ? (E36 * Q192) / ratio : (ratio * E36) / Q192
}

/**
 * A graduated token's market cap on the curve's definition (its price times the 800M curve supply), in USDC with 6
 * decimals, so the figure carries on from graduation's $100,000 without a jump. 0 for a pool that has no price.
 */
export function v4MarketCap(pool: Priced): bigint {
  return v4Value(CURVE.CURVE_SUPPLY, pool)
}

/** What `tokens` (18 decimals) are worth at the pool's price, in USDC units (6 decimals), rounded down. */
export function v4Value(tokens: bigint, pool: Priced): bigint {
  const ratio = pool.sqrtPriceX96 * pool.sqrtPriceX96
  if (ratio === 0n) return 0n
  return pool.usdcIs0 ? (tokens * Q192) / ratio : (tokens * ratio) / Q192
}

// ─── The hook's fees on a pool trade ─────────────────────────────────────────

export interface PoolTradeFees {
  platformFee: bigint
  creatorFee: bigint
  snipeFee: bigint
}

/**
 * The hook's fees on a known gross USDC amount (`_feesOnGross`): what an exact-in buy pays out of its USDC in, or what
 * an exact-in sell pays out of the USDC the pool gives (with no snipe fee). Each is rounded up on its own; fees that
 * would take the whole amount are refused (FeesExceedAmount), as the hook refuses them.
 */
export function poolFeesOnGross(gross: bigint, creatorFeeBps: number | bigint, snipeFeeBps: number | bigint = 0): PoolTradeFees {
  const platformFee = ceilDiv(gross * CURVE.FEE_BPS, BPS)
  const creatorFee = ceilDiv(gross * BigInt(creatorFeeBps), BPS)
  const snipeFee = ceilDiv(gross * BigInt(snipeFeeBps), BPS)
  if (platformFee + creatorFee + snipeFee >= gross) throw new Error('FeesExceedAmount')
  return { platformFee, creatorFee, snipeFee }
}

/**
 * The gross USDC a pool paid for a sell that left `usdcOut` after the platform and creator fees: the smallest gross
 * whose rounded-up fees leave exactly that, or, where rounding skips it, the closest one above. The router's quote
 * says only what the seller receives; this puts the fees back on it for the receipt.
 */
export function grossOfSell(usdcOut: bigint, creatorFeeBps: number | bigint): bigint {
  if (usdcOut <= 0n) return 0n
  const keep = BPS - CURVE.FEE_BPS - BigInt(creatorFeeBps)
  const net = (gross: bigint) => gross - ceilDiv(gross * CURVE.FEE_BPS, BPS) - ceilDiv(gross * BigInt(creatorFeeBps), BPS)
  // gross·keep/1e4 - 2 < net(gross) <= gross·keep/1e4, so the gross is within three units above usdcOut·1e4/keep.
  const guess = (usdcOut * BPS) / keep
  for (let gross = guess; gross <= guess + 3n; gross += 1n) if (net(gross) >= usdcOut) return gross
  return guess + 3n
}

/**
 * How much worse than the pool's price a trade does, in bps, with every fee left out: the USDC a buy puts into the
 * pool against what its tokens are worth at the price before it, or what a sell's tokens are worth there against the
 * USDC the pool pays for them. It is Swap's measure of impact (execution against the price before), which is what a
 * router's quote allows: the price after a pool trade depends on liquidity in ranges the site does not read.
 */
export function v4ImpactBps(side: 'buy' | 'sell', pool: Priced, usdc: bigint, tokens: bigint): bigint {
  const worth = v4Value(tokens, pool)
  if (side === 'buy') return usdc > 0n && worth < usdc ? ((usdc - worth) * BPS) / usdc : 0n
  return worth > 0n && usdc < worth ? ((worth - usdc) * BPS) / worth : 0n
}

/**
 * The largest trade whose impact (as v4ImpactBps measures it) stays under `targetBps` while the price stays in the
 * range the liquidity in range covers: a buy's offer (USDC, fees included) or a sell's tokens. With in-range liquidity
 * L the pool trades like a constant product on the virtual reserves L·√P (currency1) and L/√P (currency0), so a
 * net n into a side R costs n/(R + n), which stays under t while n < t·R/(1 - t). Liquidity further out is left out,
 * so this is "about", as the size hint says.
 */
export function maxV4Trade(
  side: 'buy' | 'sell',
  pool: Priced & { liquidity?: bigint },
  feeBps: number | bigint,
  targetBps: bigint,
): bigint {
  const liquidity = pool.liquidity ?? 0n
  if (liquidity <= 0n || pool.sqrtPriceX96 <= 0n || targetBps <= 0n || targetBps >= BPS) return 0n
  const reserve1 = (liquidity * pool.sqrtPriceX96) / Q96
  const reserve0 = (liquidity * Q96) / pool.sqrtPriceX96
  const [usdcSide, tokenSide] = pool.usdcIs0 ? [reserve0, reserve1] : [reserve1, reserve0]
  const reserve = side === 'buy' ? usdcSide : tokenSide
  const most = (targetBps * reserve) / (BPS - targetBps)
  if (side === 'sell') return most
  const kept = BPS - BigInt(feeBps)
  return kept > 0n ? (most * BPS) / kept : 0n
}

// ─── Trades ──────────────────────────────────────────────────────────────────

/**
 * The market cap a pool trade was made at, from the hook's PoolTrade: the USDC that went into the pool or came out of
 * it, fees left out, per token, times the 800M curve supply. The event carries no price of its own, so the chart's pool
 * points are these, each between the price before the trade and the price after it.
 */
export function poolTradeMarketCap(trade: { isBuy: boolean; usdcAmount: bigint; tokenAmount: bigint; platformFee: bigint; creatorFee: bigint; snipeFee?: bigint }): bigint {
  if (trade.tokenAmount === 0n) return 0n
  const fees = trade.platformFee + trade.creatorFee + (trade.snipeFee ?? 0n)
  const usdc = trade.isBuy ? trade.usdcAmount - fees : trade.usdcAmount
  return usdc > 0n ? (usdc * CURVE.CURVE_SUPPLY) / trade.tokenAmount : 0n
}
