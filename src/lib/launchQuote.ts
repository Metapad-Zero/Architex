import { minReceived } from './amm'
import { quoteBuy, quotePoolBuy, quotePoolSell, quoteSell } from './curve'
import { curvePriceImpactBps, curveStateOf, poolPriceImpactBps, type LaunchRecord, type TradeVenue } from './launch'

export type LaunchSide = 'buy' | 'sell'

export interface LaunchQuote {
  /** The curve before graduation (the launchpad), the launch pool after (the launch router). */
  venue: TradeVenue
  /**
   * What the trade is sent with: the USDC offered on a buy, the tokens on a sell. On the curve this is the typed
   * offer, never the quoted spend: the sell-out buy can spend one unit less than the smallest offer that sells
   * out, so offering only the spend could buy a hair less than the rest and not graduate.
   */
  offer: bigint
  /** What leaves the wallet: on the curve's sell-out buy, less than the offer. */
  amountIn: bigint
  /** Tokens on a buy; USDC after both fees on a sell. */
  amountOut: bigint
  platformFee: bigint
  creatorFee: bigint
  minReceived: bigint
  priceImpactBps: bigint
  /** This buy sells out the curve and graduates the token. */
  graduates: boolean
}

/** Quotes a launch trade locally, with the same maths as the contract that will run it (lib/curve.ts). */
export function quoteLaunchTrade(launch: LaunchRecord, side: LaunchSide, offer: bigint, slippageBps: number): LaunchQuote | undefined {
  if (offer <= 0n) return undefined
  const fee = launch.creatorFeeBps
  try {
    if (!launch.graduated) {
      const state = curveStateOf(launch)
      if (side === 'buy') {
        const result = quoteBuy(state, offer, fee)
        return {
          venue: 'curve',
          offer,
          amountIn: result.usdcSpent,
          amountOut: result.tokensOut,
          platformFee: result.platformFee,
          creatorFee: result.creatorFee,
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
        minReceived: minReceived(result.usdcOut, slippageBps),
        priceImpactBps: curvePriceImpactBps(state, result.next),
        graduates: false,
      }
    }
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
      minReceived: minReceived(result.usdcOut, slippageBps),
      priceImpactBps: poolPriceImpactBps(pool, result.next),
      graduates: false,
    }
  } catch {
    return undefined
  }
}
