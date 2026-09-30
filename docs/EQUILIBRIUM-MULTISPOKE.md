## EQUILIBRIUM Arc–Base–Robinhood: one paid launch job (fork composition)

Status on 2026-09-30: **fork-only.** This proves that one x402-paid job can pay once, issue once and credit both the Base and Robinhood spokes from a single Arc hub, on forks. It opens no public route. Robinhood stays closed on all seven gates (`docs/EQUILIBRIUM-ROBINHOOD.md`), and Solana is not part of this job.

### Sources and what this branch composes

| Source | Head | What it contributes |
| --- | --- | --- |
| PR #12 | `5a65b20` | Arc–Base adapter, executor idempotency, reproducible bytecode, receipt-fee diagnostics |
| PR #18 | `a019f43` | Robinhood route/fulfillment, including #16's `85265da`, and the rule that a payment reservation is released only when chain state proves it can never settle |

#12 and #18 diverge at `add47bb`. This branch merges both heads without conflicts; the two change disjoint files. Both heads are ancestors of this branch, and neither source branch was modified.

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

**Supply** (`adapter.supply(job)`) is read from chain state only. It covers Arc issuance, hub custody, both spoke total supplies, and in-flight claims (debit executed on Arc, credit not yet executed on the spoke). Reconciled means three things hold:

- issuance equals the bound issuance;
- canonical outside custody + base + robinhood + in-flight = issuance;
- custody = base + robinhood + in-flight.

### Fork evidence

```sh
EQUILIBRIUM_MULTISPOKE_FORK=1 bun test server/equilibrium/multispoke   # about 65 s; evidence in output/multispoke-fork-evidence.json
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
- The Solana spoke. It is excluded until its owner (49TH-34) delivers a pinned, reviewed interface.
- Return transfers, quote refill and keeper maintenance on the composed job (49TH-28/29 cover Arc–Base only).
- Operator gas caps and the approval digest of #12's testnet release gate. That gate still covers Arc–Base only and is untouched here.
