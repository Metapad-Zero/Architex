## EQUILIBRIUM: executable local proof

Open `/#equilibrium` under `bun run dev`, or `/app/#equilibrium` in a production build. The page is lazy loaded; existing swap, pools, launch, bridge and docs routes retain their behavior.

The simulation extends the 49TH-16 concept into a reviewable implementation. It uses four modeled pools; no wallet, RPC, relayer or credentials are required.

`bun run equilibrium:export` packages the same React view, font, theme and implementation checklist into `output/equilibrium/equilibrium-demo.html`. Download and open it in a browser for an offline demonstration. It has no external scripts or runtime network dependencies. Browser storage remains optional; downloaded sessions carry the complete state.

### Reproduce the example

1. Reset the simulation.
2. Create demand with 200 simulated USDC on Solana.
3. Run the balancing agent. The selected route buys 80 tokens on Arc and sells 80 from existing Solana inventory.
4. Inspect the receipt: the gap falls from 16.61408% to 8.96564%; net keeper cash is 4.020664 simulated USDC after 3 USDC operating costs. Quotes include a 0.30% pool fee. Atom rounding accounts for the small difference from the brief's floating-point arithmetic.

The agent searches 1–80 whole-token quantities across fresh routes. It requires at least 0.25 USDC of edge after operating costs and a 1 USDC buffer. Session spending is capped at 1,000 USDC; gross realized losses at 10 USDC. These are illustrative policy inputs, not recommended live settings.

### Supply and transfers

The initial 1,000,000 units are distributed equally across four markets, including public holdings, pool reserves and agent inventory. Canonical Arc custody backs remote representations. All amounts use six-decimal bigint units.

```text
Arc outside custody + remote representations + pending credits = fixed issuance
canonical custody = remote representations + pending credits
```

A source debit creates one pending transfer. Completion credits once. Replaying a completed transfer has no effect. Spoke-to-spoke inventory moves require a return to Arc and then a new outbound transfer. Failed destinations leave the original claim pending; no timeout refund creates an extra claim.

The local UI drives both debit and credit to demonstrate accounting. There is no authenticated-message verifier here. Production supply proof requires pinned bridge contracts, finalized observations and actual route tests.

### Failures and persistence

Open “Test the guardrails and bridge.” Increase costs, mark a chain stale/offline, move agent inventory, or simulate a failed sale. A failed sale leaves a bought position open and pauses the keeper. Recovery sells the bought amount back on the purchase market, includes the original operating cost plus a 1 USDC recovery cost, and refuses to exceed remaining loss, spending or cash limits. Market shocks during a halt can make recovery unsafe; the page leaves the position paused instead of silently ignoring the limit.

Validated snapshots survive browser reloads, including pending transfers and open exposure. Invalid storage starts a fresh model with an explicit notice. Storage restrictions do not stop the active simulation. “Download session” exports the complete state and action record; `restoreDemo` validates exported state for programmatic replay. This client-controlled state is not tamper-proof or an audit record of real transactions.

Each command clones and validates the state before returning it. An exception does not partially commit a mutation. The tests cover the brief's arithmetic, exact bridge round trips for all spokes, pending and duplicate messages, unknown transfers, availability, inventory/cost/budget limits, failed-leg recovery, malformed snapshots and 120 rounds of mixed activity.

### Economics and scope

Keeper profit and whole-treasury profit differ. In a matched cycle the pool/keeper combined token holdings stay constant and their combined quote holdings decrease by operating costs. Customer buys change both holdings; quote cash alone is not treasury profit. Closed-cycle keeper net excludes any unresolved exposure.

The live readiness checklist ships as `public/equilibrium-readiness.md`, linked from the page. The DEX main checkout, v1.4 worktrees, `architex-agent` experiment and `agent-launch` draft were inspected without modifying their dirty work. This implementation starts from merged main `b27850d`; it does not import the uncommitted gateway or agents-only contract experiment.

### Validation

```bash
bun test src/lib/__tests__/equilibrium.test.ts
bun run typecheck
bun run lint
bun run test
bun run build
```

The simulation's transfer and action IDs remain simulation IDs. The additional integration record reads free job evidence and dated infrastructure observations with explicit local/fork/testnet/live labels. See [recoverable integration](EQUILIBRIUM-INTEGRATION.md), [route matrix](EQUILIBRIUM-ROUTES.md) and [release preview](../public/equilibrium-release-preview.md). Real settlement, public bridge transfers and funded deployment remain closed pending those prerequisites and approval.
