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
        The contract moves straight from the curve into a real Architex pool: the USDC that
        traders put in, and the 200 million tokens held back for exactly this moment, go directly
        into a newly created pair at the same price the curve was quoting the instant before it
        sold out. That's a direct transfer rather than routing it through the normal add-liquidity
        path — an intentional choice, since seeding a pool through a donate-then-sync sequence is
        exactly the kind of two-step that can be gamed by whoever gets a transaction in between
        the two halves.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">The LP tokens are burned, not held</h3>
      <p>
        Normally, whoever adds liquidity to a pool receives LP tokens representing a claim on it,
        and can redeem them later to withdraw their share. At graduation, Architex mints those LP
        tokens directly to a dead address instead of to anyone's wallet. Nobody — not the creator,
        not Architex, not a future admin — can ever withdraw that liquidity. It sits in the pool
        permanently, and every swap fee the pool earns afterward stays in the pool too, since
        there's no one left to claim it. A graduated pool only ever gets deeper.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">What changes for holders</h3>
      <p>
        Before graduation, a token only trades against the curve, at whatever price the curve is
        quoting. After graduation, it's a normal AMM pair like any other on Architex: the swap
        page, price history, and liquidity math all work the same way they do for USDC/EURC or
        any other pool. There is no way back to curving — graduation is one-way.
      </p>
    </div>
  )
}
