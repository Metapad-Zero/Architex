import {
  BPS_DENOMINATOR,
  FEE_DENOMINATOR,
  FEE_NUMERATOR,
  findBestRoute,
  priceImpactBps,
  reservesFor,
  sqrt,
  type RouteQuote,
} from './amm'
import { CURVE } from './curve'
import { formatAmount } from './format'
import type { LaunchRecord, TradeVenue } from './launch'
import type { LaunchQuote, LaunchSide } from './launchQuote'

/**
 * The price-impact guard: one policy for every sheet that trades against a pool or a curve (Swap, and a launch's
 * curve and launch pool). A sheet hands it the impact it shows, in bps, and follows the verdict. The thresholds are
 * set here and nowhere else; each bound belongs to the tier above it (exactly 5.00% is high).
 *
 *   impact        tier          what the sheet does
 *   under 1%      normal        shows the impact as it is
 *   1% to 5%      caution       sets the impact in semibold ink, not red, and on Swap adds the pool share
 *   5% to 15%     high          sets it in Loss Red with "High price impact", names the action "Swap anyway" (or
 *                               "Buy anyway", "Sell anyway"), and names the largest trade that stays under 1% here
 *   15% to 50%    acknowledge   as high, and neither Approve nor the trade can be pressed until the trader ticks
 *                               "I accept losing about $83 to a 41% price impact"; the tick lapses as soon as the
 *                               amount, the tokens, the route or that sentence changes
 *   50% and up    refused       the button reads "Price impact too high" and stays disabled: nothing is approved
 *                               and nothing is sent, whatever the wallet's state
 *
 * The impact row also says what the impact costs in dollars ("41.45% (about $83)"), from the price before the trade.
 */
export const IMPACT_CAUTION_BPS = 100n
export const IMPACT_HIGH_BPS = 500n
export const IMPACT_ACKNOWLEDGE_BPS = 1_500n
export const IMPACT_REFUSE_BPS = 5_000n
/** The size hint names the largest trade whose impact stays under this. */
export const IMPACT_HINT_TARGET_BPS = 100n

export type ImpactTier = 'normal' | 'caution' | 'high' | 'acknowledge' | 'refused'

export function impactTier(bps: bigint): ImpactTier {
  if (bps >= IMPACT_REFUSE_BPS) return 'refused'
  if (bps >= IMPACT_ACKNOWLEDGE_BPS) return 'acknowledge'
  if (bps >= IMPACT_HIGH_BPS) return 'high'
  if (bps >= IMPACT_CAUTION_BPS) return 'caution'
  return 'normal'
}

/** 5% and up: Loss Red, "High price impact", "Swap anyway", and the size hint. */
export function isHighImpact(bps: bigint): boolean {
  return bps >= IMPACT_HIGH_BPS
}

/**
 * Whether a trade at this impact may be approved or sent now: never once refused, and past the acknowledgment line
 * only while the trader's tick holds. Connecting a wallet or switching network moves no money and is not asked about.
 */
export function impactAllows(bps: bigint, acknowledged: boolean): boolean {
  const tier = impactTier(bps)
  if (tier === 'refused') return false
  if (tier === 'acknowledge') return acknowledged
  return true
}

/**
 * What an acknowledgment is given for: the trade (its tokens or side, the typed amount, the route) and the sentence
 * the trader read. A tick is kept against this key, so it holds only while every part is unchanged.
 */
export function acknowledgmentKey(trade: readonly (string | bigint | undefined)[], sentence: string): string {
  return [...trade.map((part) => String(part ?? '')), sentence].join('|')
}

/**
 * What price impact costs a Swap, in USD (6 decimals): the value the trade would have received at the pools' prices
 * before it, less what it receives, with the 0.30% fee left out (it has its own receipt line). With `inputUsd` the pay
 * side's value (the figure under "You pay") that is inputUsd x 0.997 per hop x impact: 200 USDC at 41.45% through one
 * pool costs about $82.65.
 */
export function swapImpactLossUsd(inputUsd: bigint, impactBps: bigint, hops: number): bigint {
  if (inputUsd <= 0n || impactBps <= 0n) return 0n
  let traded = inputUsd
  for (let hop = 0; hop < hops; hop += 1) traded = (traded * FEE_NUMERATOR) / FEE_DENOMINATOR
  return (traded * impactBps) / BPS_DENOMINATOR
}

/** The same cost measured from the receive side, for a pay token with no USD price: received x impact / (1 - impact). */
export function swapImpactLossUsdFromOutput(outputUsd: bigint, impactBps: bigint): bigint {
  if (outputUsd <= 0n || impactBps <= 0n || impactBps >= BPS_DENOMINATOR) return 0n
  return (outputUsd * impactBps) / (BPS_DENOMINATOR - impactBps)
}

/** The reserves a launch trade is priced against: the curve's virtual reserves, or the launch pool's after graduation. */
function launchReserves(launch: LaunchRecord, venue: TradeVenue): { usdc: bigint; tokens: bigint } | undefined {
  if (venue === 'pool') return launch.pool ? { usdc: launch.pool.reserveUsdc, tokens: launch.pool.reserveToken } : undefined
  return { usdc: launch.virtualUsdc, tokens: launch.virtualTokens }
}

/**
 * What price impact costs a launch trade, in USD (USDC, 6 decimals): the tokens valued at the curve's or the pool's
 * price before the trade, against the USDC that went into it or came out of it. Both fees are left out (they have
 * their own receipt lines), so a buy is measured on the USDC after them and a sell on the USDC before them.
 *
 * On a launch sheet "price impact" is how far the trade moves the price, which runs ahead of this cost: a buy that
 * moves the curve's price 21% costs about 9% of the USDC that goes in.
 */
export function launchImpactLossUsd(launch: LaunchRecord, side: LaunchSide, quote: LaunchQuote): bigint {
  const reserves = launchReserves(launch, quote.venue)
  if (!reserves || reserves.tokens <= 0n) return 0n
  const fees = quote.platformFee + quote.creatorFee
  const usdc = side === 'buy' ? quote.amountIn - fees : quote.amountOut + fees
  const tokens = side === 'buy' ? quote.amountOut : quote.amountIn
  const atPriceBefore = (tokens * reserves.usdc) / reserves.tokens
  const loss = side === 'buy' ? usdc - atPriceBefore : atPriceBefore - usdc
  return loss > 0n ? loss : 0n
}

/**
 * The largest input to one constant-product pool whose impact stays under `targetBps`, straight from its reserve.
 * With the 0.30% fee (f = 0.997) an input a into reserve R has impact a·f / (R + a·f), which stays under t while
 * a < t·R / (f·(1 - t)). The mainnet USDC/EURC pool holds 281.64 USDC: under 1% means 2.853 USDC or less.
 */
export function maxSingleHopInput(reserveIn: bigint, targetBps: bigint = IMPACT_HINT_TARGET_BPS): bigint {
  if (reserveIn <= 0n || targetBps <= 0n || targetBps >= BPS_DENOMINATOR) return 0n
  const numerator = reserveIn * targetBps * FEE_DENOMINATOR
  const denominator = FEE_NUMERATOR * (BPS_DENOMINATOR - targetBps)
  // Strictly under: when the bound divides exactly, the bound itself is the target, not under it.
  return (numerator - 1n) / denominator
}

/** Enough halvings to settle any uint256 amount to the unit; the search never runs longer than this. */
const SEARCH_STEPS = 256

/**
 * The largest input to this route (its path, its pools) whose impact stays under `targetBps`. One pool has the closed
 * form above. A route through USDC has none, so this searches the route's own quote (`findBestRoute` over just the
 * route's pools, which can only take that path): it doubles until the impact reaches the target, then halves the gap,
 * each at most 256 times.
 */
export function maxRouteInput(route: RouteQuote, targetBps: bigint = IMPACT_HINT_TARGET_BPS): bigint {
  const first = route.pairs[0]
  if (!first || targetBps <= 0n) return 0n
  if (route.pairs.length === 1) return maxSingleHopInput(reservesFor(first, route.path[0])[0], targetBps)
  const tokenIn = route.path[0]
  const tokenOut = route.path[route.path.length - 1]
  const via = route.path[1]
  // An amount too small to buy anything moves nothing: it counts as under the target.
  const under = (amount: bigint) => {
    const quote = findBestRoute('exactIn', amount, tokenIn, tokenOut, via, route.pairs)
    return !quote || priceImpactBps(quote) < targetBps
  }
  let low = 0n
  let high = route.amountIn > 0n ? route.amountIn : 1n
  for (let step = 0; step < SEARCH_STEPS && under(high); step += 1) {
    low = high
    high *= 2n
  }
  for (let step = 0; step < SEARCH_STEPS && high - low > 1n; step += 1) {
    const middle = (low + high) / 2n
    if (under(middle)) low = middle
    else high = middle
  }
  return low
}

const ROOT_SCALE = 10n ** 18n

/**
 * A launch buy's largest offer (gross USDC) whose price move stays under `targetBps`, on the curve or in the launch
 * pool. Both are constant products: n USDC in after fees moves the price by (1 + n/U)² - 1, where U is the USDC side,
 * which stays under t while n < U·(√(1 + t) - 1); the platform and creator fees come off the offer first.
 */
export function maxLaunchBuy(usdcReserve: bigint, creatorFeeBps: number, targetBps: bigint = IMPACT_HINT_TARGET_BPS): bigint {
  if (usdcReserve <= 0n || targetBps <= 0n) return 0n
  const root = sqrt(((BPS_DENOMINATOR + targetBps) * ROOT_SCALE * ROOT_SCALE) / BPS_DENOMINATOR)
  const net = (usdcReserve * (root - ROOT_SCALE)) / ROOT_SCALE
  const kept = BPS_DENOMINATOR - CURVE.FEE_BPS - BigInt(creatorFeeBps)
  return kept > 0n ? (net * BPS_DENOMINATOR) / kept : 0n
}

/**
 * A launch sell's largest amount of tokens whose price move stays under `targetBps`: x tokens into a token side T move
 * the price by 1 - (T / (T + x))², which stays under t while x < T·(1/√(1 - t) - 1). The fees come off the USDC out,
 * after the move.
 */
export function maxLaunchSell(tokenReserve: bigint, targetBps: bigint = IMPACT_HINT_TARGET_BPS): bigint {
  if (tokenReserve <= 0n || targetBps <= 0n || targetBps >= BPS_DENOMINATOR) return 0n
  const root = sqrt(((BPS_DENOMINATOR - targetBps) * ROOT_SCALE * ROOT_SCALE) / BPS_DENOMINATOR)
  if (root === 0n) return 0n
  const growth = (ROOT_SCALE * ROOT_SCALE) / root
  return (tokenReserve * (growth - ROOT_SCALE)) / ROOT_SCALE
}

/** The largest buy (USDC) or sell (tokens) of this launch whose price move stays under `targetBps`, where it trades now. */
export function maxLaunchTrade(launch: LaunchRecord, side: LaunchSide, targetBps: bigint = IMPACT_HINT_TARGET_BPS): bigint {
  const reserves = launchReserves(launch, launch.graduated ? 'pool' : 'curve')
  if (!reserves) return 0n
  return side === 'buy' ? maxLaunchBuy(reserves.usdc, launch.creatorFeeBps, targetBps) : maxLaunchSell(reserves.tokens, targetBps)
}

/** Rounds down to `digits` significant digits, so "about X or less" never names more than the limit. */
export function floorToSignificant(value: bigint, digits = 3): bigint {
  if (value <= 0n) return 0n
  const length = value.toString().length
  if (length <= digits) return value
  const unit = 10n ** BigInt(length - digits)
  return (value / unit) * unit
}

/** A whole percent, rounded half up: 4,145 bps is "41%". */
export function wholePercent(bps: bigint): string {
  return `${((bps < 0n ? 0n : bps) + 50n) / 100n}%`
}

/** "an 18%" and "an 8%", "a 41%": the article is said, not spelled. */
function withArticle(percent: string): string {
  return `${percent.startsWith('8') || percent.startsWith('11%') || percent.startsWith('18%') ? 'an' : 'a'} ${percent}`
}

/** A loss in USD (6 decimals) the way the sheet says it: "$83", "$1,204", "$4.37". Undefined under half a cent. */
export function formatLossUsd(usd: bigint): string | undefined {
  if (usd < 5_000n) return undefined
  if (usd < 9_995_000n) {
    const cents = (usd + 5_000n) / 10_000n
    return `$${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`
  }
  const dollars = (usd + 500_000n) / 1_000_000n
  return `$${dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
}

/** The sentence a trader ticks past the acknowledgment line: "I accept losing about $83 to a 41% price impact". */
export function acknowledgmentText(impactBps: bigint, lossUsd: bigint | undefined): string {
  const impact = `${withArticle(wholePercent(impactBps))} price impact`
  const loss = lossUsd === undefined ? undefined : formatLossUsd(lossUsd)
  return loss ? `I accept losing about ${loss} to ${impact}` : `I accept ${impact}`
}

/**
 * "Under 1% impact here: about 2.85 USDC or less." for the largest trade that stays under the target, rounded down to
 * three significant digits. Undefined when that would show as zero.
 */
export function impactSizeHint(maxAmount: bigint, decimals: number, symbol: string, targetBps: bigint = IMPACT_HINT_TARGET_BPS): string | undefined {
  const shown = floorToSignificant(maxAmount)
  if (shown <= 0n) return undefined
  const amount = formatAmount(shown, decimals)
  if (amount === '0' || amount.startsWith('<')) return undefined
  return `Under ${wholePercent(targetBps)} impact here: about ${amount} ${symbol} or less.`
}
