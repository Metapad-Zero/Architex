/**
 * An order book for a constant-product market, derived from its reserves and fees.
 *
 * Reserves B (base) and T (target), in whole tokens; g = 1 - fee. For the constant product x * y = k:
 *
 *   buying q base costs     T * q / (g * (B - q))          (the fee comes out of what is paid in)
 *   selling y base pays     g * y * T / (B + g * y)        (core pairs: the fee comes out of the base paid in)
 *                           g * y * T / (B + y)            (launch markets: the fee comes out of the USDC paid out)
 *
 * The best ask is T / (g * B) and the best bid g * T / B: the mid price T / B with the fee on either side. Level k of
 * the book is the slice of the curve over which the marginal price moves from step^(k-1) to step^k away from the
 * best price, which works out to
 *
 *   asks: q_k = B * (1 - step^(-k/2))
 *   bids: y_k = B * (step^(k/2) - 1) / g   (core)        y_k = B * (step^(k/2) - 1)   (launch)
 *
 * Each level's quantity is its slice of base and its price is the slice's average price, so taking the first n
 * levels costs (or pays) exactly what one trade of their total size would in the pool, fees included. A bonding
 * curve is the same formula on its virtual reserves, cut off where it runs out: it can sell at most the tokens it
 * has left and buy back at most the tokens it has sold.
 */
export interface DepthMarket {
  /** Whole base tokens in reserve (virtual, for a curve). */
  base: number
  /** Whole target tokens in reserve (virtual, for a curve). */
  target: number
  /** Every fee on a trade, as a fraction: 0.003 for 0.30%. */
  fee: number
  /** 'input': the fee comes out of what the trader pays in. 'usdc': out of the target (USDC) side either way. */
  feeOn: 'input' | 'usdc'
  /** The most base a buyer can take (a curve's tokens left). */
  maxBuy?: number
  /** The most base a seller can put in (a curve's tokens sold). */
  maxSell?: number
}

export interface Level {
  price: number
  quantity: number
}

/** Marginal-price step between levels: 0.1%. */
export const LEVEL_STEP = 0.001

/** What buying `q` base costs in target, fees included. */
export function costToBuy(market: DepthMarket, q: number): number {
  const g = 1 - market.fee
  return (market.target * q) / (g * (market.base - q))
}

/** What selling `y` base pays in target, after fees. */
export function proceedsOfSell(market: DepthMarket, y: number): number {
  const g = 1 - market.fee
  return market.feeOn === 'input' ? (g * y * market.target) / (market.base + g * y) : (g * y * market.target) / (market.base + y)
}

export function bestAsk(market: DepthMarket): number {
  return market.target / ((1 - market.fee) * market.base)
}

export function bestBid(market: DepthMarket): number {
  return ((1 - market.fee) * market.target) / market.base
}

function tradable(market: DepthMarket): boolean {
  return market.base > 0 && market.target > 0 && market.fee >= 0 && market.fee < 1 && Number.isFinite(market.base) && Number.isFinite(market.target)
}

export function asks(market: DepthMarket, levels: number, step = LEVEL_STEP): Level[] {
  if (!tradable(market)) return []
  const cap = Math.min(market.maxBuy ?? Infinity, market.base)
  const out: Level[] = []
  let previous = 0
  for (let k = 1; k <= levels && previous < cap; k += 1) {
    const q = Math.min(market.base * (1 - (1 + step) ** (-k / 2)), cap)
    const quantity = q - previous
    if (quantity > 0) out.push({ price: (costToBuy(market, q) - costToBuy(market, previous)) / quantity, quantity })
    previous = q
  }
  return out
}

export function bids(market: DepthMarket, levels: number, step = LEVEL_STEP): Level[] {
  if (!tradable(market)) return []
  const g = 1 - market.fee
  const cap = market.maxSell ?? Infinity
  const out: Level[] = []
  let previous = 0
  for (let k = 1; k <= levels && previous < cap; k += 1) {
    const span = market.base * ((1 + step) ** (k / 2) - 1)
    const y = Math.min(market.feeOn === 'input' ? span / g : span, cap)
    const quantity = y - previous
    if (quantity > 0) out.push({ price: (proceedsOfSell(market, y) - proceedsOfSell(market, previous)) / quantity, quantity })
    previous = y
  }
  return out
}
