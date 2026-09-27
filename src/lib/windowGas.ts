/**
 * The gas a v1.4 buy is sent with while a snipe window is open (V14-SPEC §5, integration review #9b). A buy in a pool's
 * window also places its fee as a bid, and what that costs depends on tick state other trades change (a new low opens
 * new ticks, a sell just before can add about 60,000), so an estimate taken a moment earlier can come up 16% to 25%
 * short. While `snipeBpsOf(token) > 0`, read just before sending, such a buy goes out with a gas limit of its own: a
 * fresh estimate of that exact transaction times 1.3, or plus 200,000, whichever is larger. Every limit comes from a new
 * estimate, never from an earlier receipt (a window buy's receipt is about 11% under what it needs). Outside a window the
 * wallet estimates as it does for any trade. A limit is a ceiling: only the gas a buy uses is paid.
 */

/** A window buy's limit is at least its estimate times this, in bps (×1.3)… */
export const WINDOW_GAS_SCALE_BPS = 13_000n
/** …and at least its estimate plus this much gas. */
export const WINDOW_GAS_EXTRA = 200_000n

/** The gas limit for a window buy whose fresh estimate is `estimate`: the larger of ×1.3 (rounded up) and +200,000. */
export function windowBuyGasLimit(estimate: bigint): bigint {
  if (estimate <= 0n) throw new Error('No gas estimate')
  const scaled = (estimate * WINDOW_GAS_SCALE_BPS + 9_999n) / 10_000n
  const padded = estimate + WINDOW_GAS_EXTRA
  return scaled > padded ? scaled : padded
}

/** What deciding a trade's gas may ask the chain, just before sending: each call asks again. */
export interface WindowGasReads {
  /** `snipeBpsOf(token)` on the contract the buy goes through: the launchpad on the curve, the hook in the pool. */
  snipeBps: () => Promise<bigint>
  /** A new gas estimate of the exact transaction about to be sent. */
  estimate: () => Promise<bigint>
}

export interface LaunchTradeGasArgs {
  side: 'buy' | 'sell'
  /** Only launchpad v1.4 has snipe windows. */
  v14: boolean
  /**
   * A block the site has already seen is past the window. A window only closes, so the chain need not be asked. False
   * when that is not known.
   */
  windowClosed: boolean
}

/**
 * The gas limit to send a launch trade with, or undefined to leave it to the wallet's estimate: a v1.4 buy gets one
 * while its window is open on chain (`snipeBpsOf` read now), from a fresh estimate. Sells never pay the fee, place no
 * bid and keep the wallet's estimate.
 */
export async function launchTradeGas(trade: LaunchTradeGasArgs, reads: WindowGasReads): Promise<bigint | undefined> {
  if (!trade.v14 || trade.side !== 'buy' || trade.windowClosed) return undefined
  if ((await reads.snipeBps()) === 0n) return undefined
  return windowBuyGasLimit(await reads.estimate())
}
