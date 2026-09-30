## Arc–Base execution: adapter, unattended runner and release procedure

This adds a real RPC adapter behind the existing `PromotionalTokenAdapter` contract (`server/equilibrium/types.ts`). The job store, runner, settlement ledger and HTTP service are unchanged. Solana and Robinhood stay closed.

### How a launch executes

Each job step is one call, `EquilibriumExecutor.execute(operation, digest, calls)` (`contracts/equilibrium/EquilibriumExecutor.sol`), on the chain where the step takes effect. `operation` is `hash([job.id, step.id])`, the id the runner already binds. The executor records `digestOf[operation]` **before** running any call and reverts `OperationDone` on a second execution. Idempotency therefore sits on-chain, not in a tx nonce or the worker database. A stale worker, a restarted worker or a replayed transaction can only waste its own gas.

| Step | Chain | Calls through the executor | Result checked from the finalized receipt |
| --- | --- | --- | --- |
| payment:arc | Arc | USDC `transferWithAuthorization` (payer to Arc executor, nonce = job id) | USDC `Transfer` payer→executor equals the quoted total |
| canonical:arc | Arc | CREATE2 `EquilibriumCanonical`, fixed issuance to the executor | minted amount and address |
| manager:arc | Arc | NTT manager (LOCKING) + Wormhole transceiver behind ERC1967 proxies, threshold 1, limits, Base peers | manager proxy owned by the executor |
| pool:arc | Arc | Architex `createPair`, exact EQL + USDC in, `mint`, Arc allocation and unallocated supply to recipients | `Transfer`s executor→pair equal pool inventory |
| manager:base | Base | CREATE2 `EquilibriumSpoke` (zero supply), NTT manager (BURNING) + transceiver, Arc peers, `setMinter` | manager proxy owned by the executor |
| debit:base | Arc | approve + NTT `transfer` to the Base executor | locked `Transfer` amount, and a signed VAA (pending until signed) |
| credit:base | Base | transceiver `receiveMessage(VAA)` | spoke mint to the Base executor equals the allocation |
| pool:base | Base | Uniswap v3 `createPool`, `initialize`, full-range `mint`; callback pays the exact bound totals | `Transfer`s executor→pool equal pool inventory |

Every address a job creates is CREATE2-predicted from the job id and the two executor addresses (`layout()` in `server/equilibrium/evm/adapter.ts`). That is how each side's peers are configured before the other side exists. NTT code is the pinned submodule built with NTT's own `prod` profile (solc 0.8.19, via-IR; NttManager is 24,067 bytes). `server/equilibrium/evm/bytecode.json` carries it with SHA-256s; `bun run equilibrium:bytecode --check` compares it to a fresh build.

`observe` reads `digestOf` at the finalized block (Arc `finalized` tag; Base `finalized` tag on testnet). Executed-but-not-final or in-mempool is **pending**, never absent. Only proven absence lets the runner broadcast again, and a repeat broadcast is harmless anyway. The adapter version pins chains, executors, limits, budgets and code hashes, so a job cannot resume under a different configuration.

### Fork evidence

`bun run equilibrium:fork-test` starts pinned anvil forks of **Arc testnet (block 64,824,600)** and **Base Sepolia (block 47,513,000)**. The real Wormhole cores, the Architex factory, the Uniswap v3 factory and Base Sepolia USDC run as deployed. Three substitutions are fork-only (`server/equilibrium/evm/fork.ts`):

- Both Guardian sets are overwritten with one local key.
- Arc USDC runs as an EIP-3009 stand-in, because Arc's native USDC calls Arc precompiles `0x1800…00/01` that anvil lacks.
- The Base executor's USDC quote inventory is written to storage.

The 11 scenarios:

- A paid x402 launch runs through the HTTP service and returns 200. On-chain supply reconciles: 1,000,000 issued, 10,000 locked backing 10,000 on Base, both pools holding exact inventory, and the executors emptied.
- A resend executes nothing.
- A stale worker races a live worker on the same debit, and tokens move once.
- A late duplicate after completion sends nothing, and a raw resubmission reverts.
- A replayed VAA, directly or via a new operation, and a forged VAA are all rejected.
- Altered bytes are refused.
- Only the owner can execute.
- Worker processes killed after the credit broadcast, before the debit broadcast, and after the Arc pool broadcast are all finished by `reconcile`, every effect exactly once.
- Delayed Base finality stays pending and completes without re-execution.

What forks do **not** prove: public Guardian attestation of this route, Arc's real USDC precompile path, and real Base L1 data fees.

### Unattended runner

`bun run equilibrium:evm-serve` is the local service (`serve.ts`) wired to the EVM adapter. It verifies executors, owners, cores and venues at startup, binds 127.0.0.1, refuses ephemeral stores, and sweeps interrupted jobs every `EQUILIBRIUM_RECONCILE_MS`. A fork config must point at loopback forks. A testnet config refuses to start unless `EQUILIBRIUM_APPROVAL` equals `sha256(release preview, exact config)`, so approval of one preview cannot authorize a different configuration. There is no live mode.

### Release procedure (Stage A: Arc testnet + Base Sepolia)

1. **Wallets.** Angus names two testnet wallets:
   - an **operator**, which owns both executors and so both NTT managers, the LP positions and every deployment;
   - a **payer**, which signs the EIP-3009 authorization.
2. **Plan.** Run `bun run equilibrium:infra plan --operator <operator> --payer <payer>`. It is read-only. It writes `deployments/equilibrium-testnet.json` with nonce-predicted library and executor addresses, prints the approval digest, and lists every missing balance. The 2026-09-30 run with an empty stand-in operator reported:
   - Arc operator: about 1.003 native USDC for gas (3x margin at 25 gwei);
   - Base operator: about 0.0053 ETH, including a 0.005 ETH L1 fee allowance;
   - Base executor: 100 Base Sepolia USDC quote inventory;
   - payer: 219 Arc testnet USDC (200 pool quote + 19 step budgets).
3. **Fund.** Use the Circle testnet faucet for USDC on Arc and Base Sepolia, plus Base Sepolia ETH. Re-run `plan` until `missing` is empty.
4. **Approve.** Angus approves the printed `EQUILIBRIUM_APPROVAL` digest on the issue. Any later change to the preview or config needs a new digest.
5. **Deploy.** Run `EQUILIBRIUM_OPERATOR_KEY=… EQUILIBRIUM_APPROVAL=… bun run equilibrium:infra deploy`. This deploys the NTT library and the executor on each chain, checked against the predicted addresses. Then send the 100 Base USDC to the Base executor.
6. **Run.** `EQUILIBRIUM_EVM_CONFIG=deployments/equilibrium-testnet.json EQUILIBRIUM_OPERATOR_KEY=… EQUILIBRIUM_APPROVAL=… EQUILIBRIUM_DB=<durable path> bun run equilibrium:evm-serve`
7. **Launch.** Run `bun run equilibrium:infra request --payer <payer> --recipient <treasury>`, then `EQUILIBRIUM_PAYER_KEY=… bun run equilibrium:evm-launch --request request.json --max-total 219000000 --yes`. The request uses the preview allocation. HTTP 202 is expected while Base finalizes, which takes roughly 15–20 minutes per Base step. The sweep finishes it unattended; read `GET /equilibrium/jobs/<id>`.
8. **Verify and record.** Check token, manager, transceiver and pool addresses and balances on both explorers. Then prove the return route (Base→Arc) separately; this adapter launches outbound only.

Stop conditions and recovery are unchanged from the preview. Preserve the store (and WAL); never edit `digestOf` expectations; restart with the same config; the sweep observes before it sends.

### Known limits

- The operator key is hot, and through the executor it owns NTT upgrade, pause and peer powers. That is acceptable for a testnet pilot only. Live needs ownership moved to a multisig after deployment, which is not implemented.
- No Base→Arc return step, CCTP quote refill, keeper or refund path.
- One sender process per operator key. Concurrent processes rely on the executor for correctness but can waste gas on nonce races.
- Base cost is charged at a deliberately high 5,000 USDC/ETH.
