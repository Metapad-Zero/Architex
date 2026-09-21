## Plugin submission

Read `docs/plugins/CONTRIBUTING.md` first.

**Contract:** `contracts/plugins/launch/`
**Registry entry:** `src/content/plugins/`

### What it does with a token's creator fee

<!-- One or two sentences. -->

### The rules

- [ ] Declares `IArchitexFeePlugin` through ERC-165, and the answer can't change.
- [ ] `onFees` pulls exactly `amount` from `msg.sender` and credits only that, per token.
- [ ] `onLaunch` is authenticated with `pluginOf(token)`, and its config is write-once per token.
- [ ] Does not trade, add liquidity or call the launchpad inside a hook.
- [ ] Pays out by pull, never push.

### Tests

- [ ] Happy path, including the end-to-end payout.
- [ ] An attacker pre-configuring a token is rejected; under- and over-pulls revert; two tokens never mix.
- [ ] Fuzz: paid out never exceeds received.
- [ ] Invariant: USDC held equals the sum of per-token balances.
- [ ] `bun run contracts:test`, `contracts:solhint` and `contracts:slither` pass locally.
