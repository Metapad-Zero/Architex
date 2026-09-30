## EQUILIBRIUM release preview v2 — unapproved, closed

Prepared 2026-09-30 for 49TH-22; v2 (49TH-25) adds the executable Arc–Base adapter, unattended runner and approval digest. See `docs/EQUILIBRIUM-ARC-BASE.md`. Two-chain proposal; deployment, funding and publication await Angus's approval. Four-chain expansion needs separate proof/approval. No public token/manager/transceiver/pool exists. Evidence: synthetic durable jobs, local-Guardian bridge forks, Base Sepolia/Robinhood mainnet venue forks and dated infrastructure reads. Public route tests: zero. Real payment settlements: zero.

### Versions, routes and addresses

Base PR #7: `ff8f643303fae742523891ea7ec9ca39b70f11cc`. Integration: stacked 49TH-22 PR; pin its approved commit before execution. NTT EVM `v2.0.0+evm` / `c636cc15b07969e4b44de7e466c999c07e7387a9`, recursive dependencies; x402 core `2.26.0`. Issuance/spoke contracts: `contracts/equilibrium/`. SVM candidate `v3.0.0+solana` / `1a2a92ef7f289972b2d00dd1d58077d139fe68d7` is outside this pilot.

Pilot: Arc testnet 5042002 (Wormhole 71) ↔ Base Sepolia 84532 (10004), locking/burning, six decimals, one Wormhole transceiver, consistency 0, approved peers, 24-hour 10,000-token inbound/outbound limits. No automatic spoke-to-spoke route.

| Existing infrastructure | Arc testnet | Base Sepolia |
| --- | --- | --- |
| Wormhole core | `0xBB73cB66C26740F31d1FabDC6b7A46a038A300dd` | `0x79A1027a6A159502049F10906D333EC57E95F083` |
| Pool factory | Architex `0x6362f5a0fc007ab7d1e61f99d3f4eb04360d060a` | v3 `0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24` |
| USDC | `0x3600000000000000000000000000000000000000` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| EQL/manager/transceiver/pool | **Undeployed; created per launch through the executor** | **Undeployed; created per launch through the executor** |
| Executor + NTT library | **Undeployed; `equilibrium:infra deploy` after approval** | **Undeployed; `equilibrium:infra deploy` after approval** |

Proposed issuance: 1,000,000 EQL; 990,000 outside Arc custody and 10,000 Base representations backed by 10,000 custody. Each pool gets 5,000 EQL. Remaining tokens belong to the disclosed treasury; this is not public distribution or measured demand. Confirm venue fee tier, token order and byte hashes before execution.

### Signers, admin and liquidity ownership

v2 collapses the signing roles to two testnet wallets Angus names: an **operator** that owns both `EquilibriumExecutor`s (and through them every token deployment, NTT manager/transceiver owner and pauser power, and the LP positions), and a **payer** that signs the EIP-3009 authorization. Guardian attestation is the public Wormhole network. Neither wallet is configured. Live requires moving NTT ownership to a separately approved multisig; that is not implemented.

Canonical token has no later mint/burn/upgrade. Factory operator may issue a different request, so access/identity namespace matter. Spoke binder assigns its deployed manager once. NTT owners can upgrade and alter peers/threshold/rates/pause; those powers can affect backing. SVM freeze/program powers require a later decision. No agents-only restriction is included.

Arc LP tokens and Base v3 LP NFT belong to the approved treasury and remain **withdrawable**. No LP lock, burn, irreversible Deepen behavior or decentralization claim applies. Bridge custody is not an LP lock. Use exact approvals and revoke them when finished.

### Budgets and limits

Stage A uses test assets only and covers **one** launch at the preview allocation (1,000,000 EQL; 990,000 on Arc and 10,000 on Base; 5,000 EQL and 100 test USDC per pool). Committed test assets, all capped:

| Holder | Amount | Cap and enforcement |
| --- | --- | --- |
| Payer (Arc testnet USDC) | 219 | Quoted total: 200 pool quote + 19 step budgets (payment/platform fee 1, issuance 2, managers 5 + 5, pools 2 + 2, debit 1, credit 1). The adapter refuses any total above 219. |
| Base executor (Base Sepolia USDC) | 100 | Pre-positioned quote inventory for the Base pool; no CCTP refill. Sent **after** deployment, because the executor does not exist before it. |
| Operator gas, Arc (native USDC) | at most 2 | Deploy cap 0.5, checked before each deployment; launch cap 1.5, checked by the adapter against worst-case cost before every send. |
| Operator gas, Base (ETH) | at most 0.01 | Deploy cap 0.002 and launch cap 0.008, same enforcement, including the OP Stack L1 fee upper bound. |

Ceiling: **321 test USDC + 0.01 test ETH** (219 + 100 + 2). The 2026-09-30 plan funds about 1.0 Arc native USDC and 0.0013 ETH (3x current gas prices), inside the caps; a price spike that would exceed a cap makes `plan` refuse. No purchased assets or mainnet spending. Keeper stays disabled.

Funding before deployment: operator gas on both chains and the payer's 219 USDC. After deployment: the Base executor's 100 USDC. `equilibrium:infra check` verifies both stages without changing the approved configuration.

After public proof and real paid-job implementation, a **separate** Arc/Base mainnet proposal has a **500 USDC** total ceiling: pools 200; keeper quote 100; deployment/gas/bridge 50; recovery 50; refill fees 25; contingency 75. ETH purchases count at executable cost against this cap. Refresh mainnet addresses/quotes/roles and obtain separate approval. Contingency does not authorize another chain.

Proposed live keeper: at most 80 tokens/trade, 50 USDC cumulative session spend, 5 USDC gross realized-loss halt, quotes ≤10 seconds old, ≥0.25 USDC edge after all costs plus 1 USDC buffer, quote TTL 30 seconds, swap deadline ≤60 seconds. Recovery consumes those same limits. Pending bridge claims are unavailable inventory. No keeper is deployed. These proposed live caps do not change the showcase's illustrative 1,000 spend / 10 loss limits.

### Gates and verification

1. Approve the commit, named roles, allocation, LP terms and Stage A test budget. Prepare exact signed operation preview (nonce, salt, chain, gas cap, expected address) before broadcast.
2. Deploy/verify tokens/managers/transceivers and record hashes, owners, mint binding, peers, threshold, rates and decimals. Prove public Arc→Base Guardian credit and Base→Arc return with finalized receipts and exact backing. Fork signatures do not satisfy this gate.
3. Seed actual pools and verify balances, LP ownership, fee tier/tick and executable quotes. Prove separate quote refill or keep refill/keeper disabled.
4. Real signed Arc/Base adapters, nonce handling and on-chain replay-safe identities are implemented (`EquilibriumExecutor`, `server/equilibrium/evm/`) and rehearsed on forks, including killed workers and stale/pending evidence. Still required: authenticated operator access, a production database/indexer, and the same crash rehearsals against public settlement.
5. Independently review bridge/admin/escrow behavior before accepting external funds. Open only proven routes with free records. No UI mode or environment flag can bypass these prerequisites.
6. **Stale workers: rejected at the destination for Arc–Base; still a blocker for any other adapter.** The lease check before `broadcast` and `recordSettlement` is point-in-time, and the heartbeat is a timer, so neither can stop a worker whose lease lapsed from reaching the wire. For the Arc–Base adapter the far side decides instead. Every effect is one `EquilibriumExecutor.execute(operation, …)`, and the executor binds `operation` before running anything and reverts `OperationDone` on any second execution. Settlement is additionally bound by the EIP-3009 nonce, which is the job hash. A stale worker can therefore only spend its own gas. The fork suite proves this: a stale worker racing a live one on the same debit, a late duplicate after completion, a raw resubmission, and killed worker processes. The local rehearsal adapter still relies on its database primary key. Solana, Robinhood or any future adapter must carry an equivalent destination-side identity before real funds move.
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
bun run equilibrium:export
```

```bash
bun run equilibrium:fork-test                       # pinned Arc testnet + Base Sepolia forks, 16 scenarios
bun run equilibrium:bytecode --check                # deployed code matches a fresh pinned build
bun run equilibrium:infra plan --operator <a> --payer <b> --recipient <c>   # read-only; writes the config once, prints the digest
EQUILIBRIUM_APPROVAL=<digest> bun run equilibrium:infra deploy
bun run equilibrium:infra check                     # read-only, after deploy: deployment, Base inventory, payer, gas
EQUILIBRIUM_APPROVAL=<digest> bun run equilibrium:evm-serve
bun run equilibrium:infra request && bun run equilibrium:evm-launch --request request.json --max-total 219000000 --yes
```

### What the approval binds and authorizes

`EQUILIBRIUM_APPROVAL` is one SHA-256 over three things:

- this preview;
- the exact configuration `plan` writes: chains, RPCs, executor and library addresses, finality, NTT limits, budgets and the pilot scope;
- a manifest of the deployed bytecode bundle and every off-chain file on the launch path (`CODE_FILES` in `server/equilibrium/evm/approval.ts`).

Editing any of them invalidates it. `infra deploy` and `equilibrium:evm-serve` recompute it and refuse to act without an exact match, and a testnet configuration without a scope does not load.

The scope is enforced by the adapter, not by convention:

- **One launch:** a second job cannot start, and a second payment cannot be sent, even concurrently.
- **Only the named payer and recipient**, and only the exact allocation.
- **A quoted total of at most 219 USDC.**
- **Cumulative operator gas** within the launch caps. Before every send the adapter reserves the worst case (gas limit x a fixed max fee, 60 gwei on Arc, plus Base's L1 fee upper bound) in the same SQLite `BEGIN IMMEDIATE` transaction as the launch slot, so processes sharing the store serialize. The reservation is replaced by the receipt's actual cost only once the receipt is read; a process killed in between leaves it counted at worst case. The cap can over-count after a crash but never under-count.
- **The payer-side signer** (`scripts/equilibrium-evm-launch.ts`) is in the code manifest, so the tool the payer runs is part of what is approved.

Nothing broadcasts to a public chain without the approval. There is no live mode.

### Recovery

Stop quoting/charging and pause keeper on unknown receipts, peer mismatch, stale evidence, exceeded budget or reconciliation failure. Preserve database/WAL, signed bytes, hashes and receipt history. Inspect free GET records. Restart using the original database and pinned adapter; observe submitted effects before resending identical bytes only after proven absence. Source debit blocks credit until authenticated finalized evidence.

Paused/rate-limited messages retain the original claim. Resume after configuration checks; never mint another destination, redeploy issuance or refund on timeout. Settled payment with partial fulfillment stays partial with fees/unresolved funds disclosed. Refund only after every submitted effect is reconciled and an authorized replay-safe refund is recorded; automated refunds are not implemented. Unwind keeper exposure within remaining caps or keep it halted and disclose it.

### Public copy

Current state: “EQUILIBRIUM demonstrates one supply across four modeled markets. Durable launch jobs and bridge/venue fork rehearsals are available to inspect. Public routes and paid launches remain closed; no real funds move in the demonstration.”

Conditional two-chain release: “EQUILIBRIUM has one fixed supply on Arc and a backed representation on Base. Inspect each token, bridge, pool and payment step. The keeper trades within disclosed inventory, freshness, spending and loss limits. Prices may diverge; fees, liquidity and pool losses affect the whole treasury. Solana and Robinhood remain closed pending separate testing.”

Publish only after evidence supports the copy and Angus approves. Measure external paid creators, repeat creators and skill installations separately from internal keeper volume.
