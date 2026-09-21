export function DocsFees() {
  return (
    <div className="space-y-4">
      <p>
        Every launch token carries a creator fee: a percentage, from 0% to 10%, taken from every
        buy and every sell of that token. The creator picks it when they launch, and it's locked
        for good from then on — nobody can raise it, lower it, or switch it off, the creator
        included. The fee applies on the curve and keeps applying in the token's launch pool
        after it graduates. The creator's own first buy pays it too.
      </p>
      <p>
        It comes on top of the platform's 0.5% fee, and both are taken in USDC: out of the USDC
        you pay on a buy, out of the USDC you receive on a sell. Each is rounded up to the next
        millionth of a USDC, so rounding never works in a trader's favour. The trade sheet shows
        each fee as its own line before you confirm, and every token's page, list row and
        picker row shows its creator fee on a small dial.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">Where the fee goes</h3>
      <p>
        At launch the creator also picks one destination for the fee, and that's locked for good
        too. It can be a wallet (their own, or any other), one of the plugins listed in the token
        builder, or any other address. The site always says plainly where a token's fees go: the
        listed plugin's name, "Creator wallet" when it's the creator's own address, or "Custom
        address" with the address itself. Architex hasn't reviewed a custom address and makes no
        claim about it.
      </p>
      <p>
        Fees don't move during a trade. They wait in the launchpad, counted separately for each
        token, until someone collects them — and anyone can, at any time, with the Collect
        creator fees button on the token's page. Collecting sends them to the token's destination
        and nowhere else. Because a trade never touches the destination, no plugin can slow down
        or block trading, whatever it does.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">The listed plugins</h3>
      <p>
        <span className="font-semibold text-ink">Split</span> shares the fees among up to 20
        wallets, by fixed shares set at launch. Each wallet's share waits in the plugin until
        someone releases it; anyone can press Release for any payee, and the USDC always goes to
        that payee.
      </p>
      <p>
        <span className="font-semibold text-ink">Buyback &amp; burn</span> spends the fees buying
        the token and burns everything it buys, so the supply only ever goes down. Anyone can run
        a buyback. Each run spends at most 0.25% of the USDC side of the curve (or of the launch
        pool, after graduation), and a token can run once per block. A run takes no price limit
        on purpose: the cap keeps each one small enough that sandwiching it costs an attacker more
        in fees than it could make.
      </p>
      <p>
        <span className="font-semibold text-ink">Distribute to holders</span> pays the fees to
        the token's holders in USDC, in proportion to what they hold. The fees aren't handed out
        the moment they arrive: they're released gradually, so nobody can buy, collect the fees
        and sell again in one go. Fees that arrive to an empty stream are released evenly over 24
        hours. When more arrive while some are still waiting, the end of the stream moves by
        weight: a large delivery pushes it most of the way towards 24 hours from now, a small one
        barely moves it. Holders claim on the token's page; Claim releases what's due to everyone
        first, then pays you your share. What's released goes to whoever holds at that moment, so
        someone who buys just before a release shares what built up since the last one.
      </p>
      <p>
        <span className="font-semibold text-ink">Combo</span> splits the fees across up to five
        of these destinations by percentage, adding up to exactly 100%: wallets, a Split, Buyback
        &amp; burn, or Distribute to holders, each plugin at most once. Every collection is split
        on the spot; the last destination takes any rounding.
      </p>
      <p>
        Plugins are listed in the builder after their code has been reviewed by pull request.
        Listing means reviewed and tested; it isn't a promise about anything a plugin does.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">When a destination breaks</h3>
      <p>
        If collecting to a token's destination fails — a plugin with a bug, an address USDC
        refuses to pay — the collection is undone and the fees stay in the launchpad. Trading
        carries on exactly as before, and nobody, Architex included, can send those fees anywhere
        else. That's the cost of a destination nobody can change: a broken one keeps its fees.
      </p>
    </div>
  )
}
