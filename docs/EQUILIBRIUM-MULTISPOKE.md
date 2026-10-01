## EQUILIBRIUM Arc–Base–Robinhood: one paid launch job (fork composition)

Status on 2026-09-30: **fork-only.** This proves that one x402-paid job can pay once, issue once and credit both the Base and Robinhood spokes from a single Arc hub, on forks. It opens no public route. Robinhood stays closed on all seven gates (`docs/EQUILIBRIUM-ROBINHOOD.md`), and Solana is not part of this job.

### Sources and what this branch composes

| Source | Head | What it contributes |
| --- | --- | --- |
| PR #12 | `5a65b20` | Arc–Base adapter, executor idempotency, reproducible bytecode, receipt-fee diagnostics |
| PR #18 | `a019f43`, then `22adede` | Robinhood route/fulfillment, including #16's `85265da`, and the rule that a payment reservation is released only when chain state proves it can never settle. `22adede` (independently reviewed) adds finalized payment attribution, the residual ledger, refund states and shared-journal USDC claims. |

#12 and #18 diverge at `add47bb`. This branch merges #12 at `5a65b20` and #18 at `a019f43` (`64aeb31`), then #18's correction at `22adede` (`0748981`). All merges are conflict-free because the sources change disjoint files. Every source head is an ancestor of this branch, and no source branch was modified.

Neither source adapter can run a combined job on its own. #12 peers its hub to Base only. #18 adopts a hub, deployed beforehand, that is peered to Robinhood only. Their address layouts also differ, so routing steps to each adapter would issue two assets. The composition in `server/equilibrium/multispoke/` plans one layout for both spokes instead. It reuses the pinned bytecode, ABIs, VAA signer and v3 math from `evm/`, plus the Robinhood pins and fork start from `robinhood/`. Those source files are unchanged.

| File | Role |
| --- | --- |
| `multispoke/adapter.ts` | One `PromotionalTokenAdapter` for `arc,base,robinhood`: one hub with both peers, per-spoke manager, debit, credit and pool steps, launch slots, and chain-read supply. It refuses any non-loopback RPC and any other destination set. |
| `multispoke/fork.ts` | Harness with three forks: Arc testnet, Base Sepolia and Robinhood mainnet. |
| `multispoke/serve.ts` | Labelled HTTP service. |
| `multispoke/__tests__/` | Fork suite and a separate worker process. |

It keeps its own ports: Arc 18755, Base 18756, Robinhood 18757 and service 4048. It also keeps its own journal tables (`multispoke_*`) and never reads or writes the `evm_*` or `robinhood_*` journals.

### The job

There are twelve steps. Each is one `EquilibriumExecutor.execute(operation, digest, calls)` with `operation = hash([job.id, step.id])`. A second execution reverts `OperationDone`.

| Step | Chain | Effect |
| --- | --- | --- |
| payment:arc | Arc | EIP-3009 `transferWithAuthorization` of the quoted total to the Arc executor. The nonce is the job id. |
| canonical:arc | Arc | CREATE2 `EquilibriumCanonical`. The fixed issuance goes to the executor. |
| manager:arc | Arc | NTT manager (LOCKING) and transceiver, **peered to both spokes**, with an inbound limit per peer. |
| pool:arc | Arc | Architex pair seeded with the exact inventory. The executor keeps only the two spoke allocations. |
| manager:base, manager:robinhood | spoke | `EquilibriumSpoke` (zero supply) and NTT manager (BURNING) + transceiver, peered to the hub, then `setMinter`. |
| debit:base, debit:robinhood | Arc | Lock the allocation in the hub. The step is complete only once the VAA for the destination core is signed. |
| credit:base, credit:robinhood | spoke | `receiveMessage(VAA)` mints the allocation to the spoke executor. |
| pool:base, pool:robinhood | spoke | New Uniswap v3 pool (Base USDC / Robinhood USDG fixture) and the recipient's remainder. It refuses a pool it did not create. |

**Launch slots** combine #12's one-launch scope with #18's release rule. With `launches` set, at most that many jobs may hold a payment authorization at once. The payment step takes a slot in an IMMEDIATE transaction before anything is sent. A slot moves only when a block `confirmations` deep shows two things: the payment operation is unexecuted, and the authorization has expired or its nonce is spent. A released job is refused with `payment_failed` from then on.

**Money** carries #18's correction into the composition:

- **Attribution.** A spent nonce is never taken on trust. At a block `confirmations` deep, the adapter finds the block where the nonce flipped (step back, then bisect). That block must hold exactly one `AuthorizationUsed`/`AuthorizationCanceled` log for (payer, nonce). The transfer following that log, in that transaction, is matched against the bound payer, executor and amount. The outcome is one of four:
  - `used_outside_job`: the bound payment reached the executor, but outside the job;
  - `spent_by_other_authorization`: another authorization under the same nonce moved some amount, possibly to the executor;
  - `cancelled`;
  - `expired_unused`.

  An unrelated USDC transfer to the executor is never attributed. Anything less certain keeps the slot held.
- **Ledger.** The release and the original job's money are written in one transaction to `multispoke_payment_ledger`: authorized, received, fees spent (always 0, since a released job executed nothing), residual, evidence transaction and block, and refund state (`none`, `owed`, `submitted` or `refunded`). The release is permanent. A successor never inherits the residual.
- **Claims.** Every Arc send that moves executor USDC first commits a durable claim in `multispoke_usdc_claims`. That covers a job's `pool:arc`, a refund and an operator send. The claim then checks the executor's balance, read `confirmations` deep, against owed residuals and every other claim not executed at that depth. A claim is dropped only when the send is refused before anything is signed. Two racing sends can never both pass. Both may be refused, which is the conservative outcome. Claims are per journal: **run one journal per executor.**
- **Refund.** `refund(job)` moves exactly the residual back to the payer as one persisted executor operation (`hash([job, 'refund:arc'])`), so it executes at most once across restarts and processes. `refundStatus` reports `owed`, `prepared`, `uncertain`, `submitted` or `refunded`. The ledger says `refunded` only once the executing receipt is `confirmations` deep.
- **Operator sends.** `operatorSend(name, to, amount)` moves only unowed executor USDC. It executes at most once per name, and the same name with other parameters is `operation_conflict`.
- **Completed-job USDC.** `usdcAccount(job)` is read from the job's own receipts:
  - in: the payment;
  - out: only the Arc pool's quote;
  - held: everything else, broken into the platform fee, the reserve for the spoke pools' quote, and the step budgets.

  The spoke pools' quote was injected on Base and Robinhood from pre-positioned inventory; no Arc USDC moved for it. The operator paid the steps' gas in native currency from its own account. That cost is reported as reimbursable from the held budgets, not as USDC the executor spent.
- **Executor reconciliation.** `executorUsdc()` checks the executor's balance against the journal: payments less Arc pool quote, plus owed residuals, less operator sends. Anything left over is reported as **unattributed**, never assigned to a job.
- **Public record.** The public record (`view`) is corrected to match:
  - released jobs show their attribution, held-for-payer amount and refund state;
  - completed jobs show `quoteInventoryDeployed` as the Arc pool quote only, with spoke quote injection, native operator costs and held USDC listed separately.

**Supply** (`adapter.supply(job)`) is read from chain state only. It covers Arc issuance, hub custody, both spoke total supplies, and in-flight claims (debit executed on Arc, credit not yet executed on the spoke). Reconciled means three things hold:

- issuance equals the bound issuance;
- canonical outside custody + base + robinhood + in-flight = issuance;
- custody = base + robinhood + in-flight.

### Fork evidence

```sh
EQUILIBRIUM_MULTISPOKE_FORK=1 bun test server/equilibrium/multispoke   # 15 cases, about 70 s; evidence in output/multispoke-fork-evidence.json
```

| Test | What it establishes |
| --- | --- |
| quote and conflicts | A real service process quotes 402 bound to the Arc executor, with one payment for all twelve steps. It refuses a changed payload under the same requestId (`identity_conflict`), Arc+Base only or Arc+Robinhood only (`route_closed`), and a header signed for another job's quote (`invalid_payment`). The payer balance, the authorization nonce and the canonical address are untouched. |
| paid launch, crash and sweep | The service is SIGKILLed right after the `debit:robinhood` send. At that point Base is credited, Robinhood is in flight, and supply reconciles with the in-flight claim. A restarted service finishes the job from the journal with no client resend. One charge of exactly the quoted total. Arc 1,000,000 EQL issued; hub custody 30,000 backs Base 10,000 plus Robinhood 20,000. All three pools hold their exact inventory. Executors hold no EQL. Each of the twelve operations executed exactly once. The hub's Wormhole peers are both spoke transceivers. The real Robinhood QuoterV2 prices both directions against the job's pool. |
| resend | Re-posting the paid request returns the same job with HTTP 200. Nothing executes and nothing is charged. |
| crash + racing workers | A worker process is SIGKILLed after the `credit:base` send. Two workers then race, and the lease admits one; the other gets `job_busy`. Every effect happens once. The snapshot taken after the crash cannot be saved (`stale_worker`), and broadcasting its persisted bytes changes nothing. |
| stale adapter | Two adapter instances broadcast the same prepared `debit:robinhood` concurrently. Tokens move once. |
| replays | Re-broadcasting every step, the operator's raw `execute`, both VAAs replayed to their transceivers and the payer's authorization replayed on USDC all revert or do nothing. Tampered bytes are refused. Re-signed bytes for an executed operation are refused (`operation_conflict`). Supply is unchanged. |
| failed payment, retry | With the payer's balance gone, the payment reverts. The response is 503, the job is `partial`, and there is no charge, no issuance and no execution. After a top-up, the same request completes with one charge. |
| one launch slot | A failed payment holds the only slot, and another launch is refused `launch_limit` before quoting. Once the authorization expires on chain, the next attempt releases the slot (`payment_failed`, "authorization expired" at a recorded Arc block), and repeats stay refused. A new request then launches with one charge. The expired authorization cannot be replayed, and a third launch is refused because the settled holder keeps the slot. |
| delayed finality | With 3 Robinhood confirmations, `manager:robinhood`, `credit:robinhood` and `pool:robinhood` each wait `pending` and then complete. Each operation executes once. |
| unrelated receipt | Fresh Arc executor, 2 Arc confirmations. A held job's payment fails, and a stranger then transfers exactly the quoted amount to the executor. The job stays held, nothing is attributed, and `executorUsdc` reports the deposit as unattributed. |
| spent nonce, finality, successor isolation | The payer submits the job's authorization directly to USDC. One block deep the job is still held. Two blocks deep it is released for good as `used_outside_job`, with the evidence transaction, residual 89 USDC and refund `owed`. A repeat is refused. A successor launches with its own payment. Its `usdcAccount` shows 89 in, 10 Arc pool quote out, 79 held (fee 1 + spoke quote reserve 20 + step budgets 58), Base and Robinhood quote injected (10 each), and reconciles. The executor holds the stranger deposit + residual + 79. An operator send of one atom more than the unowed balance is refused `residual_reserved`. |
| refund: uncertain send, restart, replay | A refund worker is SIGKILLed right after sending. The journal reports `prepared` and the residual stays reserved. Resumed in another process, the refund is `submitted`, then `refunded` once 2 blocks deep. The payer gets exactly the residual once, with one execution. Repeat calls return the final ledger, and the operator's raw execute reverts. |
| other terms | An authorization for 50 USDC under the job's nonce is attributed as `spent_by_other_authorization`. It is not counted as paid, is held for the payer, and is refunded once. |
| cross-process operator sends | Two worker processes each try to send just over half the executor's balance. They never both succeed. The same name with other parameters is refused `operation_conflict`, and the balance and unattributed figures reconcile afterwards. |
| public record | `/api/equilibrium` shows the fixed labels, `publicRobinhoodRoute: closed`, and chain-read supply reconciled for every completed job. |

### Labels and substitutions

These are fixed in `MULTISPOKE_LABELS`, and a configuration cannot relabel them. Every service response carries `x-equilibrium-environment: mixed:arc-testnet-fork+base-sepolia-fork+robinhood-mainnet-fork` and `x-equilibrium-payment: fork-fixture`.

Fork-local substitutions:

- one local Guardian key in each core;
- ForkUsdc at Arc's native USDC address, with an anvil payer;
- Base USDC and Robinhood USDG quote inventory written to the spoke executors' storage;
- shanghai rules on the Robinhood fork;
- Robinhood Arbitrum gas, including its L1 component, is not modelled; Base L1 fees are bounded by the OP oracle.

Arc's anvil clock trails wall time on this fork, about 4 hours in the recorded run. The slot test therefore brings the next Arc block up to wall time, never past it, before proving expiry. This is the same fork artifact #18 records.

### What this does not prove

- Public Guardian attestation, Arc's real USDC precompile path, and real Base or Robinhood fees.
- Any public or funded route. Robinhood's seven gates are unchanged.
- The Solana spoke. It is excluded until its owner (49TH-34) delivers a pinned, reviewed interface. The four-chain composition with the queued-claim Solana branch is [EQUILIBRIUM-FOURCHAIN.md](EQUILIBRIUM-FOURCHAIN.md) (49TH-44); it leaves this three-chain job unchanged.
- Return transfers, quote refill and keeper maintenance on the composed job (49TH-28/29 cover Arc–Base only).
- Operator gas caps and the approval digest of #12's testnet release gate. That gate still covers Arc–Base only and is untouched here.
- Reimbursing operator gas from held budgets, and disbursing the platform fee. Both are reported, not moved.
- A `cancelled` outcome on chain. ForkUsdc has no `cancelAuthorization`, so that path is implemented but unexercised.
- Coordination between journals that share one executor. Claims and residuals are per journal.
