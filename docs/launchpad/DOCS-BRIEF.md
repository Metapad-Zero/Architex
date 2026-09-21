# Brief: Architex launchpad documentation

Hand this whole file to whoever (or whatever) writes the docs — Grok Build, Codex, a fresh Claude
session, a human. It's self-contained. Do not paraphrase it into a shorter prompt first; the detail
is load-bearing.

## The job

Write the official, public-facing documentation set for Architex's launchpad: the bonding-curve
mechanism that lets anyone launch a token on Arc, trade it while it's curving, and watch it
graduate into a real AMM pool. This is not a spec and not a README — it's what a stranger reads
before they either launch a token or put their own USDC into one. It has to leave them able to
explain the mechanism back, correctly, in their own words.

Audience: two people at once, often the same person on different days.
- A **creator** deciding whether to launch a token, who needs to know what's permanent, what it
  costs, and what they're promising buyers by doing it.
- A **trader** deciding whether to buy into a curve, who needs to know how the price actually
  moves, what graduation means for them, and what could go wrong.

Neither one is a Solidity engineer. Don't write down to them; write so a careful non-engineer
gets it on one read, and an engineer doesn't roll their eyes at the simplifications.

## Ground truth — read these before writing a single number

Never invent a figure, address, or link. Every fact in the docs must trace to one of these:

- `contracts/launchpad/ArchitexLaunchpad.sol` and `contracts/interfaces/IArchitexLaunchpad.sol` —
  the actual on-chain behavior. This wins if anything else disagrees with it.
- `src/lib/curve.ts` — the constants and math the frontend uses (`CURVE.*`, `quoteBuy`,
  `quoteSell`). As of this brief: 1,000,000,000 total supply, 800,000,000 on the curve,
  200,000,000 seeds the pool at graduation, 0.5% fee, curve opens around a $6,250 market cap and
  graduates at a $100,000 market cap (verify these against the file — they change; a rescale from
  8,750 to 25,000 USDC raised already happened once, see `docs/launchpad/LAUNCHPAD-SPEC.md`'s
  history).
- `docs/launchpad/LAUNCHPAD-SPEC.md` — the binding spec, including *why* things work the way they
  do (why LP tokens are burned, why graduation uses a direct transfer instead of the router, why
  sells need no approval).
- `docs/launchpad/METADATA.md` — the token-metadata system: what's stored, why it can be trusted,
  and the hard fact that **details cannot be edited after launch, ever**. This is not a limitation
  to soften; it's the thing that makes the metadata trustworthy, and creators need to feel the
  weight of it before they publish, not after.
- `src/deployments/arc-testnet.json` / `arc-mainnet.json` and `docs/launchpad/TESTNET-DEPLOY.md` —
  real deployed addresses and current network status. State plainly which networks are live.
- The site itself (`architex.fun`) and `DESIGN.md` — voice, tone, what's already been said in the
  UI. The docs should sound like they were written by the same person who wrote the app's copy,
  not a different, more excitable one.

If a number in this brief conflicts with what you read in those files, the files win. Say so if
you had to correct something.

## Non-negotiables

- **Say plainly that the contracts are not third-party audited.** Not buried in a footnote, not
  spun as a positive ("audit coming soon!") — one clear sentence in the risks section, the same
  way the app itself already discloses it.
- **Say plainly that launches are permissionless and speech on them isn't policed.** Architex
  doesn't review token names, symbols, or descriptions before they go live, and doesn't take down
  a launch for being offensive — only for being truly heinous (illegal material) or for abusing the
  platform mechanically (bot spam, not words). If risk-scoring exists by the time this is written,
  say it comes from an independent third party, not from Architex itself. Don't soften this into
  vague "community guidelines" language — state the actual policy.
- **Say plainly that metadata is permanent.** A creator who publishes a typo, a wrong link, or a
  bad image cannot fix it — only hide it from Architex's own display, which doesn't delete it from
  IPFS. Use this as the reason to double-check before publishing, not as a scary warning shouted
  in bold.
- **Never invent a social handle, domain, or address.** Use `architex.fun`, the real GitHub repo,
  and the real X handle if you state one — check `docs/launchpad/METADATA.md` and the site's own
  footer/meta tags for it rather than guessing. If you're not sure a link is real, write the
  sentence without it rather than making one up.
- **Use real numbers, not round marketing ones.** "Graduates at a $100,000 market cap" not
  "graduates once it takes off." Precision reads as more trustworthy than enthusiasm here.

## Structure

Aim for these pages/sections, as separate Markdown files under `docs/launchpad/guide/` (or wherever
the app's eventual Docs route wants to read from — flag this choice, don't block on it):

1. **Overview** — what a launchpad is, in one paragraph, before any mechanism talk. Why Architex
   built one instead of just being an AMM. Who this is for.
2. **How the curve works** — the actual mechanism: virtual reserves, constant product, why price
   rises as more is bought, what "market cap" means before there's a real pool. Use one worked
   example with real numbers (a $100 buy, a $1,000 buy) rather than describing the formula in the
   abstract. A diagram earns its place here if it shows the actual shape of the curve, not a
   generic up-and-to-the-right stock chart.
3. **Launching a token** — the actual steps, the launch fee (check the current value on-chain
   rather than hardcoding it here), what fields exist, which are optional, and the permanence
   warning from METADATA.md placed where a creator will actually read it: before they click
   publish, not after.
4. **Trading on the curve** — buying and selling before graduation: how price impact works, why a
   large buy costs progressively more, what the 0.5% fee funds, why sells need no token approval.
5. **Graduation** — what happens at the market-cap threshold: the direct transfer + LP burn, why
   burning (not just locking) the LP matters, what changes for someone holding the token before
   vs. after (it becomes a normal AMM pair), and that this is one-way — a graduated token never
   goes back to curving.
6. **Token details & trust** — the plain-language version of METADATA.md: why an IPFS address is
   trustworthy (a fingerprint of the exact bytes, not a mutable link), why images are re-encoded,
   why permanence cuts both ways.
7. **Risks** — unaudited contracts, permissionless/no-content-review policy, real USDC with real
   loss potential, volatility inherent to bonding curves, no promise of graduation or of liquidity
   after it. Short, direct, no hedging padding.
8. **FAQ / glossary** — market cap, virtual reserves, graduation, LP burn, slippage, defined in one
   sentence each for someone who's never seen a bonding curve before.

Adjust this structure if the material asks for it — this is a floor, not a template to fill
mechanically.

## Voice: make it sound like a person wrote it

This is the part that's usually wrong. Specifically avoid:

- Throat-clearing openers ("In this guide, we'll explore...", "Let's dive into...").
- Stacked hedges and disclaimers sprinkled through every paragraph instead of stated once, in the
  Risks section, and left alone elsewhere.
- Generic crypto-marketing language: "revolutionary," "seamless," "unlock," "leverage," "the future
  of finance," "to the moon." Architex's own voice (see DESIGN.md — Swiss bank-form, precise,
  restrained) is closer to a well-written prospectus than a pitch deck.
  the-move-toward-em-dash-heavy sentences, tracked-out ALL-CAPS labels, and "Word — fragment"
  constructions. None of that appears in the app's own copy; don't introduce it here.
- Uniform paragraph and sentence rhythm. Real writing varies — a short sentence after a long one,
  an example instead of another abstraction, a section that's four sentences next to one that's
  four paragraphs because it earned the length.
- Numbered "01 / 02 / 03" step markers where the content isn't actually a sequence. Use them only
  for the parts that really are steps (launching a token is; "how the curve works" mostly isn't).
- Explaining what a screenshot or diagram already shows, redundantly, in the surrounding prose.

Do reach for: concrete worked examples over abstract formulas, one real opinion where the project
actually has one (e.g., *why* LP is burned instead of locked — commit to the reasoning, don't just
list it as a fact), and specificity that only someone who actually built this would know (the
exact graduation number, the reason sells skip approval, the reason fees keep deepening the pool
after graduation because it's real USDC, not virtual).

## Definition of done

- Every number, address, and fact traces to a file listed above, or is marked TODO with what it's
  waiting on (e.g., a mainnet address that doesn't exist yet).
- The unaudited-contracts and permissionless-content disclosures are present and unambiguous.
- A creator who's never launched anything could follow "Launching a token" and know exactly what
  they're about to make permanent before they click the button.
- Reads like one person wrote the whole set in one sitting, in the app's existing voice — not
  eight independent sections in eight slightly different tones.
