export function DocsCurve() {
  return (
    <div className="space-y-4">
      <p>
        Before a token graduates, there's no pool and no order book. There's a curve: a formula
        that answers "what does the next unit cost" using only two numbers, a USDC side and a
        token side, multiplied together to a constant. Buy tokens and the USDC side goes up while
        the token side goes down; sell and it runs the other way. The product of the two never
        changes except when a fee is added to it. That's the entire mechanism. Everything else
        in this section is what falls out of it.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">Why the curve starts with numbers nobody deposited</h3>
      <p>
        A curve that opened at literally nothing on one side would either divide by zero or hand
        its whole supply to the first buyer for free. So every curve starts with virtual
        reserves: Architex pretends there's already USDC and tokens sitting against each other,
        even though no one has deposited either. That imaginary starting point is what makes the
        first token cost a sane, low amount instead of nothing, and it's why a launch has a market
        cap (currently a little over $6,250) before a single person has bought in. As real USDC
        comes in from buyers, it's added on top of the virtual amount; the "virtual" part never
        goes away, it's just a smaller and smaller share of the total the longer the curve runs.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">What buying actually costs</h3>
      <p>
        Because the two sides multiply to a constant, price rises with every purchase, and it
        rises faster the further along the curve you are, the same way a $100 order moves a
        thin order book more than a $100,000 order moves a deep one. Concretely: the first $100
        put into a fresh curve buys around 1.26% of everything that will ever be sold on it. A
        $1,000 buy on the curve at its current size moves the price by roughly 4.3%. Put twice as
        much in and you don't get twice the tokens. You get less than that, because you're
        paying a rising price the whole way, not one fixed price. The app shows you the exact
        quote, including how much the price will move, before you confirm anything.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">The fees</h3>
      <p>
        Every buy and every sell on the curve carries two fees, both in USDC: the platform's 0.5%,
        and the token's own creator fee, anywhere from 0% to 10%, set by its creator at launch and
        fixed for good. Neither goes back into the curve. The creator fee goes where the creator
        chose (see <span className="font-semibold">Creator fees &amp; plugins</span>), and the
        platform fee to the protocol's fee address.
      </p>
      <p>
        Both accrue separately and move later, in a call anyone can make. That's deliberate: a
        broken or blocklisted destination can never freeze trading, launching, or graduation,
        because a fee doesn't need anywhere to land for a trade to finish.
      </p>
      <p>
        On launchpad v1.4 the curve is the same curve, with one addition: buys in its first 20
        blocks also pay an anti-sniping fee, which never goes into the curve either. It's held for
        the token's pool; see <span className="font-semibold">Trading a launch token</span>.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">What ends it</h3>
      <p>
        A curve sells a fixed pool of tokens: 800 million of the token's 1 billion total supply.
        Once all 800 million are sold, the curve is done and the token graduates into its own
        pool; see <span className="font-semibold">Graduation</span>. Nothing else stops a curve
        early. If buying just stops, the curve stops too, sitting wherever it was. There's no
        deadline and no penalty for that; it just doesn't graduate.
      </p>
    </div>
  )
}
