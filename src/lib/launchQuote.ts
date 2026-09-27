import { minReceived } from './amm'
import { quoteBuy, quotePoolBuy, quotePoolSell, quoteSell } from './curve'
import { curvePriceImpactBps, curveStateOf, launchVersion, poolPriceImpactBps, type LaunchRecord, type TradeVenue } from './launch'
import { grossOfSell, poolFeesOnGross, v4ImpactBps } from './launchV14'

export type LaunchSide = 'buy' | 'sell'

export interface LaunchQuote {
  /** The curve before graduation (the launchpad), the pool after (v1.3's launch router, or v1.4's v4 router). */
  venue: TradeVenue
  /**
   * What the trade is sent with: the USDC offered on a buy, the tokens on a sell. On the curve this is the typed
   * offer, never the quoted spend: the sell-out buy can spend one unit less than the smallest offer that sells
   * out, so offering only the spend could buy a hair less than the rest and not graduate.
   */
  offer: bigint
  /** What leaves the wallet: on the curve's sell-out buy, less than the offer. */
  amountIn: bigint
  /** Tokens on a buy; USDC after every fee on a sell. */
  amountOut: bigint
  platformFee: bigint
  creatorFee: bigint
  /** v1.4's anti-sniping fee on a buy in a token's first blocks (on the curve or in the pool); 0 otherwise. */
  snipeFee: bigint
  /** Its rate in the block the quote was made for; 0 outside the window. */
  snipeBps: number
  minReceived: bigint
  priceImpactBps: bigint
  /** This buy sells out the curve and graduates the token. */
  graduates: boolean
}

/**
 * Quotes a launch trade locally, with the same maths as the contract that will run it (lib/curve.ts): on the curve,
 * v1.3's or v1.4's, and in a v1.3 launch pool. `snipeFeeBps` is v1.4's anti-sniping rate for a curve buy in the block
 * the quote is for (lib/launchV14.ts snipeBps). A graduated v1.4 token trades in a Uniswap pool whose depth is not
 * read here: its quote comes from the router (quoteV4Trade), so this returns undefined for it.
 */
export function quoteLaunchTrade(
  launch: LaunchRecord,
  side: LaunchSide,
  offer: bigint,
  slippageBps: number,
  snipeFeeBps = 0,
): LaunchQuote | undefined {
  if (offer <= 0n) return undefined
  const fee = launch.creatorFeeBps
  try {
    if (!launch.graduated) {
      const state = curveStateOf(launch)
      if (side === 'buy') {
        const snipeBps = launchVersion(launch) === 'v14' ? snipeFeeBps : 0
        const result = quoteBuy(state, offer, fee, snipeBps)
        return {
          venue: 'curve',
          offer,
          amountIn: result.usdcSpent,
          amountOut: result.tokensOut,
          platformFee: result.platformFee,
          creatorFee: result.creatorFee,
          snipeFee: result.snipeFee,
          snipeBps: result.snipeFee > 0n ? snipeBps : 0,
          minReceived: minReceived(result.tokensOut, slippageBps),
          priceImpactBps: curvePriceImpactBps(state, result.next),
          graduates: result.graduates,
        }
      }
      const result = quoteSell(state, offer, fee)
      return {
        venue: 'curve',
        offer,
        amountIn: offer,
        amountOut: result.usdcOut,
        platformFee: result.platformFee,
        creatorFee: result.creatorFee,
        snipeFee: 0n,
        snipeBps: 0,
        minReceived: minReceived(result.usdcOut, slippageBps),
        priceImpactBps: curvePriceImpactBps(state, result.next),
        graduates: false,
      }
    }
    if (launchVersion(launch) === 'v14') return undefined
    const pool = launch.pool
    if (!pool) return undefined
    if (side === 'buy') {
      const result = quotePoolBuy(pool, offer, fee)
      return {
        venue: 'pool',
        offer,
        amountIn: offer,
        amountOut: result.tokensOut,
        platformFee: result.platformFee,
        creatorFee: result.creatorFee,
        snipeFee: 0n,
        snipeBps: 0,
        minReceived: minReceived(result.tokensOut, slippageBps),
        priceImpactBps: poolPriceImpactBps(pool, result.next),
        graduates: false,
      }
    }
    const result = quotePoolSell(pool, offer, fee)
    return {
      venue: 'pool',
      offer,
      amountIn: offer,
      amountOut: result.usdcOut,
      platformFee: result.platformFee,
      creatorFee: result.creatorFee,
      snipeFee: 0n,
      snipeBps: 0,
      minReceived: minReceived(result.usdcOut, slippageBps),
      priceImpactBps: poolPriceImpactBps(pool, result.next),
      graduates: false,
    }
  } catch {
    return undefined
  }
}

/**
 * A graduated v1.4 token's trade in its Uniswap pool, from what the Architex v4 router quotes for it (`amountOut`:
 * tokens for a buy, USDC after fees for a sell), put together the way the curve's quote is: the hook's fees on the
 * USDC side (the snipe fee on a buy in the pool's first blocks, `snipeFeeBps`), the minimum under the slippage setting,
 * and the impact against the pool's price before the trade (lib/launchV14.ts v4ImpactBps). Undefined without a pool
 * price, or for an offer the hook would refuse.
 */
export function quoteV4Trade(
  launch: LaunchRecord,
  side: LaunchSide,
  offer: bigint,
  amountOut: bigint,
  slippageBps: number,
  snipeFeeBps = 0,
): LaunchQuote | undefined {
  const pool = launch.v4
  if (!pool || offer <= 0n || amountOut <= 0n) return undefined
  try {
    if (side === 'buy') {
      const fees = poolFeesOnGross(offer, launch.creatorFeeBps, snipeFeeBps)
      const net = offer - fees.platformFee - fees.creatorFee - fees.snipeFee
      return {
        venue: 'pool',
        offer,
        amountIn: offer,
        amountOut,
        ...fees,
        snipeBps: fees.snipeFee > 0n ? snipeFeeBps : 0,
        minReceived: minReceived(amountOut, slippageBps),
        priceImpactBps: v4ImpactBps('buy', pool, net, amountOut),
        graduates: false,
      }
    }
    const gross = grossOfSell(amountOut, launch.creatorFeeBps)
    const fees = poolFeesOnGross(gross, launch.creatorFeeBps)
    return {
      venue: 'pool',
      offer,
      amountIn: offer,
      amountOut,
      platformFee: fees.platformFee,
      creatorFee: fees.creatorFee,
      snipeFee: 0n,
      snipeBps: 0,
      minReceived: minReceived(amountOut, slippageBps),
      priceImpactBps: v4ImpactBps('sell', pool, gross, offer),
      graduates: false,
    }
  } catch {
    return undefined
  }
}
