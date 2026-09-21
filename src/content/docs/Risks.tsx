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
        That stance has limits. Architex will remove content that's genuinely heinous — illegal
        material, not merely distasteful — and will act against programs abusing the platform
        mechanically, such as bots spamming launches. If a risk score for a token ever appears on
        this site, it will come from an independent third party, not from a judgment Architex
        makes itself — the platform reviewing its own listings for "riskiness" is exactly the kind
        of gatekeeping it's trying to avoid. None of this amounts to due diligence on any specific
        token. Treat every launch as unverified until you've checked it yourself.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">There is an admin key, and it's narrower than that sounds</h3>
      <p>
        One address, held on a hardware wallet, can redirect where the trading and launch fees
        go and change the flat launch fee (capped, so it can never be raised past a small
        ceiling). That's the entire admin surface — no pause, no upgrade, no access to any
        curve's funds, no way to touch a launch or a pool once it exists. Redirecting fees can
        point at a single wallet or a multi-recipient split contract (see "Fee-distribution
        plugins" on the <span className="font-semibold">Launch</span> page) — either way, it
        only ever moves where the protocol's own fee revenue lands, never anyone's trade,
        deposit, or holdings.
      </p>

      <h3 className="mt-6 text-base font-semibold text-ink">Curves can stall, and graduation isn't a promise of anything</h3>
      <p>
        A curve only advances when people buy. If buying stops, the curve just sits there — there
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
