export function DocsTrading() {
  return (
    <div className="space-y-4">
      <p>
        Buying and selling on a curve works like any other trade in the app — enter an amount,
        review the quote, confirm. Two things behave differently from trading a regular pool,
        both worth knowing before you place a large order.
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

      <h3 className="mt-6 text-base font-semibold text-ink">Selling needs no approval step</h3>
      <p>
        Selling a normal ERC-20 into a pool is a two-step dance: approve the contract to move
        your tokens, then swap. A launch token skips the first step — it's built to let the
        launchpad pull tokens only from whoever is calling the sell, and from nowhere else. One
        transaction, one signature, same fee (0.5%) as buying.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">Before graduation, the token only moves through the curve</h3>
      <p>
        Until a token graduates, its contract refuses to let tokens move into its future pool
        address. That's not a bug — it's what stops the token from becoming tradeable anywhere
        else, or being pushed into a fake, unfunded pool, before the real one exists. Once
        graduation happens, that restriction lifts for good.
      </p>
    </div>
  )
}
