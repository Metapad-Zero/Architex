export function DocsOverview() {
  return (
    <div className="space-y-4">
      <p>
        A launchpad lets anyone put a token in front of buyers without first convincing a market
        maker to seed a pool for it. Architex does that with a bonding curve: a token starts
        trading the instant it's created, at a price set by a formula instead of by whoever
        happens to place the first order, and it keeps trading that way until enough people have
        bought in that it's ready for a normal market.
      </p>
      <p>
        Each launch also carries a creator fee, from 0% to 10% of every buy and sell, and a
        destination for it: the creator's wallet, or a plugin that splits it, buys the token back
        and burns it, or pays it to holders. Both are chosen at launch and locked for good.
      </p>
      <p>
        That's the whole idea. Everything past this page is detail — how the price actually
        moves, what a creator commits to permanently, what changes the moment a token graduates
        into Architex's regular AMM, and what you're accepting by putting real USDC into
        something that started an hour ago with no track record.
      </p>
      <p>
        Two things worth knowing before any of that: Architex's contracts have not been
        audited by a third party, and nobody at Architex reviews a launch before it goes live.
        Both of those are load-bearing design choices, not oversights — see{' '}
        <span className="font-semibold">Risks</span> for why.
      </p>
    </div>
  )
}
