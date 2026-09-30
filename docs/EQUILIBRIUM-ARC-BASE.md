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

From a fresh checkout, reproduce the complete bundle with:

```bash
git submodule update --init --recursive
bun install --frozen-lockfile
bun run equilibrium:bytecode-build --check
```

The build command forces both compilers to rebuild. NTT keeps its pinned upstream `prod` configuration; `scripts/equilibrium-ntt-remappings.txt` supplies only global relative remappings with automatic discovery disabled. The local `equilibrium` profile also disables discovery. Foundry otherwise inserts checkout-absolute dependency contexts into solc metadata, changing the complete creation code across paths. Compiler metadata remains included. The check compares the entire JSON bundle verbatim, including complete creation-code strings, link placeholders, compiler versions, metadata hashes, source keccak256 hashes, recursive gitlink pins, lockfile and build-input hashes. It refuses stale sources, mismatched gitlinks and absolute remappings. Each entry's `sha256` hashes the complete literal creation-code string, including its `0x` prefix and any link placeholders. To intentionally regenerate after a reviewed source/build change, run the build command without `--check`; this changes the release approval digest and CREATE2 predictions.

`observe` reads `digestOf` at the finalized block (Arc `finalized` tag; Base `finalized` tag on testnet). Executed-but-not-final or in-mempool is **pending**, never absent. Only proven absence lets the runner broadcast again, and a repeat broadcast is harmless anyway. The adapter version pins chains, executors, limits, budgets and code hashes, so a job cannot resume under a different configuration.

### Fork evidence

`bun run equilibrium:fork-test` starts pinned anvil forks of **Arc testnet (block 64,824,600)** and **Base Sepolia (block 47,513,000)**. The real Wormhole cores, the Architex factory, the Uniswap v3 factory and Base Sepolia USDC run as deployed. Three substitutions are fork-only (`server/equilibrium/evm/fork.ts`):

- Both Guardian sets are overwritten with one local key.
- Arc USDC runs as an EIP-3009 stand-in, because Arc's native USDC calls Arc precompiles `0x1800…00/01` that anvil lacks.
- The Base executor's USDC quote inventory is written to storage.

The 16 scenarios:

- A paid x402 launch runs through the HTTP service and returns 200. On-chain supply reconciles: 1,000,000 issued, 10,000 locked backing 10,000 on Base, both pools holding exact inventory, and the executors emptied.
- A resend executes nothing.
- A stale worker races a live worker on the same debit, and tokens move once.
- A late duplicate after completion sends nothing, and a raw resubmission reverts.
- A replayed VAA, directly or via a new operation, and a forged VAA are all rejected.
- Altered bytes are refused.
- Only the owner can execute.
- Worker processes killed after the credit broadcast, before the debit broadcast, and after the Arc pool broadcast are all finished by `reconcile`, every effect exactly once.
- Delayed Base finality stays pending and completes without re-execution.
- The approved scope allows one paid launch and refuses a second before any charge. A gas cap below one send's worst case refuses before anything is sent.
- A worker SIGKILLed right after sending, before any receipt accounting: its reservation stays at worst case, reconcile finishes the job, and committed gas equals every real receipt plus exactly that over-count.
- Gas reservations are shared across processes: a dead worker's unsettled reservation makes a second process refuse, and two workers started together never commit past the cap.
- Two worker processes racing for the one approved launch: exactly one payment executes.
- Base receipts carrying a hex `l1Fee`, injected by an RPC proxy as OP Stack nodes return it, are accounted as numbers end to end.

What forks do **not** prove: public Guardian attestation of this route, Arc's real USDC precompile path, and real Base L1 data fees.

### Unattended runner

`bun run equilibrium:evm-serve` is the local service (`serve.ts`) wired to the EVM adapter. It verifies executors, owners, cores and venues at startup, binds 127.0.0.1, refuses ephemeral stores, and sweeps interrupted jobs every `EQUILIBRIUM_RECONCILE_MS`. A fork config must point at loopback forks. A testnet config must carry a pilot scope and refuses to start unless `EQUILIBRIUM_APPROVAL` equals the digest over the release preview, the exact config and the code manifest. The adapter then enforces the scope: one launch, the named payer and recipient, the exact allocation, a total of at most 219 USDC, and worst-case operator gas within the caps before every send. There is no live mode.

### Release procedure (Stage A: Arc testnet + Base Sepolia, one launch)

1. **Wallets.** Angus names three public testnet addresses:
   - an **operator**, which owns both executors and, through them, NTT admin and the LP positions;
   - a **payer**, which signs the EIP-3009 authorization;
   - a **recipient**, which receives the allocations.
2. **Plan, once.** Run `bun run equilibrium:infra plan --operator <o> --payer <p> --recipient <r>`. It is read-only against both testnets. It:
   - writes `deployments/equilibrium-testnet.json` with nonce-predicted addresses and the pilot scope (one launch, those wallets, the preview allocation, 219 USDC total, gas caps);
   - prints `EQUILIBRIUM_APPROVAL`;
   - lists the **before-deployment** shortfall: operator gas on both chains and the payer's 219 USDC.

   It refuses to overwrite an existing plan without `--replace`, and refuses if current gas prices would break a cap.
3. **Approve.** Angus approves that digest on the issue. It binds the preview, that exact config and the code manifest.
4. **Fund before deployment.** Operator: about 1 Arc native USDC and 0.0013 Base Sepolia ETH (Circle faucet and a Base Sepolia faucet). Payer: 219 Arc testnet USDC.
5. **Deploy.** Run `EQUILIBRIUM_OPERATOR_KEY=… EQUILIBRIUM_APPROVAL=… bun run equilibrium:infra deploy`. It deploys the library and executor per chain, checks worst-case gas against the deploy caps before sending, and checks that each address matches the plan.
6. **Fund after deployment.** Send 100 Base Sepolia USDC to the Base executor. Then run `bun run equilibrium:infra check`; it must report `ready: true`.
7. **Run.** `EQUILIBRIUM_EVM_CONFIG=deployments/equilibrium-testnet.json EQUILIBRIUM_OPERATOR_KEY=… EQUILIBRIUM_APPROVAL=… EQUILIBRIUM_DB=<durable path> bun run equilibrium:evm-serve`
8. **Launch.** Run `bun run equilibrium:infra request`, then `EQUILIBRIUM_PAYER_KEY=… bun run equilibrium:evm-launch --request request.json --max-total 219000000 --yes`. HTTP 202 is expected while Base finalizes (roughly 15–20 minutes per Base step). The sweep finishes it unattended; read `GET /equilibrium/jobs/<id>`.
9. **Verify and record** addresses and balances on both explorers. Prove the Base→Arc return separately; this adapter launches outbound only.

**Ceiling:** 321 test USDC + 0.01 test ETH. That is payer 219 + Base inventory 100 + operator gas caps (Arc: deploy 0.5 + launch 1.5 native USDC; Base: 0.002 + 0.008 ETH).

Stop conditions and recovery are unchanged from the preview. Preserve the store (and WAL); never edit `digestOf` expectations; restart with the same config; the sweep observes before it sends.

### Known limits

- The operator key is hot, and through the executor it owns NTT upgrade, pause and peer powers. That is acceptable for a testnet pilot only. Live needs ownership moved to a multisig after deployment, which is not implemented.
- No Base→Arc return step, CCTP quote refill, keeper or refund path.
- One sender process per operator key. Concurrent processes rely on the executor for correctness but can waste gas on nonce races.
- Base cost is charged at a deliberately high 5,000 USDC/ETH.
