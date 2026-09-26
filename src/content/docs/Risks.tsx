import { V14Note, V14_NOTE } from './V14Note'

export function DocsRisks() {
  return (
    <div className="space-y-4">
      <p>
        Read this section before you put real USDC into anything on this site. None of it is
        hidden elsewhere in these docs, but it's worth having in one place.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">The contracts are not audited</h3>
      <p>
        Architex's contracts have not been reviewed by a third-party auditor. They've been tested
        and reviewed internally, but that is not the same guarantee an independent audit gives
        you. Only trade with money you could afford to lose entirely.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">Launches are not reviewed, and speech on them isn't policed</h3>
      <p>
        Nobody at Architex approves a launch before it goes live, and nobody reviews a name,
        symbol, or description for being offensive, in bad taste, or wrong about the project it
        describes. That's a deliberate stance, not a gap: Architex is open-source and treats what
        people are allowed to publish on it as something worth protecting, including opinions and
        language it wouldn't choose itself.
      </p>
      <p>
        That stance has limits. Architex will remove content that's genuinely heinous (illegal
        material, not merely distasteful) and will act against programs abusing the platform
        mechanically, such as bots spamming launches. If a risk score for a token ever appears on
        this site, it will come from an independent third party, not from a judgment Architex
        makes itself. The platform reviewing its own listings for "riskiness" is exactly the kind
        of gatekeeping it's trying to avoid. None of this amounts to due diligence on any specific
        token. Treat every launch as unverified until you've checked it yourself.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">There is an admin key, and it's narrower than that sounds</h3>
      <p>
        One address, held on a hardware wallet, can redirect where the platform's own trading and
        launch fees go and change the flat launch fee (capped, so it can never be raised past a
        small ceiling, and never above the fee a creator's launch agreed to). That's the entire
        admin surface. There's no pause, no upgrade, no access to any curve's funds, and no power over
        any token's creator fee, its destination, its curve or its pool. It only ever moves where
        the protocol's own fee revenue lands, never anyone's trade, deposit, holdings or creator
        fees.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">Creator-fee destinations are the creator's choice</h3>
      <p>
        A token's creator fee goes wherever its creator pointed it, for good. The listed plugins
        were reviewed by pull request; a custom address wasn't, and the site says only which it
        is. If a destination breaks, its fees stay stuck in the launchpad forever: trading is
        unaffected, and nobody can redirect them. Check where a token's fees go before you buy,
        especially a high fee going to an address you can't read.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">Limits Architex accepts</h3>
      <p>
        Some things no contract can prevent, and v1.3 lives with them rather than pretend
        otherwise:
      </p>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          Anyone can pair a launch token in a regular Architex pool, or anywhere else, like any
          ERC-20. Trades there skip the creator fee, and if the token pays holders, such a pool's
          share of the USDC can be taken out of it by anyone. The site doesn't list or route
          through those pools.
        </li>
        <li>
          Launch-pool liquidity has no helper on this site: adding or removing it has to be done
          with the pool contract directly, in one transaction. Tokens you add to a launch pool earn
          no holder dividends, because the pool is excluded from them.
        </li>
        <li>
          USDC can block addresses. If a wallet inside a Combo gets blocked, that token's
          collections fail and its fees stay in the launchpad. A blocked Split payee only blocks
          their own release.
        </li>
        <li>
          USDC sent straight to a plugin, rather than collected through the launchpad, is credited
          to no token and can't be recovered. That's why the builder refuses a plugin as a Split
          payee.
        </li>
        <li>
          The listed plugins are shared by every token that picks them. If USDC ever blocked one, or
          blocked a launch token itself, collections for the tokens involved would fail and their
          fees would stay in the launchpad; a blocked token's holders couldn't claim either.
        </li>
        <li>
          Buyback &amp; burn and Deepen pool spend at most 0.25% of the pool's USDC an hour (for
          Deepen pool, of the part locked for good). On a busy token with a high creator fee, fees
          can arrive faster than that, and the USDC waiting to be spent grows until volume cools.
          Nothing is lost; it's just slower.
        </li>
        <li>
          Holder dividends are shared by the second. If everyone else sells, whoever still holds
          collects the whole stream while they're alone, and anyone who buys shares it from then on.
        </li>
      </ul>

      <h3 className="mt-6 text-base font-semibold text-ink">What launchpad v1.4 adds</h3>
      <V14Note {...V14_NOTE} />
      <ul className="list-disc space-y-2 pl-5">
        <li>
          A graduated v1.4 token trades in a Uniswap v4 pool behind the Architex hook. The hook and
          the v4 router are Architex contracts, tested and reviewed internally but not audited, like
          the rest; the pool itself lives in Uniswap's own contract.
        </li>
        <li>
          Uniswap's app doesn't route trades to these pools until Uniswap approves the hook, which
          hasn't happened. A token you can't find there may still trade here, and there may be other,
          unrelated pools for it that skip its creator fee.
        </li>
        <li>
          In an open pool, liquidity other people add can be taken back out at any time. Only the
          launch liquidity, and the bids the hook adds, are locked for good.
        </li>
        <li>
          A buy in a token's first 20 blocks, on the curve or in its new pool, pays an anti-sniping
          fee of up to 90%. The trade sheet shows it; a buy sent another way doesn't get that warning.
        </li>
        <li>
          What a curve's anti-sniping fee collects stays in the launchpad for good if the curve never
          sells out. In the pool, each fee becomes a standing bid from half the price just before the
          buy that paid it: liquidity that buys the token back from anyone who sells that low, and
          that nobody can withdraw.
        </li>
        <li>
          Tokens in Uniswap's pool contract, anyone's, earn no holder dividends.
        </li>
      </ul>

      <h3 className="mt-6 text-base font-semibold text-ink">Curves can stall, and graduation isn't a promise of anything</h3>
      <p>
        A curve only advances when people buy. If buying stops, the curve just sits there. There
        is no deadline, no refund, and no mechanism that forces it forward. Graduating to a real
        pool is a statement about how much USDC has gone into the curve, not a judgment about the
        token's quality, and it doesn't guarantee that trading interest continues afterward.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">Prices move, sometimes fast, always against someone</h3>
      <p>
        Bonding-curve prices move mechanically with every trade, in both directions, and a token
        that graduated is still exactly as volatile as any other new listing. This is not
        financial advice, and Architex does not recommend any specific token.
      </p>
    </div>
  )
}
