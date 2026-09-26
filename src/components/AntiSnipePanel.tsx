import { GHOST, formatAmount, formatPct } from '../lib/format'
import { formatSpotUsd, type LaunchRecord } from '../lib/launch'
import { nextBidSpotPrice, secondsUntil, snipeBps, snipeWindowEnd } from '../lib/launchV14'

interface AntiSnipePanelProps {
  launch: LaunchRecord
  /** The chain's latest block (hooks/useChainBlock.ts); undefined until read. */
  block: bigint | undefined
  /** On the curve: USDC of anti-sniping fees the launchpad holds for the pool's first bid. Undefined once it graduates. */
  held: bigint | undefined
}

/**
 * A v1.4 token's anti-sniping fee (V14-SPEC §5): what a buy pays now while a window is open, and where the fee goes.
 * Nobody has to do anything with it. In the pool, the buy that pays it places it as a bid in the same transaction:
 * liquidity that only buys the token, below the market, that nobody can withdraw (the hook's bidCount counts them),
 * from half the pool's bid reference or the price before that buy, whichever is lower; while the window is open the
 * panel shows where the next one would start. On the curve the launchpad holds it, and graduation places it as the
 * pool's first bid.
 */
export function AntiSnipePanel({ launch, block, held }: AntiSnipePanelProps) {
  const opened = launch.graduated ? launch.v4?.openBlock : launch.createdBlock
  const end = opened === undefined ? undefined : snipeWindowEnd(opened)
  const rate = opened === undefined || block === undefined ? undefined : snipeBps(opened, block, launch.creatorFeeBps)
  const windowOpen = rate !== undefined && rate > 0
  const bids = launch.v4?.bidCount
  const nextBid = launch.graduated && launch.v4 ? nextBidSpotPrice(launch.v4) : undefined

  return (
    <section className="ruled-section mt-14" aria-labelledby="anti-snipe-title">
      <div className="section-heading-row">
        <h2 id="anti-snipe-title">Anti-sniping fee</h2>
        <span>Becomes bids in the pool</span>
      </div>
      <dl className="receipt-lines">
        <div>
          <dt>Fee on a buy now</dt>
          <dd className={windowOpen ? '' : 'text-g500'}>{rate === undefined ? GHOST : windowOpen ? formatPct(rate) : 'None'}</dd>
        </div>
        {windowOpen && end !== undefined && block !== undefined && (
          <div>
            <dt>Falls to 0</dt>
            <dd>{`At block ${end.toLocaleString('en-US')}, in about ${secondsUntil(end, block)}s`}</dd>
          </div>
        )}
        {launch.graduated ? (
          <>
            <div>
              <dt>Bids in the pool</dt>
              <dd className={bids === undefined ? 'text-g500' : ''}>{bids === undefined ? GHOST : bids.toLocaleString('en-US')}</dd>
            </div>
            {windowOpen && (
              <div>
                <dt>Next bid starts at</dt>
                <dd className={nextBid === undefined ? 'text-g500' : ''}>{nextBid === undefined ? GHOST : formatSpotUsd(nextBid)}</dd>
              </div>
            )}
          </>
        ) : (
          <div>
            <dt>Held for the first bid</dt>
            <dd className={held === undefined ? 'text-g500' : ''}>{held === undefined ? GHOST : `${formatAmount(held, 6)} USDC`}</dd>
          </div>
        )}
      </dl>
      <p className="fee-plugin-note">
        {launch.graduated
          ? 'For 20 blocks after its pool opened (about 10 seconds), every buy pays an extra fee that starts at 90% and falls to 0; sells never do. The same transaction turns that fee into a bid below the market: liquidity that only buys the token, which nobody can ever withdraw. Each bid starts at half the lowest price any buy in the window has started from, beginning with the price the pool opened at, so bids follow a crash down and never move back up. Nothing waits and nobody has to press anything.'
          : 'For 20 blocks after launch (about 10 seconds), every buy pays an extra fee that starts at 90% and falls to 0; sells never do. The launchpad holds what the curve’s window collects, and when the token graduates it becomes the pool’s first bid: liquidity that only buys the token, from half the price the pool opens at down, which nobody can ever withdraw. If the curve never sells out, it stays in the launchpad. After graduation, each buy in the pool’s first 20 blocks turns its own fee into a bid in the same transaction.'}
      </p>
    </section>
  )
}
