## EQUILIBRIUM release preview v1 — unapproved, closed

Prepared 2026-09-30 for 49TH-22. Two-chain proposal; deployment, funding and publication await Angus's approval. Four-chain expansion needs separate proof/approval. No public token/manager/transceiver/pool exists. Evidence: synthetic durable jobs, local-Guardian bridge forks, Base Sepolia/Robinhood mainnet venue forks and dated infrastructure reads. Public route tests: zero. Real payment settlements: zero.

### Versions, routes and addresses

Base PR #7: `ff8f643303fae742523891ea7ec9ca39b70f11cc`. Integration: stacked 49TH-22 PR; pin its approved commit before execution. NTT EVM `v2.0.0+evm` / `c636cc15b07969e4b44de7e466c999c07e7387a9`, recursive dependencies; x402 core `2.26.0`. Issuance/spoke contracts: `contracts/equilibrium/`. SVM candidate `v3.0.0+solana` / `1a2a92ef7f289972b2d00dd1d58077d139fe68d7` is outside this pilot.

Pilot: Arc testnet 5042002 (Wormhole 71) ↔ Base Sepolia 84532 (10004), locking/burning, six decimals, one Wormhole transceiver, consistency 0, approved peers, 24-hour 10,000-token inbound/outbound limits. No automatic spoke-to-spoke route.

| Existing infrastructure | Arc testnet | Base Sepolia |
| --- | --- | --- |
| Wormhole core | `0xBB73cB66C26740F31d1FabDC6b7A46a038A300dd` | `0x79A1027a6A159502049F10906D333EC57E95F083` |
| Pool factory | Architex `0x6362f5a0fc007ab7d1e61f99d3f4eb04360d060a` | v3 `0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24` |
| USDC | `0x3600000000000000000000000000000000000000` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| EQL/manager/transceiver/pool | **Undeployed; required before dependent operations** | **Undeployed; required before dependent operations** |

Proposed issuance: 1,000,000 EQL; 990,000 outside Arc custody and 10,000 Base representations backed by 10,000 custody. Each pool gets 5,000 EQL. Remaining tokens belong to the disclosed treasury; this is not public distribution or measured demand. Confirm venue fee tier, token order and byte hashes before execution.

### Signers, admin and liquidity ownership

Angus must approve/provide deployer, treasury/payer, job signer, issuance-factory operator, spoke binder, manager/transceiver owner and pauser addresses. None is configured. Proposed pilot owner is an Angus-controlled test wallet; live owner should be a separately approved multisig. Neither is instantiated here.

Canonical token has no later mint/burn/upgrade. Factory operator may issue a different request, so access/identity namespace matter. Spoke binder assigns its deployed manager once. NTT owners can upgrade and alter peers/threshold/rates/pause; those powers can affect backing. SVM freeze/program powers require a later decision. No agents-only restriction is included.

Arc LP tokens and Base v3 LP NFT belong to the approved treasury and remain **withdrawable**. No LP lock, burn, irreversible Deepen behavior or decentralization claim applies. Bridge custody is not an LP lock. Use exact approvals and revoke them when finished.

### Budgets and limits

Stage A uses test assets only: 100 test USDC per pool, at most 100 additional Arc test USDC for deployment/gas/bridge/recovery and 0.02 Base Sepolia ETH. Ceiling: **300 test USDC + 0.02 test ETH**. No purchased assets/mainnet spending. Keeper and paid launch remain disabled. Identify the actual available test funding first.

After public proof and real paid-job implementation, a **separate** Arc/Base mainnet proposal has a **500 USDC** total ceiling: pools 200; keeper quote 100; deployment/gas/bridge 50; recovery 50; refill fees 25; contingency 75. ETH purchases count at executable cost against this cap. Refresh mainnet addresses/quotes/roles and obtain separate approval. Contingency does not authorize another chain.

Proposed live keeper: at most 80 tokens/trade, 50 USDC cumulative session spend, 5 USDC gross realized-loss halt, quotes ≤10 seconds old, ≥0.25 USDC edge after all costs plus 1 USDC buffer, quote TTL 30 seconds, swap deadline ≤60 seconds. Recovery consumes those same limits. Pending bridge claims are unavailable inventory. No keeper is deployed. These proposed live caps do not change the showcase's illustrative 1,000 spend / 10 loss limits.

### Gates and verification

1. Approve the commit, named roles, allocation, LP terms and Stage A test budget. Prepare exact signed operation preview (nonce, salt, chain, gas cap, expected address) before broadcast.
2. Deploy/verify tokens/managers/transceivers and record hashes, owners, mint binding, peers, threshold, rates and decimals. Prove public Arc→Base Guardian credit and Base→Arc return with finalized receipts and exact backing. Fork signatures do not satisfy this gate.
3. Seed actual pools and verify balances, LP ownership, fee tier/tick and executable quotes. Prove separate quote refill or keep refill/keeper disabled.
4. Add real signed chain adapters, USDC escrow/settlement, authenticated operator access, durable production database/indexer and nonce management. Rehearse real settlement/debit crashes and stale/pending evidence. Enforce replay-safe identities onchain or equivalently.
5. Independently review bridge/admin/escrow behavior before accepting external funds. Open only proven routes with free records. No UI mode or environment flag can bypass these prerequisites.

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

Commands verify local code/read-only infrastructure. No public deployment command exists yet. Add the real script and signed preview after roles/adapters are ready; execution otherwise remains closed.

### Recovery

Stop quoting/charging and pause keeper on unknown receipts, peer mismatch, stale evidence, exceeded budget or reconciliation failure. Preserve database/WAL, signed bytes, hashes and receipt history. Inspect free GET records. Restart using the original database and pinned adapter; observe submitted effects before resending identical bytes only after proven absence. Source debit blocks credit until authenticated finalized evidence.

Paused/rate-limited messages retain the original claim. Resume after configuration checks; never mint another destination, redeploy issuance or refund on timeout. Settled payment with partial fulfillment stays partial with fees/unresolved funds disclosed. Refund only after every submitted effect is reconciled and an authorized replay-safe refund is recorded; automated refunds are not implemented. Unwind keeper exposure within remaining caps or keep it halted and disclose it.

### Public copy

Current state: “EQUILIBRIUM demonstrates one supply across four modeled markets. Durable launch jobs and bridge/venue fork rehearsals are available to inspect. Public routes and paid launches remain closed; no real funds move in the demonstration.”

Conditional two-chain release: “EQUILIBRIUM has one fixed supply on Arc and a backed representation on Base. Inspect each token, bridge, pool and payment step. The keeper trades within disclosed inventory, freshness, spending and loss limits. Prices may diverge; fees, liquidity and pool losses affect the whole treasury. Solana and Robinhood remain closed pending separate testing.”

Publish only after evidence supports the copy and Angus approves. Measure external paid creators, repeat creators and skill installations separately from internal keeper volume.
