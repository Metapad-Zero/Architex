/**
 * Uniswap v4 pool math, ported to bigint line for line from v4-core 1.0.2 and v4-periphery 1.0.3 (TickMath,
 * SqrtPriceMath, SwapMath, TickBitmap's one-word stepping, Pool.swap and Pool.modifyLiquidity's amounts, and
 * LiquidityAmounts). The launchpad v1.4 rehearsal (scripts/v14-rehearsal.ts) uses it as its independent model of what
 * Uniswap's PoolManager does to a pool, so every swap, add and bid can be checked to the unit.
 *
 * Only what the v1.4 pools use: LP fee 0 and no protocol fee (the rehearsal checks both on chain), so the fee parts of
 * SwapMath are carried but always 0. Every function mirrors its Solidity original, rounding included; where Solidity
 * relies on a 256-bit overflow check (SqrtPriceMath's product) the same check is made explicitly.
 */

export const Q96 = 1n << 96n
export const MIN_TICK = -887272
export const MAX_TICK = 887272
export const MIN_SQRT_PRICE = 4295128739n
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n
const TWO_256 = 1n << 256n
const MAX_U256 = TWO_256 - 1n

export const minUsableTick = (spacing: number) => Math.trunc(MIN_TICK / spacing) * spacing
export const maxUsableTick = (spacing: number) => Math.trunc(MAX_TICK / spacing) * spacing

// ── FullMath / UnsafeMath ──────────────────────────────────────────────────────

export function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error('mulDiv: division by zero')
  const r = (a * b) / d
  if (r > MAX_U256) throw new Error('mulDiv: overflow')
  return r
}
export function mulDivUp(a: bigint, b: bigint, d: bigint): bigint {
  const r = mulDiv(a, b, d)
  return (a * b) % d > 0n ? r + 1n : r
}
export const divUp = (a: bigint, b: bigint) => a / b + (a % b > 0n ? 1n : 0n)

/** OpenZeppelin Math.sqrt: the floor of the square root. */
export function isqrt(n: bigint): bigint {
  if (n < 2n) return n
  let x = n
  let y = (x + 1n) / 2n
  while (y < x) {
    x = y
    y = (x + n / x) / 2n
  }
  return x
}

// ── TickMath ───────────────────────────────────────────────────────────────────

const TICK_FACTORS: readonly [number, bigint][] = [
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

const sqrtCache = new Map<number, bigint>()
/** TickMath.getSqrtPriceAtTick. */
export function sqrtAtTick(tick: number): bigint {
  const hit = sqrtCache.get(tick)
  if (hit !== undefined) return hit
  const absTick = Math.abs(tick)
  if (!Number.isInteger(tick) || absTick > MAX_TICK) throw new Error(`sqrtAtTick: invalid tick ${tick}`)
  let price = absTick & 0x1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n
  for (const [bit, factor] of TICK_FACTORS) if (absTick & bit) price = (price * factor) >> 128n
  if (tick > 0) price = MAX_U256 / price
  const sqrtPrice = (price + (1n << 32n) - 1n) >> 32n
  sqrtCache.set(tick, sqrtPrice)
  return sqrtPrice
}

/** TickMath.getTickAtSqrtPrice: the greatest tick whose sqrt price is at or below `sqrtPrice`. Found by bisection over
 *  sqrtAtTick instead of the log2 bit-twiddling, which gives the same answer by definition. */
export function tickAtSqrt(sqrtPrice: bigint): number {
  if (sqrtPrice < MIN_SQRT_PRICE || sqrtPrice >= MAX_SQRT_PRICE) throw new Error(`tickAtSqrt: price ${sqrtPrice} out of range`)
  let lo = MIN_TICK
  let hi = MAX_TICK
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2)
    if (sqrtAtTick(mid) <= sqrtPrice) lo = mid
    else hi = mid - 1
  }
  return lo
}

// ── SqrtPriceMath ──────────────────────────────────────────────────────────────

export function nextFromAmount0RoundingUp(sqrtP: bigint, liquidity: bigint, amount: bigint, add: boolean): bigint {
  if (amount === 0n) return sqrtP
  const numerator1 = liquidity << 96n
  const product = amount * sqrtP
  if (add) {
    if (product < TWO_256) {
      const denominator = numerator1 + product
      if (denominator < TWO_256) return mulDivUp(numerator1, sqrtP, denominator)
    }
    return divUp(numerator1, numerator1 / sqrtP + amount)
  }
  if (product >= TWO_256 || numerator1 <= product) throw new Error('SqrtPriceMath: PriceOverflow')
  return mulDivUp(numerator1, sqrtP, numerator1 - product)
}

export function nextFromAmount1RoundingDown(sqrtP: bigint, liquidity: bigint, amount: bigint, add: boolean): bigint {
  if (add) return sqrtP + (amount << 96n) / liquidity
  const quotient = divUp(amount << 96n, liquidity)
  if (sqrtP <= quotient) throw new Error('SqrtPriceMath: NotEnoughLiquidity')
  return sqrtP - quotient
}

export function nextFromInput(sqrtP: bigint, liquidity: bigint, amountIn: bigint, zeroForOne: boolean): bigint {
  if (sqrtP === 0n || liquidity === 0n) throw new Error('SqrtPriceMath: InvalidPriceOrLiquidity')
  return zeroForOne ? nextFromAmount0RoundingUp(sqrtP, liquidity, amountIn, true) : nextFromAmount1RoundingDown(sqrtP, liquidity, amountIn, true)
}

export function nextFromOutput(sqrtP: bigint, liquidity: bigint, amountOut: bigint, zeroForOne: boolean): bigint {
  if (sqrtP === 0n || liquidity === 0n) throw new Error('SqrtPriceMath: InvalidPriceOrLiquidity')
  return zeroForOne ? nextFromAmount1RoundingDown(sqrtP, liquidity, amountOut, false) : nextFromAmount0RoundingUp(sqrtP, liquidity, amountOut, false)
}

export function amount0Delta(a: bigint, b: bigint, liquidity: bigint, roundUp: boolean): bigint {
  if (a > b) [a, b] = [b, a]
  if (a === 0n) throw new Error('SqrtPriceMath: InvalidPrice')
  const numerator1 = liquidity << 96n
  const numerator2 = b - a
  return roundUp ? divUp(mulDivUp(numerator1, numerator2, b), a) : mulDiv(numerator1, numerator2, b) / a
}

export function amount1Delta(a: bigint, b: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const diff = a > b ? a - b : b - a
  return roundUp ? mulDivUp(liquidity, diff, Q96) : mulDiv(liquidity, diff, Q96)
}

// ── LiquidityAmounts (v4-periphery) ────────────────────────────────────────────

export function liquidityForAmount0(a: bigint, b: bigint, amount0: bigint): bigint {
  if (a > b) [a, b] = [b, a]
  return mulDiv(amount0, mulDiv(a, b, Q96), b - a)
}
export function liquidityForAmount1(a: bigint, b: bigint, amount1: bigint): bigint {
  if (a > b) [a, b] = [b, a]
  return mulDiv(amount1, Q96, b - a)
}
export function liquidityForAmounts(sqrtP: bigint, a: bigint, b: bigint, amount0: bigint, amount1: bigint): bigint {
  if (a > b) [a, b] = [b, a]
  if (sqrtP <= a) return liquidityForAmount0(a, b, amount0)
  if (sqrtP < b) {
    const l0 = liquidityForAmount0(sqrtP, b, amount0)
    const l1 = liquidityForAmount1(a, sqrtP, amount1)
    return l0 < l1 ? l0 : l1
  }
  return liquidityForAmount1(a, b, amount1)
}

// ── Pool state ─────────────────────────────────────────────────────────────────

/** One tick's liquidity: gross (every position using it; > 0 means initialized in the bitmap) and net (added when the
 *  price crosses it upwards, subtracted downwards). */
export interface TickState {
  gross: bigint
  net: bigint
}

/** What the model knows about one pool: its price, its active liquidity and every initialized tick. */
export interface PoolModel {
  sqrtPrice: bigint
  tick: number
  liquidity: bigint
  spacing: number
  ticks: Map<number, TickState>
}

export const clonePool = (p: PoolModel): PoolModel => ({
  ...p,
  ticks: new Map([...p.ticks].map(([t, s]) => [t, { ...s }])),
})

/** The ticks a pool's bitmap marks as initialized. */
export const initializedTicks = (p: PoolModel) => [...p.ticks].filter(([, s]) => s.gross > 0n).map(([t]) => t).sort((a, b) => a - b)

/** The currency deltas a position's liquidity change asks for (Pool.modifyLiquidity), from the caller's side:
 *  negative is owed to the pool. Also applies the change to the model (ticks and, in range, active liquidity). */
export function modifyLiquidity(p: PoolModel, lower: number, upper: number, liquidityDelta: bigint): { amount0: bigint; amount1: bigint } {
  if (liquidityDelta === 0n) return { amount0: 0n, amount1: 0n }
  const signed = (a: bigint, b: bigint, which: 0 | 1) => {
    const f = which === 0 ? amount0Delta : amount1Delta
    return liquidityDelta < 0n ? f(a, b, -liquidityDelta, false) : -f(a, b, liquidityDelta, true)
  }
  let amount0 = 0n
  let amount1 = 0n
  if (p.tick < lower) {
    amount0 = signed(sqrtAtTick(lower), sqrtAtTick(upper), 0)
  } else if (p.tick < upper) {
    amount0 = signed(p.sqrtPrice, sqrtAtTick(upper), 0)
    amount1 = signed(sqrtAtTick(lower), p.sqrtPrice, 1)
    p.liquidity += liquidityDelta
  } else {
    amount1 = signed(sqrtAtTick(lower), sqrtAtTick(upper), 1)
  }
  const bump = (tick: number, netDelta: bigint) => {
    const s = p.ticks.get(tick) ?? { gross: 0n, net: 0n }
    p.ticks.set(tick, { gross: s.gross + liquidityDelta, net: s.net + netDelta })
  }
  bump(lower, liquidityDelta)
  bump(upper, -liquidityDelta)
  return { amount0, amount1 }
}

// ── TickBitmap.nextInitializedTickWithinOneWord ────────────────────────────────

function compress(tick: number, spacing: number): number {
  let c = Math.trunc(tick / spacing)
  if (tick < 0 && tick % spacing !== 0) c -= 1
  return c
}

/** The next initialized tick within the current 256-tick word, or the word's edge (not initialized). `initialized` is
 *  the set of ticks with liquidity on them (liquidityGross > 0), which is what the pool's bitmap marks. */
export function nextInitializedTickWithinOneWord(tick: number, spacing: number, lte: boolean, initialized: readonly number[]): [number, boolean] {
  let compressed = compress(tick, spacing)
  if (lte) {
    const wordStart = (compressed >> 8) * 256
    let best: number | undefined
    for (const t of initialized) {
      const c = t / spacing
      if (c <= compressed && c >= wordStart && (best === undefined || c > best)) best = c
    }
    return best !== undefined ? [best * spacing, true] : [wordStart * spacing, false]
  }
  compressed += 1
  const wordEnd = (compressed >> 8) * 256 + 255
  let best: number | undefined
  for (const t of initialized) {
    const c = t / spacing
    if (c >= compressed && c <= wordEnd && (best === undefined || c < best)) best = c
  }
  return best !== undefined ? [best * spacing, true] : [wordEnd * spacing, false]
}

// ── SwapMath and Pool.swap ─────────────────────────────────────────────────────

/** SwapMath.computeSwapStep with a zero fee (the v1.4 pools' LP fee; no protocol fee). amountRemaining < 0 is exact in. */
export function computeSwapStep(current: bigint, target: bigint, liquidity: bigint, amountRemaining: bigint) {
  const zeroForOne = current >= target
  let next: bigint
  let amountIn: bigint
  let amountOut: bigint
  if (amountRemaining < 0n) {
    const remaining = -amountRemaining
    amountIn = zeroForOne ? amount0Delta(target, current, liquidity, true) : amount1Delta(current, target, liquidity, true)
    if (remaining >= amountIn) {
      next = target
    } else {
      amountIn = remaining
      next = nextFromInput(current, liquidity, remaining, zeroForOne)
    }
    amountOut = zeroForOne ? amount1Delta(next, current, liquidity, false) : amount0Delta(current, next, liquidity, false)
  } else {
    amountOut = zeroForOne ? amount1Delta(target, current, liquidity, false) : amount0Delta(current, target, liquidity, false)
    if (amountRemaining >= amountOut) {
      next = target
    } else {
      amountOut = amountRemaining
      next = nextFromOutput(current, liquidity, amountOut, zeroForOne)
    }
    amountIn = zeroForOne ? amount0Delta(next, current, liquidity, true) : amount1Delta(current, next, liquidity, true)
  }
  return { next, amountIn, amountOut }
}

export interface SwapResult {
  /** The pool's own swap delta (the PoolManager's Swap event), from the swapper's side: negative is paid in. */
  amount0: bigint
  amount1: bigint
  sqrtPrice: bigint
  tick: number
  liquidity: bigint
  /** initialized ticks crossed */
  crossed: number[]
  steps: number
}

/** Pool.swap with a zero fee, applied to `p` (which is updated). amountSpecified < 0 is exact in, > 0 exact out, as in
 *  v4. Throws where Pool.swap would revert. */
export function swap(p: PoolModel, zeroForOne: boolean, amountSpecified: bigint, sqrtPriceLimit: bigint): SwapResult {
  if (amountSpecified === 0n) throw new Error('swap: SwapAmountCannotBeZero')
  if (zeroForOne) {
    if (sqrtPriceLimit >= p.sqrtPrice) throw new Error('swap: PriceLimitAlreadyExceeded')
    if (sqrtPriceLimit <= MIN_SQRT_PRICE) throw new Error('swap: PriceLimitOutOfBounds')
  } else {
    if (sqrtPriceLimit <= p.sqrtPrice) throw new Error('swap: PriceLimitAlreadyExceeded')
    if (sqrtPriceLimit >= MAX_SQRT_PRICE) throw new Error('swap: PriceLimitOutOfBounds')
  }
  const initialized = initializedTicks(p)
  let remaining = amountSpecified
  let calculated = 0n
  const crossed: number[] = []
  let steps = 0
  while (!(remaining === 0n || p.sqrtPrice === sqrtPriceLimit)) {
    steps++
    const start = p.sqrtPrice
    let [tickNext, isInit] = nextInitializedTickWithinOneWord(p.tick, p.spacing, zeroForOne, initialized)
    if (tickNext <= MIN_TICK) tickNext = MIN_TICK
    if (tickNext >= MAX_TICK) tickNext = MAX_TICK
    const sqrtNext = sqrtAtTick(tickNext)
    const target = zeroForOne ? (sqrtNext < sqrtPriceLimit ? sqrtPriceLimit : sqrtNext) : sqrtNext > sqrtPriceLimit ? sqrtPriceLimit : sqrtNext
    const s = computeSwapStep(p.sqrtPrice, target, p.liquidity, remaining)
    p.sqrtPrice = s.next
    if (amountSpecified > 0n) {
      remaining -= s.amountOut
      calculated -= s.amountIn
    } else {
      remaining += s.amountIn
      calculated += s.amountOut
    }
    if (p.sqrtPrice === sqrtNext) {
      if (isInit) {
        let net = p.ticks.get(tickNext)?.net ?? 0n
        if (zeroForOne) net = -net
        p.liquidity += net
        if (p.liquidity < 0n) throw new Error('swap: liquidity underflow')
        crossed.push(tickNext)
      }
      p.tick = zeroForOne ? tickNext - 1 : tickNext
    } else if (p.sqrtPrice !== start) {
      p.tick = tickAtSqrt(p.sqrtPrice)
    }
    if (steps > 10_000) throw new Error('swap: runaway loop')
  }
  const specified = amountSpecified - remaining
  const [amount0, amount1] = zeroForOne !== amountSpecified < 0n ? [calculated, specified] : [specified, calculated]
  return { amount0, amount1, sqrtPrice: p.sqrtPrice, tick: p.tick, liquidity: p.liquidity, crossed, steps }
}
