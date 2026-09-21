export function DocsTrading() {
  return (
    <div className="space-y-4">
      <p>
        Buying and selling a launch token works like any other trade in the app — enter an amount,
        review the quote, confirm — on the token's own page. Before graduation you trade on its
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
        price. On a curve, every trade moves the price, by construction — that's how the curve
        sets a price at all before a real pool exists. The interface shows the expected move
        before you confirm, the same receipt you'd see on a swap. A quote can also go stale
        between the moment you review it and the moment you confirm, if someone else trades
        first; the app catches that and asks you to check the new numbers rather than letting a
        transaction go through against a price you didn't see.
      </p>
      <p>
        The buy that sells out a curve is special: it gets exactly the tokens left and pays only
        for those, so it can spend less than you offered. The sheet says so before you confirm.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">Selling needs no approval step</h3>
      <p>
        Selling a normal ERC-20 into a pool is a two-step dance: approve the contract to move
        your tokens, then swap. A launch token skips the first step, on the curve and in its
        launch pool alike — it lets the launchpad and the launch router pull tokens only from
        whoever is calling the sell, and only into the curve or the pool. One transaction, one
        signature. Buying still needs a USDC approval the first time, for the launchpad on the
        curve and for the launch router after graduation.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">Before graduation, the token only moves through the curve</h3>
      <p>
        Until a token graduates, its contract refuses to let tokens move into its future pool
        address. That's not a bug — it's what stops the token from being pushed into a fake,
        unfunded pool before the real one exists. Once graduation happens, that restriction
        lifts for good.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">After graduation, only against USDC</h3>
      <p>
        A graduated token trades against USDC in its own launch pool, through the launch router,
        which charges both fees exactly as the curve did. It doesn't route through Architex's
        regular pools, and the Swap page doesn't quote it: picking a launch token there opens its
        page instead. Pool trades take a deadline, set in the sheet's settings with your slippage.
      </p>
    </div>
  )
}
