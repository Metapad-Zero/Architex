## EQUILIBRIUM Arc–Base–Solana–Robinhood: one paid launch job (fork + local validator)

Status on 2026-09-30: **local only.** One x402-paid job pays once, issues once on Arc and fulfils Base, Solana and Robinhood from a single Arc locking hub. Arc, Base and Robinhood are anvil forks. Solana is a local `solana-test-validator`. No public route is open, nothing was signed for or broadcast to a public network, and nothing was funded.

Run it with `bun run equilibrium:solana:build` once, then `bun run equilibrium:fourchain`. The evidence is written to `output/equilibrium/fourchain-evidence.json`.

### Sources and composition

| Source | Head | Contributes |
| --- | --- | --- |
| PR #25 (stacked on #20) | `e1ff0f8` | EVM composition: one hub, Base and Robinhood spokes, launch slots, payment attribution, residual ledger, serialized journal startup |
| Queued Solana job binding (`agent/coding-worker/61a4161b9b4a`, stacked on #23 `f9f1a2a`) | `7d17874` | Solana spoke steps, the queued-claim contract (`QueuedClaim`, `Observation`), the runner's claim handling, SVM pins and the validator, clock and seed fixtures |

The two stacks diverge at `02a35be`. Merging `7d17874` into `e1ff0f8` (`d6dff00`) conflicts only in `package.json` scripts, and both sides were kept unchanged. Neither source branch was modified. Both source heads are ancestors of this branch and stay pending independent review. This composition does not accept them.

The merge alone does not produce a four-chain job. The EVM adapter refuses any destination set other than `arc,base,robinhood`. The Solana route uses its own Arc contracts (issuance factory, route registry, distributor, payment fixture), so routing the Solana steps to it would issue a second asset. This branch adds the Solana spoke to the EVM composition's own hub instead:

| File | Change |
| --- | --- |
| `server/equilibrium/multispoke/solana.ts` | New. The Solana half of `manager`, `credit` and `pool`, using the queued-claim branch's step logic. It is keyed to the composition's hub, so the spoke peers the executor-deployed hub manager and transceiver. |
| `server/equilibrium/multispoke/adapter.ts` | With `solana` configured: the hub also peers to the pinned SVM manager and its emitter PDA. `debit:solana` is an ordinary Arc executor operation that locks the allocation and records the published message. The adapter accepts exactly `arc,base,solana,robinhood`. Supply, USDC accounting and the version also cover Solana. Without `solana`, plans, version hash and outputs match #25 byte for byte, and the three-chain fork suite passes unchanged. |
| `server/equilibrium/runner.ts` | Spoke lanes (see below). |
| `server/equilibrium/multispoke/fourchain.ts` | Harness: the three forks on their own ports, the validator, the Solana fixtures, and a loopback proxy in front of Robinhood. |
| `server/equilibrium/multispoke/__tests__/fourchain.test.ts`, `fourchain-worker.ts` | The composed rehearsal and a worker process for real SIGKILL restarts. |
| `server/equilibrium/__tests__/lanes.test.ts` | Unit regression for the runner defect. |

Ports: Arc 18855, Base 18856, Robinhood 18857 (proxy 18858), Solana 18899 (faucet 19000). The journal is a fresh `output/equilibrium/fourchain-journal-*/jobs.sqlite`. These ports and this journal are separate from the three-chain, Arc–Solana, keeper and refill suites.

### Defect found and repaired: one held spoke stalled the whole job

The runner walked the steps in order and returned at the first step that was held, pending or failing. A queued Solana claim, which can be held for 24 hours, therefore kept Robinhood's steps from ever being attempted. An unreachable Robinhood RPC also failed the whole job and took it out of the sweep. `lanes.test.ts` reproduces both cases: the runner at `d6dff00` fails two of its four tests.

Each spoke's steps depend on the Arc steps and on nothing in another spoke. The runner now handles each spoke lane on its own:

- A held claim, an unfinalized effect, or a transport failure (connection refused or reset, a timed-out request) defers only that spoke's remaining steps. The other lanes are still worked, and the job stays `partial` and sweep-eligible with every lane's reason in `error`.
- Integrity failures (an operation conflict, a receipt that does not prove its allocation, a ledger mismatch) still stop the whole job.
- An Arc step never defers, because every lane depends on it.

### The rehearsal: one job, sixteen steps

The pinned SVM manager keeps one config per program, so the validator holds one mint, and every case runs on the same job. Run figures (job `0x97d9ba1a…77fb10`, adapter `multispoke-arc-base-solana-robinhood-v1:8a1f11af273448ec`):

| Case | What happened |
| --- | --- |
| Quote and refusals | The 402 quote binds 16 steps for a total of 118,000,000 USDC atoms. The same request returns the same job. A changed Solana amount is refused with `identity_conflict`, and a request without Solana with `route_closed`. Nothing was charged. |
| Paid while degraded | The Robinhood proxy was closed, and the spoke's inbound limit (10,000,000,000) is below the Solana allocation (30,000,000,000). The paid request returns 202 with a `payment-response`. Settlement `0x19c9749a…0689d5` is recorded for exactly the total, and the payer is charged once. Arc and Base complete. `debit:solana` locks the allocation, and the pinned manager holds the delivery as a claim. Its boundary is 86,400 s past the validator's clock, measured, not assumed. `manager:robinhood` cannot reach its chain, so its lane is deferred. The free record shows `settled` beside `fulfillment: incomplete` and `queued: 30000000000`. |
| Early release | Releasing the claim directly is refused by the program (`CantReleaseYet`, 6000), and the mint supply stays 0. The reopened journal's sweep submits nothing and keeps the claim's first-seen time. |
| Restart after an irreversible credit | With Robinhood reachable again, a worker process runs the job and is SIGKILLed right after it sends `credit:robinhood`, before anything is recorded. The credit is on chain while the journal says `prepared`, and supply reconciles. The killed worker's lease blocks the sweep until it lapses. The restarted journal then completes the Robinhood lane by observing the credit, without sending it again: one execution, no journalled resend, and spoke supply exactly 20,000,000,000. |
| Validator restart with the claim outstanding | After SIGKILL the reopened ledger returns the same claim (reference, amount, recipient, boundary, first-seen time). Arc custody, read live from a fork that never restarted, still backs it. |
| Boundary passes | The finalized spoke ledger (19 accounts) is dumped and rebuilt at a new genesis with `CLOCK_REALTIME` offset by +86,460 s, and all accounts come back byte-identical. The sweep then releases the claim once and places the Solana inventory atomically. The job completes, and the claim keeps `queuedAt` and gains `releasedAt`. Releasing again is refused (`TransferAlreadyRedeemed`, 6007). |
| Replays | Re-posting the paid request returns 200 with the same settlement. The settled authorization resubmitted to USDC reverts (`AuthorizationAlreadyUsed`). A changed payload is refused. Every EVM operation executed exactly once, and the payer was not charged again. |

### Supply in common six-decimal atoms (observed, not calculated)

| Checkpoint | Arc custody | Base | Robinhood | Solana (SPL) | In flight | Of which queued | Canonical outside custody | Reconciled |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Partial | 40,000,000,000 | 10,000,000,000 | 0 | 0 | 30,000,000,000 | 30,000,000,000 | 960,000,000,000 | yes |
| Claim outstanding | 60,000,000,000 | 10,000,000,000 | 20,000,000,000 | 0 | 30,000,000,000 | 30,000,000,000 | 940,000,000,000 | yes |
| Complete | 60,000,000,000 | 10,000,000,000 | 20,000,000,000 | 30,000,000,000 | 0 | 0 | 940,000,000,000 | yes |

Issuance is 1,000,000,000,000. Each figure is read from its own chain: the Arc token's supply and the hub's balance, each EVM spoke token's supply, and the SPL mint's supply plus the burning spoke's custody account (always 0). In flight means the debit executed on Arc and the delivery was not released on the destination. A queued claim is part of in flight and is reported beside it, never added again. Reconciliation requires `outside + remote + in flight = issuance`, `custody = remote + in flight` and an empty Solana custody account.

### Money, fees and what is still owed

| Item | Figure | Status |
| --- | --- | --- |
| Paid in (Arc USDC fixture) | 118,000,000 | One settlement |
| Arc pool quote, actually spent | 10,000,000 | Moved to the pool |
| Held on the Arc executor | 108,000,000 | Platform fee 1,000,000 + spoke quote reserve 30,000,000 + step budgets 77,000,000 |
| Spoke pool quote | 10,000,000 each on Base, Robinhood and Solana | Fixture liquidity injected on the spoke, not bridged and not revenue |
| Operator EVM gas, valued in USDC atoms | Arc 95,418, Base 423,714, Robinhood 902,441 (total 1,421,573) | Paid natively by the operator. Reimbursable from the held budgets; **not reimbursed** |
| Operator Solana spend | 22,539,920 + 6,127,840 = 28,667,760 lamports | Fee-payer balance deltas, fees and rent deposits together. Not converted to USDC and not reimbursed |
| Unspent step budget | 75,578,427 | Held. **No refund or disbursement policy was executed** |

The outstanding fee and gas acceptance gate is **not** passed by this run. Fork and validator gas is not public pricing, Robinhood's L1 component is not modelled, and Solana steps report a zero launch cost because SOL has no honest conversion into the launch's atoms.

### What this does not prove

- Any public or funded route, Guardian attestation (one development key on every core), Arc's real USDC precompile, or real Base, Robinhood or Solana fees.
- An unassisted 24-hour wait. The clock moves by a ledger rebuild under a macOS `DYLD_INSERT_LIBRARIES` fixture. On other hosts the release case fails with the reason.
- A second concurrent job with a Solana leg. The pinned SVM manager holds one config, so one mint, per program deployment, and the spoke refuses a config bound to another mint.
- Return transfers, refill, keeper composition (#24's accepted Robinhood keeper head `81d167a` stays separate), halt authority, or any market adapter on Solana. The Solana pool step places inventory into an unsignable holder; it does not open a venue.
- That #20, #25 or the queued Solana branch are accepted. Their independent reviews are unchanged.
