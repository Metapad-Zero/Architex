## Recoverable shared-supply launch

This extends PR #7 at `ff8f643303fae742523891ea7ec9ca39b70f11cc`: executable synthetic jobs, issuance contracts and real-contract fork rehearsals. No public EQUILIBRIUM deployment, route transfer or real payment settlement has passed. Production adapters remain closed.

### Reconciliation

Remote main was `b27850d918646fe42debdc78c4c88f9eba65493f` when inspected. Dirty `arc-dex` main remains at `98829a0`; its `agent-launch` worktree contains an uncommitted x402 gateway with closed venues and zero ledger addresses. Its hold/launch/capture sequence has no durable shared-supply recovery record. This implementation uses the x402 v2 codec without importing that stateless sequence. The separate dirty `architex-agent` agents-only contract restriction remains an unresolved decision. All those worktrees and v1.4 work were preserved.

### Durable job contract

`server/equilibrium/` provides strict parsing, a dedicated PromotionalTokenAdapter, SQLite store, payment verifier, runner and HTTP service. Payer plus requestId identifies a request. A normalized payload hash binds canonical issuance/name/recipient/decimals, requested chains, recipients, allocations, pool inventory, expiry and cost cap. The job hash also pins adapter version, payment terms and budgets. Unknown fields and noncanonical atom amounts fail. EVM casing and destination order normalize. Tokens and quote amounts use six-decimal integer strings.

x402 v2 exact payment uses the job hash as EIP-3009 nonce. A client must honor `extra.authorizationNonce`; generic clients choosing random nonces need an extension. Verification binds domain/asset/network, payer, payee, amount and validity. Only synthetic settlement is executable today. Real USDC escrow/facilitator and deployment remain prerequisites.

The authorization is reserved durably against `(chainId, asset, nonce)` before the payment step may submit anything, so one authorization settles at most once even if a job row were restored from a backup or duplicated by a faulty deployment. A settlement receipt must prove the authorized total actually moved, not merely that a transaction exists; a receipt for a different amount, or none, stops the launch before issuance. The resulting `Settlement` — chain, asset, payer, payee, nonce, amount, transaction and finalization time — is recorded against that reservation and is readable on the free record on its own, alongside the fulfillment state. A second, differing settlement for the same authorization is refused.

Same payload resumes the original plan even after expiry or pricing changes. Conflicts return 409. An expired unpaid authorization never charges or issues; already settled fulfillment can continue. Adapter/version/payment configuration changes cannot silently resume a job.

Payment, issuance, manager, debit, credit and pool steps have independent planned/prepared/complete states. Prepared signed bytes or provider keys persist **before** submission. Restart observes that operation first. Pending/unknown evidence stops progression; proven absence allows the identical bytes to be resent. No replacement nonce, issuance salt or credit is generated for an uncertain effect. Receipts must match the operation, finality, bounded cost, issuance/transfer quantities and pool token/quote amounts. Real adapters must additionally authenticate chain, token/peers/configuration, canonical block inclusion and events. The runner trusts that adapter contract and cannot itself authenticate a fabricated receipt.

SQLite uses FULL sync, WAL, transactional revision fencing and renewable single-host leases. Tests include an actual child-process crash, reopen and expired lease. Synthetic external effects have a separate durable journal. `JobStorage` in `types.ts` is the contract the runner and service depend on, so a transactional shared database can replace the single-host store without touching either; it must reproduce the same revision fencing, lease renewal and settled-authorization uniqueness. `JobStore` migrates an existing file additively, so an older store opens without losing jobs.

A worker heartbeats its lease while an adapter call is outstanding, so a chain or provider call slower than the lease cannot orphan the effect it produced. A requested heartbeat interval longer than the lease is clamped to half of it rather than honoured, since a heartbeat that cannot fire inside the lease is no protection at all. The lease is additionally re-read immediately before `broadcast` and before `recordSettlement` — the two irreversible calls — so a worker already known to have lost its lease reaches neither the chain nor the settlement ledger. An adapter failure is reported as itself rather than being masked by the lost-lease error that follows it.

**This does not prevent every stale submission, and is a release blocker.** The pre-call re-read is point-in-time: the lease can lapse between that check and the moment the adapter actually puts bytes on the wire. The heartbeat is a timer, so an adapter that never yields — a synchronous signer, a blocking RPC client, a long CPU-bound encode — prevents any renewal from being attempted, and the lapse is neither prevented nor detected. What the fence buys is a much smaller window and a worker that stops after a *known* loss; it is not mutual exclusion over the external effect. Only the local adapter's `local_effects` primary key currently stops the duplicate row. Before real funds move, the destination has to reject the stale worker itself — a fencing token or provider idempotency key carried with the submission and enforced on the far side. See gate 6 of the [release preview](../public/equilibrium-release-preview.md).

`assertDurableStore` refuses to start the service on a host that discards prepared effects — an in-memory store, a temporary path, or a serverless marker such as `VERCEL` or `AWS_LAMBDA_FUNCTION_NAME`. The path is canonicalized before it is matched, so a symlinked temporary directory cannot slip past: on macOS `/tmp` is a symlink to `/private/tmp`, and both spellings name the same discarded disk. Canonicalization follows symlinks whose target does not exist yet, which `realpathSync` cannot do — it throws on a dangling link, and treating that as "nothing to resolve" let a durable-looking `store -> /tmp/jobs.sqlite` past the guard and then created the database on the temporary target anyway. A symlink loop is refused rather than followed. The guard returns the canonical path and callers open that, so the store that is opened is the one that was checked, and the check happens before anything creates a file. Whatever the host reports as its temporary directory is refused as well, under its real name and its alias. `EQUILIBRIUM_LEASE_MS` and `EQUILIBRIUM_RECONCILE_MS` must be positive whole numbers; a malformed value is refused at startup rather than coerced, because `Number('nope')` turns a sweep interval into a 1 ms loop and a lease into an already-expired one. Vercel ephemeral storage is unsuitable: `api/equilibrium.ts` provides free readiness and returns 503 for POST.

Recovery does not depend on a client re-sending the request. `reconcile` finishes jobs that already hold an authorization, are not complete and are owned by no live lease. `serve.ts` sweeps on boot and then on `EQUILIBRIUM_RECONCILE_MS` (default 30s), because a crashed worker still holds its lease and a fast restart alone finds nothing to resume. The sweep runs after the port opens, so one hung adapter call cannot keep the service unreachable, and a tick still in flight is not re-entered.

Unpaid quotes are never resumed; they have no effect to reconcile. Neither is a job whose last attempt submitted nothing: an expired authorization can never settle, and a route that closed before any effect went out will close the same way on the next tick, so the sweep would otherwise reclaim the same doomed job for as long as the process runs. Unresolved `pending` evidence is not a terminal failure and stays in the sweep. Progress restores eligibility, and an explicit client request always reaches the job directly regardless of the marker.

### Reproduce

```bash
bun install --frozen-lockfile
git submodule update --init --recursive
bun run test
bun run typecheck
bun run lint
bun run build
bun run equilibrium:rehearse
bun run equilibrium:contracts
forge test --match-contract EquilibriumTokenTest -vv
bun run equilibrium:probe
```

Fork tests/read-only probes require no signing key and never broadcast. `bun run test` scopes application tests to exclude vendored upstream NTT tests whose independent SDK dependencies are not installed here.

Run `bun run equilibrium:server`, then in another terminal `EQUILIBRIUM_JOB_SERVER=http://127.0.0.1:4042 bun run dev` for free local records. POST `/x402/equilibrium` returns a bound 402; retry with PAYMENT-SIGNATURE. GET `/equilibrium/jobs` and `/equilibrium/jobs/<id>` is free. Requests are capped at 16 KiB. Test fixtures show the strict request and signing format with a local test key only. `EQUILIBRIUM_DB`, `EQUILIBRIUM_LEASE_MS` and `EQUILIBRIUM_RECONCILE_MS` configure the store path, lease duration and sweep interval.

`bun run equilibrium:rehearse --db <path> --crash-step credit:base` kills a launch mid-flight; `bun run equilibrium:rehearse --db <path> --reconcile` then finishes it with no request and no signature, and starting `equilibrium:server` on that store does the same once the dead worker's lease expires.

The default synthetic two-chain job quotes 27.2 synthetic USDC: 1 platform fee, 6.2 execution fees and 20 pool quote principal. It issues 1,000,000 tokens once, with 500,000 in canonical custody backing 500,000 remote tokens. Re-running retains its addresses/payment. This fixture is distinct from the browser simulation and release allocation.

### Evidence and economics

Free records exclude signatures/prepared bytes. PAYMENT-RESPONSE describes settlement only; partial fulfillment is 202. Supply is derived from recorded steps, marked incomplete while submitted operations are unresolved, and is not an independent onchain audit. Platform fee, execution fees, deployed quote principal and held remainder are separate. Pending costs may already be spent; timeout does not imply refund.

The unspent remainder is reported as determinate only once every submitted effect resolved; while any operation is outstanding `funds.unresolvedEffects` names it and no refund may be decided from the figure. A remainder is marked refundable only when it is determinate, the launch is not complete and the amount is above zero — for example a venue that failed before its effect was ever prepared leaves exactly its step budget plus its undeployed quote inventory. This states what is owed, and does not move funds: no refund path is open.

The keeper's existing inventory, size, freshness, spending, loss and failed-leg limits are unchanged. Keeper net and whole-treasury holdings/open exposure remain distinct. Mainnet profitability, external paid demand, public finality, SVM execution and refills remain unproven. See [routes](EQUILIBRIUM-ROUTES.md) and [release preview](../public/equilibrium-release-preview.md).
