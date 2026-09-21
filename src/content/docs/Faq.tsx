export function DocsFaq() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="text-base font-semibold text-ink">Can I get my tokens back if I change my mind about a buy?</h3>
        <p>
          Sell them back into the curve, same as any other trade — there's no cooldown or lockup.
          You'll get back less than you paid if the price has moved against you since, the same
          as selling into any market.
        </p>
      </div>
      <div className="space-y-2">
        <h3 className="text-base font-semibold text-ink">Can a creator take the curve's USDC out early?</h3>
        <p>
          No. The curve holds real USDC and reserved tokens in the contract itself; nobody,
          including the creator, has a withdrawal path before graduation, and graduation sends
          the funds straight into a burned-LP pool rather than to any wallet.
        </p>
      </div>
      <div className="space-y-2">
        <h3 className="text-base font-semibold text-ink">Why can't I edit my launch after publishing?</h3>
        <p>
          Because the trust model depends on it. See{' '}
          <span className="font-semibold">Token details &amp; trust</span> for why an editable
          file couldn't be verified the same way.
        </p>
      </div>

      <div>
        <h3 className="text-base font-semibold text-ink">Glossary</h3>
        <dl className="mt-3 space-y-4">
          <div>
            <dt className="font-semibold text-ink">Bonding curve</dt>
            <dd className="text-g700">
              A formula that prices a token from two reserve numbers instead of an order book —
              see <span className="font-semibold">How the curve works</span>.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-ink">Virtual reserves</dt>
            <dd className="text-g700">
              Starting numbers a curve assumes rather than actually holds, so the first trade has
              a sane price instead of dividing by zero.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-ink">Market cap (pre-graduation)</dt>
            <dd className="text-g700">
              The curve's current price multiplied by the token's full supply — a size figure,
              not a claim about real USDC raised.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-ink">Graduation</dt>
            <dd className="text-g700">
              The one-way move from curve to real AMM pool once the curve's 800 million tokens
              sell out — see <span className="font-semibold">Graduation</span>.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-ink">LP burn</dt>
            <dd className="text-g700">
              Sending the liquidity-pool tokens created at graduation to a dead address instead of
              a wallet, so nobody can ever withdraw that liquidity.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-ink">Price impact / slippage</dt>
            <dd className="text-g700">
              How much a trade itself moves the price. The app shows this before you confirm.
            </dd>
          </div>
        </dl>
      </div>
    </div>
  )
}
