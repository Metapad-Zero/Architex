import { V14Note, V14_NOTE } from './V14Note'

export function DocsGraduation() {
  return (
    <div className="space-y-4">
      <p>
        A curve graduates the moment its 800-million-token allocation sells out. Given the fixed
        shape of the curve, that happens right around a $100,000 market cap. Graduation is
        one transaction, it's irreversible, and it's the same for every token: there's no
        version where a creator or Architex decides a token graduates early or late.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">What actually happens</h3>
      <p>
        The contract moves straight from the curve into the token's own launch pool, created with
        the token and kept closed until now: the USDC that traders put in, and the 200 million
        tokens held back for exactly this moment, go directly into the pool at the same price the
        curve was quoting the instant before it sold out. That's a direct transfer rather than
        the normal add-liquidity path, and it's intentional: seeding a pool through a
        donate-then-sync sequence is exactly the kind of two-step that can be gamed by whoever
        gets a transaction in between the two halves.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">The LP tokens are burned, not held</h3>
      <p>
        Normally, whoever adds liquidity to a pool receives LP tokens representing a claim on it,
        and can redeem them later to withdraw their share. At graduation, Architex mints those LP
        tokens directly to a dead address instead of to anyone's wallet. Nobody can ever withdraw
        that liquidity: not the creator, not Architex, not a future admin. It sits in the pool
        permanently.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">What changes for holders</h3>
      <p>
        Before graduation, a token only trades against the curve. After graduation, it trades
        against USDC in its launch pool, from the same trade sheet on its page. A launch pool is a
        plain constant-product pool with no liquidity fee of its own; every trade in it pays the
        platform's 0.5% and the token's creator fee through the launch router, the only way to
        trade there, so the creator fee keeps applying for as long as the token trades. There is
        no way back to the curve. Graduation is one-way.
      </p>
      <p>
        Anyone can add liquidity on top of the burned graduation liquidity, but there's no button
        for it here: adding or removing launch-pool liquidity has to be done directly with the
        pool contract, in a single transaction of your own. Tokens in the pool earn no holder
        dividends: the launch pool is excluded from them, whoever put the tokens there.
      </p>

      <h3 className="mt-10 text-base font-semibold text-ink">On launchpad v1.4: graduating into Uniswap v4</h3>
      <V14Note {...V14_NOTE} />
      <p>
        A curve on launchpad v1.4 sells out the same way, at the same $100,000, and graduates in
        the same transaction. What it graduates into is different: instead of a launch pool of its
        own, the token gets its own pool on Uniswap v4, opened by the Architex hook at the price
        the curve was quoting the instant before it sold out. The USDC the curve raised and the 200
        million tokens held back go in as one position that covers every price. The hook owns that
        position and has no way to remove it, so nobody can ever withdraw it: not the creator, not
        Architex. On v1.3 the LP tokens are burned; on v1.4 the hook holds the liquidity for good.
      </p>
      <p>
        Nobody can open the pool first, or at another price. The hook refuses any pool it did not
        open itself, and it opens one only when the launchpad asks, inside the buy that sells out
        the curve. Until then the token refuses to move into Uniswap's pool contract at all, so
        nobody can seed a fake pool with it.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">The same fees, whichever router trades</h3>
      <p>
        The hook takes the platform's 0.5% and the token's creator fee on every swap in the pool,
        in USDC, rounded up, exactly as the curve did. Because it does this inside the pool, the
        fees apply to every router that reaches it, not only to this site. The pool charges no
        liquidity fee of its own.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">Open or closed pools</h3>
      <p>
        The creator decides at launch who may add liquidity to the pool, and nobody can change it
        later. A closed pool, the builder's default, holds only the locked launch liquidity and
        what the hook itself locks into it. An open pool also lets anyone add liquidity of their
        own and take it back out whenever they like. Either way, the launch liquidity stays locked
        for good. The pool charges no liquidity fee, so liquidity added to an open pool earns
        nothing from trades; in practice it comes from someone paid to provide it.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">Where the anti-sniping fees go</h3>
      <p>
        For 20 blocks after a v1.4 token launches, and again for 20 blocks after its pool opens,
        buys pay an anti-sniping fee (see <span className="font-semibold">Trading a launch
        token</span>). None of it goes to the creator or to Architex. What the curve collects waits
        in the launchpad and goes into the pool at graduation; what the pool collects waits in the
        hook until anyone presses Lock on the token's page. Both go in as liquidity that holds only
        USDC, starting at half the price (the lower of the price then and the price the pool
        opened at) and running all the way down: a standing bid for the token that nobody can ever
        withdraw. If a curve never sells out, what it collected stays in the launchpad.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">Uniswap's own app</h3>
      <p>
        These are ordinary Uniswap v4 pools, and any v4 router can trade them. Uniswap's own app and
        its routing only send trades to a pool with a hook like this one once Uniswap has approved
        the hook, which hasn't happened yet, so don't expect to find these tokens there. The
        token's page on this site trades them, through the Architex v4 router.
      </p>
    </div>
  )
}
