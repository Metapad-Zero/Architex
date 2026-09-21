# Submitting a fee-distribution plugin

A plugin is anything usable as `feeTo` on `ArchitexFactory` (which pays LP tokens) or
`ArchitexLaunchpad` (which pays USDC) other than a plain wallet — usually a contract that splits
what it receives among more than one recipient. There is no in-app submission form and no
on-chain registry: this catalog is a file in the repo (`src/content/plugins/registry.ts`), edited
by pull request, reviewed like any other change to a contract in this codebase.

## Why PR-based, not a form or an on-chain registry

A `feeTo` plugin holds real, ongoing fee revenue. A form or a permissionless on-chain registry
would let anyone list an entry that looks legitimate in the marketplace UI without anyone from
Architex having read the code — the PR is the review gate, not a formality on top of one. If you
want a fully permissionless list instead, that's a fair design choice, just a different one than
this repo makes: fork the registry file.

## The two rules

1. **Never revert on receipt.** This one you don't have to do anything for — `ArchitexFactory`
   pays a plugin with a plain `_mint` (LP tokens) and `ArchitexLaunchpad` pays with a plain
   `safeTransfer` (USDC). Neither calls back into the recipient, so nothing your contract does can
   block or revert a fee accrual. Don't add a `receive()`/`fallback()` or a transfer hook that
   could change this.
2. **Distribution must be pull-based.** A payee (or anyone on their behalf — see
   `WeightedSplitDistributor.release`, callable by anyone for any payee) withdraws their own
   share. Never push funds to a list of addresses in one transaction: one bad address (a
   contract that reverts, a blocklisted address, one that's simply out of gas to receive) must
   never block everyone else's payout.

Beyond those two, a plugin can implement any split logic: equal, weighted, streaming/vesting,
milestone-based, whatever. It does not need to implement `IFeeDistributor`
(`contracts/interfaces/IFeeDistributor.sol`) to work as `feeTo` — a plain multisig works fine —
but it must to be listed here, so the marketplace UI and other contracts can read `payees()` /
`releasable()` / call `release()` without knowing your specific contract.

## Submission checklist

1. Add your contract under `contracts/plugins/fee-distribution/YourPluginName.sol`, implementing
   `IFeeDistributor`.
2. Add Foundry tests under `contracts/test/plugins/YourPluginName.t.sol`. At minimum: happy path,
   the two rules above hold under adversarial inputs (a zero-share payee, a duplicate payee, funds
   arriving after a partial release, multiple tokens held simultaneously), and a fuzz test that
   released amounts never exceed what the contract received.
3. Add an entry to `PLUGIN_REGISTRY` in `src/content/plugins/registry.ts`:
   `status: 'community'`, your `submittedBy`, and accurate `constructorArgs` — this is what
   drives the marketplace page, not your contract's NatSpec.
4. Run `bun run contracts:test`, `bun run contracts:solhint`, and `bun run contracts:slither`
   locally — all three run in CI on your PR regardless (`.github/workflows/contracts-security.yml`),
   but catching issues before review is faster for everyone. There is no third-party audit
   requirement to be listed as `community` status (the whole app doesn't have one either — see
   `SECURITY.md`), but a plugin with unresolved high/critical findings from any of the three tools
   will not be merged.
5. Open a PR using the plugin-submission template: GitHub shows a template picker when you open
   the PR (multiple templates live under `.github/PULL_REQUEST_TEMPLATE/`), or go directly to
   `.../compare/main...your-branch?template=plugin-submission.md`.

## What review checks

Same bar as any other contract change to this repo: does it do what the description says, does it
hold to the two rules above under adversarial input, do the tests actually exercise that. Review
is by a human reading the diff — the CI tools catch known bug classes, they don't replace that
reading.
