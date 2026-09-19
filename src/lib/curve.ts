/**
 * The launchpad's bonding curve, mirrored from docs/launchpad/LAUNCHPAD-SPEC.md so quotes are
 * computed locally (the way lib/amm.ts mirrors the router). Same integer math, same rounding, in
 * bigint: a quote here must equal `quoteBuy` / `quoteSell` on-chain to the last unit.
 */
const E18 = 10n ** 18n
const BPS = 10_000n

export const CURVE = {
  TOTAL_SUPPLY: 1_000_000_000n * E18,
  CURVE_SUPPLY: 800_000_000n * E18,
  POOL_SUPPLY: 200_000_000n * E18,
  VIRTUAL_TOKENS_0: 1_066_666_667n * E18,
  VIRTUAL_USDC_0: 2_916_666_667n,
  FEE_BPS: 50n,
} as const

export interface CurveState {
  virtualUsdc: bigint // 6 decimals
  virtualTokens: bigint // 18 decimals
  tokensSold: bigint // 18 decimals
}

export const INITIAL_CURVE: CurveState = { virtualUsdc: CURVE.VIRTUAL_USDC_0, virtualTokens: CURVE.VIRTUAL_TOKENS_0, tokensSold: 0n }

export interface BuyQuote {
  tokensOut: bigint
  fee: bigint
  usdcSpent: bigint // gross; less than the input only on the buy that sells out the curve
  graduates: boolean
  next: CurveState
}

export interface SellQuote {
  usdcOut: bigint // after the fee
  fee: bigint
  gross: bigint
  next: CurveState
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b
}

export function quoteBuy(state: CurveState, usdcIn: bigint): BuyQuote {
  if (usdcIn <= 0n) throw new Error('ZeroAmount')
  const remaining = CURVE.CURVE_SUPPLY - state.tokensSold
  if (remaining <= 0n) throw new Error('CurveGraduated')
  const k = state.virtualUsdc * state.virtualTokens

  // Fees round up: a floor would make every trade under 200 units of USDC free.
  let fee = ceilDiv(usdcIn * CURVE.FEE_BPS, BPS)
  let net = usdcIn - fee
  let tokensOut = state.virtualTokens - ceilDiv(k, state.virtualUsdc + net)

  if (tokensOut >= remaining) {
    // The buy that sells out the curve fills exactly the remainder and is charged only for it,
    // and never more than was offered: at the boundary the last unit comes out of the fee.
    tokensOut = remaining
    net = ceilDiv(k, state.virtualTokens - remaining) - state.virtualUsdc
    const wanted = net + ceilDiv(net * CURVE.FEE_BPS, BPS - CURVE.FEE_BPS)
    fee = (wanted < usdcIn ? wanted : usdcIn) - net
  }
  if (tokensOut === 0n) throw new Error('ZeroAmount')

  return {
    tokensOut,
    fee,
    usdcSpent: net + fee,
    graduates: tokensOut === remaining,
    next: { virtualUsdc: state.virtualUsdc + net, virtualTokens: state.virtualTokens - tokensOut, tokensSold: state.tokensSold + tokensOut },
  }
}

export function quoteSell(state: CurveState, tokensIn: bigint): SellQuote {
  if (tokensIn <= 0n) throw new Error('ZeroAmount')
  if (state.tokensSold >= CURVE.CURVE_SUPPLY) throw new Error('CurveGraduated')
  if (tokensIn > state.tokensSold) throw new Error('InsufficientSold')
  const k = state.virtualUsdc * state.virtualTokens
  const gross = state.virtualUsdc - ceilDiv(k, state.virtualTokens + tokensIn)
  const fee = ceilDiv(gross * CURVE.FEE_BPS, BPS)
  if (gross - fee === 0n) throw new Error('ZeroAmount')
  return {
    usdcOut: gross - fee,
    fee,
    gross,
    next: { virtualUsdc: state.virtualUsdc - gross, virtualTokens: state.virtualTokens + tokensIn, tokensSold: state.tokensSold - tokensIn },
  }
}

/** USDC (6 decimals) per whole token, scaled by 1e18. */
export function spotPrice(state: CurveState): bigint {
  return (state.virtualUsdc * E18 * E18) / state.virtualTokens
}

/** Spot price times the 800M curve supply, in USDC (6 decimals): the figure graduation is quoted in. */
export function marketCap(state: CurveState): bigint {
  return (state.virtualUsdc * CURVE.CURVE_SUPPLY) / state.virtualTokens
}

export function progressBps(state: CurveState): bigint {
  return (state.tokensSold * BPS) / CURVE.CURVE_SUPPLY
}

/** USDC this curve holds for sellers: every sold token can always be sold back. */
export function realUsdc(state: CurveState): bigint {
  return state.virtualUsdc - CURVE.VIRTUAL_USDC_0
}
