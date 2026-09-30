## Arc–Base transfers: Base→Arc return and USDC quote refill

This work is stacked on PR #12 (`agent/coding-overlord/49th-25-arc-base` at `75447f5`). It adds two operator transfer routes beside the launch adapter. None of them changes it. Every file the 49TH-25 launch approval binds is byte-identical to `75447f5`:

- `CODE_FILES` in `server/equilibrium/evm/approval.ts`
- `public/equilibrium-release-preview.md`
- `deployments/`

The routes are:

- **Return.** EQUILIBRIUM moves from Base back to Arc through the launch's own NTT managers. The Base spoke burns, the Guardians attest the finalized burn, and the Arc hub unlocks the same amount from custody.
- **Refill.** USDC quote inventory moves between the Arc and Base executors over Circle CCTP V2 standard transfers. This separate rail replaces the storage-funded Base inventory the launch fork suite uses.

Solana (49TH-26) and Robinhood stay closed. A refill request naming either rail is refused with `route_closed`. Nothing is substituted for it.

### How a transfer executes

A transfer is a durable record in the launch store's database (`evm_transfers`). It is separate from launch jobs: its own table, operation ids, gas table and cap, and approval. Each effect is one `EquilibriumExecutor.execute(operation, digest, calls)` with `operation = hash([transferId, stepId])`. The executor binds the operation before running anything, so a stale worker, a restarted worker or a replayed transaction cannot repeat a burn, unlock or mint. The runner has the same guarantees as launch jobs:

- Prepared bytes are persisted before sending.
- An effect that is executed but not finalized, or still in the mempool, is **pending**, never absent.
- The worker holds a heartbeat lease with revision fencing. A worker that lost its lease stops before it sends or writes.
- A sweep (`reconcileTransfers`) finishes interrupted transfers without any client request.

| Route | Step | Chain | Effect | What the finalized receipt must prove |
| --- | --- | --- | --- | --- |
| return (executor) | `burn:base` | Base | Spoke `approve` and NTT `transfer` from the Base executor's own inventory | Exactly one Wormhole message from this launch's Base transceiver. It routes Base manager → Arc hub for this spoke token at six decimals. Its amount equals the spoke's burn, the bound amount and recipient, and the executor as sender. Signed VAA required (pending until signed). |
| return (holder) | `burn:base` | Base | Nothing sent: the holder's own NTT `transfer` transaction | Same checks, read only once the holder's receipt is at or below Base's finalized block |
| return | `unlock:arc` | Arc | Hub transceiver `receiveMessage(VAA)` | `TransferRedeemed(digest)` for this message, and the canonical `Transfer` hub → recipient equals the burned amount. A queued (rate-limited) inbound transfer is an error, not a success. |
| refill | `burn:<from>` | from | USDC `approve` and TokenMessengerV2 `depositForBurn` | Exactly one `MessageSent` whose fields match the request: domains, messengers, the destination executor as mint recipient and sole destination caller, finality 2000, `maxFee` 0, no hook, amount and sender. USDC destroyed equals the amount. The attested message may differ only in nonce, executed finality (at least 2000), fee (at most `maxFee`) and expiry. |
| refill | `mint:<to>` | to | MessageTransmitterV2 `receiveMessage(message, attestation)` | USDC minted to the destination executor equals burned minus the attested fee (zero) |

Replay and authenticity sit in the deployed contracts. The Arc hub accepts only Guardian-signed VAAs from its configured Base peer and consumes each one once. The destination MessageTransmitterV2 accepts only attester-signed messages, only from the named destination caller, and each nonce once.

The routes add their own guards on top:

- **One record per holder burn.** A holder burn has one identity whoever asks, so two requests cannot record it twice.
- **Third-party relays.** Anyone may relay a VAA to the Arc hub. The return route detects a redemption made by someone else, records it as `third-party` with zero operator cost, and sends nothing.
- **Front-running.** Refills name the destination executor as the only permitted caller, so nobody can front-run the mint.

### Gas ledger and chain binding

These follow PR #12's repaired sender (49TH-25, `add47bb`), in the transfer sender's own table (`evm_transfer_gas`) against its own cap (`operatorGas`).

- **Chain binding.** Before anything is reserved or signed, the sender reads `eth_chainId` and refuses a chain id that differs from the approved configuration or from the chain id bound into the prepared plan (`wrong_chain`, "Nothing was sent"). The CLI also runs `verify()` before any command that can send: chain ids, and each executor owned by the operator.
- **Numeric fees.** Receipt costs use PR #12's `weiOf`/`l1FeeOf`, which read an OP Stack `l1Fee` given as hex, decimal, number or bigint, and refuse anything else. Base RPCs return it as hex, and viem does not format it for a plain chain definition. Before this repair the hex was concatenated into the ledger.
- **Reserve before signing.** The worst case (gas limit × max fee, plus Base's L1 fee upper bound) is checked against the cap and recorded in one IMMEDIATE SQLite transaction. Competing processes on one store serialize there, so the cap cannot be double-booked.
- **Recorded before sending.** The transaction is signed locally. Its hash is written to the reservation and the broadcast journal before `eth_sendRawTransaction`. A process killed after the send is settled later from the receipt. A reservation whose transaction never mined stays at worst case: the ledger over-counts, never under-counts.
- **Legacy rows.** A pre-repair spend row (`evm_transfer_spend`) is moved into the ledger at its finalized receipt's numeric cost; nothing is resubmitted. A malformed row whose receipt cannot be read stops sends on that chain (`gas_ledger`) until it can be.

### Conservation

`conservation()` in `transfers/returns.ts` reads one launch at each chain's finalized block:

- Canonical `totalSupply` must equal the fixed issuance.
- Arc hub custody must be at least Base `totalSupply`.
- `inFlight = custody − remote` is value between chains: a finalized burn awaiting its unlock, or a debit awaiting its credit.
- `circulating = outside custody + remote` never exceeds issuance.

Each return also checks that the unlocked amount equals the finalized burn. Each refill checks that the minted amount equals the burned amount less the attested fee.

### Refill rail: verified official deployment

Circle documents CCTP V2 on both testnets (developers.circle.com CCTP contract addresses; docs.arc.io lists the same Arc addresses). `bun run equilibrium:refill-verify` reads the following from both public RPCs and exits non-zero on any difference. Nothing is sent. It passed at Arc block 64,833,665 and Base Sepolia block 47,516,024 on 2026-09-30. The fork suite asserts the same facts at the pinned fork blocks before any substitution.

| | Arc testnet | Base Sepolia |
| --- | --- | --- |
| CCTP domain | 26 | 6 |
| TokenMessengerV2 | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` | same |
| MessageTransmitterV2 | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` | same |
| TokenMinterV2 | `0xb43db544E2c27092c107639Ad201b3dEfAbcF192` | same |
| USDC | `0x3600000000000000000000000000000000000000` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Attesters / threshold | Circle's two V2 keys (also published by Iris `/v2/publicKeys`) / 2 | same |
| Remote wiring | Base messenger registered; Base USDC maps to Arc USDC | Arc messenger registered; Arc USDC maps to Base USDC |
| Burn limit per message | 10,000,000 USDC | 10,000,000 USDC |

Attestations come from Circle's Iris sandbox, `https://iris-api-sandbox.circle.com/v2/messages/{domain}?transactionHash=…`. Only standard transfers (finality 2000) are used, and they are free on both directions today. A request with a nonzero fee ceiling is refused rather than budgeted.

### Fork evidence

Three commands reproduce it. Each starts anvil forks of Arc testnet (block 64,824,600) and Base Sepolia (block 47,513,000):

- `bun run equilibrium:fork-test`: the frozen launch suite, 12 cases.
- `bun run equilibrium:transfers-fork-test`: 11 return and 12 refill cases.
- `bun run equilibrium:transfers-rehearse`: one scenario end to end, written to `output/equilibrium/transfers-evidence.json` with supply snapshots, transactions and gas.

The launch suite and both transfer suites pass together (35 of 35).

Return cases:

- **Launch baseline.** A real fork launch through the frozen adapter. At finalized blocks, custody of 10,000 EQL equals the Base supply.
- **Executor return.** The Base burn is held unfinalized for two confirmations. The unlock is not prepared until the burn finalizes. Arc custody then releases exactly 1,500 EQL, once. A resend resumes the same record and executes nothing.
- **Holder return.** A holder's own burn is relayed only after it finalizes. A second request for the same burn resumes the same record.
- **Replay.** The redeemed VAA fails directly, through a fresh executor operation, and altered.
- **Unauthorized credit.**
  - A Base transaction that is not an NTT burn of this launch is refused before anything is prepared on Arc.
  - An unknown transaction is refused.
  - A return above executor inventory or above the per-transfer cap is refused, as is one for an unknown launch, one with an unknown field, and a conflicting payload under an existing request id.
- **Third-party relay.** A relay that lands first is recorded as `third-party`. The executor sends nothing, and custody moves once.
- **Stale worker.** A stale and a live worker race the same unlock. Custody moves once.
- **Crash recovery.** Worker processes are killed after the burn broadcast, before the unlock broadcast and after the unlock broadcast. The sweep finishes each one with every effect once.
- **Final reconciliation.** Base supply equals Arc custody (7,000 EQL). Issuance is unchanged.

Refill cases:

- **Official deployment.** The pinned facts above hold at the fork blocks.
- **Funding the launch.** The Base executor starts with zero USDC, and a launch stops at `pool:base` with nothing sent for it. A 10 USDC refill from the payment USDC left on Arc burns on Arc and is attested. Only then does it mint on Base, once. Arc supply falls and Base supply rises by exactly 10 USDC. The launch then resumes and seeds the Base pool from the refilled inventory, every step once.
- **Replay and forgery.** Each of these fails:
  - the attested message through a fresh executor operation
  - the same message sent directly by the operator (destination caller check)
  - a forged attestation
  - an altered amount
  - a correctly signed new message from the wrong caller
- **Stale worker.** A stale and a live worker race the same mint. It mints once.
- **Pending attestation.** An unattested burn is pending, not absent. Nothing is re-burned or minted until the attestation exists.
- **Crash recovery.** Worker processes are killed after the burn, before the mint and after the mint. The sweep finishes each one with every effect once.
- **Reverse rail.** Base USDC burns and the Arc executor receives it.
- **Caps and closed rails.** Refused before anything is sent: over the per-transfer cap, over inventory, the Solana and Robinhood rails, a nonzero fee, and a conflicting payload. Two refills that each fit the cumulative cap but not together both bind. Only one reserves headroom; the other sends nothing.

Measured gas at the pinned forks:

| Operation | Chain | Gas used |
| --- | --- | --- |
| Refill burn | Arc | 155,469 |
| Refill mint | Base | 197,076 |
| Return burn from executor inventory | Base | 234,383 |
| Return unlock | Arc | about 229,000 |

**Fork-only substitutions.** These are in addition to fork.ts's:

- Both MessageTransmitterV2 attester sets are replaced by one local key at threshold 1. `transfers/fork.ts` stands in for Iris. It fills exactly the fields Iris fills and signs `keccak256(message)` as the real attesters do.
- Arc's USDC stand-in becomes `ForkUsdcCctp`: ForkUsdc plus `mint` returning true and `burn`, with the same storage layout. Circle's TokenMinterV2 needs both. The real Arc USDC mints and burns through Arc precompiles anvil lacks. The stand-in ships in its own bundle (`transfers/fork-bytecode.json`) so the launch bundle is untouched. `bun run equilibrium:transfer-bytecode --check` builds it fresh and compares the whole creation code, CBOR metadata included. Foundry's auto-detected remappings for nested libraries carry the checkout's absolute path into the metadata, so this one build turns auto-detection off (every project remapping is relative) and writes to `output/forge-fork`. `foundry.toml` is not changed. The same bytes come out of any checkout with the locked `node_modules`.

**What the forks do not prove:**

- The public Guardians attesting this Base→Arc route.
- Circle's Iris attesting these burns.
- Arc's real USDC precompile path.
- Real Base L1 data fees.
- Any holder behaviour beyond a well-formed NTT transfer.

### Operating

`bun run equilibrium:transfer` operates the transfers (`server/equilibrium/evm/transfers/cli.ts`). It supports `digest`, `return`, `refill`, `run <id>`, `sweep`, `status [id]` and `supply --launch <id>`. It reads:

- the launch configuration (`EQUILIBRIUM_EVM_CONFIG`)
- a separate settings file (`EQUILIBRIUM_TRANSFER_SETTINGS`) with return and refill caps, the attestation source and operator gas caps
- the operator key and the durable launch store (`EQUILIBRIUM_DB`)

Outside forks it refuses to start unless `EQUILIBRIUM_TRANSFER_APPROVAL` equals the digest over:

- the launch configuration
- the settings file
- the transfer code: `TRANSFER_FILES` in `transfers/config.ts`, which is every transfer file plus the whole launch manifest (`CODE_FILES`): request hashing, the store, config parsing, types, the adapter, contracts and bytecode. Editing any of them changes the digest.

The repair changed transfer code, so any digest computed before it is void. No transfer approval has been given.

A testnet configuration without operator gas caps is refused, as is a fork-only attester. There is no live mode.

### Additional approval and funding for a testnet transfer rehearsal

This approval is separate from 49TH-25's, which authorizes one launch and nothing else. This one authorizes transfers only.

1. **Prerequisite.** The 49TH-25 pilot has been approved, executed and has completed. Returns operate on that launch's deployed managers. Refills move USDC between the same two executors.
2. **Settings, written once:** `deployments/equilibrium-transfers-testnet.json`. Proposed values:

   | Setting | Value |
   | --- | --- |
   | `returns.maxPerTransfer` | 1,000 EQL |
   | `refill.attestation` | Iris sandbox |
   | `refill.maxPerTransfer` | 100 USDC |
   | `refill.maxTotal` | 110 USDC |
   | `operatorGas.arc` | 0.1 native USDC (1e17 wei) |
   | `operatorGas.base` | 0.001 ETH (1e15 wei) |

   At today's testnet fees (Arc base fee 20 gwei, Base Sepolia 0.005 gwei), one operation costs about 0.006 Arc USDC or under 0.00001 ETH plus L1 fee. The pre-send check reserves about twice that. The caps cover the planned operations several times over.
3. **Approve.** Angus approves the exact `EQUILIBRIUM_TRANSFER_APPROVAL` that `bun run equilibrium:transfer digest` prints for that configuration and settings.
4. **Planned operations:**
   - One refill of 100 USDC Arc→Base. It is funded by the pilot payment's residual on the Arc executor (about 119 USDC after a 219 USDC pilot), not new money.
   - One refill of 10 USDC Base→Arc.
   - One holder return of up to 1,000 EQL, where the recipient wallet burns on Base itself.
   - Optionally one executor return: the recipient first sends up to 1,000 EQL to the Base executor.
5. **Additional funding:**

   | Wallet | Amount | Purpose |
   | --- | --- | --- |
   | Operator | ≤ 0.1 Arc testnet USDC (native gas) | Transfer gas cap |
   | Operator | ≤ 0.001 Base Sepolia ETH | Transfer gas cap |
   | Recipient | about 0.0005 Base Sepolia ETH | Its own NTT burn |

   No new USDC principal: refills move USDC the executors already hold. Ceiling for this stage: 0.1 test USDC plus 0.0015 test ETH.
6. **Stop conditions.** Stop on any of:
   - a transfer that stays `partial` after the attestation window: about 20 minutes for Base finality plus Guardian or Iris signing
   - a `queued` or `refill_cap` error
   - a conservation read with `conserved: false`

   Preserve the store. Restart with the same configuration and run `sweep`; it observes before it sends.

### Known limits

- The operator key is hot, and through the executors it owns NTT admin and the transfer rails. Testnet only.
- Refill reservations are never released. A refill that stops half way still counts against `maxTotal`, which errs toward spending less than approved.
- One sender process per operator key: the transfer sender and the launch sender each serialize their own sends. Correctness rests on the executor, but two processes can waste gas on nonce races.
- `bun run equilibrium:bytecode --check` (the launch bundle) still fails in a fresh checkout for the absolute-remapping reason above. That remediation belongs to 49TH-25; the launch bundle was not regenerated.
- `JobStore` (a launch-approval file) sets `journal_mode` before `busy_timeout`, so processes opening one store at the same instant can fail at startup with `SQLITE_BUSY`. This fails closed, with nothing sent. It is reported to 49TH-25, and the transfer race test opens its store with `busy_timeout` first.
