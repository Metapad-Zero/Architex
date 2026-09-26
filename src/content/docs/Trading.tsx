import { V14Note, V14_NOTE } from './V14Note'

export function DocsTrading() {
  return (
    <div className="space-y-4">
      <p>
        Buying and selling a launch token works like any other trade in the app, on the token's
        own page: enter an amount, review the quote, confirm. Before graduation you trade on its
        curve; after, in its launch pool. A few things behave differently from trading a regular
        pool, all worth knowing before you place a large order.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">Two fees on every trade</h3>
      <p>
        Every buy and sell pays the platform's 0.5% and the token's creator fee, which can be
        anything from 0% to 10% and never changes. Both come out of the USDC side: out of what
        you pay on a buy, out of what you receive on a sell. The trade sheet lists each one, in
        percent and in USDC, next to the minimum you'll receive, so the total cost is on screen
        before you confirm. See <span className="font-semibold">Creator fees &amp; plugins</span>{' '}
        for where the creator fee goes.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">Price impact is built in, not incidental</h3>
      <p>
        On a regular pool, a trade that's small relative to the pool's depth barely moves the
        price. On a curve, every trade moves the price, by construction. That's how the curve
        sets a price at all before a real pool exists. The interface shows the expected move
        before you confirm, the same receipt you'd see on a swap. A quote can also go stale
        between the moment you review it and the moment you confirm, if someone else trades
        first; the app catches that and asks you to check the new numbers rather than letting a
        transaction go through against a price you didn't see. Every trade, on the curve or in the
        pool, also carries a deadline, set in the sheet's settings beside your slippage: a trade
        that hasn't landed by then fails instead of going through late.
      </p>
      <p>
        The buy that sells out a curve is special: it gets exactly the tokens left and pays only
        for those, so it can spend less than you offered. The sheet says so before you confirm.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">Selling needs no approval step</h3>
      <p>
        Selling a normal ERC-20 into a pool is a two-step dance: approve the contract to move
        your tokens, then swap. A launch token skips the first step, on the curve and in its
        pool alike: it lets the launchpad and its router (the launch router, or on v1.4 the v4
        router) pull tokens only from whoever is calling the sell, and only into the curve or the
        pool. One transaction, one signature. Buying still needs a USDC approval the first time,
        for the launchpad on the curve and for the router after graduation.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">Before graduation, the token only moves through the curve</h3>
      <p>
        Until a token graduates, its contract refuses to let tokens move into its future pool
        address. That's not a bug. It's what stops the token from being pushed into a fake,
        unfunded pool before the real one exists. Once graduation happens, that restriction
        lifts for good.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">After graduation, only against USDC</h3>
      <p>
        A graduated token trades against USDC in its own pool, which charges both fees exactly
        as the curve did: on v1.3 its launch pool, through the launch router; on v1.4 its Uniswap
        v4 pool, through the v4 router. It doesn't route through Architex's regular pools, and the
        Swap page doesn't quote it: picking a launch token there opens its page instead.
      </p>

      <h3 className="mt-10 text-base font-semibold text-ink">On launchpad v1.4: the anti-sniping fee</h3>
      <V14Note {...V14_NOTE} />
      <p>
        A buy in the 20 blocks after a v1.4 token launches, and again in the 20 blocks after its
        pool opens, pays one more fee on top of the other two: 90% in the first block, falling
        evenly to nothing by the 20th. On Arc that's about 10 seconds. It means a bot that buys the
        instant a token appears pays most of its money for being first. None of it goes to the
        creator or to Architex: it becomes liquidity in the token's own pool, below the market,
        that nobody can withdraw. In the pool that happens in the same transaction as the buy that
        paid it; what the curve collects follows at graduation (see{' '}
        <span className="font-semibold">Graduation</span>). Sells never pay it, and neither
        does the creator's first buy, which happens inside the launch transaction itself. The
        platform, creator and anti-sniping fees together never take more than 99% of a buy.
      </p>
      <p>
        While it applies, the trade sheet shows it as its own line with the block it reaches zero
        at, and quotes it at the block the chain is at now. A buy lands a block or more later, when
        the fee is lower, so the fee alone never leaves you with less than the sheet showed.
        Waiting a few seconds avoids it altogether. A buy in a pool's window also costs a little
        more gas, since it adds the bid too: a fraction of a cent on Arc.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">After graduation on v1.4: Uniswap v4</h3>
      <p>
        A graduated v1.4 token trades against USDC in its own Uniswap v4 pool, and the sheet says so
        at the top, with the pool's price. It trades through the Architex v4 router, and its quote
        comes from asking the router to run the swap without keeping it, so the quote includes
        every fee the pool's hook takes. Because that answer comes from the chain rather than from
        local maths, it can take a moment to appear after you type. Slippage and the deadline work
        as they do everywhere else, and the chain is asked once more just before the trade is sent.
      </p>
      <p>
        Price impact in these pools is measured the way Swap measures it: what the trade gets
        against the pool's price just before it, with every fee left out.
      </p>
    </div>
  )
}
