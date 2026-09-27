/**
 * The launchpad v1.3 bonding curve and launch-pool quotes, mirrored from the contracts so every quote is
 * computed locally (the way lib/amm.ts mirrors the core router): `ArchitexLaunchpad._calcBuy` / `_calcSell` /
 * `_sellQuote` and `LaunchRouter._quoteBuy` / `_quoteSell`. Same integer maths, same rounding, same refusals,
 * in bigint: a quote here equals `quoteBuy` / `quoteSell` on-chain to the last unit. The reference vectors in
 * `__tests__/fixtures/v13-vectors.json` come from the Solidity itself.
 *
 * Launchpad v1.4's curves are the same curves, with one more fee on a buy in a token's first blocks: the snipe fee
 * (lib/launchV14.ts), which `quoteBuy` takes as a third rate, 0 for v1.3 and after the window. With it at 0 the maths
 * is v1.3's exactly; `__tests__/fixtures/v14-vectors.json` holds the v1.4 launchpad's own quotes with it.
 *
 * Two fees on every trade, both in USDC and both rounded up (never in the trader's favour): the 0.5% platform
 * fee and the token's creator fee (0–10%, locked at launch). A buy pays them out of the USDC in; a sell out of
 * the USDC out.
 */
const E18 = 10n ** 18n
const BPS = 10_000n

export const CURVE = {
  TOTAL_SUPPLY: 1_000_000_000n * E18,
  CURVE_SUPPLY: 800_000_000n * E18,
  POOL_SUPPLY: 200_000_000n * E18,
  VIRTUAL_TOKENS_0: 1_066_666_667n * E18,
  // A curve raises 3x this: 25,000 USDC, the USDC side of the pool that opens at graduation.
  VIRTUAL_USDC_0: 8_333_333_333n,
  /** The platform fee, on every curve and launch-pool trade. */
  FEE_BPS: 50n,
  /** The highest creator fee a token can launch with (10%). */
  MAX_CREATOR_FEE_BPS: 1_000n,
} as const

export type CurveError = 'ZeroAmount' | 'CurveGraduated' | 'ExceedsSold' | 'CreatorFeeTooHigh'

export interface CurveState {
  virtualUsdc: bigint // 6 decimals
  virtualTokens: bigint // 18 decimals
  tokensSold: bigint // 18 decimals
}

export const INITIAL_CURVE: CurveState = { virtualUsdc: CURVE.VIRTUAL_USDC_0, virtualTokens: CURVE.VIRTUAL_TOKENS_0, tokensSold: 0n }

export interface BuyQuote {
  tokensOut: bigint
  platformFee: bigint
  creatorFee: bigint
  /** v1.4's anti-sniping fee, held for the token's pool; 0 outside its window and on v1.3. */
  snipeFee: bigint
  /** Gross USDC pulled, every fee included; less than the offer only on the buy that sells out the curve. */
  usdcSpent: bigint
  graduates: boolean
  next: CurveState
}

export interface SellQuote {
  /** What the seller receives, after both fees. */
  usdcOut: bigint
  platformFee: bigint
  creatorFee: bigint
  /** USDC leaving the curve; the fees come out of it. */
  gross: bigint
  next: CurveState
}

/** A launch pool's reserves, as `LaunchPair.getReserves()` orders them (token side first). */
export interface PoolReserves {
  reserveToken: bigint // 18 decimals
  reserveUsdc: bigint // 6 decimals
}

export interface PoolBuyQuote {
  tokensOut: bigint
  platformFee: bigint
  creatorFee: bigint
  /** The gross USDC the router pulls: the offer, all of it. */
  usdcIn: bigint
  next: PoolReserves
}

export interface PoolSellQuote {
  usdcOut: bigint
  platformFee: bigint
  creatorFee: bigint
  gross: bigint
  next: PoolReserves
}

function fail(reason: CurveError): never {
  throw new Error(reason)
}

/** ceil(a / b) for a >= 0, b > 0 (the launchpad's `(a + b - 1) / b`; the router's form agrees for every a >= 0). */
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b
}

function feeBps(creatorFeeBps: number | bigint): bigint {
  const bps = BigInt(creatorFeeBps)
  if (bps < 0n || bps > CURVE.MAX_CREATOR_FEE_BPS) fail('CreatorFeeTooHigh')
  return bps
}

/** Both fees on a gross USDC amount, each rounded up on its own, as the contracts charge them. */
export function tradeFees(gross: bigint, creatorFeeBps: number | bigint): { platformFee: bigint; creatorFee: bigint } {
  const bps = feeBps(creatorFeeBps)
  return { platformFee: ceilDiv(gross * CURVE.FEE_BPS, BPS), creatorFee: ceilDiv(gross * bps, BPS) }
}

/**
 * The sell-out buy's fee split: `totalFee` is whatever the buy pulled beyond the curve's own price for the last
 * tokens. The platform takes ceil(totalFee·50/(50+c)), the creator the rest.
 */
export function splitSellOutFee(totalFee: bigint, creatorFeeBps: number | bigint): { platformFee: bigint; creatorFee: bigint } {
  const bps = feeBps(creatorFeeBps)
  const platformFee = ceilDiv(totalFee * CURVE.FEE_BPS, CURVE.FEE_BPS + bps)
  return { platformFee, creatorFee: totalFee - platformFee }
}

/**
 * `ArchitexLaunchpad.quoteBuy` / `_calcBuy`, v1.3's and v1.4's: `snipeFeeBps` is v1.4's anti-sniping rate for the block
 * the buy is quoted in (lib/launchV14.ts snipeBps), 0 otherwise. Throws the contract's error name where it reverts.
 */
export function quoteBuy(state: CurveState, usdcIn: bigint, creatorFeeBps: number | bigint, snipeFeeBps: number | bigint = 0): BuyQuote {
  const bps = feeBps(creatorFeeBps)
  const snipeBps = BigInt(snipeFeeBps)
  const remaining = CURVE.CURVE_SUPPLY - state.tokensSold
  if (remaining <= 0n) fail('CurveGraduated')
  if (usdcIn <= 0n) fail('ZeroAmount')
  const k = state.virtualUsdc * state.virtualTokens

  let { platformFee, creatorFee } = tradeFees(usdcIn, bps)
  let snipeFee = ceilDiv(usdcIn * snipeBps, BPS)
  // Fees that eat the whole input buy nothing.
  if (platformFee + creatorFee + snipeFee >= usdcIn) fail('ZeroAmount')
  let net = usdcIn - platformFee - creatorFee - snipeFee
  let tokensOut = state.virtualTokens - ceilDiv(k, state.virtualUsdc + net)
  if (tokensOut === 0n) fail('ZeroAmount')

  let usdcSpent = usdcIn
  let graduates = false
  if (tokensOut >= remaining) {
    // The buy that sells out the curve fills exactly the remainder and pays only for it, never more than
    // offered; the fees are whatever it pulls beyond the remainder's price.
    const allFees = CURVE.FEE_BPS + bps + snipeBps
    net = ceilDiv(k, state.virtualTokens - remaining) - state.virtualUsdc
    const gross = net + ceilDiv(net * allFees, BPS - allFees)
    usdcSpent = gross < usdcIn ? gross : usdcIn
    const totalFee = usdcSpent - net
    if (snipeBps === 0n) {
      ;({ platformFee, creatorFee } = splitSellOutFee(totalFee, bps))
      snipeFee = 0n
    } else {
      // v1.4's split of three: the platform's share rounded up, then the creator's (capped at what is left), then
      // the snipe fee takes the rest. With no snipe fee it is splitSellOutFee's, unit for unit.
      platformFee = ceilDiv(totalFee * CURVE.FEE_BPS, allFees)
      const creatorShare = ceilDiv(totalFee * bps, allFees)
      creatorFee = creatorShare < totalFee - platformFee ? creatorShare : totalFee - platformFee
      snipeFee = totalFee - platformFee - creatorFee
    }
    tokensOut = remaining
    graduates = true
  }

  return {
    tokensOut,
    platformFee,
    creatorFee,
    snipeFee,
    usdcSpent,
    graduates,
    next: {
      virtualUsdc: state.virtualUsdc + (usdcSpent - platformFee - creatorFee - snipeFee),
      virtualTokens: state.virtualTokens - tokensOut,
      tokensSold: state.tokensSold + tokensOut,
    },
  }
}

/** `ArchitexLaunchpad.quoteSell` / `_sellQuote`. Throws the contract's error name where the contract reverts. */
export function quoteSell(state: CurveState, tokensIn: bigint, creatorFeeBps: number | bigint): SellQuote {
  const bps = feeBps(creatorFeeBps)
  if (state.tokensSold >= CURVE.CURVE_SUPPLY) fail('CurveGraduated')
  if (tokensIn <= 0n) fail('ZeroAmount')
  if (tokensIn > state.tokensSold) fail('ExceedsSold')
  const k = state.virtualUsdc * state.virtualTokens
  const gross = state.virtualUsdc - ceilDiv(k, state.virtualTokens + tokensIn)
  const { platformFee, creatorFee } = tradeFees(gross, bps)
  if (platformFee + creatorFee >= gross) fail('ZeroAmount')
  return {
    usdcOut: gross - platformFee - creatorFee,
    platformFee,
    creatorFee,
    gross,
    next: { virtualUsdc: state.virtualUsdc - gross, virtualTokens: state.virtualTokens + tokensIn, tokensSold: state.tokensSold - tokensIn },
  }
}

/**
 * `LaunchRouter.quoteBuy`: exact-in, constant product, no LP fee. Both fees come off the USDC in, rounded up;
 * the pool pays floor(net · reserveToken / (reserveUsdc + net)).
 */
export function quotePoolBuy(reserves: PoolReserves, usdcIn: bigint, creatorFeeBps: number | bigint): PoolBuyQuote {
  const bps = feeBps(creatorFeeBps)
  if (usdcIn <= 0n) fail('ZeroAmount')
  const { platformFee, creatorFee } = tradeFees(usdcIn, bps)
  if (platformFee + creatorFee >= usdcIn) fail('ZeroAmount')
  const net = usdcIn - platformFee - creatorFee
  const tokensOut = (net * reserves.reserveToken) / (reserves.reserveUsdc + net)
  if (tokensOut === 0n) fail('ZeroAmount')
  return {
    tokensOut,
    platformFee,
    creatorFee,
    usdcIn,
    next: { reserveToken: reserves.reserveToken - tokensOut, reserveUsdc: reserves.reserveUsdc + net },
  }
}

/**
 * `LaunchRouter.quoteSell`: the pool pays floor(tokensIn · reserveUsdc / (reserveToken + tokensIn)) gross, and both
 * fees come off that gross, rounded up.
 */
export function quotePoolSell(reserves: PoolReserves, tokensIn: bigint, creatorFeeBps: number | bigint): PoolSellQuote {
  const bps = feeBps(creatorFeeBps)
  if (tokensIn <= 0n) fail('ZeroAmount')
  const gross = (tokensIn * reserves.reserveUsdc) / (reserves.reserveToken + tokensIn)
  const { platformFee, creatorFee } = tradeFees(gross, bps)
  if (platformFee + creatorFee >= gross) fail('ZeroAmount')
  return {
    usdcOut: gross - platformFee - creatorFee,
    platformFee,
    creatorFee,
    gross,
    next: { reserveToken: reserves.reserveToken + tokensIn, reserveUsdc: reserves.reserveUsdc - gross },
  }
}

/** USDC (6 decimals) per whole token, scaled by 1e18. */
export function spotPrice(state: Pick<CurveState, 'virtualUsdc' | 'virtualTokens'>): bigint {
  return (state.virtualUsdc * E18 * E18) / state.virtualTokens
}

/** Spot price times the 800M curve supply, in USDC (6 decimals): the figure graduation is quoted in. */
export function marketCap(state: Pick<CurveState, 'virtualUsdc' | 'virtualTokens'>): bigint {
  return (state.virtualUsdc * CURVE.CURVE_SUPPLY) / state.virtualTokens
}

export function progressBps(state: Pick<CurveState, 'tokensSold'>): bigint {
  return (state.tokensSold * BPS) / CURVE.CURVE_SUPPLY
}

/** USDC this curve holds for sellers: every sold token can always be sold back. */
export function realUsdc(state: Pick<CurveState, 'virtualUsdc'>): bigint {
  return state.virtualUsdc - CURVE.VIRTUAL_USDC_0
}

/** A launch pool's price, in the same units as `spotPrice`; 0 for an empty pool. */
export function poolSpotPrice(reserves: PoolReserves): bigint {
  return reserves.reserveToken === 0n ? 0n : (reserves.reserveUsdc * E18 * E18) / reserves.reserveToken
}

/**
 * A graduated token's market cap on the curve's definition (price times the 800M curve supply), from its pool, so
 * the figure carries on from graduation's $100,000 without a jump. 0 for an empty pool.
 */
export function poolMarketCap(reserves: PoolReserves): bigint {
  return reserves.reserveToken === 0n ? 0n : (reserves.reserveUsdc * CURVE.CURVE_SUPPLY) / reserves.reserveToken
}

/** How far a trade moves the price, in bps of the price before it. */
export function priceMoveBps(before: bigint, after: bigint): bigint {
  if (before === 0n) return 0n
  const delta = after > before ? after - before : before - after
  return (delta * BPS) / before
}
