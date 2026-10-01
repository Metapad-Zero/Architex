EQUILIBRIUM 49TH-40 Robinhood keeper — FORK ONLY, public route closed.

- mixed:arc-testnet-fork+robinhood-mainnet-fork; not a public route
- local Guardian threshold 1; public attestation unproven
- Arc ForkUsdc replaces native precompile settlement
- USDG provisional; pre-positioned by fork storage write; no quote refill
- USDG valuation fixture: 0.98 USDC per USDG, not parity or an FX execution proof
- native gas fixture: 5000 USDC/ETH; Robinhood L1 allowance synthetic, not measured
- development-key native balances; no public signing, funding or deployments
- finality: two locally mined confirmations, not public Guardian latency

Vaults, assets, pools, finality, operator powers, valuation expiry, fee inputs and every bound are fixed by keeper.json and the keeper manifest below. The operator owns the vaults and may run legs, halt, resume, attest a remote close and withdraw while the vault permits it. This is not a bridge proof for remote trade closure; the operator attests a finalized receipt.

Recovery: pause new admissions, retain the private journal, reconcile signed transactions and finality, unwind the same position only within the remaining loss limit, then resume. Never delete a pending claim or change an operation to get past a refusal. After a signed-before-send crash, replay the persisted signed bytes. Fixture expiry or unavailable inputs refuse sends; an unresolved journal must be reviewed before changing its bound manifest.

Keeper profit is conservative USDC-reference valuation of receipts. It does not execute USDG→USDC conversion. Leg gas appears once in trading net; controls and maintenance appear once in combined net. Principal and internal volume are not revenue. Pool/treasury income and external customer revenue are not evaluated in this rehearsal.

No owner authorization, deployment, funding or campaign approval is requested by this fixture bundle.
