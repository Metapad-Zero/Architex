export function DocsGraduation() {
  return (
    <div className="space-y-4">
      <p>
        A curve graduates the moment its 800-million-token allocation sells out — which, given
        the fixed shape of the curve, happens right around a $100,000 market cap. Graduation is
        one transaction, it's irreversible, and it's the same for every token: there's no
        version where a creator or Architex decides a token graduates early or late.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">What actually happens</h3>
      <p>
        The contract moves straight from the curve into the token's own launch pool, created with
        the token and kept closed until now: the USDC that traders put in, and the 200 million
        tokens held back for exactly this moment, go directly into the pool at the same price the
        curve was quoting the instant before it sold out. That's a direct transfer rather than
        the normal add-liquidity path — an intentional choice, since seeding a pool through a
        donate-then-sync sequence is exactly the kind of two-step that can be gamed by whoever
        gets a transaction in between the two halves.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">The LP tokens are burned, not held</h3>
      <p>
        Normally, whoever adds liquidity to a pool receives LP tokens representing a claim on it,
        and can redeem them later to withdraw their share. At graduation, Architex mints those LP
        tokens directly to a dead address instead of to anyone's wallet. Nobody — not the creator,
        not Architex, not a future admin — can ever withdraw that liquidity. It sits in the pool
        permanently.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">What changes for holders</h3>
      <p>
        Before graduation, a token only trades against the curve. After graduation, it trades
        against USDC in its launch pool, from the same trade sheet on its page. A launch pool is a
        plain constant-product pool with no liquidity fee of its own; every trade in it pays the
        platform's 0.5% and the token's creator fee through the launch router, the only way to
        trade there, so the creator fee keeps applying for as long as the token trades. There is
        no way back to the curve — graduation is one-way.
      </p>
      <p>
        Anyone can add liquidity on top of the burned graduation liquidity, but there's no button
        for it here: adding or removing launch-pool liquidity has to be done directly with the
        pool contract, in a single transaction of your own. Tokens in the pool earn no holder
        dividends — the launch pool is excluded from them, whoever put the tokens there.
      </p>
    </div>
  )
}
