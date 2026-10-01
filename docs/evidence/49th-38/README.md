## Arc→Base keeper token refill — fork evidence

49TH-38 is stacked on PR #17 at `4f48dfa6953d105d175ba15e9aa2af25628dfb34`.
This bundle records local pinned-fork execution, not public approval or live acceptance.

The route locks existing executor-owned canonical tokens on Arc, authenticates the finalized
NTT message, and mints the matching representation directly to the bound Base keeper vault.
Direction, launch, token, recipient, managers and amount remain bound across restart.

| Acceptance | Evidence |
| --- | --- |
| Authenticated debit/credit | 28 finalized operation receipts, one execution log per operation |
| Supply reconciliation | Issuance stays 1000000000000 atoms; custody and remote supply both 10630000000; no pending claim at completion |
| Delayed destination | Two-confirmation Base observation remains pending; finalized reads show the 10000000-atom claim before redemption |
| Authority | Forged signature and signed unapproved peer refused on an unredeemed claim; non-owner executor use refused |
| Replay and restart | Twelve hard process exits before/after send, receipt write and cost write; request/operation/VAA replay cannot duplicate credit |
| Bounds | Depleted source inventory, per-transfer cap, racing cumulative admissions, zero gas budget and unsupported nonzero protocol fee refuse |
| Trading guard | Pending maintenance blocks consider/runCycle; it stays reserved until costs and receipts settle |
| Accounting | Independent receipt-derived maintenance cost is 91330 quote atoms; all reservations settle; principal excluded |
| Public acceptance | Open; no public sends, signatures, funding, deployment or publication authorized |

Reproduce from this branch with Bun and Anvil installed; loopback ports 18765 and 18766 must be free:

```sh
bun install --frozen-lockfile
bun run equilibrium:keeper-token-refill-rehearse
bun run equilibrium:keeper-token-refill-fork-test
bun run equilibrium:keeper-maintenance-fork-test
bun run server/equilibrium/keeper/token-refill-bundle-verify.ts
bun run server/equilibrium/keeper/token-refill-bundle-verify.ts output/49th-38
```

The first command regenerates artifacts under `output/49th-38`; the checked bundle here is frozen
for this branch. Regenerated timestamps change launch IDs, contract addresses, receipt hashes and
approval digests. Compare checks, conservation and actual receipt-derived totals, not those identities.
The verifier checks exact code manifests/digests, all frozen launch code dependencies against the
stack base, unchanged public previews, and absence of development private keys from the bundle.

Substitutions: local Guardian/CCTP attester sets at threshold one, Arc USDC stand-in, local
operator-owned setup inventory and development-key gas. Only crash workers shorten the lease to
200ms; public leases stay 30000ms. Real Base L1 fees, public Guardian/Circle availability, Arc
precompile settlement, payment repairs and Solana/Robinhood live acceptance remain unproven here.
The token refill does not depend on the delayed-payment or Solana recovery changes owned elsewhere.

Recovery keeps the original signed transaction privately in SQLite and uses the original gas
reservation. A transaction whose nonce or fee cannot be accepted stays pending for operator
reconciliation; it does not silently raise gas limits, replace identities or sign a higher-cost
replacement. Keep the original durable record and use maintenance-reconcile before trading.
Use one runner per operator key; owner actions outside this database are not a cross-chain lock.

The keeper/transfer digests in approval-manifests.json bind these exact keyless fork configurations
and code. They grant no public authorization. Launch approval code and pre-existing public approval
bundles are unchanged. 49TH-36, 49TH-37 and the PR #20 follow-up remain outside this scope.
