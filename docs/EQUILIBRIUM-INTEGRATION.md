## Recoverable shared-supply launch

This extends PR #7 at `ff8f643303fae742523891ea7ec9ca39b70f11cc`: executable synthetic jobs, issuance contracts and real-contract fork rehearsals. No public EQUILIBRIUM deployment, route transfer or real payment settlement has passed. Production adapters remain closed.

### Reconciliation

Remote main was `b27850d918646fe42debdc78c4c88f9eba65493f` when inspected. Dirty `arc-dex` main remains at `98829a0`; its `agent-launch` worktree contains an uncommitted x402 gateway with closed venues and zero ledger addresses. Its hold/launch/capture sequence has no durable shared-supply recovery record. This implementation uses the x402 v2 codec without importing that stateless sequence. The separate dirty `architex-agent` agents-only contract restriction remains an unresolved decision. All those worktrees and v1.4 work were preserved.

### Durable job contract

`server/equilibrium/` provides strict parsing, a dedicated PromotionalTokenAdapter, SQLite store, payment verifier, runner and HTTP service. Payer plus requestId identifies a request. A normalized payload hash binds canonical issuance/name/recipient/decimals, requested chains, recipients, allocations, pool inventory, expiry and cost cap. The job hash also pins adapter version, payment terms and budgets. Unknown fields and noncanonical atom amounts fail. EVM casing and destination order normalize. Tokens and quote amounts use six-decimal integer strings.

x402 v2 exact payment uses the job hash as EIP-3009 nonce. A client must honor `extra.authorizationNonce`; generic clients choosing random nonces need an extension. Verification binds domain/asset/network, payer, payee, amount and validity. Only synthetic settlement is executable today. Real USDC escrow/facilitator and deployment remain prerequisites.

Same payload resumes the original plan even after expiry or pricing changes. Conflicts return 409. An expired unpaid authorization never charges or issues; already settled fulfillment can continue. Adapter/version/payment configuration changes cannot silently resume a job.

Payment, issuance, manager, debit, credit and pool steps have independent planned/prepared/complete states. Prepared signed bytes or provider keys persist **before** submission. Restart observes that operation first. Pending/unknown evidence stops progression; proven absence allows the identical bytes to be resent. No replacement nonce, issuance salt or credit is generated for an uncertain effect. Receipts must match the operation, finality, bounded cost, issuance/transfer quantities and pool token/quote amounts. Real adapters must additionally authenticate chain, token/peers/configuration, canonical block inclusion and events. The runner trusts that adapter contract and cannot itself authenticate a fabricated receipt.

SQLite uses FULL sync, WAL, transactional revision fencing and renewable single-host leases. Tests include an actual child-process crash, reopen and expired lease. Synthetic external effects have a separate durable journal. Production requires a durable host or transactional shared database, real nonce management and replay-safe payment/chain adapters. Vercel ephemeral storage is unsuitable: `api/equilibrium.ts` provides free readiness and returns 503 for POST.

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

Run `bun run equilibrium:server`, then in another terminal `EQUILIBRIUM_JOB_SERVER=http://127.0.0.1:4042 bun run dev` for free local records. POST `/x402/equilibrium` returns a bound 402; retry with PAYMENT-SIGNATURE. GET `/equilibrium/jobs` and `/equilibrium/jobs/<id>` is free. Requests are capped at 16 KiB. Test fixtures show the strict request and signing format with a local test key only.

The default synthetic two-chain job quotes 27.2 synthetic USDC: 1 platform fee, 6.2 execution fees and 20 pool quote principal. It issues 1,000,000 tokens once, with 500,000 in canonical custody backing 500,000 remote tokens. Re-running retains its addresses/payment. This fixture is distinct from the browser simulation and release allocation.

### Evidence and economics

The [read-only Arc/Base deployment audit](EQUILIBRIUM-AUDIT.md) checks pinned finalized supply, proxy implementations, authorities and peers against an approved manifest. It rejects missing deployments and unauthenticated backing gaps. Passing that two-chain snapshot never opens a route or proves payment, pools or the four-chain release.

Free records exclude signatures/prepared bytes. PAYMENT-RESPONSE describes settlement only; partial fulfillment is 202. Supply is derived from recorded steps, marked incomplete while submitted operations are unresolved, and is not an independent onchain audit. Platform fee, execution fees, deployed quote principal and held remainder are separate. Pending costs may already be spent; timeout does not imply refund.

The keeper's existing inventory, size, freshness, spending, loss and failed-leg limits are unchanged. Keeper net and whole-treasury holdings/open exposure remain distinct. Mainnet profitability, external paid demand, public finality, SVM execution and refills remain unproven. See [routes](EQUILIBRIUM-ROUTES.md) and [release preview](../public/equilibrium-release-preview.md).
