## Plugin submission

See `docs/plugins/CONTRIBUTING.md` before filling this out.

**Contract:** `contracts/plugins/fee-distribution/`
**Registry entry:** `src/content/plugins/registry.ts`

### What it does

<!-- One or two sentences: what split logic, for what use case. -->

### The two rules

- [ ] Never reverts on receipt — no `receive()`/`fallback()`/transfer hook that could block a
      fee accrual from `ArchitexFactory` or `ArchitexLaunchpad`.
- [ ] Distribution is pull-based — no payee can block another payee's withdrawal.

### Tests

- [ ] Happy path
- [ ] Adversarial inputs (zero-share payee, duplicate payee, funds arriving after a partial
      release, multiple tokens held simultaneously — whichever apply to this design)
- [ ] Fuzz test: released amounts never exceed what the contract received
- [ ] `bun run contracts:test` passes locally
- [ ] `bun run contracts:solhint` and `bun run contracts:slither` pass locally (CI re-runs both
      regardless)

### Registry entry

- [ ] `status: 'community'` and `submittedBy` set
- [ ] `constructorArgs` match the actual constructor
