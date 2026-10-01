EQUILIBRIUM 49TH-40 token maintenance — FORK ONLY, public route closed.

Same asset: canonical Arc token locks into its existing NTT hub; the bound Robinhood peer authenticates the published message and mints directly into the keeper vault. Token cap 4000000000 per transfer / 16000000000 cumulatively, in 6-decimal token atoms. Pending claims count and prevent new trades. This scope permits no issuance, no USDG refill and no nonzero native protocol payment.

Both chains use two local confirmations. The finalized source publication binds managers, chain, source token, precision, amount, sender and recipient. Completion requires the matching finalized redemption, exact mint and supply equation: canonical outside custody + remote supply + authenticated pending claims = fixed issuance; custody = remote supply + pending claims. Keeper/transfer identities and RPCs must match. Source inventory, NTT capacity, operator gas and cumulative operating cost must be available before sending.

Custody: fork development-key executor owns the managers/transceivers, including upgrade, peers, threshold, pause and rate-limit powers. Local Guardian threshold 1 is a fixture. Exact addresses and Guardian set indexes are in route.json. Replays and process restarts use the same operations and signed bytes; costs include control and maintenance calls under the keeper operating cap.

The journal contains signed transactions and must remain private (0600). Stop by ending the foreground run; its exact Anvil children are stopped and awaited. No persistent service is delivered.

- mixed:arc-testnet-fork+robinhood-mainnet-fork; not a public route
- local Guardian threshold 1; public attestation unproven
- Arc ForkUsdc replaces native precompile settlement
- USDG provisional; pre-positioned by fork storage write; no quote refill
- USDG valuation fixture: 0.98 USDC per USDG, not parity or an FX execution proof
- native gas fixture: 5000 USDC/ETH; Robinhood L1 allowance synthetic, not measured
- development-key native balances; no public signing, funding or deployments
- finality: two locally mined confirmations, not public Guardian latency
